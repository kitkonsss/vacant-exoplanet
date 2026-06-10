import { CONTRACT_OPTIONS, briefUrl, cotUrl, expectedRangeUrl, gammaHeatmapUrl, heatmapUrl, macroUrl, oiDataUrl, positionBiasUrl, signalLogUrl, signalScorecardUrl, strategyUrl } from './config.js';
import { parseOIData } from './vol2vol.js';

async function fetchJsonSoft(url) {
    try {
        const res = await fetch(`${url}?t=${Date.now()}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.warn(`fetch failed: ${url}`, e);
        return null;
    }
}

async function fetchTextSoft(url) {
    try {
        const res = await fetch(`${url}?t=${Date.now()}`);
        if (!res.ok) return null;
        return await res.text();
    } catch (e) {
        console.warn(`fetch failed: ${url}`, e);
        return null;
    }
}

/**
 * Fetches position bias summary + per-contract files for an asset.
 * Returns `{ summary, contracts }` with contracts filtered to those that loaded.
 */
export async function fetchPositionBias(assetId) {
    const keys = CONTRACT_OPTIONS.map(({ key }) => key);
    const contractResults = await Promise.all(
        keys.map((key) => fetchJsonSoft(positionBiasUrl(assetId, `${key}_PositionBias.json`)))
    );
    return {
        contracts: contractResults.filter(Boolean)
    };
}

/**
 * Fetches an OI heatmap JSON for one contract (strike × historical day).
 */
export async function fetchHeatmap(assetId, contractKey) {
    return fetchJsonSoft(heatmapUrl(assetId, contractKey));
}

/**
 * Fetches a Gamma (1 Pct) heatmap JSON for one contract (strike × historical day).
 */
export async function fetchGammaHeatmap(assetId, contractKey) {
    return fetchJsonSoft(gammaHeatmapUrl(assetId, contractKey));
}

/**
 * Fetches + parses the raw Vol2Vol OI text dump for one contract.
 * Returns the structured shape from `parseOIData`
 * ({ contract, futPrc, futureChg, vol, dte, settle, strikes:[...] }) or null.
 */
export async function fetchOIData(assetId, contractKey) {
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
    return fetchJsonSoft(cotUrl(assetId));
}

/**
 * Fetches the auto-synthesized daily strategy for an asset.
 * Shape: { directional_bias, components, key_levels, scenarios, ... }.
 */
export async function fetchStrategy(assetId) {
    return fetchJsonSoft(strategyUrl(assetId));
}

/**
 * Fetches the LLM narrative daily brief (markdown text) for an asset.
 */
export async function fetchBrief(assetId) {
    return fetchTextSoft(briefUrl(assetId));
}

/**
 * Fetches everything the Signals tab shows: the IV-based expected range,
 * the fired-signal log, and the win/loss scorecard. Each may be null if the
 * pipeline hasn't produced it yet (e.g. no signals fired).
 */
export async function fetchSignals(assetId) {
    const [expectedRange, log, scorecard] = await Promise.all([
        fetchJsonSoft(expectedRangeUrl(assetId)),
        fetchJsonSoft(signalLogUrl(assetId)),
        fetchJsonSoft(signalScorecardUrl(assetId))
    ]);
    return { expectedRange, log: Array.isArray(log) ? log : [], scorecard };
}
