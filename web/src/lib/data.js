import { heatmapUrl, positionBiasUrl } from './config.js';

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
    const keys = ['current', 'friday', 'monthly'];
    const [summary, ...contractResults] = await Promise.all([
        fetchJsonSoft(positionBiasUrl(assetId, 'position_bias_summary.json')),
        ...keys.map((key) => fetchJsonSoft(positionBiasUrl(assetId, `${key}_PositionBias.json`)))
    ]);
    return {
        summary,
        contracts: contractResults.filter(Boolean)
    };
}

/**
 * Fetches an OI heatmap JSON for one contract.
 */
export async function fetchHeatmap(assetId, contractKey) {
    return fetchJsonSoft(heatmapUrl(assetId, contractKey));
}
