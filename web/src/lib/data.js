import { ASSET_PROFILES, CONTRACT_OPTIONS, briefUrl, cotUrl, cryptoSnapshotUrl, dataApiUrl, econCalendarUrl, expectedRangeUrl, gammaHeatmapUrl, heatmapUrl, isCryptoAsset, ivBaselineUrl, macroUrl, oiDataUrl, optionFlowUrl, positionBiasUrl, signalLogUrl, signalScorecardUrl, strategyUrl, wallBacktestUrl } from './config.js';
import { parseOIData } from './vol2vol.js';

const CRYPTO_SNAPSHOT_TTL_MS = 4000;
const POSITION_BIAS_TTL_MS = 15000;
const OI_DATA_TTL_MS = 60000;
const SOFT_FETCH_RETRY_MS = 250;
const FETCH_TIMEOUT_MS = 8000;
/** @type {Map<string, {ts: number, data: any, pending?: Promise<any>}>} */
const cryptoSnapshotCache = new Map();
/** @type {Map<string, {ts: number, data: any, pending?: Promise<any>}>} */
const positionBiasCache = new Map();
/** @type {Map<string, {ts: number, data: any, pending?: Promise<any>}>} */
const oiDataCache = new Map();
const jsonLastGood = new Map();
const textLastGood = new Map();
const staticJsonPending = new Map();
const staticTextPending = new Map();

function cacheBust(url) {
    return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonSoft(url, {
    retries = 1,
    cacheBustUrl = true,
    useLastGood = false,
    stopRetryStatuses = [400, 404, 502],
    warn = true
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const res = await fetch(cacheBustUrl ? cacheBust(url) : url, {
                cache: cacheBustUrl ? 'no-store' : 'default',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
            });
            if (res.ok) {
                const data = await res.json();
                if (useLastGood) jsonLastGood.set(url, data);
                return data;
            }
            lastError = new Error(`HTTP ${res.status}`);
            if (stopRetryStatuses.includes(res.status)) break;
        } catch (e) {
            lastError = e;
        }

        if (attempt < retries) {
            await delay(SOFT_FETCH_RETRY_MS * (attempt + 1));
        }
    }

    if (warn) console.warn(`fetch failed: ${url}`, lastError);
    return useLastGood ? jsonLastGood.get(url) ?? null : null;
}

async function fetchTextSoft(url, {
    retries = 1,
    cacheBustUrl = true,
    useLastGood = false,
    stopRetryStatuses = [400, 404, 502],
    warn = true
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const res = await fetch(cacheBustUrl ? cacheBust(url) : url, {
                cache: cacheBustUrl ? 'no-store' : 'default',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
            });
            if (res.ok) {
                const text = await res.text();
                if (useLastGood) textLastGood.set(url, text);
                return text;
            }
            lastError = new Error(`HTTP ${res.status}`);
            if (stopRetryStatuses.includes(res.status)) break;
        } catch (e) {
            lastError = e;
        }

        if (attempt < retries) {
            await delay(SOFT_FETCH_RETRY_MS * (attempt + 1));
        }
    }

    if (warn) console.warn(`fetch failed: ${url}`, lastError);
    return useLastGood ? textLastGood.get(url) ?? null : null;
}

async function fetchStaticJson(assetId, fileName, rawUrl) {
    const key = `${assetId}:${fileName}`;
    const existing = staticJsonPending.get(key);
    if (existing) return existing;

    const pending = (async () => (
        await fetchJsonSoft(dataApiUrl(assetId, fileName), {
            retries: 1,
            cacheBustUrl: false,
            useLastGood: true,
            warn: false
        }) || await fetchJsonSoft(rawUrl, {
            retries: 1,
            cacheBustUrl: false,
            useLastGood: true
        })
    ))().finally(() => {
        if (staticJsonPending.get(key) === pending) staticJsonPending.delete(key);
    });
    staticJsonPending.set(key, pending);
    return pending;
}

async function fetchStaticText(assetId, fileName, rawUrl) {
    const key = `${assetId}:${fileName}`;
    const existing = staticTextPending.get(key);
    if (existing) return existing;

    const pending = (async () => (
        await fetchTextSoft(dataApiUrl(assetId, fileName), {
            retries: 1,
            cacheBustUrl: false,
            useLastGood: true,
            warn: false
        }) || await fetchTextSoft(rawUrl, {
            retries: 1,
            cacheBustUrl: false,
            useLastGood: true
        })
    ))().finally(() => {
        if (staticTextPending.get(key) === pending) staticTextPending.delete(key);
    });
    staticTextPending.set(key, pending);
    return pending;
}

async function fetchCryptoSnapshot(assetId, { force = false } = {}) {
    const now = Date.now();
    const cached = cryptoSnapshotCache.get(assetId);
    if (!force && cached?.data && now - cached.ts < CRYPTO_SNAPSHOT_TTL_MS) {
        return cached.data;
    }
    if (cached?.pending) return cached.pending;

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
export async function fetchPositionBias(assetId, { force = false } = {}) {
    const now = Date.now();
    const cached = positionBiasCache.get(assetId);
    if (!force && cached?.data && now - cached.ts < POSITION_BIAS_TTL_MS) {
        return cached.data;
    }
    if (cached?.pending) return cached.pending;

    if (isCryptoAsset(assetId)) {
        const pending = fetchCryptoSnapshot(assetId, { force }).then((snapshot) => {
            const next = {
                ...snapshot,
                contracts: snapshot?.contracts || cached?.data?.contracts || [],
                expectedRange: snapshot?.expected_range || cached?.data?.expectedRange || null
            };
            positionBiasCache.set(assetId, { ts: Date.now(), data: next });
            return next;
        }).catch((error) => {
            console.warn(`position bias failed: ${assetId}`, error);
            const fallback = cached?.data ?? { contracts: [], expectedRange: null };
            positionBiasCache.set(assetId, { ts: cached?.ts ?? 0, data: fallback });
            return fallback;
        });
        positionBiasCache.set(assetId, { ts: cached?.ts ?? 0, data: cached?.data ?? null, pending });
        return pending;
    }

    const pending = (async () => {
        const keys = CONTRACT_OPTIONS.map(({ key }) => key);
        const [contractResults, expectedRange] = await Promise.all([
            Promise.all(keys.map((key) => {
                const fileName = `${key}_PositionBias.json`;
                return fetchStaticJson(assetId, fileName, positionBiasUrl(assetId, fileName));
            })),
            fetchStaticJson(assetId, 'expected_range.json', expectedRangeUrl(assetId))
        ]);
        const contracts = contractResults.filter(Boolean);
        const next = {
            contracts: contracts.length ? contracts : cached?.data?.contracts || [],
            expectedRange: expectedRange || cached?.data?.expectedRange || null
        };
        positionBiasCache.set(assetId, { ts: Date.now(), data: next });
        return next;
    })().catch((error) => {
        console.warn(`position bias failed: ${assetId}`, error);
        const fallback = cached?.data ?? { contracts: [], expectedRange: null };
        positionBiasCache.set(assetId, { ts: cached?.ts ?? 0, data: fallback });
        return fallback;
    });
    positionBiasCache.set(assetId, { ts: cached?.ts ?? 0, data: cached?.data ?? null, pending });
    return pending;
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

/**
 * Fetches an OI heatmap JSON for one contract (strike × historical day).
 */
export async function fetchHeatmap(assetId, contractKey) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return snapshot?.heatmaps?.[contractKey] ?? null;
    }
    const fileName = `${contractKey}_OIHeatmap.json`;
    return fetchStaticJson(assetId, fileName, heatmapUrl(assetId, contractKey));
}

/**
 * Fetches a Gamma (1 Pct) heatmap JSON for one contract (strike × historical day).
 */
export async function fetchGammaHeatmap(assetId, contractKey) {
    if (isCryptoAsset(assetId)) {
        const snapshot = await fetchCryptoSnapshot(assetId);
        return snapshot?.gamma_heatmaps?.[contractKey] ?? null;
    }
    const fileName = `${contractKey}_GammaHeatmap.json`;
    return fetchStaticJson(assetId, fileName, gammaHeatmapUrl(assetId, contractKey));
}

/**
 * Fetches + parses the raw Vol2Vol OI text dump for one contract.
 * Returns the structured shape from `parseOIData`
 * ({ contract, futPrc, futureChg, vol, dte, settle, strikes:[...] }) or null.
 */
export async function fetchOIData(assetId, contractKey, { force = false } = {}) {
    const key = `${assetId}:${contractKey}`;
    const now = Date.now();
    const cached = oiDataCache.get(key);
    if (!force && cached?.data && now - cached.ts < OI_DATA_TTL_MS) return cached.data;
    if (cached?.pending) return cached.pending;

    if (isCryptoAsset(assetId)) {
        const pending = fetchCryptoSnapshot(assetId, { force }).then((snapshot) => {
            const next = snapshot?.oi_data?.[contractKey] ?? cached?.data ?? null;
            oiDataCache.set(key, { ts: Date.now(), data: next });
            return next;
        }).catch((error) => {
            console.warn(`OI data failed: ${key}`, error);
            const fallback = cached?.data ?? null;
            oiDataCache.set(key, { ts: cached?.ts ?? 0, data: fallback });
            return fallback;
        });
        oiDataCache.set(key, { ts: cached?.ts ?? 0, data: cached?.data ?? null, pending });
        return pending;
    }
    const pending = (async () => {
        const fileName = `${contractKey}_OIData.txt`;
        const text = await fetchStaticText(assetId, fileName, oiDataUrl(assetId, contractKey));
        const next = parseOIData(text) || cached?.data || null;
        oiDataCache.set(key, { ts: Date.now(), data: next });
        return next;
    })().catch((error) => {
        console.warn(`OI data failed: ${key}`, error);
        const fallback = cached?.data ?? null;
        oiDataCache.set(key, { ts: cached?.ts ?? 0, data: fallback });
        return fallback;
    });
    oiDataCache.set(key, { ts: cached?.ts ?? 0, data: cached?.data ?? null, pending });
    return pending;
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
    return fetchStaticJson(assetId, 'cot.json', cotUrl(assetId));
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
    return fetchStaticJson(assetId, 'daily_strategy.json', strategyUrl(assetId));
}

/**
 * Fetches the LLM narrative daily brief (markdown text) for an asset.
 */
export async function fetchBrief(assetId) {
    if (isCryptoAsset(assetId)) return null;
    return fetchStaticText(assetId, 'daily_brief.md', briefUrl(assetId));
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
        fetchStaticJson(assetId, 'expected_range.json', expectedRangeUrl(assetId)),
        fetchStaticJson(assetId, 'signal_log.json', signalLogUrl(assetId)),
        fetchStaticJson(assetId, 'signal_scorecard.json', signalScorecardUrl(assetId)),
        fetchStaticJson(assetId, 'option_flow.json', optionFlowUrl(assetId)),
        fetchStaticJson(assetId, 'wall_backtest.json', wallBacktestUrl(assetId)),
        fetchStaticJson(assetId, 'daily_strategy.json', strategyUrl(assetId))
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
    const arr = await fetchStaticJson(assetId, 'iv_baseline.json', ivBaselineUrl(assetId));
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
        // The 5-second callers already outlive the 4-second snapshot TTL. Reuse a
        // just-fetched dashboard snapshot so startup does not immediately issue a
        // second identical crypto request.
        const snapshot = await fetchCryptoSnapshot(assetId);
        const live = snapshot?.live_price;
        return live && Number.isFinite(live.price) ? live : null;
    }

    try {
        const res = await fetch(`/api/price?sym=${encodeURIComponent(sym)}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!res.ok) return null;
        const j = await res.json();
        return j && Number.isFinite(j.price) ? j : null;
    } catch (e) {
        return null;
    }
}
