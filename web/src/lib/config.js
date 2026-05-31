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

// Per-contract historical OI heatmap (strike × historical day).
export function heatmapUrl(assetId, contractKey) {
    return dataUrl(assetId, `${contractKey}_OIHeatmap.json`);
}

// Per-contract historical Gamma (1 Pct) heatmap — same shape as OI,
// but Greek=Gamma 1Pct so cells are gamma-weighted OI per day.
export function gammaHeatmapUrl(assetId, contractKey) {
    return dataUrl(assetId, `${contractKey}_GammaHeatmap.json`);
}

// OHLC for the asset's underlying futures (yfinance-sourced, rollover back-adjusted).
// `tf` is '1d' (default, file=OHLC.json) or '1h' (file=OHLC_1h.json).
export function ohlcUrl(assetId, tf = '1d') {
    const fname = tf === '1h' ? 'OHLC_1h.json' : 'OHLC.json';
    return dataUrl(assetId, fname);
}

// Macro snapshot (yields / real yields / DXY / VIX + per-asset interpretation).
// Shared across assets — always at the root data/ folder (Phase 0 macro layer).
export function macroUrl() {
    return `${DATA_BASE}/data/macro.json`;
}

// CFTC COT positioning per asset — data/cot.json (GC) or data/nq/cot.json (NQ).
export function cotUrl(assetId) {
    return dataUrl(assetId, 'cot.json');
}

// Auto-synthesized daily strategy per asset (positioning + macro + COT blend).
export function strategyUrl(assetId) {
    return dataUrl(assetId, 'daily_strategy.json');
}
