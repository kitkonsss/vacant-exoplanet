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

export const CONTRACT_OPTIONS = [
    { key: 'current', label: 'Current' },
    { key: 'tomorrow', label: 'Tomorrow' },
    { key: 'friday', label: 'Friday' },
    { key: 'monthly', label: 'Monthly' }
];

export const DEFAULT_CONTRACT_KEY = CONTRACT_OPTIONS[0].key;

function dataUrl(assetId, fileName) {
    const profile = ASSET_PROFILES[assetId];
    const folder = profile?.dataFolder || 'data';
    return `${DATA_BASE}/${folder}/${fileName}`;
}

export function positionBiasUrl(assetId, fileName) {
    return dataUrl(assetId, fileName);
}

// Per-contract historical OI heatmap (strike × historical day). Feeds the
// OI Heatmap tab and the Conviction tab.
export function heatmapUrl(assetId, contractKey) {
    return dataUrl(assetId, `${contractKey}_OIHeatmap.json`);
}

// Matrix view: one file per asset (strike × expiration). Feeds the
// Gamma Heatmap tab — gamma values per (strike, expiration) summed
// across calls+puts.
export function gammaMatrixUrl(assetId) {
    return dataUrl(assetId, 'GammaMatrix.json');
}
