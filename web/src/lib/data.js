import { CONTRACT_OPTIONS, gammaHeatmapUrl, heatmapUrl, ohlcUrl, positionBiasUrl } from './config.js';

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
 * Fetches OHLC for the asset's underlying futures.
 * `tf` is '1d' (default) or '1h'.
 * Shape: { interval, candles: [{ time, open, high, low, close, volume? }, ...] }
 */
export async function fetchOHLC(assetId, tf = '1d') {
    return fetchJsonSoft(ohlcUrl(assetId, tf));
}
