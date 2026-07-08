// Cloudflare Worker entry — serves the static SvelteKit build via the ASSETS
// binding, a same-origin live-price API at /api/price, and a same-origin crypto
// options/futures snapshot at /api/crypto/snapshot. Same origin means the
// browser fetch is never CORS-blocked.
//
// Free on the Workers plan: static-asset requests are free/unlimited; Worker
// invocations hit only API routes and are cached briefly at the edge.

const ALLOWED = new Set(['GC=F', 'NQ=F']);
const RAW_DATA_BASE = 'https://raw.githubusercontent.com/kitkonsss/vacant-exoplanet/main';
const CRYPTO_ASSETS = {
    btc: {
        id: 'btc',
        short: 'BTC',
        okxUly: 'BTC-USD',
        okxSwap: 'BTC-USDT-SWAP',
        bybitBase: 'BTC',
        bybitLinear: 'BTCUSDT',
        deribitCurrency: 'BTC',
        deribitIndex: 'btc_usd',
        strikeWindow: 30000,
    },
    eth: {
        id: 'eth',
        short: 'ETH',
        okxUly: 'ETH-USD',
        okxSwap: 'ETH-USDT-SWAP',
        bybitBase: 'ETH',
        bybitLinear: 'ETHUSDT',
        deribitCurrency: 'ETH',
        deribitIndex: 'eth_usd',
        strikeWindow: 2500,
    },
};
const CRYPTO_VENUES = new Set(['aggregate', 'deribit', 'okx', 'bybit']);
const AGGREGATE_VENUES = ['deribit', 'okx', 'bybit'];
const MS_DAY = 86400000;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// Third Friday of (year, month=1..12) — CME equity-index expiry.
function thirdFriday(year, month) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (5 - first.getUTCDay() + 7) % 7; // days to the first Friday
    return new Date(Date.UTC(year, month - 1, 1 + offset + 14));
}

// Map a front-month symbol to the LEAD (most-active) contract. Yahoo's `=F`
// symbols stay pinned to the expiring front month until last trade — near a
// quarterly expiry `NQ=F` can read ~300 pts below the contract liquidity has
// rolled to. Two roll calendars (mirror of scraper/contract_roll.py):
//   index (NQ): quarterly Mar/Jun/Sep/Dec, roll 8d before the 3rd-Friday expiry.
//   gold (GC):  even months, roll ~6d before the 1st of the delivery month
//               (≈ First Notice Day). Inter-contract spread is tiny so the
//               approximation is harmless.
const ROLL_CFG = {
    'NQ=F': { root: 'NQ', suffix: '.CME', kind: 'index', months: [3, 6, 9, 12], buf: 8 },
    'GC=F': { root: 'GC', suffix: '.CMX', kind: 'gold', months: [2, 4, 6, 8, 10, 12], buf: 6 },
};

function leadSymbol(front) {
    const cfg = ROLL_CFG[front];
    if (!cfg) return front;
    const now = Date.now();
    const y = new Date(now).getUTCFullYear();
    const candidates = [...cfg.months.map((m) => [y, m]), ...cfg.months.map((m) => [y + 1, m])];
    for (const [cy, cm] of candidates) {
        const anchor = cfg.kind === 'gold'
            ? Date.UTC(cy, cm - 1, 1) - cfg.buf * 86400000        // 1st of delivery month - buf
            : thirdFriday(cy, cm).getTime() - cfg.buf * 86400000; // 3rd-Friday expiry - buf
        if (now < anchor) {
            const letter = 'FGHJKMNQUVXZ'[cm - 1];
            const yy = String(cy % 100).padStart(2, '0');
            return `${cfg.root}${letter}${yy}${cfg.suffix}`;
        }
    }
    return front;
}

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json',
            // CF edge + browser coalesce polls -> hit Yahoo ~1x/15s (dodges 429).
            'cache-control': 'public, max-age=15',
        },
    });
}

function cryptoJson(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json',
            'cache-control': status === 200 ? 'public, max-age=5' : 'no-store',
        },
    });
}

async function rawJson(path, { ttl = 30 } = {}) {
    const upstream = await fetch(`${RAW_DATA_BASE}${path}`, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502);
    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${ttl}`,
        },
    });
}

function cleanDataPath(path) {
    const clean = String(path || '').replace(/^\/+/, '');
    if (!clean.startsWith('data/')) return null;
    if (clean.includes('..') || clean.includes('\\')) return null;
    if (!/\.(json|txt|md)$/.test(clean)) return null;
    return clean;
}

async function rawData(request) {
    const url = new URL(request.url);
    const clean = cleanDataPath(url.searchParams.get('path'));
    if (!clean) return json({ error: 'bad data path' }, 400);
    const ttl = clean.endsWith('.json') ? 30 : 60;
    const upstream = await fetch(`${RAW_DATA_BASE}/${clean}`, {
        headers: { accept: clean.endsWith('.json') ? 'application/json' : 'text/plain' },
        cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!upstream.ok) return new Response('', { status: upstream.status, headers: { 'cache-control': 'no-store' } });
    const contentType = clean.endsWith('.json') ? 'application/json' : clean.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': contentType,
            'cache-control': `public, max-age=${ttl}`,
        },
    });
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
    if (!Number.isFinite(v)) return null;
    const f = 10 ** d;
    return Math.round(v * f) / f;
}

function normalizeIv(v) {
    const n = num(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 3 ? n / 100 : n;
}

function median(values) {
    const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
}

function normalCdf(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normalPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function proxyGreeks({ price, strike, expiryMs, iv, type }) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(strike) || strike <= 0 || !Number.isFinite(iv) || iv <= 0) {
        return {};
    }
    const years = Math.max((expiryMs - Date.now()) / MS_DAY / 365, 1 / 365 / 24);
    const sqrtT = Math.sqrt(years);
    const d1 = (Math.log(price / strike) + 0.5 * iv * iv * years) / (iv * sqrtT);
    const d2 = d1 - iv * sqrtT;
    const pdf = normalPdf(d1);
    const call = type === 'C';
    const delta = call ? normalCdf(d1) : normalCdf(d1) - 1;
    const gamma = pdf / (price * iv * sqrtT);
    const vega = price * pdf * sqrtT / 100;
    const theta = -(price * pdf * iv) / (2 * sqrtT * 365);
    return {
        delta,
        gamma,
        vega,
        theta: call ? theta : theta,
        theoreticalProbability: call ? normalCdf(d2) : normalCdf(-d2),
    };
}

function isoDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function expiryLabel(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
    });
}

function okxExpiryMs(yyMMdd) {
    const yy = Number(yyMMdd.slice(0, 2));
    const mm = Number(yyMMdd.slice(2, 4));
    const dd = Number(yyMMdd.slice(4, 6));
    return Date.UTC(2000 + yy, mm - 1, dd, 8, 0, 0);
}

function bybitExpiryMs(day, mon, yy) {
    const month = MONTHS[String(mon || '').toUpperCase()];
    if (month == null) return null;
    return Date.UTC(2000 + Number(yy), month, Number(day), 8, 0, 0);
}

function parseOkxOptionId(instId) {
    const m = String(instId || '').match(/^(BTC|ETH)-USD(?:_[A-Z]+)?-(\d{6})-([0-9.]+)-([CP])$/);
    if (!m) return null;
    const expiryMs = okxExpiryMs(m[2]);
    return {
        key: `${m[1]}-${m[2]}-${m[3]}-${m[4]}`,
        expiryMs,
        expiryCode: m[2],
        strike: Number(m[3]),
        type: m[4],
    };
}

function parseBybitOptionId(symbol) {
    const m = String(symbol || '').match(/^(BTC|ETH)-(\d{2})([A-Z]{3})(\d{2})-([0-9.]+)-([CP])(?:-USDT)?$/);
    if (!m) return null;
    const expiryMs = bybitExpiryMs(m[2], m[3], m[4]);
    if (!expiryMs) return null;
    return {
        key: `${m[1]}-${m[2]}${m[3]}${m[4]}-${m[5]}-${m[6]}`,
        expiryMs,
        expiryCode: `${m[2]}${m[3]}${m[4]}`,
        strike: Number(m[5]),
        type: m[6],
    };
}

function parseDeribitOptionId(instrumentName) {
    const m = String(instrumentName || '').match(/^(BTC|ETH)-(\d{1,2})([A-Z]{3})(\d{2})-([0-9.]+)-([CP])$/);
    if (!m) return null;
    const expiryMs = bybitExpiryMs(m[2].padStart(2, '0'), m[3], m[4]);
    if (!expiryMs) return null;
    return {
        key: `${m[1]}-${m[2].padStart(2, '0')}${m[3]}${m[4]}-${m[5]}-${m[6]}`,
        expiryMs,
        expiryCode: `${m[2].padStart(2, '0')}${m[3]}${m[4]}`,
        strike: Number(m[5]),
        type: m[6],
    };
}

async function fetchOkx(path) {
    const res = await fetch(`https://www.okx.com${path}`, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 5, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`OKX ${res.status}`);
    const j = await res.json();
    if (j?.code !== '0') throw new Error(`OKX ${j?.code || 'error'} ${j?.msg || ''}`.trim());
    return Array.isArray(j.data) ? j.data : [];
}

async function fetchBybit(path) {
    const res = await fetch(`https://api.bybit.com${path}`, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 5, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`Bybit ${res.status}`);
    const j = await res.json();
    if (j?.retCode !== 0) throw new Error(`Bybit ${j?.retCode || 'error'} ${j?.retMsg || ''}`.trim());
    return Array.isArray(j?.result?.list) ? j.result.list : [];
}

async function fetchDeribit(path) {
    const res = await fetch(`https://www.deribit.com${path}`, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 5, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`Deribit ${res.status}`);
    const j = await res.json();
    if (j?.error) throw new Error(`Deribit ${j.error?.code || 'error'} ${j.error?.message || ''}`.trim());
    return j?.result;
}

function optionRowsFromOkx(summaryRows, oiRows, nowMs) {
    const oiByKey = new Map();
    for (const row of oiRows || []) {
        const parsed = parseOkxOptionId(row.instId);
        if (!parsed) continue;
        oiByKey.set(parsed.key, {
            oi: num(row.oi) ?? 0,
            oiCcy: num(row.oiCcy),
            oiUsd: num(row.oiUsd),
        });
    }

    const out = [];
    for (const row of summaryRows || []) {
        const parsed = parseOkxOptionId(row.instId);
        if (!parsed || parsed.expiryMs <= nowMs || !Number.isFinite(parsed.strike)) continue;
        const oi = oiByKey.get(parsed.key) || {};
        const openInterest = oi.oiCcy ?? oi.oi ?? 0;
        out.push({
            provider: 'okx',
            venue: 'okx',
            symbol: row.instId,
            expiryMs: parsed.expiryMs,
            expiryCode: parsed.expiryCode,
            strike: parsed.strike,
            type: parsed.type,
            markIv: normalizeIv(row.markVol) ?? normalizeIv(row.volLv),
            bidIv: normalizeIv(row.bidVol),
            askIv: normalizeIv(row.askVol),
            delta: num(row.delta),
            gamma: num(row.gamma),
            vega: num(row.vega),
            theta: num(row.theta),
            fwdPx: num(row.fwdPx),
            openInterest,
            openInterestRaw: oi.oi ?? 0,
            openInterestUsd: oi.oiUsd ?? (num(row.fwdPx) && openInterest ? num(row.fwdPx) * openInterest : null),
            volume24h: 0,
            volumeUsd: null,
        });
    }
    return out;
}

function optionRowsFromBybit(tickerRows, nowMs) {
    const out = [];
    for (const row of tickerRows || []) {
        const parsed = parseBybitOptionId(row.symbol);
        if (!parsed || parsed.expiryMs <= nowMs || !Number.isFinite(parsed.strike)) continue;
        const price = num(row.underlyingPrice) ?? num(row.indexPrice);
        const openInterest = num(row.openInterest) ?? 0;
        out.push({
            provider: 'bybit',
            venue: 'bybit',
            symbol: row.symbol,
            expiryMs: parsed.expiryMs,
            expiryCode: parsed.expiryCode,
            strike: parsed.strike,
            type: parsed.type,
            markIv: normalizeIv(row.markIv),
            bidIv: normalizeIv(row.bid1Iv),
            askIv: normalizeIv(row.ask1Iv),
            delta: num(row.delta),
            gamma: num(row.gamma),
            vega: num(row.vega),
            theta: num(row.theta),
            fwdPx: price,
            openInterest,
            openInterestRaw: openInterest,
            openInterestUsd: price && openInterest ? price * openInterest : null,
            volume24h: num(row.volume24h) ?? num(row.totalVolume) ?? 0,
            volumeUsd: num(row.turnover24h) ?? num(row.totalTurnover),
        });
    }
    return out;
}

function optionRowsFromDeribit(summaryRows, indexPrice, nowMs) {
    const out = [];
    for (const row of summaryRows || []) {
        const parsed = parseDeribitOptionId(row.instrument_name);
        if (!parsed || parsed.expiryMs <= nowMs || !Number.isFinite(parsed.strike)) continue;
        const fwdPx = num(row.underlying_price) ?? num(row.estimated_delivery_price) ?? indexPrice;
        const markIv = normalizeIv(row.mark_iv);
        const greeks = proxyGreeks({
            price: fwdPx ?? indexPrice,
            strike: parsed.strike,
            expiryMs: parsed.expiryMs,
            iv: markIv,
            type: parsed.type,
        });
        const openInterest = num(row.open_interest) ?? 0;
        out.push({
            provider: 'deribit',
            venue: 'deribit',
            symbol: row.instrument_name,
            expiryMs: parsed.expiryMs,
            expiryCode: parsed.expiryCode,
            strike: parsed.strike,
            type: parsed.type,
            markIv,
            bidIv: null,
            askIv: null,
            delta: greeks.delta ?? null,
            gamma: greeks.gamma ?? null,
            vega: greeks.vega ?? null,
            theta: greeks.theta ?? null,
            fwdPx,
            openInterest,
            openInterestRaw: openInterest,
            openInterestUsd: indexPrice && openInterest ? indexPrice * openInterest : null,
            volume24h: num(row.volume) ?? 0,
            volumeUsd: num(row.volume_usd),
        });
    }
    return out;
}

function aggregateExpiry(rows, price, cfg, contractKey) {
    const byStrike = new Map();
    for (const r of rows) {
        if (Math.abs(r.strike - price) > cfg.strikeWindow) continue;
        const item = byStrike.get(r.strike) || {
            strike: r.strike,
            call_oi: 0,
            put_oi: 0,
            call_volume: 0,
            put_volume: 0,
            call_iv_sum: 0,
            call_iv_weight: 0,
            put_iv_sum: 0,
            put_iv_weight: 0,
            call_gamma: 0,
            put_gamma: 0,
            venue_oi: {},
        };
        const oi = Math.max(0, r.openInterest || 0);
        const vol = Math.max(0, r.volume24h || 0);
        const gamma1pct = Math.abs(r.gamma || 0) * price * 0.01 * oi;
        const venue = r.venue || r.provider || 'unknown';
        item.venue_oi[venue] = (item.venue_oi[venue] || 0) + oi;
        if (r.type === 'C') {
            item.call_oi += oi;
            item.call_volume += vol;
            item.call_gamma += gamma1pct;
            if (r.markIv && oi > 0) {
                item.call_iv_sum += r.markIv * oi;
                item.call_iv_weight += oi;
            }
        } else {
            item.put_oi += oi;
            item.put_volume += vol;
            item.put_gamma += gamma1pct;
            if (r.markIv && oi > 0) {
                item.put_iv_sum += r.markIv * oi;
                item.put_iv_weight += oi;
            }
        }
        byStrike.set(r.strike, item);
    }

    const positionMap = [...byStrike.values()]
        .map((x) => {
            const totalOi = x.call_oi + x.put_oi;
            const totalVol = x.call_volume + x.put_volume;
            let side = 'mixed';
            if (x.call_oi >= x.put_oi * 1.2 && x.call_oi > 0) side = 'call_wall';
            else if (x.put_oi >= x.call_oi * 1.2 && x.put_oi > 0) side = 'put_wall';
            return {
                strike: x.strike,
                side,
                total_oi: round(totalOi, 4),
                call_oi: round(x.call_oi, 4),
                put_oi: round(x.put_oi, 4),
                call_volume: round(x.call_volume, 4),
                put_volume: round(x.put_volume, 4),
                activity_vs_oi: totalOi > 0 ? round(totalVol / totalOi, 4) : null,
                call_iv: x.call_iv_weight ? round(x.call_iv_sum / x.call_iv_weight, 5) : null,
                put_iv: x.put_iv_weight ? round(x.put_iv_sum / x.put_iv_weight, 5) : null,
                gamma_1pct: round(x.call_gamma + x.put_gamma, 4),
                venues: Object.fromEntries(Object.entries(x.venue_oi).map(([venue, value]) => [venue, round(value, 4)])),
            };
        })
        .filter((x) => x.total_oi > 0 || x.call_volume > 0 || x.put_volume > 0)
        .sort((a, b) => a.strike - b.strike);

    const totals = positionMap.reduce((acc, x) => {
        acc.call_oi += x.call_oi || 0;
        acc.put_oi += x.put_oi || 0;
        acc.open_interest += x.total_oi || 0;
        acc.call_volume += x.call_volume || 0;
        acc.put_volume += x.put_volume || 0;
        return acc;
    }, { call_oi: 0, put_oi: 0, open_interest: 0, call_volume: 0, put_volume: 0 });
    totals.oi_put_call_ratio = totals.call_oi > 0 ? round(totals.put_oi / totals.call_oi, 3) : null;
    totals.volume_vs_oi = totals.open_interest > 0 ? round((totals.call_volume + totals.put_volume) / totals.open_interest, 4) : null;

    const support = positionMap.filter((x) => x.strike < price).reduce((s, x) => s + (x.put_oi || 0), 0);
    const resistance = positionMap.filter((x) => x.strike > price).reduce((s, x) => s + (x.call_oi || 0), 0);
    const denom = support + resistance || 1;
    const score = round(((support - resistance) / denom) * 40, 1);
    const label = score >= 12 ? 'lean_bullish' : score <= -12 ? 'lean_bearish' : 'neutral';

    const dte = Math.max(0, (rows[0].expiryMs - Date.now()) / MS_DAY);
    return {
        contract_key: contractKey,
        contract: `${cfg.short} ${expiryLabel(rows[0].expiryMs)}`,
        expiration: isoDate(rows[0].expiryMs),
        dte: round(dte, 2),
        dte_raw: round(dte, 6),
        future_price: price,
        confidence: 'live',
        position_bias: { label, score },
        totals,
        position_map: positionMap,
    };
}

function chooseBuckets(rows) {
    const expiries = [...new Set(rows.map((r) => r.expiryMs))].sort((a, b) => a - b);
    const picked = new Map();
    const use = (key, expiry) => {
        if (expiry && ![...picked.values()].includes(expiry)) picked.set(key, expiry);
    };
    use('current', expiries[0]);
    use('tomorrow', expiries[1]);
    use('friday', expiries.find((ms) => new Date(ms).getUTCDay() === 5 && ![...picked.values()].includes(ms)));
    use('monthly', expiries.find((ms) => (ms - Date.now()) / MS_DAY >= 21 && ![...picked.values()].includes(ms)) || expiries[expiries.length - 1]);
    return picked;
}

function dteForMath(contract) {
    return Number.isFinite(contract?.dte_raw) ? contract.dte_raw : contract?.dte;
}

function ivPoints(positionMap, type) {
    return (positionMap || [])
        .map((row) => ({
            strike: row.strike,
            iv: type === 'put' ? row.put_iv : row.call_iv,
        }))
        .filter((row) => Number.isFinite(row.strike) && Number.isFinite(row.iv) && row.iv > 0)
        .sort((a, b) => a.strike - b.strike);
}

function interpolatedIv(positionMap, type, strikeTarget) {
    if (!Number.isFinite(strikeTarget)) return null;
    const points = ivPoints(positionMap, type);
    if (!points.length) return null;
    if (points.length === 1 || strikeTarget <= points[0].strike) return points[0].iv;
    const last = points[points.length - 1];
    if (strikeTarget >= last.strike) return last.iv;
    for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (a.strike <= strikeTarget && strikeTarget <= b.strike) {
            const t = b.strike > a.strike ? (strikeTarget - a.strike) / (b.strike - a.strike) : 0;
            return a.iv + (b.iv - a.iv) * t;
        }
    }
    return null;
}

function averageFinite(values) {
    const xs = values.filter(Number.isFinite);
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

function atmIv(positionMap, price) {
    return averageFinite([
        interpolatedIv(positionMap, 'call', price),
        interpolatedIv(positionMap, 'put', price),
    ]);
}

function oneDayBasisTenor(tenors) {
    const targetDays = 1;
    return [...tenors]
        .filter((t) => Number.isFinite(t.atm_iv) && t.atm_iv > 0 && Number.isFinite(dteForMath(t)) && dteForMath(t) > 0)
        .sort((a, b) => {
            const ad = dteForMath(a);
            const bd = dteForMath(b);
            const diff = Math.abs(ad - targetDays) - Math.abs(bd - targetDays);
            if (diff !== 0) return diff;
            return Number(bd >= targetDays) - Number(ad >= targetDays);
        })[0] || null;
}

function buildExpectedRange(contracts, price) {
    const tenors = [];
    for (const c of contracts) {
        const iv = atmIv(c.position_map, price);
        const dte = dteForMath(c);
        if (!Number.isFinite(iv) || iv <= 0 || !Number.isFinite(dte) || dte <= 0) continue;
        const move = price * iv * Math.sqrt(dte / 365);
        const bands = {};
        for (const k of [1, 2, 3]) {
            bands[`plus${k}`] = round(price + k * move, 2);
            bands[`minus${k}`] = round(price - k * move, 2);
        }
        tenors.push({
            contract_key: c.contract_key,
            symbol: c.contract,
            expiration: c.expiration,
            dte: c.dte,
            future_price: price,
            atm_iv: round(iv, 5),
            atm_iv_pct: round(iv * 100, 2),
            expected_move_to_expiry: round(move, 2),
            bands_to_expiry: bands,
        });
    }
    if (!tenors.length) return null;
    const short = tenors[0];
    const long = tenors[tenors.length - 1];
    const basis = oneDayBasisTenor(tenors) || short;
    const horizonDays = 1;
    const expectedMove = price * basis.atm_iv * Math.sqrt(horizonDays / 365);
    const slope = round((short.atm_iv - long.atm_iv) * 100, 2);
    const shape = slope > 2 ? 'inverted (front crypto vol premium)' : slope < -2 ? 'contango (risk priced later)' : 'flat';

    const basisContract = contracts.find((c) => c.contract_key === basis.contract_key) || contracts[0];
    const putIv = interpolatedIv(basisContract.position_map, 'put', price * 0.98);
    const callIv = interpolatedIv(basisContract.position_map, 'call', price * 1.02);
    const putSkew = putIv && basis.atm_iv ? round((putIv - basis.atm_iv) * 100, 2) : null;
    const callSkew = callIv && basis.atm_iv ? round((callIv - basis.atm_iv) * 100, 2) : null;
    const skewRead = putSkew != null && callSkew != null
        ? putSkew - callSkew > 1 ? 'put_skew_dominant (downside fear priced in)'
            : callSkew - putSkew > 1 ? 'call_skew_dominant (upside chase priced in)'
                : 'balanced'
        : 'unknown';

    const bands1d = {};
    for (const k of [1, 2, 3]) {
        bands1d[`plus${k}`] = round(price + k * expectedMove, 2);
        bands1d[`minus${k}`] = round(price - k * expectedMove, 2);
    }

    return {
        method: 'Realtime crypto ATM IV interpolated from public exchange option chain; 1d move = F x IV x sqrt(1/365)',
        expected_move: round(expectedMove, 2),
        expected_move_1d: round(expectedMove, 2),
        day_high_est: round(price + expectedMove, 2),
        day_low_est: round(price - expectedMove, 2),
        atm_iv_pct: basis.atm_iv_pct,
        atm_iv_pct_1d_basis: basis.atm_iv_pct,
        iv_basis_tenor: { contract_key: basis.contract_key, symbol: basis.symbol, dte: basis.dte },
        basis_tenor: { contract_key: basis.contract_key, symbol: basis.symbol, dte: basis.dte },
        horizon_days: horizonDays,
        bands_1d: bands1d,
        term_structure: {
            slope_volpts_short_minus_monthly: slope,
            shape,
            short_tenor: short.symbol,
            long_tenor: long.symbol,
        },
        skew: {
            measured_at_pct: 2,
            put_skew_volpts: putSkew,
            call_skew_volpts: callSkew,
            read: skewRead,
        },
        tenors,
    };
}

function buildHeatmaps(contracts, price, generatedAt, cfg, provider = 'crypto') {
    const heatmaps = {};
    const gammaHeatmaps = {};
    const oiData = {};
    for (const c of contracts) {
        const visibleRows = [...(c.position_map || [])].sort((a, b) => b.strike - a.strike);
        const contractAtmIv = atmIv(c.position_map, price);
        heatmaps[c.contract_key] = {
            asset: cfg.id,
            provider,
            generated_at: generatedAt,
            contract: c.contract,
            underlying: price,
            dates: ['Live'],
            strikes: visibleRows.map((r) => ({ strike: r.strike, values: [round(r.total_oi || 0, 4)] })),
        };
        gammaHeatmaps[c.contract_key] = {
            asset: cfg.id,
            provider,
            generated_at: generatedAt,
            contract: c.contract,
            underlying: price,
            dates: ['Live'],
            strikes: visibleRows.map((r) => ({ strike: r.strike, values: [round(r.gamma_1pct || 0, 4)] })),
        };
        oiData[c.contract_key] = {
            contract: c.contract,
            futPrc: price,
            futureChg: 0,
            vol: Number.isFinite(contractAtmIv) ? round(contractAtmIv * 100, 2) : null,
            dte: dteForMath(c),
            settle: price,
            strikes: c.position_map.map((r) => {
                const ivCount = (r.call_iv ? 1 : 0) + (r.put_iv ? 1 : 0);
                return {
                    strike: r.strike,
                    call: r.call_oi || 0,
                    put: r.put_oi || 0,
                    volSettle: ivCount ? ((r.call_iv || 0) + (r.put_iv || 0)) / ivCount : 0,
                };
            }),
        };
    }
    return { heatmaps, gammaHeatmaps, oiData };
}

function buildGammaSummary(contracts, price) {
    const walls = [];
    for (const c of contracts) {
        for (const r of c.position_map || []) {
            if ((r.gamma_1pct || 0) > 0) {
                walls.push({
                    contract: c.contract_key,
                    contract_key: c.contract_key,
                    strike: r.strike,
                    gamma_1pct: r.gamma_1pct,
                    side: r.strike >= price ? 'above' : 'below',
                    distance_points: round(r.strike - price, 2),
                });
            }
        }
    }
    walls.sort((a, b) => (b.gamma_1pct || 0) - (a.gamma_1pct || 0));
    const top = walls.slice(0, 12);
    const upside = top.filter((w) => w.strike > price);
    const downside = top.filter((w) => w.strike < price);
    return {
        significant_floor: top[0] ? round(top[0].gamma_1pct * 0.25, 4) : 0,
        top_walls: top,
        significant_walls: top,
        nearest_upside_wall: [...upside].sort((a, b) => a.strike - b.strike)[0] || null,
        nearest_downside_wall: [...downside].sort((a, b) => b.strike - a.strike)[0] || null,
        major_upside_wall: [...upside].sort((a, b) => (b.gamma_1pct || 0) - (a.gamma_1pct || 0))[0] || null,
        major_downside_wall: [...downside].sort((a, b) => (b.gamma_1pct || 0) - (a.gamma_1pct || 0))[0] || null,
    };
}

function buildStrategy({ cfg, price, generatedAt, contracts, expectedRange, funding, swapOi, provider, providerLabel, venueBreakdown, venueErrors }) {
    const primary = contracts[0];
    const support = primary?.position_map?.filter((x) => x.strike < price).reduce((s, x) => s + (x.put_oi || 0), 0) || 0;
    const resistance = primary?.position_map?.filter((x) => x.strike > price).reduce((s, x) => s + (x.call_oi || 0), 0) || 0;
    const denom = support + resistance || 1;
    const wallScore = ((support - resistance) / denom) * 50;
    const fundingRate = funding?.fundingRate ?? null;
    const fundingScore = Number.isFinite(fundingRate) ? Math.max(-15, Math.min(15, -fundingRate * 100000)) : 0;
    const score = round(wallScore + fundingScore, 1);
    const label = score >= 20 ? 'bullish' : score >= 8 ? 'lean_bullish' : score <= -20 ? 'bearish' : score <= -8 ? 'lean_bearish' : 'neutral';
    const gamma = buildGammaSummary(contracts, price);
    const confluenceLevels = [...(primary?.position_map || [])]
        .sort((a, b) => (b.total_oi || 0) - (a.total_oi || 0))
        .slice(0, 10)
        .map((r) => ({
            level: r.strike,
            confluence: 2 + ((r.gamma_1pct || 0) > 0 ? 1 : 0),
            sources: ['crypto_options_oi', (r.gamma_1pct || 0) > 0 ? 'gamma_proxy' : 'oi_wall'].filter(Boolean),
            distance_points: round(r.strike - price, 2),
        }));
    return {
        version: 2,
        asset: cfg.short,
        generated_at: generatedAt,
        future_price: price,
        source: 'crypto_realtime',
        provider,
        provider_label: providerLabel || provider,
        directional_bias: { label, score, confidence: 'medium' },
        components: {
            positioning: { score: round(wallScore, 1), label, weight: 0.75 },
            futures: {
                score: round(fundingScore, 1),
                label: fundingRate > 0.0001 ? 'crowded_long' : fundingRate < -0.0001 ? 'crowded_short' : 'neutral',
                weight: 0.25,
                funding_rate: fundingRate,
                open_interest_usd: swapOi?.oiUsd ?? null,
            },
        },
        agreement: { bullish_layers: score > 0 ? 2 : 0, bearish_layers: score < 0 ? 2 : 0, aligned: Math.abs(score) >= 8 ? 2 : 0, total: 2 },
        regime: {
            regime: expectedRange?.term_structure?.shape?.startsWith('inverted') || Math.abs(fundingRate || 0) > 0.00015 ? 'trending' : 'range',
            score: expectedRange?.term_structure?.shape?.startsWith('inverted') ? 2 : 0,
            reasons: [
                expectedRange?.term_structure?.shape,
                fundingRate != null ? `funding ${(fundingRate * 100).toFixed(4)}%` : null,
            ].filter(Boolean),
            lead_playbook: 'crypto_options',
        },
        expected_range: expectedRange,
        option_flow: {
            generated_at: generatedAt,
            method: 'Realtime option chain snapshot. No historical delta storage in v1.',
            imbalance_1h: null,
            flow_magnet_1h: null,
            wall_activity_1h: [],
        },
        futures: { funding, open_interest: swapOi },
        confluence_levels: confluenceLevels,
        gamma_1pct: gamma,
        data_freshness: {
            source: 'exchange_public_api',
            provider,
            provider_label: providerLabel || provider,
            venues: venueBreakdown || null,
            venue_errors: venueErrors || [],
            updated: generatedAt,
        },
    };
}

function providerLabel(provider, venueBreakdown) {
    if (provider !== 'aggregate') return provider.toUpperCase();
    const names = { deribit: 'Deribit', okx: 'OKX', bybit: 'Bybit' };
    const active = Object.entries(venueBreakdown || {})
        .filter(([, meta]) => meta?.ok)
        .map(([venue]) => names[venue] || venue.toUpperCase());
    return `Aggregate: ${active.join(' + ') || 'No venues'}`;
}

function summarizeVenueRows(rows, price) {
    const totals = rows.reduce((acc, row) => {
        acc.option_rows += 1;
        acc.option_open_interest += row.openInterest || 0;
        acc.option_open_interest_usd += row.openInterestUsd || ((row.openInterest || 0) * price);
        acc.option_volume += row.volume24h || 0;
        acc.option_volume_usd += row.volumeUsd || 0;
        return acc;
    }, { option_rows: 0, option_open_interest: 0, option_open_interest_usd: 0, option_volume: 0, option_volume_usd: 0 });
    return {
        option_rows: totals.option_rows,
        option_open_interest: round(totals.option_open_interest, 4),
        option_open_interest_usd: round(totals.option_open_interest_usd, 2),
        option_volume_24h: round(totals.option_volume, 4),
        option_volume_usd_24h: round(totals.option_volume_usd, 2),
    };
}

function buildVenueBreakdown(venueData, venueErrors = []) {
    const out = {};
    for (const data of venueData || []) {
        out[data.venue] = {
            ok: true,
            price: round(data.price, 2),
            ...summarizeVenueRows(data.rows || [], data.price),
            futures_open_interest_usd: round(data.swapOi?.oiUsd ?? null, 2),
            funding_rate: data.funding?.fundingRate ?? null,
        };
    }
    for (const err of venueErrors || []) {
        if (!out[err.venue]) out[err.venue] = { ok: false, error: err.error };
    }
    return out;
}

function aggregateFunding(venueData) {
    let weight = 0;
    let funding = 0;
    let premium = 0;
    let premiumWeight = 0;
    let nextFundingTime = null;
    const venues = {};
    for (const data of venueData || []) {
        const rate = data.funding?.fundingRate;
        const oiUsd = data.swapOi?.oiUsd;
        if (Number.isFinite(rate) && Number.isFinite(oiUsd) && oiUsd > 0) {
            funding += rate * oiUsd;
            weight += oiUsd;
        }
        if (Number.isFinite(data.funding?.premium) && Number.isFinite(oiUsd) && oiUsd > 0) {
            premium += data.funding.premium * oiUsd;
            premiumWeight += oiUsd;
        }
        if (Number.isFinite(data.funding?.nextFundingTime)) {
            nextFundingTime = nextFundingTime == null ? data.funding.nextFundingTime : Math.min(nextFundingTime, data.funding.nextFundingTime);
        }
        if (data.funding) venues[data.venue] = data.funding;
    }
    return {
        fundingRate: weight ? funding / weight : null,
        nextFundingTime,
        premium: premiumWeight ? premium / premiumWeight : null,
        venues,
        method: 'OI USD weighted across venues with futures/perp funding',
    };
}

function aggregateSwapOi(venueData) {
    const venues = {};
    let oi = 0;
    let oiCcy = 0;
    let oiUsd = 0;
    for (const data of venueData || []) {
        if (!data.swapOi) continue;
        venues[data.venue] = data.swapOi;
        oi += data.swapOi.oi || 0;
        oiCcy += data.swapOi.oiCcy || data.swapOi.oi || 0;
        oiUsd += data.swapOi.oiUsd || 0;
    }
    return {
        oi: oi ? round(oi, 4) : null,
        oiCcy: oiCcy ? round(oiCcy, 4) : null,
        oiUsd: oiUsd ? round(oiUsd, 2) : null,
        venues,
        method: 'Sum of OKX + Bybit linear/swap open interest; Deribit excluded from perp funding aggregate',
    };
}

function snapshotFromRows({ cfg, provider, rows, price, funding, swapOi, generatedAt, venueBreakdown = {}, venueErrors = [] }) {
    const buckets = chooseBuckets(rows);
    const contracts = [];
    for (const [key, expiryMs] of buckets.entries()) {
        const expiryRows = rows.filter((r) => r.expiryMs === expiryMs);
        if (expiryRows.length) contracts.push(aggregateExpiry(expiryRows, price, cfg, key));
    }
    const expectedRange = buildExpectedRange(contracts, price);
    const { heatmaps, gammaHeatmaps, oiData } = buildHeatmaps(contracts, price, generatedAt, cfg, provider);
    const label = providerLabel(provider, venueBreakdown);
    const strategy = buildStrategy({
        cfg,
        price,
        generatedAt,
        contracts,
        expectedRange,
        funding,
        swapOi,
        provider,
        providerLabel: label,
        venueBreakdown,
        venueErrors,
    });
    return {
        asset: cfg.id,
        asset_label: `${cfg.short} Crypto Options`,
        source: 'crypto_realtime',
        provider,
        provider_label: label,
        venues: venueBreakdown,
        venue_errors: venueErrors,
        generated_at: generatedAt,
        live_price: {
            sym: provider === 'aggregate' ? `${cfg.short}-AGG` : provider === 'okx' ? cfg.okxSwap : provider === 'bybit' ? cfg.bybitLinear : `${cfg.short}-DERIBIT`,
            price,
            time: Math.floor(Date.parse(generatedAt) / 1000),
            exch: provider === 'aggregate' ? 'AGGREGATE' : provider.toUpperCase(),
        },
        future_price: price,
        contracts,
        expected_range: expectedRange,
        heatmaps,
        gamma_heatmaps: gammaHeatmaps,
        oi_data: oiData,
        strategy,
        futures: { funding, open_interest: swapOi },
    };
}

function snapshotHasOi(snapshot) {
    return (snapshot?.contracts || []).some((c) => (c?.totals?.open_interest || 0) > 0);
}

async function buildOkxVenueData(cfg, nowMs) {
    const [tickerRows, swapOiRows, fundingRows, summaryRows, optionOiRows] = await Promise.all([
        fetchOkx(`/api/v5/market/ticker?instId=${encodeURIComponent(cfg.okxSwap)}`),
        fetchOkx(`/api/v5/public/open-interest?instType=SWAP&instId=${encodeURIComponent(cfg.okxSwap)}`),
        fetchOkx(`/api/v5/public/funding-rate?instId=${encodeURIComponent(cfg.okxSwap)}`),
        fetchOkx(`/api/v5/public/opt-summary?uly=${encodeURIComponent(cfg.okxUly)}`),
        fetchOkx(`/api/v5/public/open-interest?instType=OPTION&uly=${encodeURIComponent(cfg.okxUly)}`),
    ]);
    const price = num(tickerRows[0]?.last) ?? num(summaryRows[0]?.fwdPx);
    if (!price) throw new Error('OKX missing price');
    const rows = optionRowsFromOkx(summaryRows, optionOiRows, nowMs);
    if (!rows.length) throw new Error('OKX missing option rows');
    return {
        venue: 'okx',
        rows,
        price,
        funding: {
            fundingRate: num(fundingRows[0]?.fundingRate),
            nextFundingTime: num(fundingRows[0]?.nextFundingTime),
            premium: num(fundingRows[0]?.premium),
        },
        swapOi: {
            oi: num(swapOiRows[0]?.oi),
            oiCcy: num(swapOiRows[0]?.oiCcy),
            oiUsd: num(swapOiRows[0]?.oiUsd),
        },
    };
}

async function buildBybitVenueData(cfg, nowMs) {
    const [linearRows, optionRowsRaw] = await Promise.all([
        fetchBybit(`/v5/market/tickers?category=linear&symbol=${encodeURIComponent(cfg.bybitLinear)}`),
        fetchBybit(`/v5/market/tickers?category=option&baseCoin=${encodeURIComponent(cfg.bybitBase)}`),
    ]);
    const linear = linearRows[0] || {};
    const rows = optionRowsFromBybit(optionRowsRaw, nowMs);
    const price = num(linear.lastPrice) ?? rows.find((r) => r.fwdPx)?.fwdPx;
    if (!price) throw new Error('Bybit missing price');
    if (!rows.length) throw new Error('Bybit missing option rows');
    return {
        venue: 'bybit',
        rows,
        price,
        funding: {
            fundingRate: num(linear.fundingRate),
            nextFundingTime: num(linear.nextFundingTime),
            premium: null,
        },
        swapOi: {
            oi: num(linear.openInterest),
            oiCcy: num(linear.openInterest),
            oiUsd: num(linear.openInterestValue),
        },
    };
}

async function buildDeribitVenueData(cfg, nowMs) {
    const [summaryRows, indexResult] = await Promise.all([
        fetchDeribit(`/api/v2/public/get_book_summary_by_currency?currency=${encodeURIComponent(cfg.deribitCurrency)}&kind=option`),
        fetchDeribit(`/api/v2/public/get_index_price?index_name=${encodeURIComponent(cfg.deribitIndex)}`),
    ]);
    const indexPrice = num(indexResult?.index_price) ?? num(indexResult?.estimated_delivery_price);
    const rows = optionRowsFromDeribit(Array.isArray(summaryRows) ? summaryRows : [], indexPrice, nowMs);
    const price = indexPrice ?? median(rows.map((r) => r.fwdPx));
    if (!price) throw new Error('Deribit missing price');
    if (!rows.length) throw new Error('Deribit missing option rows');
    return {
        venue: 'deribit',
        rows,
        price,
        funding: null,
        swapOi: null,
    };
}

async function buildVenueData(cfg, venue, nowMs) {
    if (venue === 'deribit') return buildDeribitVenueData(cfg, nowMs);
    if (venue === 'okx') return buildOkxVenueData(cfg, nowMs);
    if (venue === 'bybit') return buildBybitVenueData(cfg, nowMs);
    throw new Error(`Unsupported venue ${venue}`);
}

async function buildSingleVenueSnapshot(cfg, venue, generatedAt, nowMs) {
    const data = await buildVenueData(cfg, venue, nowMs);
    const venueBreakdown = buildVenueBreakdown([data]);
    const snapshot = snapshotFromRows({
        cfg,
        provider: venue,
        rows: data.rows,
        price: data.price,
        funding: data.funding,
        swapOi: data.swapOi,
        generatedAt,
        venueBreakdown,
    });
    if (!snapshotHasOi(snapshot)) throw new Error(`${venue} returned no usable option OI`);
    return snapshot;
}

async function buildAggregateCryptoSnapshot(cfg, generatedAt, nowMs) {
    const settled = await Promise.all(AGGREGATE_VENUES.map(async (venue) => {
        try {
            const data = await buildVenueData(cfg, venue, nowMs);
            if (!data.rows.some((row) => (row.openInterest || 0) > 0)) {
                throw new Error(`${venue} returned no usable option OI`);
            }
            return { ok: true, data };
        } catch (e) {
            return { ok: false, venue, error: String(e?.message || e) };
        }
    }));
    const venueData = settled.filter((x) => x.ok).map((x) => x.data);
    const venueErrors = settled.filter((x) => !x.ok).map(({ venue, error }) => ({ venue, error }));
    if (!venueData.length) {
        throw Object.assign(new Error('All crypto venues failed'), { venueErrors });
    }

    const price = median(venueData.map((data) => data.price));
    const rows = venueData.flatMap((data) => data.rows);
    const venueBreakdown = buildVenueBreakdown(venueData, venueErrors);
    const snapshot = snapshotFromRows({
        cfg,
        provider: 'aggregate',
        rows,
        price,
        funding: aggregateFunding(venueData),
        swapOi: aggregateSwapOi(venueData),
        generatedAt,
        venueBreakdown,
        venueErrors,
    });
    if (!snapshotHasOi(snapshot)) {
        throw Object.assign(new Error('Aggregate returned no usable option OI'), { venueErrors });
    }
    return snapshot;
}

async function cryptoSnapshot(request) {
    const url = new URL(request.url);
    const asset = (url.searchParams.get('asset') || '').toLowerCase();
    const venue = (url.searchParams.get('venue') || 'aggregate').toLowerCase();
    const cfg = CRYPTO_ASSETS[asset];
    if (!cfg) return cryptoJson({ error: 'bad asset', allowed: Object.keys(CRYPTO_ASSETS) }, 400);
    if (!CRYPTO_VENUES.has(venue)) return cryptoJson({ error: 'bad venue', allowed: [...CRYPTO_VENUES] }, 400);

    const nowMs = Date.now();
    const generatedAt = new Date(nowMs).toISOString();
    try {
        const snapshot = venue === 'aggregate'
            ? await buildAggregateCryptoSnapshot(cfg, generatedAt, nowMs)
            : await buildSingleVenueSnapshot(cfg, venue, generatedAt, nowMs);
        return cryptoJson(snapshot);
    } catch (e) {
        const venueErrors = e?.venueErrors || [{ venue, error: String(e?.message || e) }];
        return cryptoJson({ error: 'provider failure', asset, venue, venue_errors: venueErrors }, 502);
    }
}

async function price(request) {
    const sym = new URL(request.url).searchParams.get('sym') || 'GC=F';
    if (!ALLOWED.has(sym)) return json({ error: 'bad sym' }, 400);
    // Resolve the requested front-month token to the lead contract liquidity
    // has rolled to, so the live marker matches what traders are watching.
    const target = leadSymbol(sym);
    try {
        const upstream = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target)}?interval=1d&range=1d`,
            {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                cf: { cacheTtl: 15, cacheEverything: true },
            }
        );
        if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502);
        const j = await upstream.json();
        const m = j?.chart?.result?.[0]?.meta || {};
        return json({
            sym: target,        // the lead contract actually quoted
            front: sym,         // the front-month token requested
            price: m.regularMarketPrice ?? null,
            time: m.regularMarketTime ?? null,
            exch: m.fullExchangeName ?? null,
        });
    } catch (e) {
        return json({ error: String(e) }, 502);
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/api/price') return price(request);
        if (url.pathname === '/api/crypto/snapshot') return cryptoSnapshot(request);
        if (url.pathname === '/api/bias-history') return rawJson('/data/bias_snapshots/bias_history.json');
        if (url.pathname === '/api/data') return rawData(request);
        // Everything else: serve the static SvelteKit build.
        return env.ASSETS.fetch(request);
    },
};
