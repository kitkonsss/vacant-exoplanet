// Data source — same GitHub raw repo the original dashboard uses.
const DATA_BASE = 'https://raw.githubusercontent.com/kitkonsss/vacant-exoplanet/main';

export const ASSET_PROFILES = {
    gc: {
        id: 'gc',
        label: 'Gold (GC)',
        shortLabel: 'GC',
        source: 'static',
        liveSymbol: 'GC=F',
        dataFolder: 'data',
        visibleStrikeRange: 350,
        // Target view: GC moves are quoted in $/oz (= 1 point). $100/contract per
        // point, $10/contract per micro (MGC). fixedTpRef = the habitual flat $100
        // TP, shown vs today's expected move so the mismatch on quiet days is obvious.
        unit: '$',
        pointValueUsd: 100,
        microPointValueUsd: 10,
        fixedTpRef: 100
    },
    nq: {
        id: 'nq',
        label: 'Nasdaq (NQ)',
        shortLabel: 'NQ',
        source: 'static',
        liveSymbol: 'NQ=F',
        dataFolder: 'data/nq',
        visibleStrikeRange: 2000,
        // NQ moves in index points: $20/contract per point, $2/contract per micro
        // (MNQ). No habitual fixed-TP reference, so the comparison card is hidden.
        unit: 'จุด',
        pointValueUsd: 20,
        microPointValueUsd: 2,
        fixedTpRef: null
    },
    btc: {
        id: 'btc',
        label: 'Bitcoin (BTC)',
        shortLabel: 'BTC',
        source: 'crypto',
        liveSymbol: 'BTC-USDT-SWAP',
        dataFolder: null,
        visibleStrikeRange: 30000,
        unit: '$',
        pointValueUsd: 1,
        microPointValueUsd: null,
        fixedTpRef: null
    },
    eth: {
        id: 'eth',
        label: 'Ethereum (ETH)',
        shortLabel: 'ETH',
        source: 'crypto',
        liveSymbol: 'ETH-USDT-SWAP',
        dataFolder: null,
        visibleStrikeRange: 2500,
        unit: '$',
        pointValueUsd: 1,
        microPointValueUsd: null,
        fixedTpRef: null
    }
};

export const CONTRACT_OPTIONS = [
    { key: 'current', label: 'Current' },
    { key: 'tomorrow', label: 'Tomorrow' },
    { key: 'friday', label: 'Friday' },
    { key: 'monthly', label: 'Monthly' }
];

export const DEFAULT_CONTRACT_KEY = CONTRACT_OPTIONS[0].key;

function dataPath(assetId, fileName) {
    const profile = ASSET_PROFILES[assetId];
    const folder = profile?.dataFolder || 'data';
    return `${folder}/${fileName}`;
}

function dataUrl(assetId, fileName) {
    return `${DATA_BASE}/${dataPath(assetId, fileName)}`;
}

export function dataApiUrl(assetId, fileName) {
    return `/api/data?path=${encodeURIComponent(dataPath(assetId, fileName))}`;
}

export function isCryptoAsset(assetId) {
    return ASSET_PROFILES[assetId]?.source === 'crypto';
}

export function cryptoSnapshotUrl(assetId) {
    return `/api/crypto/snapshot?asset=${encodeURIComponent(assetId)}`;
}

export function positionBiasUrl(assetId, fileName) {
    return dataUrl(assetId, fileName);
}

export function biasHistoryUrl() {
    return `${DATA_BASE}/data/bias_snapshots/bias_history.json`;
}

export function biasHistoryApiUrl() {
    return '/api/bias-history';
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

// Per-contract raw Vol2Vol OI text dump (header + `Strike,Call,Put,Vol Settle`).
// Powers the Vol2Vol Expected Range (SD bands) + the per-strike OI table.
export function oiDataUrl(assetId, contractKey) {
    return dataUrl(assetId, `${contractKey}_OIData.txt`);
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

// Scheduled US high-impact macro events (FOMC / CPI / NFP) — the days you must
// NOT fade. Shared across assets, lives at the root data/ folder. Static curated
// schedule (refreshed yearly), so it's the same for GC and NQ.
export function econCalendarUrl() {
    return `${DATA_BASE}/data/econ_calendar.json`;
}

// CFTC COT positioning per asset — data/cot.json (GC) or data/nq/cot.json (NQ).
export function cotUrl(assetId) {
    return dataUrl(assetId, 'cot.json');
}

// Auto-synthesized daily strategy per asset (positioning + macro + COT blend).
export function strategyUrl(assetId) {
    return dataUrl(assetId, 'daily_strategy.json');
}

// LLM narrative brief (markdown) written by the Daily Strategy Brief workflow.
export function briefUrl(assetId) {
    return dataUrl(assetId, 'daily_brief.md');
}

// IV-based expected range (ATM IV / SD bands / term structure / skew) —
// computed by scraper/expected_range_fetch.py from the Vol2Vol smile.
export function expectedRangeUrl(assetId) {
    return dataUrl(assetId, 'expected_range.json');
}

// Rolling per-session IV / skew / term-slope history — iv_baseline.json. Used to
// judge whether today's ATM IV is high or low vs its own recent norm (so we can
// say "vol is bid up = big move priced" instead of showing a bare percentage).
export function ivBaselineUrl(assetId) {
    return dataUrl(assetId, 'iv_baseline.json');
}

// Entry signals fired by the price watcher + their win/loss self-eval.
export function signalLogUrl(assetId) {
    return dataUrl(assetId, 'signal_log.json');
}

export function signalScorecardUrl(assetId) {
    return dataUrl(assetId, 'signal_scorecard.json');
}

// Phase 2a intraday option flow — snapshot deltas of the Vol2Vol intraday
// volumes (flow velocity / magnet / wall activity), from flow_analyze.py.
export function optionFlowUrl(assetId) {
    return dataUrl(assetId, 'option_flow.json');
}

// Historical wall backtest (touch/respect/magnet rates with CIs) — backtest_walls.py.
export function wallBacktestUrl(assetId) {
    return dataUrl(assetId, 'wall_backtest.json');
}
