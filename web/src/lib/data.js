import { CONTRACT_OPTIONS, briefUrl, cotUrl, gammaHeatmapUrl, heatmapUrl, macroUrl, positionBiasUrl, strategyUrl } from './config.js';

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
 * Fetches the macro snapshot (yields / real yields / DXY / VIX + gold
 * tailwind/headwind interpretation). Shape: { series, interpretation: { gold } }.
 */
export async function fetchMacro() {
    return fetchJsonSoft(macroUrl());
}

/**
 * Fetches CFTC COT positioning for an asset.
 * GC shape: { managed_money, producer_merchant, swap_dealer, interpretation }.
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
