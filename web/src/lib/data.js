import { ASSET_PROFILES, CONTRACT_OPTIONS, biasHistoryApiUrl, biasHistoryUrl, briefUrl, cotUrl, cryptoSnapshotUrl, econCalendarUrl, expectedRangeUrl, gammaHeatmapUrl, heatmapUrl, isCryptoAsset, ivBaselineUrl, macroUrl, oiDataUrl, optionFlowUrl, positionBiasUrl, signalLogUrl, signalScorecardUrl, strategyUrl, wallBacktestUrl } from './config.js';
import { parseOIData } from './vol2vol.js';

const CRYPTO_SNAPSHOT_TTL_MS = 4000;
const SOFT_FETCH_RETRY_MS = 250;
/** @type {Map<string, {ts: number, data: any, pending?: Promise<any>}>} */
const cryptoSnapshotCache = new Map();

function cacheBust(url) {
    return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonSoft(url, { retries = 1, cacheBustUrl = true } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const res = await fetch(cacheBustUrl ? cacheBust(url) : url, { cache: cacheBustUrl ? 'no-store' : 'default' });
            if (res.ok) return await res.json();
            lastError = new Error(`HTTP ${res.status}`);
        } catch (e) {
            lastError = e;
        }

        if (attempt < retries) {
            await delay(SOFT_FETCH_RETRY_MS * (attempt + 1));
        }
    }

    console.warn(`fetch failed: ${url}`, lastError);
    return null;
}

async function fetchTextSoft(url) {
    try {
        const res = await fetch(cacheBust(url));
        if (!res.ok) return null;
        return await res.text();
    } catch (e) {
        console.warn(`fetch failed: ${url}`, e);
        return null;
    }
}

async function fetchCryptoSnapshot(assetId, { force = false } = {}) {
    const now = Date.now();
    const cached = cryptoSnapshotCache.get(assetId);
    if (!force && cached?.data && now - cached.ts < CRYPTO_SNAPSHOT_TTL_MS) {
        return cached.data;
    }
    if (!force && cached?.pending) return cached.pending;

    const pending = fetchJsonSoft(cryptoSnapshotUrl(assetId)).then((data) => {
        cryptoSnapshotCache.set(assetId, { ts: Date.now(), data });
        return data;
    }).catch((e) => {
        console.warn(`crypto snapshot failed: ${assetId}`, e);
        cryptoSnapshotCache.set(assetId, { ts: Date.now(), data: cached?.data ?? null });
        return cached?.data ?? null;
    });
    cryptoSnapshotCache.set(assetId, { ts: cached?.ts ?? 0, data: cached?.data ?? null, pending });
    return pending;
}

/**
 * Fetches position bias summary + per-contract files for an asset.
 * Returns `{ summary, contracts }` with contracts filtered to those that loaded.
 */
export async function fetchPositionBias(assetId) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return {
            ...snapshot,
            contracts: snapshot?.contracts || [],
            expectedRange: snapshot?.expected_range || null
        };
    }

    const keys = CONTRACT_OPTIONS.map(({ key }) => key);
    const [contractResults, expectedRange] = await Promise.all([
        Promise.all(keys.map((key) => fetchJsonSoft(positionBiasUrl(assetId, `${key}_PositionBias.json`)))),
        fetchJsonSoft(expectedRangeUrl(assetId))
    ]);
    return {
        contracts: contractResults.filter(Boolean),
        expectedRange
    };
}

/**
 * Fetches the position-bias payload for every dashboard asset.
 * Returns an object keyed by asset id: `{ gc, nq, btc, eth }`.
 */
export async function fetchPositionBiasDashboard(assetIds = Object.keys(ASSET_PROFILES)) {
    const entries = await Promise.all(
        assetIds.map(async (assetId) => [assetId, await fetchPositionBias(assetId)])
    );
    return Object.fromEntries(entries);
}

export async function fetchBiasHistory() {
    const data = await fetchJsonSoft(biasHistoryApiUrl(), { retries: 2, cacheBustUrl: false })
        || await fetchJsonSoft(biasHistoryUrl(), { retries: 2 });
    if (!data) {
        return {
            load_error: true,
            error_message: 'Bias history could not be loaded. Keeping the last successful read if available.',
            records: []
        };
    }
    return {
        ...data,
        records: Array.isArray(data?.records) ? data.records : []
    };
}

/**
 * Fetches an OI heatmap JSON for one contract (strike × historical day).
 */
export async function fetchHeatmap(assetId, contractKey) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return snapshot?.heatmaps?.[contractKey] ?? null;
    }
    return fetchJsonSoft(heatmapUrl(assetId, contractKey));
}

/**
 * Fetches a Gamma (1 Pct) heatmap JSON for one contract (strike × historical day).
 */
export async function fetchGammaHeatmap(assetId, contractKey) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return snapshot?.gamma_heatmaps?.[contractKey] ?? null;
    }
    return fetchJsonSoft(gammaHeatmapUrl(assetId, contractKey));
}

/**
 * Fetches + parses the raw Vol2Vol OI text dump for one contract.
 * Returns the structured shape from `parseOIData`
 * ({ contract, futPrc, futureChg, vol, dte, settle, strikes:[...] }) or null.
 */
export async function fetchOIData(assetId, contractKey) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return snapshot?.oi_data?.[contractKey] ?? null;
    }
    const text = await fetchTextSoft(oiDataUrl(assetId, contractKey));
    return parseOIData(text);
}

/**
 * Fetches the shared macro snapshot (yields / real yields / DXY / VIX + per-asset
 * tailwind/headwind interpretation). Shape: { series, interpretation: { gold, nq } }.
 */
export async function fetchMacro() {
    return fetchJsonSoft(macroUrl());
}

/**
 * Fetches CFTC COT positioning for an asset.
 * GC shape: { managed_money, producer_merchant, swap_dealer, interpretation }.
 * NQ shape: { leveraged_funds, asset_manager, dealer, interpretation }.
 */
export async function fetchCot(assetId) {
    if (isCryptoAsset(assetId)) return null;
    return fetchJsonSoft(cotUrl(assetId));
}

/**
 * Fetches the auto-synthesized daily strategy for an asset.
 * Shape: { directional_bias, components, key_levels, scenarios, ... }.
 */
export async function fetchStrategy(assetId) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return snapshot?.strategy ?? null;
    }
    return fetchJsonSoft(strategyUrl(assetId));
}

/**
 * Fetches the LLM narrative daily brief (markdown text) for an asset.
 */
export async function fetchBrief(assetId) {
    if (isCryptoAsset(assetId)) return null;
    return fetchTextSoft(briefUrl(assetId));
}

/**
 * Fetches everything the Signals tab shows: the IV-based expected range,
 * the fired-signal log, and the win/loss scorecard. Each may be null if the
 * pipeline hasn't produced it yet (e.g. no signals fired).
 */
export async function fetchSignals(assetId) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return {
            expectedRange: snapshot?.expected_range ?? null,
            log: [],
            scorecard: null,
            optionFlow: snapshot?.strategy?.option_flow ?? null,
            wallBacktest: null,
            roundWalls: null
        };
    }

    const [expectedRange, log, scorecard, optionFlow, wallBacktest, strategy] = await Promise.all([
        fetchJsonSoft(expectedRangeUrl(assetId)),
        fetchJsonSoft(signalLogUrl(assetId)),
        fetchJsonSoft(signalScorecardUrl(assetId)),
        fetchJsonSoft(optionFlowUrl(assetId)),
        fetchJsonSoft(wallBacktestUrl(assetId)),
        fetchJsonSoft(strategyUrl(assetId))
    ]);
    return {
        expectedRange,
        log: Array.isArray(log) ? log : [],
        scorecard,
        optionFlow,
        wallBacktest,
        roundWalls: strategy?.round_walls ?? null
    };
}

/**
 * Fetches the scheduled high-impact macro calendar (FOMC / CPI / NFP). Returns
 * the events array (sorted as authored), or [] if unavailable. Shared across
 * assets, so assetId is ignored.
 */
export async function fetchEconCalendar() {
    const j = await fetchJsonSoft(econCalendarUrl());
    return Array.isArray(j?.events) ? j.events : [];
}

/**
 * Fetches the rolling IV baseline history (per-session ATM IV / put-call skew /
 * term slope) used to gauge whether today's volatility is elevated vs its own
 * recent norm. Always returns an array (possibly empty), never null.
 */
export async function fetchIvBaseline(assetId) {
    if (isCryptoAsset(assetId)) return [];
    const arr = await fetchJsonSoft(ivBaselineUrl(assetId));
    return Array.isArray(arr) ? arr : [];
}

/**
 * Live futures price from the same-origin /api/price Cloudflare Pages Function
 * (proxies Yahoo GC=F / NQ=F). Returns { sym, price, time, exch } or null.
 *
 * Deliberately NOT cache-busted: relying on the function's 15s cache-control so
 * repeated polls (and multiple tabs) coalesce instead of hammering Yahoo. On a
 * host without the function (e.g. the legacy GitHub Pages URL) this 404s and
 * returns null, so callers transparently fall back to the scrape-time price.
 */
export async function fetchLivePrice(sym, assetId = null) {
    if (assetId && isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId, { force: true });
        const live = snapshot?.live_price;
        return live && Number.isFinite(live.price) ? live : null;
    }

    try {
        const res = await fetch(`/api/price?sym=${encodeURIComponent(sym)}`);
        if (!res.ok) return null;
        const j = await res.json();
        return j && Number.isFinite(j.price) ? j : null;
    } catch (e) {
        return null;
    }
}
