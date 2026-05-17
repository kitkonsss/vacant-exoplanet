// Data source — same GitHub raw repo the original dashboard uses.
const DATA_BASE = 'https://raw.githubusercontent.com/kitkonsss/vacant-exoplanet/main';

export const ASSET_PROFILES = {
    gc: {
        id: 'gc',
        label: 'Gold (GC)',
        shortLabel: 'GC',
        dataFolder: 'data',
        visibleStrikeRange: 350
    },
    nq: {
        id: 'nq',
        label: 'Nasdaq (NQ)',
        shortLabel: 'NQ',
        dataFolder: 'data/nq',
        visibleStrikeRange: 2000
    }
};

function dataUrl(assetId, fileName) {
    const profile = ASSET_PROFILES[assetId];
    const folder = profile?.dataFolder || 'data';
    return `${DATA_BASE}/${folder}/${fileName}`;
}

export function positionBiasUrl(assetId, fileName) {
    return dataUrl(assetId, fileName);
}

export function heatmapUrl(assetId, contractKey) {
    return dataUrl(assetId, `${contractKey}_OIHeatmap.json`);
}
