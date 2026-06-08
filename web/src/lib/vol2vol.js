// CME Vol2Vol Expected Range helpers.
//
// Faithful to CME's QuikStrike Vol2Vol methodology:
//   - bands are centred on the underlying future's SETTLEMENT price
//   - 1 SD (points) = Settle × (σ/100) × √(DTE/365), where σ is the settlement
//     vol and DTE is calendar days to expiration; 2 SD / 3 SD = 2× / 3×
//   - buy edge = Settle − kSD, sell edge = Settle + kSD
//   - "price is at X SD" = (live future price − Settle) / 1SD
//
// All inputs come from the published `{contract}_OIData.txt` files (parsed here),
// so no Python/scraper changes are needed.

/** Pull a labelled number out of the single-line OIData header. Mirrors the
 *  scraper's `_extract_header_number` (quikstrike_scraper.py). */
function headerNumber(header, label) {
    const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*([-+]?\\d[\\d,]*(?:\\.\\d+)?)`, 'i');
    const m = header.match(re);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse a `{contract}_OIData.txt` payload into structured fields.
 * Header example:
 *   "... (0.43 DTE) Option Symbol: G2MM6 ... Vol: 17.81 Vol Chg: 0.00 Future Chg: -43.4 FutPrc: 4321.7"
 * Body: CSV `Strike,Call,Put,Vol Settle`.
 *
 * @param {string|null} text
 * @returns {null | {
 *   contract: string|null, futPrc: number|null, futureChg: number|null,
 *   vol: number|null, dte: number|null, settle: number|null,
 *   strikes: Array<{ strike: number, call: number, put: number, volSettle: number }>
 * }}
 */
export function parseOIData(text) {
    if (!text) return null;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    const header = lines[0].split(/\s+/).join(' ');

    const symbolMatch = header.match(/Option Symbol:\s*([A-Z0-9]+)/i);
    const dteMatch = header.match(/\(([\d.]+)\s*DTE\)/i);

    const futPrc = headerNumber(header, 'FutPrc');
    const futureChg = headerNumber(header, 'Future Chg');
    // Settlement = live future price minus the day's change vs prior settle.
    const settle =
        futPrc != null && futureChg != null ? round(futPrc - futureChg, 4) : null;

    // Data rows start after the "Strike,Call,Put,..." header line.
    const headerRowIdx = lines.findIndex((l) => /^strike\s*,/i.test(l));
    const dataLines = headerRowIdx >= 0 ? lines.slice(headerRowIdx + 1) : lines.slice(1);

    const strikes = [];
    for (const line of dataLines) {
        const parts = line.split(',');
        if (parts.length < 3) continue;
        const strike = Number(parts[0]);
        if (!Number.isFinite(strike)) continue;
        strikes.push({
            strike,
            call: toInt(parts[1]),
            put: toInt(parts[2]),
            volSettle: toFloat(parts[3])
        });
    }
    if (!strikes.length) return null;

    return {
        contract: symbolMatch ? symbolMatch[1] : null,
        futPrc,
        futureChg,
        vol: headerNumber(header, 'Vol'),
        dte: dteMatch ? Number(dteMatch[1]) : null,
        settle,
        strikes
    };
}

/**
 * Expected-range bands. `fixRange`, when finite, overrides the computed 1 SD
 * (vol2vol's editable "Fix Range"); 2 SD / 3 SD always recompute as 2× / 3×.
 *
 * @param {{ settle: number|null, vol: number|null, dte: number|null, fixRange?: number|null }} args
 * @returns {null | {
 *   computed1sd: number|null, sd: [number, number, number],
 *   edges: { buy: [number, number, number], sell: [number, number, number] }
 * }}
 */
export function expectedRange({ settle, vol, dte, fixRange = null }) {
    if (settle == null || !Number.isFinite(settle)) return null;

    const computed1sd =
        vol != null && dte != null && vol > 0 && dte > 0
            ? settle * (vol / 100) * Math.sqrt(dte / 365)
            : null;

    const sd1 = Number.isFinite(fixRange) && fixRange > 0 ? fixRange : computed1sd;
    if (sd1 == null || !Number.isFinite(sd1) || sd1 <= 0) {
        return { computed1sd, sd: [0, 0, 0], edges: { buy: [settle, settle, settle], sell: [settle, settle, settle] } };
    }

    const sd = /** @type {[number, number, number]} */ ([sd1, sd1 * 2, sd1 * 3]);
    return {
        computed1sd,
        sd,
        edges: {
            buy: /** @type {[number, number, number]} */ (sd.map((d) => settle - d)),
            sell: /** @type {[number, number, number]} */ (sd.map((d) => settle + d))
        }
    };
}

/**
 * Where the live price sits relative to the settlement, in 1-SD units.
 * @returns {null | { z: number, sign: -1|0|1, band: 0|1|2|3 }}
 */
export function priceSdLocation(price, settle, sd1) {
    if (
        price == null || settle == null || sd1 == null ||
        !Number.isFinite(price) || !Number.isFinite(settle) || !Number.isFinite(sd1) || sd1 <= 0
    ) {
        return null;
    }
    const z = (price - settle) / sd1;
    const sign = z > 0 ? 1 : z < 0 ? -1 : 0;
    const band = /** @type {0|1|2|3} */ (Math.min(3, Math.floor(Math.abs(z))));
    return { z, sign, band };
}

function toInt(v) {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? Math.round(n) : 0;
}
function toFloat(v) {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}
function round(v, d) {
    const f = 10 ** d;
    return Math.round(v * f) / f;
}
