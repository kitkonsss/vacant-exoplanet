// ========== CONFIG ==========
const MY_BASE = 'https://raw.githubusercontent.com/kitkonsss/vacant-exoplanet/main';

// ── ASSET PROFILES — ค่าเฉพาะแต่ละสินทรัพย์อยู่ที่เดียว ──
const ASSET_PROFILES = {
    gc: {
        id: 'gc',
        label: 'Gold (GC)',
        shortLabel: 'GC',
        yahooSymbol: 'GC=F',
        contractMultiplier: 100,       // Gold options = 100 oz
        visibleStrikeRange: 350,       // ±350 from price
        gexScanStep: 5,                // $5 grid for GEX flip scan
        defaultADV: 200000,
        oiHotThreshold: 100,
        volHotThreshold: 80,
        proximityRange: 100,           // for wall detection clustering
        dataFolder: 'data',
        contracts: {
            current: {
                label: 'Current',
                intradayUrl: MY_BASE + '/data/current_IntradayData.txt',
                oiUrl: MY_BASE + '/data/current_OIData.txt',
            },
            friday: {
                label: 'Friday',
                intradayUrl: MY_BASE + '/data/friday_IntradayData.txt',
                oiUrl: MY_BASE + '/data/friday_OIData.txt',
            },
            monthly: {
                label: 'Monthly',
                intradayUrl: MY_BASE + '/data/monthly_IntradayData.txt',
                oiUrl: MY_BASE + '/data/monthly_OIData.txt',
            },
            analysis: { label: 'Trade Setup' },
            chart: { label: 'Live Chart' },
        },
    },
    nq: {
        id: 'nq',
        label: 'Nasdaq (NQ)',
        shortLabel: 'NQ',
        yahooSymbol: 'NQ=F',
        contractMultiplier: 20,        // E-mini NASDAQ 100 options = $20/pt
        visibleStrikeRange: 2000,      // ±2000 from price (~20000 level)
        gexScanStep: 25,               // 25-pt grid for GEX flip scan
        defaultADV: 500000,
        oiHotThreshold: 50,
        volHotThreshold: 40,
        proximityRange: 500,
        dataFolder: 'data/nq',
        contracts: {
            current: {
                label: 'Current',
                intradayUrl: MY_BASE + '/data/nq/current_IntradayData.txt',
                oiUrl: MY_BASE + '/data/nq/current_OIData.txt',
            },
            friday: {
                label: 'Friday',
                intradayUrl: MY_BASE + '/data/nq/friday_IntradayData.txt',
                oiUrl: MY_BASE + '/data/nq/friday_OIData.txt',
            },
            monthly: {
                label: 'Monthly',
                intradayUrl: MY_BASE + '/data/nq/monthly_IntradayData.txt',
                oiUrl: MY_BASE + '/data/nq/monthly_OIData.txt',
            },
            analysis: { label: 'Trade Setup' },
            chart: { label: 'Live Chart' },
        },
    },
};

// ── Active profile helper ──
function getProfile() { return ASSET_PROFILES[state.activeAsset]; }

const CONFIG = {
    refreshIntervalMs: 1800000, // 30 minutes
    barMaxWidth: 180,
};

let state = {
    activeAsset: 'gc',            // 'gc' | 'nq'
    activeTab: 'analysis',
    tradingStyle: 'daytrade',     // 'daytrade' | 'swing' | 'position'
    data: { current: {}, friday: {}, monthly: {}, analysis: {}, chart: {} },
    refreshTimer: null,
    chartInitialized: false,
};

// ========== MATH ==========
function normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}

function calcDelta(F, K, sigma, t, isCall) {
    if (sigma <= 0 || t <= 0) return isCall ? (F > K ? 1 : 0) : (F < K ? -1 : 0);
    const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * t) / (sigma * Math.sqrt(t));
    return isCall ? normalCDF(d1) : normalCDF(d1) - 1;
}

function calcGamma(F, K, sigma, t) {
    if (sigma <= 0 || t <= 0) return 0;
    const sqrtT = Math.sqrt(t);
    const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * t) / (sigma * sqrtT);
    const phi = 0.3989423 * Math.exp(-d1 * d1 / 2); // standard normal PDF
    return phi / (F * sigma * sqrtT);
}

// Max Pain: strike where total intrinsic value (pain to writers) is minimized
function calcMaxPain(strikes) {
    if (!strikes || strikes.length === 0) return null;
    let minPain = Infinity;
    let maxPainStrike = strikes[0].strike;
    for (const target of strikes) {
        let pain = 0;
        for (const s of strikes) {
            // Calls ITM: strike < target expiry price → writers pay (target - strike) × OI
            if (s.strike < target.strike) pain += s.call * (target.strike - s.strike);
            // Puts ITM: strike > target expiry price → writers pay (strike - target) × OI
            if (s.strike > target.strike) pain += s.put * (s.strike - target.strike);
        }
        if (pain < minPain) { minPain = pain; maxPainStrike = target.strike; }
    }
    return maxPainStrike;
}

// GEX: Net Gamma Exposure (positive = dealers long gamma = stabilizing)
// Flip = spot price where totalGEX(S) crosses zero (regime change Long↔Short gamma)
function calcNetGEX(strikes, F, dte) {
    if (!strikes || strikes.length === 0 || dte <= 0) return { netGEX: 0, flipStrike: null };
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;

    // Helper: compute total net GEX at a hypothetical spot price S
    function totalGEXAtSpot(S) {
        let gex = 0;
        for (const s of strikes) {
            const g = calcGamma(S, s.strike, s.volSettle, t);
            const callGEX = g * s.call * contractMultiplier * S * S * 0.01;
            const putGEX = g * s.put * contractMultiplier * S * S * 0.01;
            gex += callGEX - putGEX; // Call GEX - Put GEX
        }
        return gex;
    }

    // Net GEX at current spot
    const netGEX = totalGEXAtSpot(F);

    // Find GEX flip: scan spot grid and find zero-crossing nearest to current price
    const sortedStrikes = [...strikes].map(s => s.strike).sort((a, b) => a - b);
    const scanLow = sortedStrikes[0] - 300;
    const scanHigh = sortedStrikes[sortedStrikes.length - 1] + 300;
    const step = getProfile().gexScanStep;
    let crossings = [];
    let prevGEX = totalGEXAtSpot(scanLow);
    for (let S = scanLow + step; S <= scanHigh; S += step) {
        const curGEX = totalGEXAtSpot(S);
        if ((prevGEX <= 0 && curGEX > 0) || (prevGEX >= 0 && curGEX < 0)) {
            // Linear interpolation for precise crossing
            const crossS = S - step + step * Math.abs(prevGEX) / (Math.abs(prevGEX) + Math.abs(curGEX));
            crossings.push(Math.round(crossS));
        }
        prevGEX = curGEX;
    }

    // Pick crossing nearest to current spot
    let flipStrike = null;
    if (crossings.length > 0) {
        crossings.sort((a, b) => Math.abs(a - F) - Math.abs(b - F));
        flipStrike = crossings[0];
    }

    return { netGEX, flipStrike };
}

// ========== VOLUME GEX — Intraday flow regime confirmation ==========
// Uses today's traded volume (instead of OI) to see if new flow confirms or contradicts the OI-based regime
// NOTE: This is SECONDARY — OI GEX remains the primary regime signal. Volume GEX is "second opinion" only.
// For expiring contracts (DTE < 1), volume is meaningless for future regime — skip.
function calcVolumeGEX(oiStrikes, intradayStrikes, F, dte) {
    if (!intradayStrikes || intradayStrikes.length === 0 || !oiStrikes || oiStrikes.length === 0 || dte <= 0)
        return { volumeGEX: 0, confidence: 'NO_DATA', detail: 'ไม่มี Intraday data', volOIRatio: 0, hotStrikes: [] };

    // Expiring contract — volume won't become tomorrow's OI, skip analysis
    if (dte < 1) {
        return { volumeGEX: 0, confidence: 'EXPIRING', detail: `Contract ใกล้หมดอายุ (${dte.toFixed(2)} DTE) — volume ไม่มีผลต่อ regime พรุ่งนี้`, volOIRatio: 0, hotStrikes: [] };
    }

    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;

    // Compute GEX using intraday volume instead of OI
    let volGEX = 0;
    for (const iStrike of intradayStrikes) {
        // Use volSettle from intraday data (live IV), fallback to OI data's vol
        const oiMatch = oiStrikes.find(s => s.strike === iStrike.strike);
        const vol = iStrike.volSettle > 0 ? iStrike.volSettle : (oiMatch ? oiMatch.volSettle : 0);
        if (vol <= 0) continue;

        const g = calcGamma(F, iStrike.strike, vol, t);
        const callGEX = g * iStrike.call * contractMultiplier * F * F * 0.01;
        const putGEX = g * iStrike.put * contractMultiplier * F * F * 0.01;
        volGEX += callGEX - putGEX;
    }

    // Compute total volume vs total OI to gauge volume significance
    const totalVol = intradayStrikes.reduce((sum, s) => sum + s.call + s.put, 0);
    const totalOI = oiStrikes.reduce((sum, s) => sum + s.call + s.put, 0);
    const volOIRatio = totalOI > 0 ? totalVol / totalOI : 0;

    // OI GEX sign for comparison (already computed externally, but we need sign here)
    let oiGEX = 0;
    for (const s of oiStrikes) {
        if (s.volSettle <= 0) continue;
        const g = calcGamma(F, s.strike, s.volSettle, t);
        oiGEX += g * s.call * contractMultiplier * F * F * 0.01 - g * s.put * contractMultiplier * F * F * 0.01;
    }

    const sameSign = (oiGEX >= 0 && volGEX >= 0) || (oiGEX < 0 && volGEX < 0);
    const meaningfulVolume = volOIRatio > 0.05; // At least 5% of OI traded today

    let confidence, detail;
    if (!meaningfulVolume) {
        confidence = 'LOW_VOLUME';
        detail = `Volume เบา (${(volOIRatio * 100).toFixed(1)}% of OI) — ยังไม่พอยืนยัน Regime`;
    } else if (sameSign) {
        confidence = 'CONFIRMED';
        detail = `Intraday Flow ยืนยัน ${oiGEX >= 0 ? 'Long' : 'Short'} γ`;
        detail += ` — วันนี้ ${volGEX >= 0 ? 'Call' : 'Put'} volume dominant (Vol/OI: ${(volOIRatio * 100).toFixed(0)}%)`;
    } else {
        confidence = 'DIVERGING';
        const shifting = volGEX >= 0 ? 'Long γ' : 'Short γ';
        detail = `Volume GEX ชี้ไป ${shifting} สวนทาง OI! Regime อาจเปลี่ยนหลัง settlement (Vol/OI: ${(volOIRatio * 100).toFixed(0)}%)`;
    }

    // Per-wall reinforcement: find where volume is concentrated
    let hotStrikes = [];
    for (const iStrike of intradayStrikes) {
        const totalStrikeVol = iStrike.call + iStrike.put;
        if (totalStrikeVol > totalVol * 0.05) { // > 5% of total volume at one strike
            const oiMatch = oiStrikes.find(s => s.strike === iStrike.strike);
            const existingOI = oiMatch ? oiMatch.call + oiMatch.put : 0;
            hotStrikes.push({
                strike: iStrike.strike,
                callVol: iStrike.call,
                putVol: iStrike.put,
                totalVol: totalStrikeVol,
                existingOI,
                isNewWall: existingOI < totalStrikeVol * 2, // Volume > 50% of OI = likely new wall
                side: iStrike.call > iStrike.put ? 'call' : 'put'
            });
        }
    }
    hotStrikes.sort((a, b) => b.totalVol - a.totalVol);

    return { volumeGEX: volGEX, confidence, detail, volOIRatio, hotStrikes: hotStrikes.slice(0, 5) };
}

// Charm: ∂Delta/∂T (time-decay of delta) — Black-76 with r=0
// Shows how dealer delta positions drift as time passes, independent of price/vol
function calcCharm(F, K, sigma, t) {
    if (sigma <= 0 || t <= 0) return 0;
    const sqrtT = Math.sqrt(t);
    const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * t) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const phi = 0.3989423 * Math.exp(-d1 * d1 / 2);
    // Charm = ∂N(d1)/∂T = -φ(d1)·d2/(2T) for Black-76 at r=0
    return -phi * d2 / (2 * t);
}

// Net Charm Exposure: daily delta change in dealer book from time decay alone
// As 1 day passes (T shrinks by 1/365), dealer delta shifts by this amount
//   Positive = dealer delta increasing → must SELL futures → bearish pressure
//   Negative = dealer delta decreasing → must BUY futures → bullish support
function calcNetCharmExposure(strikes, F, dte) {
    if (!strikes || strikes.length === 0 || dte <= 0) return 0;
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;
    let netCharm = 0;
    for (const s of strikes) {
        const c = calcCharm(F, s.strike, s.volSettle, t);
        // Dealer is short both → delta change per day = charm × (callOI + putOI) × mult × F × 0.01 / 365
        netCharm += c * (s.call + s.put) * contractMultiplier * F * 0.01 / 365;
    }
    return netCharm;
}

// Vomma: ∂Vega/∂σ — how sensitive is Vega to vol changes (vol-of-vol)
// High Vomma in wings = vol spike amplifies dealer's short-vega → forced buying → cascade
function calcVomma(F, K, sigma, t) {
    if (sigma <= 0 || t <= 0) return 0;
    const sqrtT = Math.sqrt(t);
    const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * t) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const phi = 0.3989423 * Math.exp(-d1 * d1 / 2);
    // Vomma = Vega × d1 × d2 / σ
    return phi * sqrtT * d1 * d2 / sigma;
}

// Net Vomma Exposure: aggregate vol-acceleration risk in dealer book
// Dealers are short options → short vega. Vomma measures how MUCH more short-vega
// they become per 1% vol increase → large magnitude = vol spike cascades
function calcNetVommaExposure(strikes, F, dte) {
    if (!strikes || strikes.length === 0 || dte <= 0) return 0;
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;
    let netVomma = 0;
    for (const s of strikes) {
        const vm = calcVomma(F, s.strike, s.volSettle, t);
        // Dealers short → exposure = -Vomma × OI (the more negative, the more cascade risk)
        netVomma += -vm * (s.call + s.put) * contractMultiplier * F * 0.01;
    }
    return netVomma; // Large negative = high vol cascade risk
}

// Vanna: ∂Delta/∂σ — measures how delta changes when IV changes
// When vol spikes + positive net vanna → dealers must sell → cascade
function calcVanna(F, K, sigma, t) {
    if (sigma <= 0 || t <= 0) return 0;
    const sqrtT = Math.sqrt(t);
    const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * t) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const phi = 0.3989423 * Math.exp(-d1 * d1 / 2);
    return -phi * d2 / sigma;
}

// Net Vanna Exposure: aggregate dealer vanna × OI across all strikes
// Dealers are short BOTH calls and puts → exposure = -Vanna × OI for both sides
// Result: hedgeFlow = -netVanna × dSigma
//   netVanna < 0 → IV↑ causes dealers to BUY (bullish)
//   netVanna > 0 → IV↑ causes dealers to SELL (bearish)
function calcNetVannaExposure(strikes, F, dte) {
    if (!strikes || strikes.length === 0 || dte <= 0) return 0;
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;
    let netVanna = 0;
    for (const s of strikes) {
        const v = calcVanna(F, s.strike, s.volSettle, t);
        // Dealers short calls → call vanna exposure = -v × callOI
        // Dealers short puts  → put vanna exposure  = -v × putOI  (same sign convention)
        const callVannaExp = -v * s.call * contractMultiplier * F * 0.01;
        const putVannaExp = -v * s.put * contractMultiplier * F * 0.01;
        netVanna += callVannaExp + putVannaExp;
    }
    return netVanna;
}

// ========== GAME THEORY ENGINE ==========
// Applies game-theoretic models to options market microstructure:
// 1. Wall Credibility Score (Commitment Signal)
// 2. Dealer Response Payoff Matrix
// 3. Nash Equilibrium Approximation per regime
// 4. Monte Carlo Dealer Strategy Simulation
// 5. Multi-Agent Model (Dealer vs Speculator dynamics)

// ── 1. WALL CREDIBILITY SCORE (Credible Threat Analysis) ──
// A wall is "credible" if the dealer has high cost to abandon it.
// Cost = OI × Gamma × contractMultiplier × F² × 0.01  ($ at risk if wall breaks)
// Higher cost = more incentive to defend = more credible wall
function calcWallCredibility(wall, allWalls, F, dte, oiStrikes, intradayStrikes) {
    if (!wall || dte <= 0) return { score: 0, label: 'N/A', cost: 0, reinforced: false, detail: '' };
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;
    const side = wall.strike > F ? 'call' : 'put';
    const oiKey = side === 'call' ? 'call' : 'put';

    // Commitment cost: how much $ dealer has at stake defending this wall
    const g = calcGamma(F, wall.strike, 0.20, t); // use 20% IV estimate if no volSettle
    const oiMatch = oiStrikes ? oiStrikes.find(s => s.strike === wall.strike) : null;
    const vol = oiMatch && oiMatch.volSettle > 0 ? oiMatch.volSettle : 0.20;
    const gammaAtWall = calcGamma(F, wall.strike, vol, t);
    const commitmentCost = gammaAtWall * wall.oi * contractMultiplier * F * F * 0.01;

    // Cluster strength: multi-strike walls are harder to break than single-strike
    const clusterBonus = wall.clusterCount > 1 ? Math.min(1.5, 1 + wall.clusterCount * 0.15) : 1.0;

    // Volume reinforcement: if today's volume is building on this wall, it's MORE credible
    let reinforced = false;
    let volReinforcement = 1.0;
    if (intradayStrikes && intradayStrikes.length > 0) {
        const iMatch = intradayStrikes.find(s => s.strike === wall.strike);
        if (iMatch) {
            const volAtWall = side === 'call' ? iMatch.call : iMatch.put;
            const volOIRatio = wall.oi > 0 ? volAtWall / wall.oi : 0;
            if (volOIRatio > 0.10) { reinforced = true; volReinforcement = 1.3; }  // Active defense
            else if (volOIRatio > 0.05) { volReinforcement = 1.1; }
            else if (volOIRatio < 0.01) { volReinforcement = 0.7; }  // Stale wall
        }
    }

    // Distance factor: walls closer to price are more actively defended
    const dist = Math.abs(wall.strike - F);
    const distFactor = dist < 30 ? 1.3 : dist < 80 ? 1.0 : 0.8;

    // Tier bonus: primary walls get defended first
    const tierBonus = wall.tier === 'primary' ? 1.4 : wall.tier === 'secondary' ? 1.1 : 0.9;

    // Final credibility = commitment cost × modifiers, normalized to 0-100
    const rawScore = commitmentCost * clusterBonus * volReinforcement * distFactor * tierBonus;

    // Normalize against all walls
    const allCosts = allWalls.map(w => {
        const gw = calcGamma(F, w.strike, vol, t);
        return gw * w.oi * contractMultiplier * F * F * 0.01;
    });
    const maxCost = Math.max(...allCosts, 1);
    const normalizedScore = Math.min(100, Math.round((rawScore / maxCost) * 60 * clusterBonus * tierBonus));

    let label, labelColor;
    if (normalizedScore >= 80) { label = 'FORTRESS'; labelColor = 'var(--green)'; }
    else if (normalizedScore >= 55) { label = 'STRONG'; labelColor = 'var(--cyan)'; }
    else if (normalizedScore >= 30) { label = 'MODERATE'; labelColor = 'var(--accent)'; }
    else { label = 'WEAK'; labelColor = 'var(--red)'; }

    const detail = `Cost: $${(commitmentCost / 1e6).toFixed(2)}M | Cluster: ${wall.clusterCount || 1} | ${reinforced ? '⚡Reinforced' : volReinforcement < 1 ? '⏳Stale' : '—'}`;

    return { score: normalizedScore, label, labelColor, cost: commitmentCost, reinforced, clusterBonus, volReinforcement, distFactor, tierBonus, detail };
}

// ── 2. DEALER RESPONSE PAYOFF MATRIX ──
// Models 4 scenarios of price approaching a wall:
//   Rows: Price → Wall, Price breaks Wall
//   Cols: Dealer hedges aggressively, Dealer doesn't hedge
// Returns probability-weighted expected outcomes
function calcDealerPayoffMatrix(wall, credibility, F, er1Day, isLongGamma) {
    if (!wall || !credibility) return null;

    const dist = Math.abs(wall.strike - F);
    const distRatio = er1Day > 0 ? dist / er1Day : 1;

    // Base probabilities from credibility score
    const pHedge = Math.min(0.95, credibility.score / 100 * 0.8 + 0.15); // Higher credibility = more likely to hedge
    const pNoHedge = 1 - pHedge;

    // Price approach probability (closer = more likely to test)
    const pApproach = distRatio < 0.5 ? 0.75 : distRatio < 1.0 ? 0.50 : distRatio < 2.0 ? 0.25 : 0.10;
    const pBreak = 1 - pApproach;

    // Regime affects break probability
    const regimeMultiplier = isLongGamma ? 0.6 : 1.4; // Long γ = harder to break, Short γ = easier
    const adjustedPBreak = Math.min(0.85, pBreak * regimeMultiplier);
    const adjustedPHold = 1 - adjustedPBreak;

    // Payoff matrix (in ER units, positive = favorable for trader)
    const matrix = {
        // [Price approaches wall, Dealer hedges] → Wall holds, price bounces
        approach_hedge: {
            prob: pApproach * pHedge,
            outcome: 'Wall Holds (Bounce)',
            payoff: 0.5, // Favorable if fading
            traderAction: 'Fade: Entry ที่ Wall → TP กลาง Range',
            confidence: credibility.score > 60 ? 'HIGH' : 'MEDIUM',
        },
        // [Price approaches wall, Dealer doesn't hedge] → Wall breaks
        approach_noHedge: {
            prob: pApproach * pNoHedge,
            outcome: 'Wall Breaks (Breakout)',
            payoff: -0.5, // Bad if fading
            traderAction: 'SL ถูกทำลาย — ต้อง Flip direction',
            confidence: credibility.score < 40 ? 'HIGH' : 'LOW',
        },
        // [Price breaks wall, Dealer hedges] → Cascade (forced hedging amplifies move)
        break_hedge: {
            prob: adjustedPBreak * pHedge,
            outcome: 'Cascade Move',
            payoff: 1.5, // Very favorable if following breakout
            traderAction: 'Follow: TP ถัดไปไกล (Dealer hedge ดัน momentum)',
            confidence: !isLongGamma ? 'HIGH' : 'LOW',
        },
        // [Price breaks wall, Dealer doesn't hedge] → Normal breakout
        break_noHedge: {
            prob: adjustedPBreak * pNoHedge,
            outcome: 'Normal Breakout',
            payoff: 0.8,
            traderAction: 'Follow: TP ถัดไป แต่อาจ pullback',
            confidence: 'MEDIUM',
        },
    };

    // Expected value for fade vs follow strategy
    const fadeEV = matrix.approach_hedge.prob * matrix.approach_hedge.payoff
        + matrix.approach_noHedge.prob * matrix.approach_noHedge.payoff
        + matrix.break_hedge.prob * (-matrix.break_hedge.payoff) // Bad for fade
        + matrix.break_noHedge.prob * (-matrix.break_noHedge.payoff);

    const followEV = matrix.approach_hedge.prob * (-0.3) // Whipsaw
        + matrix.approach_noHedge.prob * matrix.approach_noHedge.payoff
        + matrix.break_hedge.prob * matrix.break_hedge.payoff
        + matrix.break_noHedge.prob * matrix.break_noHedge.payoff;

    const bestStrategy = fadeEV > followEV ? 'FADE' : 'FOLLOW';
    const strategyEdge = Math.abs(fadeEV - followEV);
    const edgeLabel = strategyEdge > 0.3 ? 'STRONG' : strategyEdge > 0.1 ? 'MODERATE' : 'WEAK';

    return {
        matrix, fadeEV, followEV, bestStrategy, strategyEdge, edgeLabel,
        wallHoldProb: adjustedPHold,
        wallBreakProb: adjustedPBreak,
        pHedge, pNoHedge,
    };
}

// ── 3. NASH EQUILIBRIUM APPROXIMATION ──
// Finds approximate equilibrium price where dealer and speculator strategies balance
// Long γ: Nash Eq. converges toward Max Pain (mean-reversion attractor)
// Short γ: No stable Eq. (trending) — equilibrium is at boundary (wall break)
function calcNashEquilibrium(oiStrikes, F, dte, isLongGamma, mpStrike, flipStrike, putWalls, callWalls) {
    if (!oiStrikes || oiStrikes.length === 0 || dte <= 0) return null;
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;

    // Compute "dealer utility" at each price point
    // Dealer wants: minimize hedging cost, stay delta-neutral
    // Speculator wants: maximize directional move
    const sortedStrikes = [...oiStrikes].map(s => s.strike).sort((a, b) => a - b);
    const scanLow = sortedStrikes[0];
    const scanHigh = sortedStrikes[sortedStrikes.length - 1];
    const step = getProfile().gexScanStep;

    let equilibria = [];

    for (let S = scanLow; S <= scanHigh; S += step) {
        // Dealer hedging cost at price S
        let dealerCost = 0;
        let specProfit = 0;

        for (const s of oiStrikes) {
            if (s.volSettle <= 0) continue;
            const g = calcGamma(S, s.strike, s.volSettle, t);
            const d = calcDelta(S, s.strike, s.volSettle, t, true);
            const dPut = calcDelta(S, s.strike, s.volSettle, t, false);

            // Dealer cost: gamma exposure × OI (higher gamma = more rebalancing needed)
            dealerCost += g * (s.call + s.put) * contractMultiplier * S * 0.01;

            // Speculator potential: how much directional P&L at this price
            const callIntrinsic = Math.max(0, S - s.strike) * s.call;
            const putIntrinsic = Math.max(0, s.strike - S) * s.put;
            specProfit += callIntrinsic + putIntrinsic;
        }

        // Nash: equilibrium is where dealer cost is minimized AND speculator profit is moderate
        // This is essentially the "least resistance" price
        const utilitySum = dealerCost + specProfit * 0.001; // Scale specProfit down
        equilibria.push({ price: S, dealerCost, specProfit, utility: utilitySum });
    }

    // Find local minima of dealer cost (these are equilibrium candidates)
    const candidates = [];
    for (let i = 1; i < equilibria.length - 1; i++) {
        if (equilibria[i].utility < equilibria[i - 1].utility &&
            equilibria[i].utility < equilibria[i + 1].utility) {
            candidates.push(equilibria[i]);
        }
    }

    // If no local minima found, use global minimum
    if (candidates.length === 0) {
        const minUtil = equilibria.reduce((p, c) => c.utility < p.utility ? c : p);
        candidates.push(minUtil);
    }

    // Pick the equilibrium nearest to current price
    candidates.sort((a, b) => Math.abs(a.price - F) - Math.abs(b.price - F));
    const primaryEq = candidates[0];

    // Stability assessment
    let stability, stabilityColor;
    if (isLongGamma) {
        // Long γ = equilibrium is stable (price converges)
        stability = 'STABLE';
        stabilityColor = 'var(--green)';
    } else {
        // Short γ = equilibrium is unstable (price diverges)
        const distFromEq = Math.abs(F - primaryEq.price);
        if (distFromEq < step * 2) {
            stability = 'UNSTABLE (AT EQ.)';
            stabilityColor = 'var(--red)';
        } else {
            stability = 'TRENDING AWAY';
            stabilityColor = 'var(--orange)';
        }
    }

    // Attraction strength: how strongly price is pulled toward equilibrium
    const distToEq = primaryEq.price - F;
    const attractionDir = distToEq > 0 ? 'UP' : distToEq < 0 ? 'DOWN' : 'AT_EQ';

    return {
        price: primaryEq.price,
        dealerCost: primaryEq.dealerCost,
        stability,
        stabilityColor,
        attractionDir,
        distToEq,
        allEquilibria: candidates.slice(0, 3),
        isLongGamma,
    };
}

// ── 4. MONTE CARLO DEALER STRATEGY SIMULATION ──
// Lightweight simulation: runs N paths of price movement with dealer hedging response
// Returns distribution of outcomes to estimate wall hold/break probabilities
function monteCarloWallTest(wall, F, er1Day, dte, isLongGamma, credibility, nSims) {
    if (!wall || er1Day <= 0) return null;
    nSims = nSims || 500; // Keep lightweight

    const dist = Math.abs(wall.strike - F);
    const isAbove = wall.strike > F;
    const dailyVol = er1Day / Math.sqrt(252); // Daily σ in $ terms
    const steps = Math.min(Math.ceil(dte), 5); // Simulate up to 5 days ahead

    // Dealer dampening factor: in Long γ, dealer hedging reduces realized vol
    const dampening = isLongGamma ? 0.65 : 1.20; // Long γ = dampened, Short γ = amplified
    const effectiveVol = dailyVol * dampening;

    // Credibility affects "wall absorption": high credibility = wall absorbs momentum
    const wallAbsorption = credibility ? credibility.score / 100 * 0.5 : 0.2;

    let wallHits = 0;
    let wallBreaks = 0;
    let bouncebacks = 0;
    let cascades = 0;
    let finalPrices = [];

    for (let sim = 0; sim < nSims; sim++) {
        let price = F;
        let hitWall = false;
        let brokeWall = false;

        for (let step = 0; step < steps; step++) {
            // Random walk with dealer hedging overlay
            const shock = gaussianRandom() * effectiveVol;

            // Dealer response near wall: dampens movement toward wall
            const distToWall = wall.strike - price;
            const nearWallFactor = Math.abs(distToWall) < er1Day * 0.3
                ? (1 - wallAbsorption * (1 - Math.abs(distToWall) / (er1Day * 0.3)))
                : 1.0;

            price += shock * nearWallFactor;

            // Check wall interaction
            if ((isAbove && price >= wall.strike) || (!isAbove && price <= wall.strike)) {
                hitWall = true;

                // Break or bounce? Based on momentum and credibility
                const momentum = Math.abs(shock) / effectiveVol;
                const breakThreshold = 1 - wallAbsorption - (isLongGamma ? 0.2 : -0.1);
                if (momentum > breakThreshold) {
                    brokeWall = true;
                    // Cascade: price continues through
                    price += shock * (isLongGamma ? 0.3 : 0.8); // Short γ = bigger cascade
                    cascades++;
                } else {
                    // Bounce back
                    price = wall.strike + (isAbove ? -1 : 1) * Math.abs(shock) * 0.5;
                    bouncebacks++;
                }
            }
        }

        if (hitWall) wallHits++;
        if (brokeWall) wallBreaks++;
        finalPrices.push(price);
    }

    // Compute statistics
    finalPrices.sort((a, b) => a - b);
    const median = finalPrices[Math.floor(nSims / 2)];
    const p10 = finalPrices[Math.floor(nSims * 0.1)];
    const p90 = finalPrices[Math.floor(nSims * 0.9)];

    const wallHitPct = (wallHits / nSims * 100);
    const wallBreakPct = wallHits > 0 ? (wallBreaks / wallHits * 100) : 0;
    const bouncePct = wallHits > 0 ? (bouncebacks / wallHits * 100) : 0;
    const cascadePct = wallHits > 0 ? (cascades / wallHits * 100) : 0;

    return {
        nSims, steps,
        wallHitPct: Math.round(wallHitPct),
        wallBreakPct: Math.round(wallBreakPct),
        bouncePct: Math.round(bouncePct),
        cascadePct: Math.round(cascadePct),
        medianPrice: median,
        range10_90: [p10, p90],
        summary: wallBreakPct > 50
            ? `Wall $${wall.strike} น่าจะ Break (${Math.round(wallBreakPct)}%)`
            : `Wall $${wall.strike} น่าจะ Hold (${Math.round(bouncePct)}% bounce)`,
    };
}

// Helper: Box-Muller transform for Gaussian random numbers
function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ── 5. MULTI-AGENT MODEL ──
// Models interaction between 3 agent types:
//   1. Dealers (hedgers): forced to hedge, stabilize in Long γ, amplify in Short γ
//   2. Speculators (trend followers): chase momentum, buy breakouts
//   3. Institutional (mean-reversion): scale in near walls, fade extremes
// Returns aggregate "market pressure" score
function calcMultiAgentPressure(F, oiStrikes, intradayStrikes, dte, isLongGamma, walls, er1Day) {
    if (!oiStrikes || oiStrikes.length === 0 || dte <= 0) return null;
    const t = dte / 365;
    const contractMultiplier = getProfile().contractMultiplier;

    // ── Agent 1: Dealer (Hedging Pressure) ──
    // Net delta the dealer needs to hedge today
    let dealerDelta = 0;
    for (const s of oiStrikes) {
        if (s.volSettle <= 0) continue;
        const cd = calcDelta(F, s.strike, s.volSettle, t, true);
        const pd = calcDelta(F, s.strike, s.volSettle, t, false);
        // Dealer is short options → hedge = buy delta for calls, sell delta for puts
        dealerDelta += (-cd * s.call + -pd * s.put) * contractMultiplier;
    }
    // Normalize to -1 to +1
    const adv = getProfile().defaultADV;
    const dealerPressure = Math.max(-1, Math.min(1, dealerDelta / adv * 10));

    // ── Agent 2: Speculator (Momentum Pressure) ──
    // Based on intraday volume imbalance: are specs buying calls or puts?
    let specPressure = 0;
    if (intradayStrikes && intradayStrikes.length > 0) {
        let callVol = 0, putVol = 0;
        for (const s of intradayStrikes) {
            // Weight by proximity to ATM (ATM volume = more directional intent)
            const dist = Math.abs(s.strike - F);
            const weight = dist < er1Day * 0.5 ? 2.0 : dist < er1Day ? 1.0 : 0.5;
            callVol += s.call * weight;
            putVol += s.put * weight;
        }
        const totalVol = callVol + putVol;
        if (totalVol > 0) {
            specPressure = (callVol - putVol) / totalVol; // +1 = all calls, -1 = all puts
        }
    }

    // ── Agent 3: Institutional (Mean-Reversion Pressure) ──
    // Institutions scale into walls (put walls = buy, call walls = sell)
    let instPressure = 0;
    const putWalls = walls.filter(w => w.strike < F);
    const callWalls = walls.filter(w => w.strike > F);

    // How much OI is "defending" each side?
    const putDefense = putWalls.reduce((sum, w) => sum + w.oi / Math.max(1, Math.abs(F - w.strike) / er1Day), 0);
    const callDefense = callWalls.reduce((sum, w) => sum + w.oi / Math.max(1, Math.abs(F - w.strike) / er1Day), 0);
    const totalDefense = putDefense + callDefense;
    if (totalDefense > 0) {
        instPressure = (putDefense - callDefense) / totalDefense; // +1 = support stronger, -1 = resistance stronger
    }

    // ── Combine agents with regime-dependent weights ──
    let dealerW, specW, instW;
    if (isLongGamma) {
        // Long γ: dealer dominates (stabilizing), inst follows, spec powerless
        dealerW = 0.50; specW = 0.15; instW = 0.35;
    } else {
        // Short γ: spec dominates (trend), dealer amplifies, inst gets run over
        dealerW = 0.25; specW = 0.45; instW = 0.30;
    }

    const netPressure = dealerPressure * dealerW + specPressure * specW + instPressure * instW;
    const netDirection = netPressure > 0.1 ? 'BULLISH' : netPressure < -0.1 ? 'BEARISH' : 'NEUTRAL';
    const netColor = netPressure > 0.1 ? 'var(--green)' : netPressure < -0.1 ? 'var(--red)' : 'var(--text-muted)';

    // Conflict detection: are agents fighting each other?
    const signs = [Math.sign(dealerPressure), Math.sign(specPressure), Math.sign(instPressure)];
    const allAgree = signs.every(s => s === signs[0]) || signs.every(s => s === 0);
    const majorConflict = (Math.sign(dealerPressure) !== 0 && Math.sign(specPressure) !== 0 && Math.sign(dealerPressure) !== Math.sign(specPressure));

    let consensus, consensusColor;
    if (allAgree && Math.abs(netPressure) > 0.3) {
        consensus = 'STRONG CONSENSUS';
        consensusColor = 'var(--green)';
    } else if (majorConflict) {
        consensus = 'CONFLICT (Dealer vs Spec)';
        consensusColor = 'var(--orange)';
    } else {
        consensus = 'MIXED';
        consensusColor = 'var(--text-muted)';
    }

    return {
        netPressure: Math.round(netPressure * 100) / 100,
        netDirection, netColor,
        agents: {
            dealer: { pressure: Math.round(dealerPressure * 100) / 100, weight: dealerW, label: dealerPressure > 0 ? 'Buy' : 'Sell' },
            speculator: { pressure: Math.round(specPressure * 100) / 100, weight: specW, label: specPressure > 0 ? 'Call Dominant' : 'Put Dominant' },
            institutional: { pressure: Math.round(instPressure * 100) / 100, weight: instW, label: instPressure > 0 ? 'Support Strong' : 'Resistance Strong' },
        },
        consensus, consensusColor,
        isLongGamma,
    };
}

// ── GAME THEORY: Aggregate Analysis ──
// Runs all GT models and returns a consolidated result for UI display
function calcGameTheoryAnalysis(d) {
    if (!d || !d.uPrice || !d.callWalls || !d.putWalls) return null;

    const allWalls = [...d.putWalls, ...d.callWalls];
    const oiStrikes = d.oiStrikes || null;

    // Wall Credibility for all walls
    const wallCredibilities = allWalls.map(w => ({
        wall: w,
        credibility: calcWallCredibility(w, allWalls, d.uPrice, d.dte, oiStrikes, d.sourceStrikes2),
    }));

    // Payoff Matrix for nearest walls
    const nearestCall = d.nearestCall || (d.callWalls.length > 0 ? d.callWalls[0] : null);
    const nearestPut = d.nearestPut || (d.putWalls.length > 0 ? d.putWalls[0] : null);

    let callPayoff = null, putPayoff = null;
    if (nearestCall) {
        const callCred = wallCredibilities.find(wc => wc.wall.strike === nearestCall.strike);
        if (callCred) {
            callPayoff = calcDealerPayoffMatrix(nearestCall, callCred.credibility, d.uPrice, d.er1Day, d.isLongGamma);
        }
    }
    if (nearestPut) {
        const putCred = wallCredibilities.find(wc => wc.wall.strike === nearestPut.strike);
        if (putCred) {
            putPayoff = calcDealerPayoffMatrix(nearestPut, putCred.credibility, d.uPrice, d.er1Day, d.isLongGamma);
        }
    }

    // Monte Carlo for nearest walls
    let callMC = null, putMC = null;
    if (nearestCall) {
        const callCred = wallCredibilities.find(wc => wc.wall.strike === nearestCall.strike);
        callMC = monteCarloWallTest(nearestCall, d.uPrice, d.er1Day, d.dte, d.isLongGamma, callCred?.credibility, 500);
    }
    if (nearestPut) {
        const putCred = wallCredibilities.find(wc => wc.wall.strike === nearestPut.strike);
        putMC = monteCarloWallTest(nearestPut, d.uPrice, d.er1Day, d.dte, d.isLongGamma, putCred?.credibility, 500);
    }

    return {
        wallCredibilities,
        callPayoff, putPayoff,
        callMC, putMC,
    };
}

// ========== MULTI-WALL DETECTION (Quant-Grade) ==========
// Finds ALL significant OI walls, clusters nearby strikes, and classifies by tier
// Returns array sorted by distance from price (nearest first)
function findSignificantWalls(strikes, uPrice, side, proximityRange) {
    if (proximityRange === undefined) proximityRange = getProfile().proximityRange;
    const oiKey = side === 'call' ? 'call' : 'put';
    // Filter to correct side of price
    const filtered = side === 'call'
        ? strikes.filter(s => s.strike > uPrice && s[oiKey] > 0)
        : strikes.filter(s => s.strike < uPrice && s[oiKey] > 0);

    if (filtered.length === 0) {
        // Absolute fallback if no strikes exist above/below uPrice
        const fallbackStrike = strikes.reduce((p, c) => (c[oiKey] || 0) > (p[oiKey] || 0) ? c : p, strikes[0]);
        if (!fallbackStrike) return []; // Truly empty
        const dist = Math.abs(fallbackStrike.strike - uPrice);
        return [{ strike: fallbackStrike.strike, oi: fallbackStrike[oiKey], tier: 'primary', dist, clusterOI: fallbackStrike[oiKey], clusterStrikes: [fallbackStrike.strike], isNearby: dist <= proximityRange }];
    }

    // Step 1: Find max OI for threshold calculations
    const maxOI = Math.max(...filtered.map(s => s[oiKey]));
    const avgOI = filtered.reduce((sum, s) => sum + s[oiKey], 0) / filtered.length;

    // Step 2: Filter to significant strikes (≥15% of max OI or ≥ 2× average)
    const significantThreshold = Math.max(maxOI * 0.15, avgOI * 2);
    const significant = filtered.filter(s => s[oiKey] >= significantThreshold);

    if (significant.length === 0) {
        // Fallback: take the top strike by OI
        const top = filtered.reduce((p, c) => c[oiKey] > p[oiKey] ? c : p);
        const dist = side === 'call' ? top.strike - uPrice : uPrice - top.strike;
        return [{ strike: top.strike, oi: top[oiKey], tier: 'primary', dist, clusterOI: top[oiKey], clusterStrikes: [top.strike], isNearby: dist <= proximityRange }];
    }

    // Step 3: Cluster adjacent strikes within $15 into wall zones
    const sorted = [...significant].sort((a, b) => a.strike - b.strike);
    const clusters = [];
    let cluster = { strikes: [sorted[0]], totalOI: sorted[0][oiKey] };

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].strike - sorted[i - 1].strike <= 15) {
            cluster.strikes.push(sorted[i]);
            cluster.totalOI += sorted[i][oiKey];
        } else {
            clusters.push(cluster);
            cluster = { strikes: [sorted[i]], totalOI: sorted[i][oiKey] };
        }
    }
    clusters.push(cluster);

    // Step 4: For each cluster, pick the representative strike (highest OI in cluster)
    const walls = clusters.map(cl => {
        const rep = cl.strikes.reduce((p, c) => c[oiKey] > p[oiKey] ? c : p);
        const dist = side === 'call' ? rep.strike - uPrice : uPrice - rep.strike;
        return {
            strike: rep.strike,
            oi: rep[oiKey],
            tier: 'tertiary', // will be upgraded below
            dist,
            clusterOI: cl.totalOI,
            clusterStrikes: cl.strikes.map(s => s.strike),
            clusterCount: cl.strikes.length,
            isNearby: dist <= proximityRange
        };
    });

    // Step 5: Classify tiers
    const maxClusterOI = Math.max(...walls.map(w => w.clusterOI));
    for (const w of walls) {
        if (w.clusterOI === maxClusterOI) w.tier = 'primary';
        else if (w.clusterOI >= maxClusterOI * 0.30) w.tier = 'secondary';
        // else stays 'tertiary'
    }

    // Step 6: Sort by distance from price (nearest first)
    walls.sort((a, b) => a.dist - b.dist);

    return walls;
}

// Convenience: get nearest and primary walls from wall array
function getWallSummary(walls) {
    if (walls.length === 0) return { nearest: null, primary: null, walls: [] };
    const nearest = walls[0]; // already sorted by distance
    const primary = walls.find(w => w.tier === 'primary') || walls[0];
    return { nearest, primary, walls };
}

// ========== BROKEN WALL DETECTION (Volume-Confirmed) ==========
// Detects OI walls that price has ALREADY passed through, confirmed by intraday volume
// Call broken wall = call OI cluster BELOW price (was resistance → now potential support)
// Put broken wall = put OI cluster ABOVE price (was support → now potential resistance)
// Returns array sorted by distance from price (nearest first)
function detectBrokenWalls(oiStrikes, intradayStrikes, uPrice, side, er1Day) {
    if (!oiStrikes || oiStrikes.length === 0) return [];
    const oiKey = side === 'call' ? 'call' : 'put';

    // Call: broken walls are call OI clusters BELOW price (price moved above them)
    // Put: broken walls are put OI clusters ABOVE price (price moved below them)
    const filtered = side === 'call'
        ? oiStrikes.filter(s => s.strike < uPrice && s[oiKey] > 0)
        : oiStrikes.filter(s => s.strike > uPrice && s[oiKey] > 0);
    if (filtered.length === 0) return [];

    // Only consider walls within reasonable distance (2× ER = recently broken)
    const maxDist = (er1Day || 50) * 2.5;
    const nearby = filtered.filter(s => {
        const dist = side === 'call' ? uPrice - s.strike : s.strike - uPrice;
        return dist > 0 && dist <= maxDist;
    });
    if (nearby.length === 0) return [];

    // Find significant OI (same thresholds as findSignificantWalls)
    const maxOI = Math.max(...nearby.map(s => s[oiKey]));
    const avgOI = nearby.reduce((sum, s) => sum + s[oiKey], 0) / nearby.length;
    const significantThreshold = Math.max(maxOI * 0.15, avgOI * 2);
    const significant = nearby.filter(s => s[oiKey] >= significantThreshold);
    if (significant.length === 0) {
        // Fallback: take the highest OI nearby
        const top = nearby.reduce((p, c) => c[oiKey] > p[oiKey] ? c : p);
        const dist = side === 'call' ? uPrice - top.strike : top.strike - uPrice;
        // Only include if OI is meaningful (> 50% of global max nearby)
        if (top[oiKey] < maxOI * 0.5) return [];
        return [buildBrokenEntry([top], top, oiKey, side, dist, intradayStrikes)];
    }

    // Cluster adjacent strikes within $15 (same as findSignificantWalls)
    const sorted = [...significant].sort((a, b) => a.strike - b.strike);
    const clusters = [];
    let cluster = { strikes: [sorted[0]], totalOI: sorted[0][oiKey] };
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].strike - sorted[i - 1].strike <= 15) {
            cluster.strikes.push(sorted[i]);
            cluster.totalOI += sorted[i][oiKey];
        } else {
            clusters.push(cluster);
            cluster = { strikes: [sorted[i]], totalOI: sorted[i][oiKey] };
        }
    }
    clusters.push(cluster);

    // Build broken wall entries
    const brokenWalls = clusters.map(cl => {
        const rep = cl.strikes.reduce((p, c) => c[oiKey] > p[oiKey] ? c : p);
        const dist = side === 'call' ? uPrice - rep.strike : rep.strike - uPrice;
        return buildBrokenEntry(cl.strikes, rep, oiKey, side, dist, intradayStrikes, cl.totalOI);
    });

    brokenWalls.sort((a, b) => a.dist - b.dist);
    return brokenWalls;
}

// Helper: build a single broken wall entry with volume confirmation
function buildBrokenEntry(clusterStrikes, rep, oiKey, side, dist, intradayStrikes, clusterOI) {
    const oi = rep[oiKey];
    const totalOI = clusterOI || oi;
    let volumeConf = 'none';
    let volRatio = 0;
    let intradayVol = 0;

    if (intradayStrikes && intradayStrikes.length > 0) {
        for (const cs of clusterStrikes) {
            const iMatch = intradayStrikes.find(is => is.strike === cs.strike);
            if (iMatch) intradayVol += (side === 'call' ? iMatch.call : iMatch.put);
        }
        volRatio = totalOI > 0 ? intradayVol / totalOI : 0;
        // Volume confirmation:
        // > 15% of OI traded today at this strike = STRONG (wall was actively absorbed)
        // > 5%  = MODERATE (decent flow through the wall)
        // > 2%  = WEAK (some activity)
        if (volRatio > 0.15) volumeConf = 'strong';
        else if (volRatio > 0.05) volumeConf = 'moderate';
        else if (volRatio > 0.02) volumeConf = 'weak';
    }

    return {
        strike: rep.strike, oi, clusterOI: totalOI,
        clusterStrikes: clusterStrikes.map(s => s.strike),
        dist, intradayVol, volRatio, volumeConf,
        newRole: side === 'call' ? 'support' : 'resistance'
    };
}

// ========== TRADE SETUP BUILDER (R:R Engine) ==========
// Builds a proper trade setup with directional TP filtering, volatility-scaled SL, and R:R grading
// direction: 'long' or 'short'
// entryStrike: the wall/level for entry
// allLevels: array of { strike, label, type } — all relevant levels (walls, maxpain, gamma mean, etc.)
// er1Day: expected 1-day range in $ terms
// dte: days to expiration (for SL scaling)
// walls: the put/call walls arrays for SL placement behind next wall
function buildTradeSetup(direction, entryStrike, allLevels, er1Day, dte, putWalls, callWalls) {
    const isLong = direction === 'long';

    // ── SL: place behind the next significant wall on the WRONG side ──
    // For LONG: SL = nearest put wall BELOW entry - buffer
    // For SHORT: SL = nearest call wall ABOVE entry + buffer
    const slBuffer = Math.max(er1Day * 0.3, 8); // volatility-scaled, min $8

    let slStrike;
    if (isLong) {
        // Find the nearest put wall BELOW entry (not AT entry)
        const wallsBelow = putWalls.filter(w => w.strike < entryStrike - 5).sort((a, b) => b.strike - a.strike);
        if (wallsBelow.length > 0) {
            slStrike = wallsBelow[0].strike - slBuffer;
        } else {
            // Fallback: use ER-based SL
            const slRange = Math.max(er1Day * 0.7, 15);
            slStrike = entryStrike - slRange;
        }
    } else {
        // Find the nearest call wall ABOVE entry (not AT entry)
        const wallsAbove = callWalls.filter(w => w.strike > entryStrike + 5).sort((a, b) => a.strike - b.strike);
        if (wallsAbove.length > 0) {
            slStrike = wallsAbove[0].strike + slBuffer;
        } else {
            const slRange = Math.max(er1Day * 0.7, 15);
            slStrike = entryStrike + slRange;
        }
    }
    slStrike = Math.round(slStrike);

    // ── TP: collect all levels on the CORRECT side, sorted by distance ──
    const tpCandidates = [];
    for (const lv of allLevels) {
        if (isLong && lv.strike > entryStrike + 3) {
            tpCandidates.push({ ...lv, dist: lv.strike - entryStrike });
        } else if (!isLong && lv.strike < entryStrike - 3) {
            tpCandidates.push({ ...lv, dist: entryStrike - lv.strike });
        }
    }
    tpCandidates.sort((a, b) => a.dist - b.dist);

    // Take top 3 TPs
    const tps = tpCandidates.slice(0, 3);

    // ── R:R Calculation ──
    const risk = Math.abs(entryStrike - slStrike);
    const reward = tps.length > 0 ? tps[0].dist : 0;
    const rr = risk > 0 ? reward / risk : 0;

    // ── Quality Grade ──
    let grade, gradeColor, gradeIcon, gradeLabel;
    if (rr >= 2.0) { grade = 'A'; gradeColor = 'var(--green)'; gradeIcon = '🟢'; gradeLabel = 'ดี'; }
    else if (rr >= 1.5) { grade = 'B'; gradeColor = '#ffd54f'; gradeIcon = '🟡'; gradeLabel = 'OK'; }
    else if (rr >= 1.0) { grade = 'C'; gradeColor = 'var(--orange)'; gradeIcon = '🟠'; gradeLabel = 'ระวัง'; }
    else { grade = 'F'; gradeColor = 'var(--red)'; gradeIcon = '🔴'; gradeLabel = 'ข้าม'; }

    // ── Trade Type Label by DTE ──
    let tradeType, tradeTypeIcon;
    if (dte <= 2) { tradeType = 'DAY TRADE'; tradeTypeIcon = '🎯'; }
    else if (dte <= 10) { tradeType = 'SWING'; tradeTypeIcon = '🌟'; }
    else { tradeType = 'POSITION'; tradeTypeIcon = '📈'; }

    return {
        direction, entryStrike, slStrike, tps, risk, reward, rr,
        grade, gradeColor, gradeIcon, gradeLabel,
        tradeType, tradeTypeIcon,
        isViable: rr >= 1.0
    };
}

// ========== BREAKDOWN RISK SCORE (0-100) ==========
function calcBreakdownRisk(oiStrikes, intradayStrikes, uPrice, dte, gexFlipStrike, er1Day) {
    const components = {
        gexFlip: { score: 0, max: 20, label: 'GEX Flip Distance', detail: '' },
        support: { score: 0, max: 20, label: 'Wall Strength (S/R)', detail: '' },
        volume: { score: 0, max: 20, label: 'Volume Anomaly', detail: '' },
        skew: { score: 0, max: 20, label: 'IV Skew Stress', detail: '' },
        gammaZone: { score: 0, max: 20, label: 'Gamma Zone', detail: '' },
    };
    let noMansLand = false;
    let noMansLandSide = ''; // 'above' or 'below'

    // --- 1. GEX Flip Distance (0-20) ---
    if (gexFlipStrike && er1Day > 0) {
        const distToFlip = Math.abs(uPrice - gexFlipStrike);
        const ratio = distToFlip / er1Day;
        if (ratio < 0.5) { components.gexFlip.score = 20; components.gexFlip.detail = `ใกล้มาก! $${gexFlipStrike} (${distToFlip.toFixed(0)} pts)`; }
        else if (ratio < 1.0) { components.gexFlip.score = 14; components.gexFlip.detail = `ใกล้ $${gexFlipStrike} (${distToFlip.toFixed(0)} pts)`; }
        else if (ratio < 2.0) { components.gexFlip.score = 6; components.gexFlip.detail = `ห่างพอสมควร $${gexFlipStrike}`; }
        else { components.gexFlip.score = 0; components.gexFlip.detail = `ห่างมาก $${gexFlipStrike}`; }
    } else {
        components.gexFlip.detail = 'ไม่มี Flip Point';
    }

    // --- 2. Wall Strength — weakest of Put Wall (support) vs Call Wall (resistance) (0-20) ---
    if (oiStrikes && oiStrikes.length > 0) {
        const evalWall = (strikes, side) => {
            if (strikes.length === 0) return { score: 20, detail: `ไม่มี ${side} Wall!` };
            const oiKey = side === 'Put' ? 'put' : 'call';
            const maxOI = Math.max(...strikes.map(s => s[oiKey]));
            const avgOI = strikes.reduce((sum, s) => sum + s[oiKey], 0) / strikes.length;
            const wallRatio = maxOI / Math.max(avgOI, 1);
            const significantWalls = strikes.filter(s => s[oiKey] > maxOI * 0.4).length;
            let score = 0, detail = '';
            if (wallRatio < 2) { score = 18; detail = `${side} Wall บางมาก (${wallRatio.toFixed(1)}×)`; }
            else if (wallRatio < 3.5) { score = 10; detail = `${side} Wall ปานกลาง (${wallRatio.toFixed(1)}×)`; }
            else { score = 2; detail = `${side} Wall หนา (${wallRatio.toFixed(1)}×)`; }
            if (significantWalls <= 1) { score = Math.min(20, score + 6); detail += ' ⚠️ Wall เดียว!'; }
            return { score, detail };
        };
        const putsBelow = oiStrikes.filter(s => s.strike < uPrice && s.put > 0);
        const callsAbove = oiStrikes.filter(s => s.strike > uPrice && s.call > 0);
        const putWall = evalWall(putsBelow, 'Put');
        const callWall = evalWall(callsAbove, 'Call');
        if (putWall.score >= callWall.score) {
            components.support.score = putWall.score;
            components.support.detail = `▼ ${putWall.detail} | ▲ ${callWall.detail}`;
        } else {
            components.support.score = callWall.score;
            components.support.detail = `▲ ${callWall.detail} | ▼ ${putWall.detail}`;
        }
    }

    // --- 3. Volume Anomaly — checks BOTH put and call vol surges (0-20) ---
    if (intradayStrikes && intradayStrikes.length > 0 && oiStrikes && oiStrikes.length > 0) {
        let totalPutVol = intradayStrikes.reduce((sum, s) => sum + s.put, 0);
        let totalCallVol = intradayStrikes.reduce((sum, s) => sum + s.call, 0);
        let totalPutOI = oiStrikes.reduce((sum, s) => sum + s.put, 0);
        let totalCallOI = oiStrikes.reduce((sum, s) => sum + s.call, 0);
        const putVolOIRatio = totalPutOI > 0 ? totalPutVol / totalPutOI : 0;
        const callVolOIRatio = totalCallOI > 0 ? totalCallVol / totalCallOI : 0;
        const maxRatio = Math.max(putVolOIRatio, callVolOIRatio);
        const dominantSide = putVolOIRatio >= callVolOIRatio ? 'Put' : 'Call';
        const otherSide = dominantSide === 'Put' ? 'Call' : 'Put';
        const otherRatio = dominantSide === 'Put' ? callVolOIRatio : putVolOIRatio;

        if (maxRatio > 0.5) { components.volume.score = 18; components.volume.detail = `${dominantSide} Vol/OI: ${(maxRatio * 100).toFixed(0)}% — ซื้อ ${dominantSide} ใหม่เยอะ!`; }
        else if (maxRatio > 0.3) { components.volume.score = 12; components.volume.detail = `${dominantSide} Vol/OI: ${(maxRatio * 100).toFixed(0)}% — ค่อนข้างสูง`; }
        else if (maxRatio > 0.15) { components.volume.score = 5; components.volume.detail = `${dominantSide} Vol/OI: ${(maxRatio * 100).toFixed(0)}% — ปกติ`; }
        else { components.volume.score = 0; components.volume.detail = `Vol/OI เบาทั้ง 2 ฝั่ง`; }

        components.volume.detail += ` (${otherSide}: ${(otherRatio * 100).toFixed(0)}%)`;
    } else {
        components.volume.detail = 'ไม่มี Intraday data';
    }

    // --- 4. IV Skew Stress — checks BOTH OTM put and OTM call skew (0-20) ---
    if (oiStrikes && oiStrikes.length > 0) {
        const atm = oiStrikes.reduce((p, c) => Math.abs(c.strike - uPrice) < Math.abs(p.strike - uPrice) ? c : p);
        const atmVol = atm.volSettle;

        if (atmVol > 0) {
            const otmPuts = oiStrikes.filter(s => {
                const pct = (uPrice - s.strike) / uPrice;
                return pct > 0.02 && pct < 0.08 && s.volSettle > 0;
            });
            const otmCalls = oiStrikes.filter(s => {
                const pct = (s.strike - uPrice) / uPrice;
                return pct > 0.02 && pct < 0.08 && s.volSettle > 0;
            });

            const putSkewRatio = otmPuts.length > 0
                ? otmPuts.reduce((sum, s) => sum + s.volSettle, 0) / otmPuts.length / atmVol : 1.0;
            const callSkewRatio = otmCalls.length > 0
                ? otmCalls.reduce((sum, s) => sum + s.volSettle, 0) / otmCalls.length / atmVol : 1.0;

            const maxSkew = Math.max(putSkewRatio, callSkewRatio);
            const skewSide = putSkewRatio >= callSkewRatio ? 'Put' : 'Call';
            const otherSkew = skewSide === 'Put' ? callSkewRatio : putSkewRatio;

            if (maxSkew > 1.4) { components.skew.score = 20; components.skew.detail = `${skewSide} Skew +${(maxSkew * 100 - 100).toFixed(0)}% — Extreme Fear!`; }
            else if (maxSkew > 1.2) { components.skew.score = 14; components.skew.detail = `${skewSide} Skew +${(maxSkew * 100 - 100).toFixed(0)}% — Fear สูง`; }
            else if (maxSkew > 1.05) { components.skew.score = 6; components.skew.detail = `${skewSide} Skew +${(maxSkew * 100 - 100).toFixed(0)}% — ปกติ`; }
            else { components.skew.score = 0; components.skew.detail = `Skew flat ทั้ง 2 ฝั่ง`; }

            const otherPct = ((otherSkew - 1) * 100).toFixed(0);
            const otherSideName = skewSide === 'Put' ? 'Call' : 'Put';
            components.skew.detail += ` (${otherSideName}: ${otherPct >= 0 ? '+' : ''}${otherPct}%)`;
        }
    }

    // --- 5. Gamma Zone — is price inside or outside the gamma concentration? (0-20) ---
    let gammaMean = null;
    let gammaZoneHigh = null;
    let gammaZoneLow = null;
    if (oiStrikes && oiStrikes.length > 0 && dte > 0) {
        const t = dte / 365;
        // Calculate gamma-weighted center and spread
        let totalGammaWeight = 0;
        let gammaWeightedSum = 0;
        let gammaByStrike = [];
        for (const s of oiStrikes) {
            const g = calcGamma(uPrice, s.strike, s.volSettle, t);
            const totalOI = s.call + s.put;
            const weight = g * totalOI;
            totalGammaWeight += weight;
            gammaWeightedSum += weight * s.strike;
            gammaByStrike.push({ strike: s.strike, gamma: weight });
        }

        if (totalGammaWeight > 0) {
            const gammaCenter = gammaWeightedSum / totalGammaWeight;
            gammaMean = gammaCenter;
            // Find CONTIGUOUS range containing >= 80% of gamma mass
            // Sort by strike, then use sliding window to find smallest contiguous interval
            gammaByStrike.sort((a, b) => a.strike - b.strike);
            const target = totalGammaWeight * 0.80;
            let bestLow = gammaByStrike[0].strike;
            let bestHigh = gammaByStrike[gammaByStrike.length - 1].strike;
            let bestWidth = bestHigh - bestLow;
            let left = 0;
            let windowSum = 0;
            for (let right = 0; right < gammaByStrike.length; right++) {
                windowSum += gammaByStrike[right].gamma;
                // Shrink from left while still >= target
                while (left < right && (windowSum - gammaByStrike[left].gamma) >= target) {
                    windowSum -= gammaByStrike[left].gamma;
                    left++;
                }
                if (windowSum >= target) {
                    const w = gammaByStrike[right].strike - gammaByStrike[left].strike;
                    if (w < bestWidth) {
                        bestWidth = w;
                        bestLow = gammaByStrike[left].strike;
                        bestHigh = gammaByStrike[right].strike;
                    }
                }
            }
            const gammaHigh = bestHigh;
            const gammaLow = bestLow;
            gammaZoneHigh = gammaHigh;
            gammaZoneLow = gammaLow;

            const priceDistFromCenter = Math.abs(uPrice - gammaCenter);
            const zoneWidth = gammaHigh - gammaLow;
            const isAboveZone = uPrice > gammaHigh;
            const isBelowZone = uPrice < gammaLow;
            const distOutside = isAboveZone ? (uPrice - gammaHigh) : isBelowZone ? (gammaLow - uPrice) : 0;

            if (isAboveZone || isBelowZone) {
                noMansLand = true;
                noMansLandSide = isAboveZone ? 'above' : 'below';
                const outsidePct = zoneWidth > 0 ? (distOutside / zoneWidth * 100).toFixed(0) : '∞';
                if (distOutside > er1Day) {
                    components.gammaZone.score = 20;
                    components.gammaZone.detail = `🚨 NO MAN'S LAND! ราคา${isAboveZone ? 'เหนือ' : 'ต่ำกว่า'}โซน Gamma $${distOutside.toFixed(0)} — Mean Reversion ไม่ทำงาน`;
                } else {
                    components.gammaZone.score = 14;
                    components.gammaZone.detail = `⚠️ ราคาออกนอก Gamma Zone — ${isAboveZone ? 'เหนือ' : 'ต่ำกว่า'} $${distOutside.toFixed(0)}`;
                }
            } else {
                components.gammaZone.score = 0;
                components.gammaZone.detail = `ราคาอยู่ใน Gamma Zone ($${gammaLow.toFixed(0)}–$${gammaHigh.toFixed(0)})`;
            }
            components.gammaZone.detail += ` | ศูนย์กลาง $${gammaCenter.toFixed(0)}`;
        }
    }

    const totalScore = components.gexFlip.score + components.support.score + components.volume.score + components.skew.score + components.gammaZone.score;

    let riskLevel = 'LOW';
    let riskColor = 'var(--green)';
    let riskIcon = '🟢';
    let positionAdv = '';
    if (totalScore >= 75) { riskLevel = 'EXTREME'; riskColor = '#ff1744'; riskIcon = '🔴'; positionAdv = 'หยุดเทรด / ปิด Position ทันที'; }
    else if (totalScore >= 55) { riskLevel = 'HIGH'; riskColor = 'var(--orange)'; riskIcon = '🟠'; positionAdv = 'ลดขนาด 50-75% / ย้าย SL ชิดขึ้น'; }
    else if (totalScore >= 35) { riskLevel = 'MODERATE'; riskColor = 'var(--accent)'; riskIcon = '🟡'; positionAdv = 'ระวัง / Position ปกติแต่ SL ต้องแน่น'; }
    else { positionAdv = 'สภาพปกติ / เทรดตาม Setup ได้'; }

    if (noMansLand) {
        positionAdv = `⛔ NO MAN'S LAND — ราคาออกนอก Gamma Zone (${noMansLandSide === 'above' ? 'ทะลุขึ้น' : 'หลุดลง'}). Mean Reversion ไม่ทำงาน! ห้าม fade, รอ OI update ใหม่`;
        if (riskLevel === 'LOW') { riskLevel = 'MODERATE'; riskColor = 'var(--accent)'; riskIcon = '🟡'; }
    }

    return { totalScore, riskLevel, riskColor, riskIcon, positionAdv, components, noMansLand, noMansLandSide, gammaMean, gammaZoneHigh, gammaZoneLow };
}

// ========== MARKET BIAS ENGINE (-100 to +100) ==========
// Synthesizes 10 quantitative signals into a single directional bias score
// Positive = Bullish, Negative = Bearish
function calcMarketBias(d) {
    const signals = [];
    let totalWeight = 0;
    let weightedSum = 0;
    let agreeCount = 0;
    let disagreeCount = 0;

    // Helper: add a signal
    const addSignal = (name, score, maxWeight, detail, icon) => {
        // score: -1 to +1 (bearish to bullish), scaled by maxWeight
        const weighted = score * maxWeight;
        signals.push({ name, score: weighted, max: maxWeight, rawScore: score, detail, icon, direction: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral' });
        totalWeight += maxWeight;
        weightedSum += weighted;
        if (score > 0.1) agreeCount++;
        else if (score < -0.1) disagreeCount++;
    };

    // ── 1. GEX Regime + Price Position (Weight: 20) ──
    // Long γ + below MP = bullish magnet pull / Long γ + above MP = bearish pull
    // Short γ = trend, bias depends on current momentum
    if (d.isLongGamma !== undefined) {
        let gexScore = 0;
        if (d.isLongGamma) {
            // Long γ = mean reversion → bias toward Max Pain
            if (d.priceBelowMP) gexScore = 0.7;       // below MP → pulled UP
            else if (d.priceAboveMP) gexScore = -0.7;  // above MP → pulled DOWN
            else gexScore = 0;                          // at MP = neutral
            // Dampening zone override
            if (d.priceAboveCallWall && d.isLongGamma) gexScore = -0.5; // dampening = bearish pressure
        } else {
            // Short γ = trend following → check broken walls + proximity
            if (d.priceAboveCallWall) gexScore = 0.8;    // breakout = bullish momentum
            else if (d.priceBelowPutWall) gexScore = -0.8; // breakdown = bearish momentum
            else if (d.biasScore > 0) gexScore = 0.3;    // weak momentum bias
            else if (d.biasScore < 0) gexScore = -0.3;
        }
        const gexDetail = d.isLongGamma
            ? `Long γ — ${d.priceBelowMP ? 'ราคาต่ำกว่า MP ดึงขึ้น' : d.priceAboveMP ? 'ราคาเหนือ MP ดึงลง' : 'ราคาที่ MP สมดุล'}`
            : `Short γ — ${d.priceAboveCallWall ? 'Breakout ขึ้น' : d.priceBelowPutWall ? 'Breakdown ลง' : 'รอ Trigger'}`;
        addSignal('GEX Regime', gexScore, 20, gexDetail, '🌊');
    }

    // ── 2. Vanna Direction (Weight: 15) ──
    // vannaExp < 0 → IV↑ causes dealers to BUY = bullish
    // vannaExp > 0 → IV↑ causes dealers to SELL = bearish
    if (d.vannaExp !== undefined && d.vannaExp !== 0) {
        const vannaContracts = Math.abs(d.vannaExp / (d.uPrice * 100));
        const adv = getProfile().defaultADV;
        const vannaPctAdv = vannaContracts / adv;
        // Scale: meaningful if > 0.5% ADV
        const magnitude = Math.min(1, vannaPctAdv / 0.03); // caps at 3% ADV
        const vannaScore = d.vannaExp < 0 ? magnitude : -magnitude;
        const vannaDir = d.vannaExp < 0 ? 'Dealers Buy (Bullish)' : 'Dealers Sell (Bearish)';
        addSignal('Vanna', vannaScore, 15, `IV↑ → ${vannaDir} ~${(vannaPctAdv * 100).toFixed(1)}% ADV`, '⚡');
    }

    // ── 3. Charm Direction (Weight: 10) ──
    // charmExp < 0 → time decay causes dealers to BUY = bullish
    // charmExp > 0 → time decay causes dealers to SELL = bearish
    if (d.charmExp !== undefined && d.charmExp !== 0) {
        const charmContracts = Math.abs(d.charmExp / (d.uPrice * 100));
        const adv = getProfile().defaultADV;
        const charmPctAdv = charmContracts / adv;
        const magnitude = Math.min(1, charmPctAdv / 0.02);
        const charmScore = d.charmExp < 0 ? magnitude : -magnitude;
        const charmDir = d.charmExp < 0 ? 'Dealers Buy (Bullish)' : 'Dealers Sell (Bearish)';
        addSignal('Charm', charmScore, 10, `Theta → ${charmDir} ~${(charmPctAdv * 100).toFixed(1)}% ADV`, '⏱️');
    }

    // ── 4. P/C Ratio (Weight: 10) ──
    if (d.pcr !== undefined && d.pcr > 0) {
        let pcrScore = 0;
        let pcrDetail = '';
        if (d.pcr < 0.6) { pcrScore = 1.0; pcrDetail = `PCR ${d.pcr.toFixed(2)} — Call dominant สุดขั้ว`; }
        else if (d.pcr < 0.8) { pcrScore = 0.6; pcrDetail = `PCR ${d.pcr.toFixed(2)} — Call dominant`; }
        else if (d.pcr < 0.95) { pcrScore = 0.2; pcrDetail = `PCR ${d.pcr.toFixed(2)} — เอียง Call เล็กน้อย`; }
        else if (d.pcr <= 1.05) { pcrScore = 0; pcrDetail = `PCR ${d.pcr.toFixed(2)} — สมดุล`; }
        else if (d.pcr <= 1.2) { pcrScore = -0.2; pcrDetail = `PCR ${d.pcr.toFixed(2)} — เอียง Put เล็กน้อย`; }
        else if (d.pcr <= 1.5) { pcrScore = -0.6; pcrDetail = `PCR ${d.pcr.toFixed(2)} — Put dominant`; }
        else { pcrScore = -1.0; pcrDetail = `PCR ${d.pcr.toFixed(2)} — Put dominant สุดขั้ว`; }
        addSignal('P/C Ratio', pcrScore, 10, pcrDetail, '📊');
    }

    // ── 5. Price vs Max Pain (Weight: 10) ──
    if (d.mpStrike && d.uPrice > 0 && d.er1Day > 0) {
        const distToMP = d.uPrice - d.mpStrike;
        const distRatio = distToMP / d.er1Day; // normalized by ER
        // Below MP = bullish (magnet pull up), above = bearish
        let mpScore = 0;
        if (distRatio < -1.5) mpScore = 1.0;
        else if (distRatio < -0.5) mpScore = 0.6;
        else if (distRatio < -0.1) mpScore = 0.2;
        else if (distRatio <= 0.1) mpScore = 0;
        else if (distRatio <= 0.5) mpScore = -0.2;
        else if (distRatio <= 1.5) mpScore = -0.6;
        else mpScore = -1.0;
        const mpDir = distToMP > 0 ? `เหนือ MP +${distToMP.toFixed(0)} (ดึงลง)` : `ต่ำกว่า MP ${distToMP.toFixed(0)} (ดึงขึ้น)`;
        addSignal('Max Pain', mpScore, 10, `$${d.mpStrike} — ${mpDir}`, '🎯');
    }

    // ── 6. Volume GEX Confirmation (Weight: 10) ──
    if (d.volGEXResult && d.volGEXResult.confidence !== 'NO_DATA') {
        let volScore = 0;
        const vg = d.volGEXResult;
        if (vg.confidence === 'CONFIRMED') {
            // Intraday confirms OI regime
            volScore = vg.volumeGEX >= 0 ? 0.6 : -0.6; // Call-dominant intraday = bullish
        } else if (vg.confidence === 'DIVERGING') {
            // Intraday contradicts OI — future regime shift signal
            volScore = vg.volumeGEX >= 0 ? 0.4 : -0.4;
        } else if (vg.confidence === 'LOW_VOLUME') {
            volScore = 0; // no signal
        }
        const volDetail = vg.detail || `Vol/OI: ${(vg.volOIRatio * 100).toFixed(0)}%`;
        addSignal('Volume Flow', volScore, 10, volDetail, '📈');
    }

    // ── 7. Broken Walls (Weight: 10) ──
    const bestBrokenCall = (d.brokenCallWalls || []).find(bw => bw.volumeConf === 'strong' || bw.volumeConf === 'moderate');
    const bestBrokenPut = (d.brokenPutWalls || []).find(bw => bw.volumeConf === 'strong' || bw.volumeConf === 'moderate');
    if (bestBrokenCall || bestBrokenPut) {
        let brokenScore = 0;
        let brokenDetail = '';
        if (bestBrokenCall && !bestBrokenPut) {
            brokenScore = bestBrokenCall.volumeConf === 'strong' ? 1.0 : 0.6;
            brokenDetail = `Call Wall $${bestBrokenCall.strike} ทะลุแล้ว → New Support (${bestBrokenCall.volumeConf})`;
        } else if (bestBrokenPut && !bestBrokenCall) {
            brokenScore = bestBrokenPut.volumeConf === 'strong' ? -1.0 : -0.6;
            brokenDetail = `Put Wall $${bestBrokenPut.strike} หลุดแล้ว → New Resistance (${bestBrokenPut.volumeConf})`;
        } else {
            // Both broken — net out
            const callStr = bestBrokenCall.volumeConf === 'strong' ? 1.0 : 0.6;
            const putStr = bestBrokenPut.volumeConf === 'strong' ? 1.0 : 0.6;
            brokenScore = (callStr - putStr) * 0.5;
            brokenDetail = `ทั้ง Call ($${bestBrokenCall.strike}) และ Put ($${bestBrokenPut.strike}) ถูกทะลุ`;
        }
        addSignal('Broken Walls', brokenScore, 10, brokenDetail, '🔥');
    } else {
        addSignal('Broken Walls', 0, 10, 'ไม่มี Wall ถูกทะลุ', '🔥');
    }

    // ── 8. Wall Asymmetry (Weight: 5) ──
    // Stronger put walls (support) = bullish, stronger call walls (resistance) = bearish  
    if (d.putWalls && d.callWalls && d.putWalls.length > 0 && d.callWalls.length > 0) {
        const putOI = d.putWalls.reduce((sum, w) => sum + w.clusterOI, 0);
        const callOI = d.callWalls.reduce((sum, w) => sum + w.clusterOI, 0);
        const totalOI = putOI + callOI;
        if (totalOI > 0) {
            const putPct = putOI / totalOI;
            // putPct > 0.5 = more support = bullish; < 0.5 = more resistance = bearish
            const asymScore = (putPct - 0.5) * 4; // scale: 0.5 → 0, 0.75 → 1, 0.25 → -1
            const clampedScore = Math.max(-1, Math.min(1, asymScore));
            const wallDetail = putPct > 0.55 ? `Support หนากว่า (Put ${(putPct * 100).toFixed(0)}%)` :
                putPct < 0.45 ? `Resistance หนากว่า (Call ${((1 - putPct) * 100).toFixed(0)}%)` : 'สมดุล';
            addSignal('Wall Asymmetry', clampedScore, 5, wallDetail, '🧱');
        }
    }

    // ── 9. IV Skew (Weight: 5) ──
    // High put skew = fear = bearish tail risk → bearish bias
    // High call skew = upside demand → bullish bias
    if (d.risk && d.risk.components && d.risk.components.skew) {
        const skewDetail = d.risk.components.skew.detail || '';
        let skewScore = 0;
        if (skewDetail.includes('Put Skew')) {
            skewScore = d.risk.components.skew.score > 12 ? -0.8 : d.risk.components.skew.score > 5 ? -0.4 : -0.1;
        } else if (skewDetail.includes('Call Skew')) {
            skewScore = d.risk.components.skew.score > 12 ? 0.8 : d.risk.components.skew.score > 5 ? 0.4 : 0.1;
        }
        addSignal('IV Skew', skewScore, 5, skewDetail || 'Flat', '📐');
    }

    // ── 10. Gamma Zone Position (Weight: 5) ──
    if (d.risk && d.risk.gammaMean && d.uPrice > 0) {
        const distFromCenter = d.uPrice - d.risk.gammaMean;
        const er = d.er1Day || 50;
        const normDist = distFromCenter / er;
        // Below center = revert up = bullish, above = revert down = bearish
        let gammaScore = 0;
        if (d.risk.noMansLand) {
            // Outside gamma zone = strong directional signal
            gammaScore = d.risk.noMansLandSide === 'above' ? 0.8 : -0.8; // above = momentum UP, below = momentum DOWN
            // In no-man's-land, mean reversion doesn't work, so momentum wins
        } else {
            gammaScore = Math.max(-1, Math.min(1, -normDist * 0.8)); // below center = positive
        }
        const gammaDetail = d.risk.noMansLand
            ? `No Man's Land — ${d.risk.noMansLandSide === 'above' ? 'เหนือ Gamma Zone' : 'ต่ำกว่า Gamma Zone'}`
            : `${distFromCenter > 0 ? 'เหนือ' : 'ต่ำกว่า'} Gamma Mean ${Math.abs(distFromCenter).toFixed(0)} pts`;
        addSignal('Gamma Zone', gammaScore, 5, gammaDetail, '🔵');
    }

    // ── 11. Game Theory: Multi-Agent Consensus (Weight: 10) ──
    if (d.multiAgent) {
        const ma = d.multiAgent;
        const maScore = Math.max(-1, Math.min(1, ma.netPressure * 2));
        let maDetail = `${ma.consensus} — `;
        maDetail += `Dealer: ${ma.agents.dealer.label} | Spec: ${ma.agents.speculator.label} | Inst: ${ma.agents.institutional.label}`;
        addSignal('Agent Model', maScore, 10, maDetail, '🎮');
    }

    // ── 12. Game Theory: Wall Credibility Asymmetry (Weight: 5) ──
    if (d.gameTheory && d.gameTheory.wallCredibilities && d.gameTheory.wallCredibilities.length > 0) {
        const wcs = d.gameTheory.wallCredibilities;
        const putCreds = wcs.filter(wc => wc.wall.strike < d.uPrice);
        const callCreds = wcs.filter(wc => wc.wall.strike > d.uPrice);
        const avgPutCred = putCreds.length > 0 ? putCreds.reduce((s, wc) => s + wc.credibility.score, 0) / putCreds.length : 50;
        const avgCallCred = callCreds.length > 0 ? callCreds.reduce((s, wc) => s + wc.credibility.score, 0) / callCreds.length : 50;
        // More credible support = bullish, more credible resistance = bearish
        const credDiff = (avgPutCred - avgCallCred) / 100;
        const credScore = Math.max(-1, Math.min(1, credDiff * 2));
        const credDetail = `Support Cred: ${avgPutCred.toFixed(0)} | Resistance Cred: ${avgCallCred.toFixed(0)}`;
        addSignal('Wall Credibility', credScore, 5, credDetail, '🏰');
    }

    // ── Regime-Adaptive Weight Adjustment ──
    // Long γ: boost Max Pain + Wall Asymmetry weights, reduce Momentum signals
    // Short γ: boost Broken Walls + Volume Flow, reduce Mean-Reversion signals
    if (d.isLongGamma !== undefined) {
        for (const sig of signals) {
            if (d.isLongGamma) {
                // Long γ = mean reversion dominant
                if (sig.name === 'Max Pain') { weightedSum += sig.score * 0.3; totalWeight += sig.max * 0.3; }
                if (sig.name === 'Wall Asymmetry' || sig.name === 'Wall Credibility') { weightedSum += sig.score * 0.4; totalWeight += sig.max * 0.4; }
                if (sig.name === 'Broken Walls') { weightedSum -= sig.score * 0.2; totalWeight += sig.max * 0.2; }
            } else {
                // Short γ = trend dominant
                if (sig.name === 'Broken Walls') { weightedSum += sig.score * 0.4; totalWeight += sig.max * 0.4; }
                if (sig.name === 'Volume Flow') { weightedSum += sig.score * 0.3; totalWeight += sig.max * 0.3; }
                if (sig.name === 'Max Pain') { weightedSum -= sig.score * 0.3; totalWeight += sig.max * 0.3; }
            }
        }
    }

    // ── Aggregate ──
    const finalScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;
    const clampedFinal = Math.max(-100, Math.min(100, finalScore));

    // Count direction agreement
    const bullishCount = signals.filter(s => s.rawScore > 0.1).length;
    const bearishCount = signals.filter(s => s.rawScore < -0.1).length;
    const neutralCount = signals.filter(s => Math.abs(s.rawScore) <= 0.1).length;
    const dominantCount = Math.max(bullishCount, bearishCount);
    const activeSignals = bullishCount + bearishCount;

    let confidence, confColor, confIcon;
    if (dominantCount >= 7) { confidence = 'HIGH'; confColor = 'var(--green)'; confIcon = '🟢'; }
    else if (dominantCount >= 5) { confidence = 'MEDIUM'; confColor = 'var(--accent)'; confIcon = '🟡'; }
    else { confidence = 'LOW'; confColor = 'var(--text-muted)'; confIcon = '⚪'; }

    // Label + color + icon
    let label, color, icon;
    if (clampedFinal >= 50) { label = 'STRONG BUY'; color = '#00e676'; icon = '🟢'; }
    else if (clampedFinal >= 20) { label = 'BUY'; color = 'var(--green)'; icon = '🔼'; }
    else if (clampedFinal >= 5) { label = 'LEAN BUY'; color = '#66bb6a'; icon = '↗️'; }
    else if (clampedFinal >= -5) { label = 'NEUTRAL'; color = 'var(--text-secondary)'; icon = '➖'; }
    else if (clampedFinal >= -20) { label = 'LEAN SELL'; color = '#ef9a9a'; icon = '↘️'; }
    else if (clampedFinal >= -50) { label = 'SELL'; color = 'var(--red)'; icon = '🔽'; }
    else { label = 'STRONG SELL'; color = '#ff1744'; icon = '🔴'; }

    return {
        score: clampedFinal, label, color, icon,
        confidence, confColor, confIcon,
        bullishCount, bearishCount, neutralCount,
        signals
    };
}

// ========== PARSE ==========
function parseVol2VolData(text) {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const header = lines[0];
    const dteMatch = header.match(/\(([\d.]+)\s*DTE\)/);
    const priceMatch = header.match(/FutPrc:\s+([\d.]+)/) || header.match(/vs\s+([\d.]+)/);
    const changeMatches = header.match(/\(([+-]?[\d.]+)\)/g);
    const typeMatch = header.match(/- (.+)$/);

    let contract = '';
    const symMatch = header.match(/Option Symbol:\s*(\S+)/);
    const cMatch1 = header.match(/Contract:\s+(\S+)/);
    const cMatch2 = header.match(/\)\s+(\S+)\s+\(/);

    if (symMatch) contract = symMatch[1];
    else if (cMatch1) contract = cMatch1[1];
    else if (cMatch2) contract = cMatch2[1];

    const dte = dteMatch ? parseFloat(dteMatch[1]) : 0;
    const underlying = priceMatch ? parseFloat(priceMatch[1]) : 0;
    let change = 0;
    if (changeMatches && changeMatches.length >= 2) {
        change = parseFloat(changeMatches[changeMatches.length - 1].replace(/[()]/g, ''));
    }
    const dataType = typeMatch ? typeMatch[1].trim() : '';

    // Extract Header Totals (Fix for missing tail data)
    // Header: ... Put: 4,827 Call: 4,131 ...
    const putTotalMatch = header.match(/Put:\s+([\d,]+)/);
    const callTotalMatch = header.match(/Call:\s+([\d,]+)/);
    const totalPut = putTotalMatch ? parseInt(putTotalMatch[1].replace(/,/g, '')) : undefined;
    const totalCall = callTotalMatch ? parseInt(callTotalMatch[1].replace(/,/g, '')) : undefined;

    const strikes = [];
    for (let i = 2; i < lines.length; i++) {
        const p = lines[i].split(',');
        if (p.length >= 4) {
            strikes.push({
                strike: parseFloat(p[0]),
                call: parseInt(p[1].replace(/,/g, '')),
                put: parseInt(p[2].replace(/,/g, '')),
                volSettle: parseFloat(p[3]),
                total: parseInt(p[1].replace(/,/g, '')) + parseInt(p[2].replace(/,/g, '')),
            });
        }
    }

    // Check if underlying is valid (sometimes it's 0 if header regex failed)
    let finalUnderlying = underlying;
    let underlyingIsFallback = false;
    if (finalUnderlying === 0 && strikes.length > 0) {
        // Fallback: use median strike
        const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
        const mid = Math.floor(sorted.length / 2);
        finalUnderlying = sorted[mid].strike;
        underlyingIsFallback = true;
    }

    return { header, dte, underlying: finalUnderlying, underlyingIsFallback, change, dataType, contract, strikes, totalPut, totalCall };
}

// ========== FETCH ==========
async function fetchTabData(tabKey) {
    const cfg = getProfile().contracts[tabKey];
    if (!cfg.intradayUrl && !cfg.oiUrl) {
        state.data[tabKey] = { intraday: null, oi: null };
        return;
    }
    try {
        const ts = Date.now();
        const promises = [];
        promises.push(cfg.intradayUrl ? fetch(cfg.intradayUrl + '?t=' + ts) : Promise.resolve(null));
        promises.push(cfg.oiUrl ? fetch(cfg.oiUrl + '?t=' + ts) : Promise.resolve(null));
        const [intRes, oiRes] = await Promise.all(promises);
        state.data[tabKey] = {
            intraday: intRes?.ok ? parseVol2VolData(await intRes.text()) : null,
            oi: oiRes?.ok ? parseVol2VolData(await oiRes.text()) : null,
        };
    } catch (e) {
        console.error(`Fetch error (${tabKey}):`, e);
    }
}

// ========== RENDER ROWS ==========
function renderPanel(containerId, data, hotThreshold) {
    const container = document.getElementById(containerId);
    if (!data?.strikes) {
        container.innerHTML = '<div class="placeholder-msg"><div class="icon">📊</div><div class="desc">No data available</div></div>';
        return;
    }
    // Use globalUnderlying (from Current contract) for consistency with Trade Setup
    let globalUnderlying = 0;
    if (state.data.current?.oi?.underlying) globalUnderlying = state.data.current.oi.underlying;
    else if (state.data.monthly?.oi?.underlying) globalUnderlying = state.data.monthly.oi.underlying;
    else if (state.data.friday?.oi?.underlying) globalUnderlying = state.data.friday.oi.underlying;
    const underlying = globalUnderlying > 0 ? globalUnderlying : data.underlying;
    const filtered = data.strikes.filter(s =>
        s.strike >= underlying - getProfile().visibleStrikeRange &&
        s.strike <= underlying + getProfile().visibleStrikeRange &&
        s.total >= hotThreshold
    );
    if (filtered.length === 0) {
        container.innerHTML = '<div class="placeholder-msg"><div class="icon">📭</div><div class="desc">No data in visible range matching filters</div></div>';
        return;
    }

    let maxCallStrike = null;
    let maxPutStrike = null;
    let maxCallVal = 0;
    let maxPutVal = 0;
    let maxSingle = 1;

    for (const s of filtered) {
        if (s.call > maxCallVal) { maxCallVal = s.call; maxCallStrike = s; }
        if (s.put > maxPutVal) { maxPutVal = s.put; maxPutStrike = s; }
        maxSingle = Math.max(maxSingle, s.call, s.put);
    }

    filtered.sort((a, b) => b.strike - a.strike);
    const closestStrike = filtered.reduce((prev, curr) =>
        Math.abs(curr.strike - underlying) < Math.abs(prev.strike - underlying) ? curr : prev, filtered[0]);

    // Grid header
    let html = '<div class="grid-header">' +
        '<span class="h-put">OTM Δ</span>' +
        '<span class="h-put h-right">Put</span>' +
        '<span></span>' +
        '<span>Strike</span>' +
        '<span></span>' +
        '<span class="h-call h-left">Call</span>' +
        '<span class="h-call">OTM Δ</span>' +
        '<span class="h-right">Total</span>' +
        '</div>';

    for (const s of filtered) {
        const isATM = s === closestStrike;
        const isHot = !isATM && s.total >= hotThreshold;

        const isMaxCall = s === maxCallStrike && s.call > 0;
        const isMaxPut = s === maxPutStrike && s.put > 0;

        let rowCls = 'row';
        if (isATM) rowCls += ' atm';
        else if (isHot) rowCls += ' hot';

        // Strike color
        let strikeStyle = '';
        if (isATM) {
            strikeStyle = 'color:#ffffff;font-weight:800;font-size:12px;';
        } else if (s.strike > underlying) {
            strikeStyle = 'color:var(--green);';
        } else {
            strikeStyle = 'color:var(--red);';
        }

        let strikeCls = 'row-strike';
        if (isATM) strikeCls += ' atm';
        else if (isHot) strikeCls += ' hot';

        let callCls = 'row-call';
        if (isMaxCall) callCls += ' max-call';

        let putCls = 'row-put';
        if (isMaxPut) putCls += ' max-put';

        // Bar width as percentage of container (use 100% max)
        const callPct = Math.max(0, (s.call / maxSingle) * 100);
        const putPct = Math.max(0, (s.put / maxSingle) * 100);

        // Delta
        const t = data.dte / 365;
        const callDeltaRaw = calcDelta(underlying, s.strike, s.volSettle, t, true);
        const putDeltaRaw = calcDelta(underlying, s.strike, s.volSettle, t, false);

        // Convention A: left = |Put Δ|, right = Call Δ (actual delta each side)
        const callDeltaStr = Math.round(callDeltaRaw * 100);
        const putDeltaStr = Math.round(Math.abs(putDeltaRaw) * 100);

        html += `<div class="${rowCls}">` +
            `<span class="row-delta-put">${putDeltaStr}</span>` +
            `<span class="${putCls}">${s.put > 0 ? s.put.toLocaleString() : ''}</span>` +
            `<div class="row-bar-put">${s.put > 0 ? `<div class="bar bar-put" style="width:${putPct}%"></div>` : ''}</div>` +
            `<span class="${strikeCls}" style="${strikeStyle}">${s.strike}</span>` +
            `<div class="row-bar-call">${s.call > 0 ? `<div class="bar bar-call" style="width:${callPct}%"></div>` : ''}</div>` +
            `<span class="${callCls}">${s.call > 0 ? s.call.toLocaleString() : ''}</span>` +
            `<span class="row-delta-call">${callDeltaStr}</span>` +
            `<span class="row-total ${isHot || (isATM && s.total >= hotThreshold) ? 'high' : ''}">${s.total.toLocaleString()}</span>` +
            `</div>`;
    }
    container.innerHTML = html;
}

// ========== UPDATE SUMMARY ==========
function updateSummary(intraday, oi) {
    const data = oi || intraday;
    if (!data) return;

    // Sync underlying price across all timeframes (same logic as Trade Setup)
    // All contracts map to the same underlying future (e.g. GCJ6)
    let globalUnderlying = 0;
    if (state.data.current?.oi?.underlying) globalUnderlying = state.data.current.oi.underlying;
    else if (state.data.monthly?.oi?.underlying) globalUnderlying = state.data.monthly.oi.underlying;
    else if (state.data.friday?.oi?.underlying) globalUnderlying = state.data.friday.oi.underlying;
    const uPrice = globalUnderlying > 0 ? globalUnderlying : data.underlying;

    // Header info
    document.getElementById('contractName').textContent = getProfile().label;
    document.getElementById('contractDetail').textContent = data.contract || '';
    document.getElementById('priceDisplay').textContent = uPrice.toFixed(1);
    const ce = document.getElementById('priceChange');
    ce.textContent = `${data.change >= 0 ? '+' : ''}${data.change.toFixed(1)}`;
    ce.className = `price-change ${data.change >= 0 ? 'up' : 'down'}`;
    document.getElementById('dteBadge').textContent = `DTE ${data.dte.toFixed(2)}`;
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('th-TH');
    document.getElementById('footerContract').textContent = data.contract || '';

    // Vol Settle & Expected Range
    if (intraday?.strikes) {
        const atm = intraday.strikes.reduce((p, c) =>
            Math.abs(c.strike - uPrice) < Math.abs(p.strike - uPrice) ? c : p);
        if (atm.volSettle > 0) {
            document.getElementById('sumVolSettle').textContent = (atm.volSettle * 100).toFixed(2) + '%';
            const er = uPrice * atm.volSettle * Math.sqrt(data.dte / 365);
            document.getElementById('sumExpRange').textContent = `±${er.toFixed(1)}`;
            document.getElementById('sumExpRangePrices').textContent =
                `$${(uPrice - er).toFixed(0)} – $${(uPrice + er).toFixed(0)}`;
        }
        document.getElementById('footerDataType').textContent = intraday.dataType || '';
    }

    // OI stats
    if (oi?.strikes) {
        const mx = oi.strikes.reduce((p, c) => c.total > p.total ? c : p);
        document.getElementById('sumMaxOI').textContent = mx.strike.toString();
        document.getElementById('sumMaxOIDetail').textContent = `Total: ${mx.total} (C:${mx.call} P:${mx.put})`;

        // Use Header Totals if available (more accurate), else sum rows
        let tc = 0, tp = 0;
        if (oi.totalCall !== undefined && oi.totalPut !== undefined) {
            tc = oi.totalCall;
            tp = oi.totalPut;
        } else {
            oi.strikes.forEach(s => { tc += s.call; tp += s.put; });
        }

        document.getElementById('sumTotalCall').textContent = tc.toLocaleString();
        document.getElementById('sumTotalPut').textContent = tp.toLocaleString();
        document.getElementById('sumPCRatio').textContent = tc > 0 ? (tp / tc).toFixed(2) : '—';

        // Max Pain
        const mpStrike = calcMaxPain(oi.strikes);
        if (mpStrike !== null) {
            document.getElementById('sumMaxPain').textContent = mpStrike.toString();
            const dist = uPrice - mpStrike;
            const distStr = dist >= 0 ? `+${dist.toFixed(0)}` : dist.toFixed(0);
            document.getElementById('sumMaxPainDetail').textContent = `Dist: ${distStr} from price`;
        }

        // Net GEX (use synced underlying price — same as Trade Setup)
        const gexResult = calcNetGEX(oi.strikes, uPrice, data.dte);
        const gexVal = gexResult.netGEX;
        const gexEl = document.getElementById('sumNetGEX');
        if (gexVal > 0) {
            gexEl.textContent = '+' + (gexVal / 1e6).toFixed(1) + 'M';
            gexEl.className = 'summary-value val-green';
            document.getElementById('sumNetGEXDetail').textContent = 'Long Gamma (Stable)';
        } else {
            gexEl.textContent = (gexVal / 1e6).toFixed(1) + 'M';
            gexEl.className = 'summary-value' + (gexVal < 0 ? ' bear' : '');
            gexEl.style.color = 'var(--red)';
            document.getElementById('sumNetGEXDetail').textContent = 'Short Gamma (Volatile)';
        }

        // Institutional Hedge Analysis
        // Splits total OI into 3 delta buckets:
        //   ITM  (|Δ|>0.70): institutional hedges / deep-in-the-money
        //   ATM  (0.30-0.70): near-money, mixed
        //   OTM  (|Δ|<0.30): speculative / lottery tickets
        const t_h = Math.max(data.dte, 0.01) / 365;
        let itmOI = 0, atmOI_h = 0, otmOI = 0;
        oi.strikes.forEach(s => {
            const cd = calcDelta(uPrice, s.strike, s.volSettle, t_h, true);
            const pd = Math.abs(calcDelta(uPrice, s.strike, s.volSettle, t_h, false));
            itmOI += (cd > 0.70 ? s.call : 0) + (pd > 0.70 ? s.put : 0);
            atmOI_h += (cd >= 0.30 && cd <= 0.70 ? s.call : 0) + (pd >= 0.30 && pd <= 0.70 ? s.put : 0);
            otmOI += (cd < 0.30 ? s.call : 0) + (pd < 0.30 ? s.put : 0);
        });
        const totalHedgeOI = (itmOI + atmOI_h + otmOI) || 1;
        const itmPct = itmOI / totalHedgeOI * 100;
        const atmPct = atmOI_h / totalHedgeOI * 100;
        const otmPct = otmOI / totalHedgeOI * 100;
        const hedgeEl = document.getElementById('sumHedgePct');
        hedgeEl.textContent = itmPct.toFixed(0) + '% ITM';
        hedgeEl.style.color = itmPct > 40 ? 'var(--orange)' : itmPct > 20 ? 'var(--text-primary)' : 'var(--cyan)';
        document.getElementById('hedgeBarITM').style.flex = itmPct.toString();
        document.getElementById('hedgeBarATM').style.flex = atmPct.toString();
        document.getElementById('hedgeBarOTM').style.flex = otmPct.toString();
        const hedgeLabel = itmPct > 40 ? 'Heavy Hedge' : itmPct > 20 ? 'Moderate Hedge' : 'Spec-Driven';
        document.getElementById('sumHedgeDetail').textContent = `${hedgeLabel} | OTM ${otmPct.toFixed(0)}%`;
    }
}

// ========== TAB SWITCH ==========
async function switchTab(tabKey) {
    state.activeTab = tabKey;
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tabKey);
    });

    const mainContainer = document.getElementById('mainContainer');
    const chartContainer = document.getElementById('chartContainer');
    const summaryStrip = document.getElementById('summaryStrip');

    if (tabKey === 'chart') {
        mainContainer.classList.add('hide-main');
        summaryStrip.style.display = 'none';
        document.getElementById('analysisContainer').classList.remove('active');
        chartContainer.classList.add('active');
        if (!state.chartInitialized) {
            initLightweightChart();
            state.chartInitialized = true;
        } else {
            plotWallsOnChart(); // Re-plot lines in case data updated
        }
        return;
    } else if (tabKey === 'analysis') {
        mainContainer.classList.add('hide-main');
        summaryStrip.style.display = 'none';
        chartContainer.classList.remove('active');
        document.getElementById('analysisContainer').classList.add('active');
        renderAnalysisTab();
        return;
    } else {
        mainContainer.classList.remove('hide-main');
        summaryStrip.style.display = 'flex';
        chartContainer.classList.remove('active');
        document.getElementById('analysisContainer').classList.remove('active');
    }

    // Fetch data if not loaded yet
    const tabData = state.data[tabKey];
    if (!tabData || (!tabData.intraday && !tabData.oi)) {
        await fetchTabData(tabKey);
    }
    renderActiveTab();
}

// ========== TRADING STYLE SWITCH ==========
const STYLE_CONFIG = {
    daytrade: { key: 'current', label: 'Daytrade', icon: '⚡', slMul: 0.4, erScale: 1, wallSlice: 3, desc: 'Intraday — SL/TP แคบ, ใช้สัญญาใกล้สุด' },
    swing: { key: 'friday', label: 'Swing', icon: '🔄', slMul: 0.8, erScale: 2.2, wallSlice: 5, desc: 'ข้ามวัน — SL กว้างขึ้น, ใช้สัญญา Friday' },
    position: { key: 'monthly', label: 'Position', icon: '📊', slMul: 1.5, erScale: 5.2, wallSlice: 7, desc: 'สัปดาห์+ — SL กว้างสุด, ใช้สัญญา Monthly' },
};

function switchTradingStyle(style) {
    if (!STYLE_CONFIG[style] || style === state.tradingStyle) return;
    state.tradingStyle = style;
    document.querySelectorAll('.style-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.style === style);
    });
    if (state.activeTab === 'analysis') renderAnalysisTab();
}

let chartInstance = null;
let candleSeries = null;
let wallLines = []; // multi-wall lines

function plotWallsOnChart() {
    if (!candleSeries) return;

    // Clear existing lines
    for (const line of wallLines) {
        try { candleSeries.removePriceLine(line); } catch (e) { }
    }
    wallLines = [];

    const tData = state.data['current'];
    if (!tData || !tData.oi || !tData.oi.strikes) return;

    let uPrice = 0;
    if (state.data.current?.oi?.underlying) uPrice = state.data.current.oi.underlying;
    else if (state.data.monthly?.oi?.underlying) uPrice = state.data.monthly.oi.underlying;
    if (uPrice === 0) return;

    const callWalls = findSignificantWalls(tData.oi.strikes, uPrice, 'call');
    const putWalls = findSignificantWalls(tData.oi.strikes, uPrice, 'put');

    const lineStyles = [LightweightCharts.LineStyle.Solid, LightweightCharts.LineStyle.Dashed, LightweightCharts.LineStyle.Dotted];
    const lineWidths = [2, 1, 1];

    callWalls.slice(0, 3).forEach((w, i) => {
        wallLines.push(candleSeries.createPriceLine({
            price: w.strike, color: i === 0 ? '#26a69a' : '#26a69a88',
            lineWidth: lineWidths[i], lineStyle: lineStyles[i],
            axisLabelVisible: i < 2,
            title: i === 0 ? `Call Wall ${w.oi.toLocaleString()}` : `C ${w.oi.toLocaleString()}`,
        }));
    });

    putWalls.slice(0, 3).forEach((w, i) => {
        wallLines.push(candleSeries.createPriceLine({
            price: w.strike, color: i === 0 ? '#ef5350' : '#ef535088',
            lineWidth: lineWidths[i], lineStyle: lineStyles[i],
            axisLabelVisible: i < 2,
            title: i === 0 ? `Put Wall ${w.oi.toLocaleString()}` : `P ${w.oi.toLocaleString()}`,
        }));
    });
}

async function initLightweightChart() {
    const container = document.getElementById('lwc_chart');
    if (!container) return;

    // Show loading status
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:14px;">⏳ Loading ${getProfile().label} chart data...</div>`;

    chartInstance = LightweightCharts.createChart(container, {
        layout: {
            background: { type: 'solid', color: '#131722' },
            textColor: '#9598a1',
        },
        grid: {
            vertLines: { color: '#2a2e3e' },
            horzLines: { color: '#2a2e3e' },
        },
        timeScale: {
            timeVisible: true,
            secondsVisible: false,
        }
    });

    candleSeries = chartInstance.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
    });

    // Fetch chart data via CORS proxies (Yahoo Finance blocks direct browser calls)
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${getProfile().yahooSymbol}?interval=15m&range=5d`;
    const proxies = [
        `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`,
        yahooUrl
    ];

    let loaded = false;
    for (const url of proxies) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const data = await res.json();
            const result = data.chart.result[0];
            const chartData = [];
            for (let i = 0; i < result.timestamp.length; i++) {
                const q = result.indicators.quote[0];
                if (q.open[i] != null && q.high[i] != null && q.low[i] != null && q.close[i] != null) {
                    chartData.push({
                        time: result.timestamp[i],
                        open: q.open[i],
                        high: q.high[i],
                        low: q.low[i],
                        close: q.close[i]
                    });
                }
            }
            candleSeries.setData(chartData);
            loaded = true;
            break;
        } catch (err) {
            console.warn("Chart proxy failed:", url, err);
        }
    }

    if (!loaded) {
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--red);font-size:14px;text-align:center;z-index:10;background:rgba(0,0,0,0.7);padding:20px;border-radius:8px;';
        errorDiv.innerHTML = '⚠️ ไม่สามารถโหลดข้อมูลกราฟได้<br><span style="font-size:12px;color:var(--text-secondary);">Yahoo Finance API ถูกบล็อค (CORS) — ลอง Refresh อีกครั้ง</span>';
        container.style.position = 'relative';
        container.appendChild(errorDiv);
    }

    // Sync with current tab data to plot walls
    plotWallsOnChart();

    // Handle resize
    window.addEventListener('resize', () => {
        chartInstance.resize(container.clientWidth, container.clientHeight);
    });
}


function renderAnalysisTab() {
    const container = document.getElementById('analysisGrid');
    const header = document.getElementById('analysisHeader');
    const pulseEl = document.getElementById('marketPulse');
    if (pulseEl) pulseEl.innerHTML = '';

    const timeframes = [
        { key: 'current', label: 'Daily' },
        { key: 'friday', label: 'Weekly' },
        { key: 'monthly', label: 'Monthly' }
    ];

    // Sync underlying price
    let globalUnderlying = 0;
    if (state.data.current?.oi?.underlying) globalUnderlying = state.data.current.oi.underlying;
    else if (state.data.monthly?.oi?.underlying) globalUnderlying = state.data.monthly.oi.underlying;
    else if (state.data.friday?.oi?.underlying) globalUnderlying = state.data.friday.oi.underlying;

    // ── Compute per-timeframe data ──
    const tfData = {};
    for (const tf of timeframes) {
        const data = state.data[tf.key]?.oi;
        const intraday = state.data[tf.key]?.intraday;
        if (!data || !data.strikes || data.strikes.length === 0) continue;

        const uPrice = data.underlying > 0 ? data.underlying : (globalUnderlying > 0 ? globalUnderlying : 0);
        let tc = data.totalCall !== undefined ? data.totalCall : data.strikes.reduce((sum, s) => sum + s.call, 0);
        let tp = data.totalPut !== undefined ? data.totalPut : data.strikes.reduce((sum, s) => sum + s.put, 0);
        const pcr = tc > 0 ? (tp / tc) : 1;
        let biasScore = 0;
        if (pcr > 1.2) biasScore = -1;
        else if (pcr < 0.8) biasScore = 1;

        // ── Multi-Wall Detection ──
        const sourceStrikes2 = intraday?.strikes?.length > 0 ? intraday.strikes : null;
        const atm2 = data.strikes.reduce((p, c) => Math.abs(c.strike - uPrice) < Math.abs(p.strike - uPrice) ? c : p);
        const er1DayBase = atm2.volSettle > 0 ? uPrice * atm2.volSettle * Math.sqrt(1 / 365) : 50;

        // Scale ER by trading style: swing ~sqrt(5), position ~sqrt(27)
        const erScale = STYLE_CONFIG[state.tradingStyle].erScale;
        const er1Day = er1DayBase * (tf.key === STYLE_CONFIG[state.tradingStyle].key ? erScale : 1);

        const wallSliceCount = tf.key === STYLE_CONFIG[state.tradingStyle].key ? STYLE_CONFIG[state.tradingStyle].wallSlice : 3;
        const callWalls = findSignificantWalls(data.strikes, uPrice, 'call', er1Day * 2);
        const putWalls = findSignificantWalls(data.strikes, uPrice, 'put', er1Day * 2);
        const callSummary = getWallSummary(callWalls);
        const putSummary = getWallSummary(putWalls);

        // ── Broken Wall Detection (Volume-Confirmed) ──
        const brokenCallWalls = detectBrokenWalls(data.strikes, sourceStrikes2, uPrice, 'call', er1Day);
        const brokenPutWalls = detectBrokenWalls(data.strikes, sourceStrikes2, uPrice, 'put', er1Day);

        // Backward-compat: maxCall/maxPut = primary wall (or fallback to old logic)
        const callsAbove = data.strikes.filter(s => s.strike >= uPrice && s.call > 0);
        const putsBelow = data.strikes.filter(s => s.strike <= uPrice && s.put > 0);
        let maxCall = callSummary.primary
            ? { strike: callSummary.primary.strike, call: callSummary.primary.oi }
            : (callsAbove.length > 0 ? callsAbove.reduce((p, c) => c.call > p.call ? c : p) : data.strikes.reduce((p, c) => c.call > p.call ? c : p));
        let maxPut = putSummary.primary
            ? { strike: putSummary.primary.strike, put: putSummary.primary.oi }
            : (putsBelow.length > 0 ? putsBelow.reduce((p, c) => c.put > p.put ? c : p) : data.strikes.reduce((p, c) => c.put > p.put ? c : p));

        // Nearest walls (for day-trade proximity)
        const nearestCall = callSummary.nearest;
        const nearestPut = putSummary.nearest;

        // Structural walls: highest OI on the CORRECT side of price (for breakout detection)
        // Call wall = highest call OI at strikes >= uPrice (resistance)
        // Put wall  = highest put OI at strikes <= uPrice (support)
        const callsAtOrAbove = data.strikes.filter(s => s.strike >= uPrice && s.call > 0);
        const putsAtOrBelow = data.strikes.filter(s => s.strike <= uPrice && s.put > 0);
        const structCallWall = callsAtOrAbove.length > 0
            ? callsAtOrAbove.reduce((p, c) => c.call > p.call ? c : p)
            : data.strikes.reduce((p, c) => c.call > p.call ? c : p); // fallback: no calls above price
        const structPutWall = putsAtOrBelow.length > 0
            ? putsAtOrBelow.reduce((p, c) => c.put > p.put ? c : p)
            : data.strikes.reduce((p, c) => c.put > p.put ? c : p); // fallback: no puts below price
        const priceAboveCallWall = callsAtOrAbove.length > 0 && uPrice > structCallWall.strike;
        const priceBelowPutWall = putsAtOrBelow.length > 0 && uPrice < structPutWall.strike;
        const callWallBreakoutDist = uPrice - structCallWall.strike;
        const putWallBreakdownDist = structPutWall.strike - uPrice;

        if (nearestCall && nearestCall.dist < 30 && tc > tp) biasScore += 1;
        else if (nearestPut && nearestPut.dist < 30 && tp > tc) biasScore -= 1;

        const mpStrike = calcMaxPain(data.strikes);
        const mpDist = mpStrike !== null ? (uPrice - mpStrike) : 0;
        const priceAboveMP = mpStrike !== null && uPrice > mpStrike;
        const priceBelowMP = mpStrike !== null && uPrice < mpStrike;

        const gexResult = calcNetGEX(data.strikes, uPrice, data.dte);
        const gexVal = gexResult.netGEX;
        const isLongGamma = gexVal >= 0;

        // Volume GEX: use intraday volume to confirm/challenge OI-based regime
        const volGEXResult = calcVolumeGEX(data.strikes, sourceStrikes2, uPrice, data.dte);

        // Use NEAREST wall for proximity detection (dynamic threshold = 1-day ER)
        const distToNearestCall = nearestCall ? nearestCall.dist : (maxCall.strike - uPrice);
        const distToNearestPut = nearestPut ? nearestPut.dist : (uPrice - maxPut.strike);
        const proximityThreshold = Math.max(er1Day * 0.8, 20); // dynamic, min 20, scales with trading style via er1Day
        const nearCallWall = distToNearestCall < proximityThreshold;
        const nearPutWall = distToNearestPut < proximityThreshold;

        // Tradeable range between nearest walls
        const tradeableRange = (nearestCall ? nearestCall.dist : 999) + (nearestPut ? nearestPut.dist : 999);

        const risk = calcBreakdownRisk(data.strikes, sourceStrikes2, uPrice, data.dte, gexResult.flipStrike, er1Day);
        const vannaExp = calcNetVannaExposure(data.strikes, uPrice, data.dte);
        const charmExp = calcNetCharmExposure(data.strikes, uPrice, data.dte);
        const vommaExp = calcNetVommaExposure(data.strikes, uPrice, data.dte);

        const t_h = Math.max(data.dte, 0.01) / 365;
        let itmOI = 0, atmOI = 0, otmOI = 0;
        data.strikes.forEach(s => {
            const cd = calcDelta(uPrice, s.strike, s.volSettle, t_h, true);
            const pd = Math.abs(calcDelta(uPrice, s.strike, s.volSettle, t_h, false));
            itmOI += (cd > 0.70 ? s.call : 0) + (pd > 0.70 ? s.put : 0);
            atmOI += (cd >= 0.30 && cd <= 0.70 ? s.call : 0) + (pd >= 0.30 && pd <= 0.70 ? s.put : 0);
            otmOI += (cd < 0.30 ? s.call : 0) + (pd < 0.30 ? s.put : 0);
        });
        const totalH = (itmOI + atmOI + otmOI) || 1;
        const itmPct = itmOI / totalH * 100;
        const hedgeLabel = itmPct > 40 ? 'Heavy Hedge' : itmPct > 20 ? 'Moderate Hedge' : 'Spec-Driven';

        let biasLabel = 'Neutral';
        if (biasScore >= 2) biasLabel = 'Strong Bullish';
        else if (biasScore > 0) biasLabel = 'Bullish';
        else if (biasScore <= -2) biasLabel = 'Strong Bearish';
        else if (biasScore < 0) biasLabel = 'Bearish';

        tfData[tf.key] = {
            uPrice, pcr, biasScore, biasLabel,
            maxCall, maxPut, mpStrike, mpDist, priceAboveMP, priceBelowMP,
            structCallWall, structPutWall, priceAboveCallWall, priceBelowPutWall,
            callWallBreakoutDist, putWallBreakdownDist,
            gexResult, gexVal, isLongGamma, volGEXResult,
            distToCallWall: maxCall.strike - uPrice, distToPutWall: uPrice - maxPut.strike,
            nearCallWall, nearPutWall,
            nearestCall, nearestPut, callWalls, putWalls, callSummary, putSummary,
            brokenCallWalls, brokenPutWalls,
            tradeableRange, er1Day, sourceStrikes2, wallSliceCount,
            risk, vannaExp, charmExp, vommaExp, hedgeLabel, itmPct, dte: data.dte,
            oiStrikes: data.strikes,
            longDteWarning: data.dte > 60 // Greeks less accurate at long DTE (r=0 assumption)
        };
    }

    // ── Primary = based on trading style ──
    const styleCfg = STYLE_CONFIG[state.tradingStyle];
    const d = tfData[styleCfg.key] || tfData.current;
    const primaryKey = tfData[styleCfg.key] ? styleCfg.key : 'current';
    const styleFallback = !tfData[styleCfg.key] && styleCfg.key !== 'current';
    if (!d) {
        header.innerHTML = `<div class="placeholder-msg" style="padding:40px"><div class="icon">📊</div><div class="title">No Data</div><div class="desc">Loading or no ${styleCfg.label} data available.</div></div>`;
        container.innerHTML = '';
        return;
    }

    // ── GAME THEORY COMPUTATION ──
    try {
        const allWalls = [...(d.putWalls || []), ...(d.callWalls || [])];
        d.multiAgent = calcMultiAgentPressure(
            d.uPrice, d.oiStrikes, d.sourceStrikes2, d.dte,
            d.isLongGamma, allWalls, d.er1Day
        );
        d.gameTheory = calcGameTheoryAnalysis(d);
        d.nashEq = calcNashEquilibrium(
            d.oiStrikes, d.uPrice, d.dte, d.isLongGamma,
            d.mpStrike, d.gexResult?.flipStrike, d.putWalls, d.callWalls
        );
    } catch (e) {
        console.warn('Game Theory computation error:', e);
        d.multiAgent = null;
        d.gameTheory = null;
        d.nashEq = null;
    }

    // ── MARKET BIAS ──
    const bias = calcMarketBias(d);

    const isFallback = state.data.current?.oi?.underlyingIsFallback
        || state.data.monthly?.oi?.underlyingIsFallback
        || state.data.friday?.oi?.underlyingIsFallback;

    // ── STATUS BADGE ──
    let bText, bColor, bDesc;
    if (d.risk.noMansLand) {
        const up = d.risk.noMansLandSide === 'above';
        bText = up ? '⛔ BREAKOUT' : '⛔ CASCADE';
        bColor = '#ff1744';
        bDesc = up ? 'ราคาออกนอก Gamma Zone → ห้ามสวนทาง Follow ขึ้น' : 'ราคาออกนอก Gamma Zone → ห้ามสวนทาง Follow ลง';
    } else if (d.priceAboveCallWall && d.isLongGamma) {
        // DAMPENING ZONE: Above Call Wall + Long Gamma = Dealer sells strength, buys weakness = Sideways
        bText = '🔄 DAMPENING ZONE';
        bColor = 'var(--cyan)';
        bDesc = `ราคาเหนือ Call Wall $${d.structCallWall.strike} (+${d.callWallBreakoutDist.toFixed(0)} pts) + Long γ → Dealer กด Sideways`;
        bDesc += ` — Squeeze ไม่เกิด เพราะ Dealer ขายเมื่อขึ้น ซื้อเมื่อลง (Mean-Revert)`;
    } else if (d.priceAboveCallWall) {
        // Short Gamma + Above Call Wall = genuine breakout
        // Vanna confirmation requires meaningful magnitude (> 0.5% ADV)
        const vannaContractsCheck = Math.abs(d.vannaExp / (d.uPrice * 100));
        const vannaMeaningful = vannaContractsCheck / getProfile().defaultADV > 0.005; // > 0.5% of ADV
        const vannaConfirm = d.vannaExp < 0 && vannaMeaningful; // negative = dealers BUY = confirms upside
        const vannaNeutral = !vannaMeaningful;
        bText = vannaConfirm ? '🚀 BREAKOUT + Vanna' : '🚀 BREAKOUT';
        bColor = 'var(--green)';
        bDesc = `ราคาทะลุ Call Wall $${d.structCallWall.strike} ไปแล้ว +${d.callWallBreakoutDist.toFixed(0)} pts`;
        if (vannaConfirm) bDesc += ` — Vanna ยืนยัน: Dealers ต้อง Buy ดันราคาต่อ`;
        else if (vannaNeutral) bDesc += ` — Vanna แรงน้อย (ไม่มีนัยสำคัญ) ระวัง pullback`;
        else bDesc += ` — Vanna ยังไม่ confirm ระวัง pullback`;
    } else if (d.priceBelowPutWall) {
        const vannaContractsCheck = Math.abs(d.vannaExp / (d.uPrice * 100));
        const vannaMeaningful = vannaContractsCheck / 200000 > 0.005;
        const vannaConfirm = d.vannaExp > 0 && vannaMeaningful; // positive = dealers SELL = confirms downside
        const vannaNeutral = !vannaMeaningful;
        bText = vannaConfirm ? '💧 CASCADE + Vanna' : '💧 CASCADE';
        bColor = 'var(--red)';
        bDesc = `ราคาหลุด Put Wall $${d.structPutWall.strike} ไปแล้ว -${d.putWallBreakdownDist.toFixed(0)} pts`;
        if (vannaConfirm) bDesc += ` — Vanna ยืนยัน: Dealers ต้อง Sell กดราคาต่อ`;
        else if (vannaNeutral) bDesc += ` — Vanna แรงน้อย (ไม่มีนัยสำคัญ) ระวัง bounce`;
        else bDesc += ` — Vanna ยังไม่ confirm ระวัง bounce`;
    } else if (d.nearCallWall && d.gexVal >= 0) {
        const ncs = d.nearestCall ? d.nearestCall.strike : d.maxCall.strike;
        bText = '⚡ ชน Resistance'; bColor = '#ffd54f';
        bDesc = `ใกล้ Call Wall $${ncs} (${d.nearestCall ? d.nearestCall.oi.toLocaleString() + ' OI' : ''}) → ทะลุ=Squeeze / ย่อ=Short`;
    } else if (d.nearPutWall && d.gexVal >= 0) {
        const nps = d.nearestPut ? d.nearestPut.strike : d.maxPut.strike;
        bText = '⚡ ชน Support'; bColor = '#ffd54f';
        bDesc = `ใกล้ Put Wall $${nps} (${d.nearestPut ? d.nearestPut.oi.toLocaleString() + ' OI' : ''}) → หลุด=Cascade / เด้ง=Long`;
    } else if (d.nearCallWall && d.gexVal < 0) {
        bText = '🚀 Squeeze Risk'; bColor = 'var(--orange)';
        bDesc = `Short γ + ใกล้ Call Wall → ทะลุ = Squeeze รุนแรง`;
    } else if (d.nearPutWall && d.gexVal < 0) {
        bText = '💧 Drop Risk'; bColor = 'var(--orange)';
        bDesc = `Short γ + ใกล้ Put Wall → หลุด = Cascade ลง`;
    } else if (d.isLongGamma) {
        if (d.priceAboveMP) { bText = '🔄 Pullback Zone'; bColor = 'var(--cyan)'; bDesc = 'Long γ + เหนือ Max Pain → แรงดึงลง'; }
        else if (d.priceBelowMP) { bText = '🔄 Bounce Zone'; bColor = 'var(--green)'; bDesc = 'Long γ + ต่ำกว่า Max Pain → แรงดึงขึ้น'; }
        else { bText = '🔄 Range Bound'; bColor = 'var(--cyan)'; bDesc = 'Long γ + ราคาใกล้ Max Pain → Sideway'; }
    } else {
        const upBias = d.biasScore > 0 || d.priceBelowMP;
        bText = upBias ? '🌊 Trend Up' : '🌊 Trend Down';
        bColor = upBias ? 'var(--green)' : 'var(--red)';
        bDesc = 'Short γ → ราคาวิ่งรุนแรงเมื่อหลุดแนว ติดตามทิศทาง';
    }

    // ── KEY LEVELS (Multi-Wall) ──
    const levels = [];
    const tierIcon = t => t === 'primary' ? '🔴' : t === 'secondary' ? '🟡' : '⚪';
    const tierLabel = t => t === 'primary' ? 'Primary' : t === 'secondary' ? 'Secondary' : 'Minor';

    // Wall Migration / Intraday Flow logic wrapper
    // Compares Intraday Vol vs OI to gauge if a wall is reinforced or stale
    const checkWallMigration = (strike, side, oi, intradayStrikesData) => {
        if (!intradayStrikesData || intradayStrikesData.length === 0) return '';
        const intraStrike = intradayStrikesData.find(s => s.strike === strike);
        if (!intraStrike) return '';
        const intraVol = side === 'put' ? intraStrike.put : intraStrike.call;
        if (oi > 0) {
            const volPace = intraVol / oi;
            if (volPace > 0.15) return ' <span style="color:var(--green);font-size:10px;background:rgba(38,166,154,.15);padding:1px 4px;border-radius:3px;margin-left:4px" title="Volume/OI > 15%">⚡ แรงหนุนเพิ่ม (Reinforced)</span>';
            if (volPace < 0.02) return ' <span style="color:var(--text-muted);font-size:10px;background:rgba(255,255,255,.05);padding:1px 4px;border-radius:3px;margin-left:4px" title="Volume/OI < 2%">⏳ เก่า/แห้ง (Stale)</span>';
        }
        return '';
    };

    // Put Walls — all significant walls below price
    if (d.priceBelowPutWall) {
        levels.push({ price: d.structPutWall.strike, label: '💔 Broken Put Wall', color: 'var(--orange)', icon: '💔', dist: d.structPutWall.strike - d.uPrice, oi: 0, tier: '', action: 'ราคาหลุดแล้ว → กลายเป็น Resistance (SL zone)' });
    }
    // Helper: get credibility badge for a wall strike
    const getCredBadge = (strike) => {
        if (!d.gameTheory || !d.gameTheory.wallCredibilities) return '';
        const wc = d.gameTheory.wallCredibilities.find(wc => wc.wall.strike === strike);
        if (!wc) return '';
        const c = wc.credibility;
        const clr = c.score >= 70 ? 'var(--green)' : c.score >= 40 ? 'var(--orange)' : 'var(--red)';
        return ` <span style="font-size:9px;padding:1px 4px;border-radius:3px;background:${clr}15;color:${clr};border:1px solid ${clr}30;font-weight:700">${c.label} ${c.score}</span>`;
    };
    for (const w of d.putWalls.slice(0, d.wallSliceCount || 3)) {
        const tierBadge = tierLabel(w.tier);
        const clusterInfo = w.clusterCount > 1 ? ` [${w.clusterCount} strikes, ${w.clusterOI.toLocaleString()} total]` : '';
        const migrationTag = checkWallMigration(w.strike, 'put', w.oi, d.sourceStrikes2);
        const credBadge = getCredBadge(w.strike);
        levels.push({
            price: w.strike, label: `Put Wall${credBadge} ${migrationTag}`, color: 'var(--put-color)',
            icon: tierIcon(w.tier), dist: -(w.dist), oi: w.oi, tier: w.tier,
            action: `Support ${w.isNearby ? '📍 ใกล้!' : ''} OI: ${w.oi.toLocaleString()}${clusterInfo}`
        });
    }

    // Broken Call Walls — was resistance, now new support below price (volume-confirmed)
    for (const bw of (d.brokenCallWalls || []).filter(bw => bw.volumeConf !== 'none').slice(0, 2)) {
        const confIcon = bw.volumeConf === 'strong' ? '🔥' : bw.volumeConf === 'moderate' ? '⚡' : '💤';
        const confLabel = bw.volumeConf === 'strong' ? 'Vol ยืนยัน!' : bw.volumeConf === 'moderate' ? 'Vol พอใช้' : 'Vol น้อย';
        levels.push({
            price: bw.strike, label: `${confIcon} Broken R→S`, color: 'var(--orange)',
            icon: confIcon, dist: -(bw.dist), oi: bw.oi, tier: '',
            action: `New Support (เคยเป็น Call Wall) | OI: ${bw.oi.toLocaleString()} | ${confLabel} (Vol/OI: ${(bw.volRatio * 100).toFixed(0)}%)`
        });
    }

    // Structural levels
    if (d.risk.gammaMean) levels.push({ price: +d.risk.gammaMean.toFixed(0), label: 'Gamma Mean', color: 'var(--cyan)', icon: '🔵', dist: d.risk.gammaMean - d.uPrice, oi: 0, tier: '', action: 'จุดสมดุล — TP ชั้นดี' });
    if (d.mpStrike) levels.push({ price: d.mpStrike, label: 'Max Pain', color: 'var(--pink)', icon: '🟣', dist: d.mpStrike - d.uPrice, oi: 0, tier: '', action: 'จุดดึงดูดราคา (Expiry Magnet)' });
    if (d.gexResult.flipStrike) {
        const fd = d.gexResult.flipStrike - d.uPrice;
        const fw = Math.abs(fd) < 60 ? ' ⚠️' : '';
        levels.push({ price: d.gexResult.flipStrike, label: 'GEX Flip' + fw, color: 'var(--accent)', icon: '⚡', dist: fd, oi: 0, tier: '', action: 'ข้ามนี้ = เปลี่ยน regime (Long↔Short γ)' });
    }

    // Call Walls — all significant walls above price
    if (d.priceAboveCallWall) {
        levels.push({ price: d.structCallWall.strike, label: '💔 Broken Call Wall', color: 'var(--orange)', icon: '💔', dist: d.structCallWall.strike - d.uPrice, oi: 0, tier: '', action: 'ราคาทะลุแล้ว → กลายเป็น Support (SL zone)' });
    }
    for (const w of d.callWalls.slice(0, d.wallSliceCount || 3)) {
        const tierBadge = tierLabel(w.tier);
        const clusterInfo = w.clusterCount > 1 ? ` [${w.clusterCount} strikes, ${w.clusterOI.toLocaleString()} total]` : '';
        const migrationTag = checkWallMigration(w.strike, 'call', w.oi, d.sourceStrikes2);
        const credBadgeC = getCredBadge(w.strike);
        levels.push({
            price: w.strike, label: `Call Wall${credBadgeC} ${migrationTag}`, color: 'var(--call-color)',
            icon: tierIcon(w.tier), dist: w.dist, oi: w.oi, tier: w.tier,
            action: `Resistance ${w.isNearby ? '📍 ใกล้!' : ''} OI: ${w.oi.toLocaleString()}${clusterInfo}`
        });
    }

    // Broken Put Walls — was support, now new resistance above price (volume-confirmed)
    for (const bw of (d.brokenPutWalls || []).filter(bw => bw.volumeConf !== 'none').slice(0, 2)) {
        const confIcon = bw.volumeConf === 'strong' ? '🔥' : bw.volumeConf === 'moderate' ? '⚡' : '💤';
        const confLabel = bw.volumeConf === 'strong' ? 'Vol ยืนยัน!' : bw.volumeConf === 'moderate' ? 'Vol พอใช้' : 'Vol น้อย';
        levels.push({
            price: bw.strike, label: `${confIcon} Broken S→R`, color: 'var(--orange)',
            icon: confIcon, dist: bw.dist, oi: bw.oi, tier: '',
            action: `New Resistance (เคยเป็น Put Wall) | OI: ${bw.oi.toLocaleString()} | ${confLabel} (Vol/OI: ${(bw.volRatio * 100).toFixed(0)}%)`
        });
    }

    levels.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));

    const levelsHtml = levels.map(l => {
        const ds = l.dist >= 0 ? `+${l.dist.toFixed(0)}` : l.dist.toFixed(0);
        const isNear = Math.abs(l.dist) < (d.er1Day || 40);
        const dc = isNear ? 'var(--orange)' : 'var(--text-muted)';
        const bgHighlight = isNear ? 'background:rgba(255,152,0,.06);border-radius:6px;padding:9px 8px;margin:0 -8px;' : 'padding:9px 0;';
        return `<div style="display:flex;align-items:center;gap:10px;${bgHighlight}border-bottom:1px solid rgba(255,255,255,.05)">
            <span style="font-size:14px;width:20px;text-align:center">${l.icon}</span>
            <span style="font-size:13px;font-weight:700;color:${l.color};min-width:130px">${l.label}</span>
            <span style="font-size:15px;font-weight:800;color:var(--text-primary);min-width:60px">$${l.price}</span>
            <span style="font-size:12px;font-weight:700;color:${dc};min-width:45px">(${ds})</span>
            <span style="font-size:11px;color:var(--text-secondary);flex:1">${l.action}</span>
        </div>`;
    }).join('');

    // Breakout / Cascade zones
    let breakoutHtml = '';
    if (d.risk.gammaZoneHigh && d.risk.gammaZoneLow) {
        breakoutHtml = `
        <div style="display:flex;gap:16px;margin-top:12px;padding:14px 16px;background:rgba(0,0,0,.25);border-radius:10px;border:1px dashed rgba(255,255,255,.1)">
            <div style="flex:1">
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">🔼 Squeeze (ทะลุขึ้น = Follow Long)</div>
                <div style="font-size:16px;font-weight:800;color:var(--call-color)">$${d.risk.gammaZoneHigh.toFixed(0)} <span style="font-size:12px;color:var(--text-muted)">(+${(d.risk.gammaZoneHigh - d.uPrice).toFixed(0)})</span></div>
            </div>
            <div style="width:1px;background:rgba(255,255,255,.1)"></div>
            <div style="flex:1">
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">🔽 Cascade (หลุดลง = Follow Short)</div>
                <div style="font-size:16px;font-weight:800;color:var(--put-color)">$${d.risk.gammaZoneLow.toFixed(0)} <span style="font-size:12px;color:var(--text-muted)">(-${(d.uPrice - d.risk.gammaZoneLow).toFixed(0)})</span></div>
            </div>
        </div>`;
    }

    // ── BATTLE MAP BAR (Redesigned — visual centerpiece) ──
    const displayedPutWalls = d.putWalls.slice(0, 3);
    const displayedCallWalls = d.callWalls.slice(0, 3);
    const displayedBrokenCalls = (d.brokenCallWalls || []).filter(bw => bw.volumeConf !== 'none').slice(0, 2);
    const displayedBrokenPuts = (d.brokenPutWalls || []).filter(bw => bw.volumeConf !== 'none').slice(0, 2);
    const allBarStrikes = [
        ...displayedPutWalls.map(w => w.strike),
        ...displayedCallWalls.map(w => w.strike),
        ...displayedBrokenCalls.map(bw => bw.strike),
        ...displayedBrokenPuts.map(bw => bw.strike),
    ];
    const barLow = allBarStrikes.length > 0
        ? Math.min(...allBarStrikes)
        : (d.putSummary.primary ? d.putSummary.primary.strike : d.maxPut.strike);
    const barHigh = allBarStrikes.length > 0
        ? Math.max(...allBarStrikes)
        : (d.callSummary.primary ? d.callSummary.primary.strike : d.maxCall.strike);
    const barRange = barHigh - barLow || 1;
    const pricePct = Math.max(2, Math.min(98, ((d.uPrice - barLow) / barRange) * 100));

    // Compute helper pct for structural levels
    const toPct = (val) => Math.max(0, Math.min(100, ((val - barLow) / barRange) * 100));

    // OI density per wall (for glow width)
    const allWallOIs = [...displayedPutWalls, ...displayedCallWalls].map(w => w.oi);
    const maxWallOI = allWallOIs.length > 0 ? Math.max(...allWallOIs) : 1;

    // Build wall line markers (lines only — labels go in the row below)
    let wallLinesHtml = '';
    for (const w of displayedPutWalls) {
        const pct = toPct(w.strike);
        const isPrimary = w.tier === 'primary';
        wallLinesHtml += `<div style="position:absolute;left:${pct}%;top:0;height:100%;transform:translateX(-50%);z-index:1">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:${isPrimary ? 3 : 2}px;height:100%;background:var(--put-color);opacity:${isPrimary ? 0.9 : 0.4};border-radius:1px"></div>
        </div>`;
    }
    for (const w of displayedCallWalls) {
        const pct = toPct(w.strike);
        const isPrimary = w.tier === 'primary';
        wallLinesHtml += `<div style="position:absolute;left:${pct}%;top:0;height:100%;transform:translateX(-50%);z-index:1">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:${isPrimary ? 3 : 2}px;height:100%;background:var(--call-color);opacity:${isPrimary ? 0.9 : 0.4};border-radius:1px"></div>
        </div>`;
    }

    // Broken wall lines (dashed orange — volume-confirmed broken levels)
    for (const bw of displayedBrokenCalls) {
        const pct = toPct(bw.strike);
        const isStrong = bw.volumeConf === 'strong';
        wallLinesHtml += `<div style="position:absolute;left:${pct}%;top:0;height:100%;transform:translateX(-50%);z-index:2">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:0;height:100%;border-left:${isStrong ? 3 : 2}px dashed var(--orange);opacity:${isStrong ? 0.9 : 0.5}"></div>
        </div>`;
    }
    for (const bw of displayedBrokenPuts) {
        const pct = toPct(bw.strike);
        const isStrong = bw.volumeConf === 'strong';
        wallLinesHtml += `<div style="position:absolute;left:${pct}%;top:0;height:100%;transform:translateX(-50%);z-index:2">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:0;height:100%;border-left:${isStrong ? 3 : 2}px dashed var(--orange);opacity:${isStrong ? 0.9 : 0.5}"></div>
        </div>`;
    }

    // Structural level lines (dashed — no labels on bar, shown in row below)
    let structLinesHtml = '';
    if (d.mpStrike) {
        const mpPct = toPct(d.mpStrike);
        structLinesHtml += `<div style="position:absolute;left:${mpPct}%;top:0;height:100%;width:0;border-left:2px dashed var(--pink);opacity:0.5;z-index:2"></div>`;
    }
    if (d.risk.gammaMean) {
        const gmPct = toPct(d.risk.gammaMean);
        structLinesHtml += `<div style="position:absolute;left:${gmPct}%;top:0;height:100%;width:0;border-left:2px dashed var(--cyan);opacity:0.5;z-index:2"></div>`;
    }
    if (d.gexResult.flipStrike) {
        const flipPct = toPct(d.gexResult.flipStrike);
        structLinesHtml += `<div style="position:absolute;left:${flipPct}%;top:0;height:100%;width:0;border-left:2px dashed var(--accent);opacity:0.6;z-index:2"></div>`;
    }
    // Nash Equilibrium line (Game Theory)
    if (d.nashEq && d.nashEq.eqPrice) {
        const nashPct = toPct(d.nashEq.eqPrice);
        structLinesHtml += `<div style="position:absolute;left:${nashPct}%;top:0;height:100%;width:0;border-left:2px dashed #e040fb;opacity:0.7;z-index:3" title="Nash Eq $${d.nashEq.eqPrice}"></div>`;
    }

    // Nearest walls for distance display
    const nearPutStrike = d.nearestPut ? d.nearestPut.strike : (displayedPutWalls[0] ? displayedPutWalls[0].strike : null);
    const nearCallStrike = d.nearestCall ? d.nearestCall.strike : (displayedCallWalls[0] ? displayedCallWalls[0].strike : null);
    const nearPutDist = nearPutStrike ? Math.abs(d.uPrice - nearPutStrike) : 999;
    const nearCallDist = nearCallStrike ? Math.abs(nearCallStrike - d.uPrice) : 999;

    // Regime gradient
    const regimeGrad = d.isLongGamma
        ? 'linear-gradient(90deg, rgba(255,197,110,.08) 0%, rgba(86,181,250,.04) 50%, rgba(92,224,240,.08) 100%)'
        : 'linear-gradient(90deg, rgba(244,88,102,.08) 0%, rgba(255,255,255,.03) 50%, rgba(46,216,164,.08) 100%)';

    // Tradeable range
    const tradeRangePts = d.tradeableRange < 999 ? d.tradeableRange.toFixed(0) : '—';

    // Build labels row BELOW bar — clean separated row, no overlap
    let labelsRow = [];
    for (const w of displayedPutWalls) {
        const oiK = w.oi >= 1000 ? (w.oi / 1000).toFixed(1) + 'K' : w.oi.toString();
        labelsRow.push({ strike: w.strike, color: 'var(--put-color)', label: `$${w.strike}`, sub: w.tier === 'primary' ? oiK : '', primary: w.tier === 'primary' });
    }
    if (d.mpStrike) labelsRow.push({ strike: d.mpStrike, color: 'var(--pink)', label: `MP`, sub: `$${d.mpStrike}`, primary: false });
    if (d.risk.gammaMean) labelsRow.push({ strike: d.risk.gammaMean, color: 'var(--cyan)', label: `GM`, sub: `$${d.risk.gammaMean.toFixed(0)}`, primary: false });
    if (d.gexResult.flipStrike) labelsRow.push({ strike: d.gexResult.flipStrike, color: 'var(--accent)', label: `⚡Flip`, sub: `$${d.gexResult.flipStrike}`, primary: false });
    if (d.nashEq && d.nashEq.eqPrice) labelsRow.push({ strike: d.nashEq.eqPrice, color: '#e040fb', label: `🎯Nash`, sub: `$${d.nashEq.eqPrice}`, primary: false });
    for (const bw of displayedBrokenCalls) {
        labelsRow.push({ strike: bw.strike, color: 'var(--orange)', label: `🔥$${bw.strike}`, sub: 'Broken', primary: bw.volumeConf === 'strong' });
    }
    for (const bw of displayedBrokenPuts) {
        labelsRow.push({ strike: bw.strike, color: 'var(--orange)', label: `🔥$${bw.strike}`, sub: 'Broken', primary: bw.volumeConf === 'strong' });
    }
    for (const w of displayedCallWalls) {
        const oiK = w.oi >= 1000 ? (w.oi / 1000).toFixed(1) + 'K' : w.oi.toString();
        labelsRow.push({ strike: w.strike, color: 'var(--call-color)', label: `$${w.strike}`, sub: w.tier === 'primary' ? oiK : '', primary: w.tier === 'primary' });
    }
    labelsRow.sort((a, b) => a.strike - b.strike);
    // Anti-overlap: multi-row greedy placement
    // Each label has an estimated width in % units (~5% for short labels)
    const MIN_PCT_GAP = 5;
    const ROWS = [0, 18, 36]; // 3 possible vertical offsets
    const rowLastPct = [[-999], [-999], [-999]]; // track last placed pct per row
    const labelPcts = labelsRow.map(l => ({ ...l, pct: toPct(l.strike), offsetY: 0 }));
    for (const lbl of labelPcts) {
        let placed = false;
        for (let r = 0; r < ROWS.length; r++) {
            const lastPct = rowLastPct[r][rowLastPct[r].length - 1];
            if (lbl.pct - lastPct >= MIN_PCT_GAP) {
                lbl.offsetY = ROWS[r];
                rowLastPct[r].push(lbl.pct);
                placed = true;
                break;
            }
        }
        if (!placed) {
            // Force into least-congested row
            lbl.offsetY = ROWS[2];
            rowLastPct[2].push(lbl.pct);
        }
    }
    const labelsRowHtml = labelPcts.map(l => {
        return `<div style="position:absolute;left:${l.pct}%;transform:translateX(-50%);text-align:center;white-space:nowrap;top:${l.offsetY}px">
            <div style="font-size:${l.primary ? 11 : 9}px;font-weight:${l.primary ? 800 : 600};color:${l.color};opacity:${l.primary ? 1 : 0.7}">${l.label}</div>
            ${l.sub ? `<div style="font-size:8px;color:${l.color};opacity:0.6">${l.sub}</div>` : ''}
        </div>`;
    }).join('');

    // ── Broken Wall Detection for action hints ──
    const bestBrokenCall = (d.brokenCallWalls || []).find(bw => bw.volumeConf === 'strong' || bw.volumeConf === 'moderate');
    const bestBrokenPut = (d.brokenPutWalls || []).find(bw => bw.volumeConf === 'strong' || bw.volumeConf === 'moderate');
    const hasBrokenWall = bestBrokenCall || bestBrokenPut;

    // Action hint (single line, not on bar)
    let actionHint = '';
    if (d.isLongGamma) {
        if (bestBrokenCall) {
            const retestStr = `<span style="color:var(--orange);font-weight:700">BUY RETEST $${bestBrokenCall.strike}</span>`;
            const tpStr = nearCallStrike ? `→ <span style="color:var(--call-color);font-weight:700">TP $${nearCallStrike}</span>` : '';
            actionHint = `${retestStr} ${tpStr}`;
        } else if (bestBrokenPut) {
            const retestStr = `<span style="color:var(--orange);font-weight:700">SELL RETEST $${bestBrokenPut.strike}</span>`;
            const tpStr = nearPutStrike ? `→ <span style="color:var(--put-color);font-weight:700">TP $${nearPutStrike}</span>` : '';
            actionHint = `${retestStr} ${tpStr}`;
        } else {
            const sellAt = nearCallStrike && !d.priceAboveCallWall ? `<span style="color:var(--call-color);font-weight:700">SELL $${nearCallStrike}</span>` : '';
            const buyAt = nearPutStrike && !d.priceBelowPutWall ? `<span style="color:var(--put-color);font-weight:700">BUY $${nearPutStrike}</span>` : '';
            actionHint = [buyAt, sellAt].filter(Boolean).join(' <span style="color:var(--text-muted)">·····</span> ');
        }
    } else {
        if (bestBrokenCall) {
            actionHint = `<span style="color:var(--orange);font-weight:700">BUY RETEST $${bestBrokenCall.strike}</span> (Breakout confirmed)`;
        } else if (bestBrokenPut) {
            actionHint = `<span style="color:var(--orange);font-weight:700">SELL RETEST $${bestBrokenPut.strike}</span> (Breakdown confirmed)`;
        } else {
            const bko = nearCallStrike && !d.priceAboveCallWall ? `ทะลุ $${nearCallStrike} = <span style="color:var(--green);font-weight:700">BUY 🚀</span>` : '';
            const bkd = nearPutStrike && !d.priceBelowPutWall ? `หลุด $${nearPutStrike} = <span style="color:var(--red);font-weight:700">SELL 💧</span>` : '';
            actionHint = [bkd, bko].filter(Boolean).join(' <span style="color:var(--text-muted)">·····</span> ');
        }
    }

    const rangeBarHtml = `
    <div style="padding:6px 0 8px 0;margin:4px 0 8px">
        <!-- 3-col header: Support | Range | Resistance -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="text-align:left">
                <div style="font-size:9px;color:var(--put-color);font-weight:600;text-transform:uppercase;letter-spacing:.5px">◀ Support</div>
                <div style="font-size:20px;font-weight:900;color:var(--put-color)">$${nearPutStrike || barLow}</div>
                <div style="font-size:11px;color:var(--text-muted);font-weight:600">${nearPutDist < 999 ? nearPutDist.toFixed(0) + ' pts' : ''}</div>
            </div>
            <div style="text-align:center">
                <div style="font-size:24px;font-weight:900;color:white">$${d.uPrice.toFixed(1)}</div>
                <div style="font-size:11px;color:${d.tradeableRange < 30 ? 'var(--red)' : d.tradeableRange < 60 ? 'var(--orange)' : 'var(--text-muted)'};font-weight:700">Range: ${tradeRangePts} pts</div>
            </div>
            <div style="text-align:right">
                <div style="font-size:9px;color:var(--call-color);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Resistance ▶</div>
                <div style="font-size:20px;font-weight:900;color:var(--call-color)">$${nearCallStrike || barHigh}</div>
                <div style="font-size:11px;color:var(--text-muted);font-weight:600">${nearCallDist < 999 ? nearCallDist.toFixed(0) + ' pts' : ''}</div>
            </div>
        </div>

        <!-- THE BAR (clean — lines only, no text) -->
        <div style="position:relative;height:32px;background:${regimeGrad};border-radius:6px;overflow:visible;border:1px solid rgba(255,255,255,.08)">
            <div style="position:absolute;left:0;top:0;height:100%;width:${pricePct}%;background:linear-gradient(to right,rgba(255,197,110,.05),rgba(255,255,255,.03));border-radius:6px 0 0 6px"></div>
            ${wallLinesHtml}
            ${structLinesHtml}
            <!-- Price needle with futures label -->
            <div style="position:absolute;left:${pricePct}%;top:-4px;bottom:-4px;width:3px;background:white;transform:translateX(-50%);z-index:6;border-radius:2px;box-shadow:0 0 8px rgba(255,255,255,.5)"></div>
            <div style="position:absolute;left:${pricePct}%;top:-22px;transform:translateX(-50%);z-index:7;white-space:nowrap">
                <div style="font-size:11px;font-weight:800;color:white;background:rgba(30,30,40,.85);padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.3);text-shadow:0 0 4px rgba(255,255,255,.4)">$${d.uPrice.toFixed(1)}</div>
            </div>
        </div>

        <!-- Labels row (below bar, clean horizontal) -->
        <div style="position:relative;height:56px;margin-top:4px">
            ${labelsRowHtml}
        </div>

        <!-- Action hint + regime -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
            <div style="font-size:11px">
                ${d.isLongGamma
            ? '<span style="color:var(--green);font-weight:700">🔄 Long γ</span> <span style="color:var(--text-muted)">Wall = Fade</span>'
            : '<span style="color:var(--red);font-weight:700">🌊 Short γ</span> <span style="color:var(--text-muted)">Wall = Breakout</span>'
        }
            </div>
            <div style="font-size:12px">${actionHint}</div>
        </div>
    </div>`;

    // ── ACTION LINE (R:R Engine, Multi-Wall) ──
    // Helper: format wall strike colored
    const fmtC = (strike) => `<span style="color:var(--call-color);font-weight:700">$${strike}</span>`;
    const fmtP = (strike) => `<span style="color:var(--put-color);font-weight:700">$${strike}</span>`;
    const fmtPink = (strike) => `<span style="color:var(--pink);font-weight:700">$${strike}</span>`;
    const fmtCyan = (strike) => `<span style="color:var(--cyan);font-weight:700">$${strike}</span>`;

    // Use nearest walls for primary references, fallback to max
    const nrStr = d.nearestCall ? fmtC(d.nearestCall.strike) : fmtC(d.maxCall.strike);
    const nsStr = d.nearestPut ? fmtP(d.nearestPut.strike) : fmtP(d.maxPut.strike);
    const nrDist = d.nearestCall ? d.nearestCall.dist : d.distToCallWall;
    const nsDist = d.nearestPut ? d.nearestPut.dist : d.distToPutWall;

    // Build wall chain: "→ $5250 (234) → $5300 (1,139)"
    const wsc = d.wallSliceCount || 3;
    const callChain = d.callWalls.slice(1, wsc).map(w => `→ ${fmtC(w.strike)} (${w.oi.toLocaleString()})`).join(' ');
    const putChain = d.putWalls.slice(1, wsc).map(w => `→ ${fmtP(w.strike)} (${w.oi.toLocaleString()})`).join(' ');

    // Tradeable range info
    const trStr = d.tradeableRange < 999 ? `<span style="font-size:12px;color:var(--text-muted)">📊 Tradeable Range: ${d.tradeableRange.toFixed(0)} pts</span>` : '';

    // ── PROXIMITY CLASSIFICATION ──
    const erRef = d.er1Day || 50;
    const callProx = nrDist / erRef;   // ratio: < 0.5 = near, > 0.7 = far
    const putProx = nsDist / erRef;
    const nearCallZone = callProx < 0.5;
    const nearPutZone = putProx < 0.5;
    const noEdgeZone = callProx > 0.7 && putProx > 0.7;
    const trendUp = d.biasScore > 0 || d.priceBelowMP;
    const trendDown = d.biasScore < 0 || d.priceAboveMP;

    // ── STYLE-AWARE CONTEXT ──
    const styleCtx = {
        daytrade: {
            scalpLabel: 'SCALP', holdWarn: '❌ ห้ามถือข้ามคืน!',
            sizeHint: 'Size เล็ก — scalp เท่านั้น', confirmTf: 'แท่ง 5m/15m',
            holdDuration: 'ภายในวัน', entryMethod: 'Pin Bar / Reject ที่ Wall',
            noChase: 'ถ้าตั้ง TP ที่กลางแล้วราคายังไม่ถึง → ปิด อย่าโลภ',
        },
        swing: {
            scalpLabel: 'SWING', holdWarn: '⏳ ถือ 2-5 วัน ได้ — ใช้ Daily Close ยืนยัน',
            sizeHint: 'Size ปกติ — ถือ 2-5 วัน', confirmTf: 'Daily Close',
            holdDuration: '2-5 วัน', entryMethod: 'Daily Close เหนือ/ใต้ Wall',
            noChase: 'TP ที่ Wall ถัดไป — ไม่ต้องรีบปิด ถ้า Daily ยังไม่ Reject',
        },
        position: {
            scalpLabel: 'POSITION', holdWarn: '📅 ถือ 1-4 สัปดาห์ — ใช้ Weekly Close ยืนยัน',
            sizeHint: 'Full size — ถือ 1-4 สัปดาห์', confirmTf: 'Weekly Close',
            holdDuration: '1-4 สัปดาห์', entryMethod: 'Weekly Close เหนือ/ใต้ Major Wall',
            noChase: 'TP ที่ Major Wall ถัดไป — ถือยาว ปิดเมื่อ Weekly Reject',
        },
    }[state.tradingStyle];

    // ── Collect ALL levels for TP candidate pool ──
    const allSetupLevels = [];
    // Call walls as levels
    for (const w of d.callWalls) {
        allSetupLevels.push({ strike: w.strike, label: `Call Wall (${w.oi.toLocaleString()})`, type: 'call-wall' });
    }
    // Put walls as levels
    for (const w of d.putWalls) {
        allSetupLevels.push({ strike: w.strike, label: `Put Wall (${w.oi.toLocaleString()})`, type: 'put-wall' });
    }
    // Max Pain
    if (d.mpStrike) {
        allSetupLevels.push({ strike: d.mpStrike, label: 'Max Pain', type: 'maxpain' });
    }
    // Gamma Mean
    if (d.risk.gammaMean) {
        allSetupLevels.push({ strike: +d.risk.gammaMean.toFixed(0), label: 'Gamma Mean', type: 'gamma-mean' });
    }
    // GEX Flip
    if (d.gexResult.flipStrike) {
        allSetupLevels.push({ strike: d.gexResult.flipStrike, label: 'GEX Flip', type: 'gex-flip' });
    }

    // ── Render helper for a single setup card ──
    const renderSetupCard = (setup, borderColor, bgColor) => {
        const isLong = setup.direction === 'long';
        const dirLabel = isLong ? 'LONG' : 'SHORT';
        const dirColor = isLong ? 'var(--green)' : 'var(--red)';
        const dirBg = isLong ? 'rgba(38,166,154,.06)' : 'rgba(239,83,80,.06)';
        const dirBorder = isLong ? 'rgba(38,166,154,.15)' : 'rgba(239,83,80,.15)';

        let html = `<div style="flex:1;min-width:240px;padding:12px 16px;background:${dirBg};border-radius:10px;border:1px solid ${dirBorder}">`;

        // Header with trade type + R:R badge
        html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">`;
        html += `<div style="font-size:11px;color:var(--text-muted);font-weight:700">${setup.tradeTypeIcon} ${setup.tradeType} ${dirLabel}</div>`;
        html += `<div style="font-size:11px;font-weight:800;color:${setup.gradeColor};background:${setup.gradeColor}15;padding:2px 8px;border-radius:10px;border:1px solid ${setup.gradeColor}40">${setup.gradeIcon} R:R ${setup.rr.toFixed(1)} ${setup.gradeLabel}</div>`;
        html += `</div>`;

        // Entry
        const entryFmt = isLong ? fmtP(setup.entryStrike) : fmtC(setup.entryStrike);
        html += `<div style="font-size:13px;color:var(--text-primary);line-height:2.0">`;
        html += `<b>Entry:</b> ${entryFmt} (${isLong ? 'ที่ Support' : 'ที่ Resistance'})<br>`;

        // SL with risk in $
        html += `<b>SL:</b> <span style="color:var(--red)">$${setup.slStrike}</span> <span style="font-size:11px;color:var(--text-muted)">(${isLong ? '' : '+'}${isLong ? '-' : ''}$${setup.risk.toFixed(0)} risk)</span><br>`;

        // TP chain with distances
        if (setup.tps.length > 0) {
            const tpParts = setup.tps.map((tp, i) => {
                const tpFmt = tp.type === 'call-wall' || tp.type === 'gex-flip' ? fmtC(tp.strike) : tp.type === 'put-wall' ? fmtP(tp.strike) : tp.type === 'maxpain' ? fmtPink(tp.strike) : fmtCyan(tp.strike);
                const dist = isLong ? tp.strike - setup.entryStrike : setup.entryStrike - tp.strike;
                return `TP${i + 1}: ${tpFmt} (${isLong ? '+' : ''}${isLong ? '' : '-'}${dist.toFixed(0)})`;
            });
            html += `<b>Target:</b> ${tpParts.join(' → ')}<br>`;
        } else {
            html += `<b>Target:</b> <span style="color:var(--text-muted)">ไม่มี TP ที่เหมาะสม</span><br>`;
        }

        html += `</div>`;

        // Warning for bad R:R
        if (!setup.isViable) {
            html += `<div style="font-size:11px;color:var(--red);margin-top:4px;padding:4px 8px;background:rgba(239,83,80,.08);border-radius:6px">⚠️ R:R ต่ำเกิน — ไม่แนะนำเทรด</div>`;
        }
        // DTE warning for swing
        if (setup.tradeType === 'SWING') {
            html += `<div style="font-size:11px;color:var(--orange);margin-top:4px">⚠️ Size เบาๆ — กิน 2-5 วัน</div>`;
        }

        html += `</div>`;
        return html;
    };

    let actionHtml;
    if (d.risk.noMansLand) {
        const isUp = d.risk.noMansLandSide === 'above';
        actionHtml = isUp
            ? `<b style="color:#ff1744">ห้าม Short!</b> ราคานอก Gamma Zone — Follow ขึ้นอย่างเดียว | SL ใต้ High ล่าสุด`
            : `<b style="color:#ff1744">ห้าม Buy!</b> ราคานอก Gamma Zone — Follow ลงอย่างเดียว | SL เหนือ Low ล่าสุด`;
    } else if (d.priceAboveCallWall && d.isLongGamma) {
        // DAMPENING ZONE: Long Gamma + Above Call Wall = mean-reversion, not squeeze
        const swStr = fmtC(d.structCallWall.strike);
        const gmTarget = d.risk.gammaMean ? fmtCyan(d.risk.gammaMean.toFixed(0)) : (d.mpStrike ? fmtPink(d.mpStrike) : swStr);
        actionHtml = `<div style="padding:16px 18px;background:rgba(0,188,212,.06);border-radius:10px;border:1px solid rgba(0,188,212,.2)">`;
        actionHtml += `<div style="font-size:13px;font-weight:800;color:var(--cyan);margin-bottom:8px">🔄 DAMPENING ZONE — Long γ กด Sideways</div>`;
        actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
        actionHtml += `ราคาเหนือ Call Wall ${swStr} (+${d.callWallBreakoutDist.toFixed(0)} pts) แต่ Long Gamma<br>`;
        actionHtml += `<span style="color:var(--cyan);font-weight:700">→ Dealer ขายเมื่อราคาขึ้น / ซื้อเมื่อราคาลง = Squeeze ไม่เกิด</span><br>`;
        actionHtml += `<span style="color:var(--red)">❌ ห้าม Chase Long!</span> ราคาไม่มี momentum ขึ้นต่อ<br>`;
        actionHtml += `<span style="color:var(--green)">✅ Strategy:</span> Mean-Reversion — Short ใกล้ Peak TP ${gmTarget} | หรือรอ OI เปลี่ยน`;
        actionHtml += `</div></div>`;
    } else if (d.priceAboveCallWall) {
        // Short Gamma + Above Call Wall = genuine breakout
        const vannaContractsAct = Math.abs(d.vannaExp / (d.uPrice * 100));
        const vannaMeaningfulAct = vannaContractsAct / getProfile().defaultADV > 0.005;
        const vannaConfirm = d.vannaExp < 0 && vannaMeaningfulAct;
        const swStr = fmtC(d.structCallWall.strike);
        // Build breakout long setup with buildTradeSetup
        const breakoutSetup = buildTradeSetup('long', d.structCallWall.strike, allSetupLevels, d.er1Day, d.dte, d.putWalls, d.callWalls);
        actionHtml = `<b style="color:var(--green)">Buy / Follow Long!</b> ราคาทะลุ Call Wall ${swStr} ไปแล้ว +${d.callWallBreakoutDist.toFixed(0)} pts`;
        if (vannaConfirm) actionHtml += `<br>✅ Vanna ยืนยัน — Dealers ต้อง Buy = ดัน squeeze ต่อ`;
        else if (!vannaMeaningfulAct) actionHtml += `<br>⚠️ Vanna แรงน้อย — ไม่มีนัยสำคัญ pullback ได้`;
        else actionHtml += `<br>⚠️ Vanna ยังไม่ยืนยัน — ถ้า IV ลดราคาอาจ pullback กลับ`;
        actionHtml += `<br><b>SL:</b> <span style="color:var(--red)">$${breakoutSetup.slStrike}</span> ใต้ Call Wall เดิม`;
        if (breakoutSetup.tps.length > 0) {
            const tpParts = breakoutSetup.tps.map((tp, i) => `TP${i + 1}: ${fmtC(tp.strike)} (+${tp.dist.toFixed(0)})`);
            actionHtml += ` | ${tpParts.join(' → ')}`;
        }
        actionHtml += `<br><span style="font-size:12px;color:${breakoutSetup.gradeColor};font-weight:700">${breakoutSetup.gradeIcon} R:R ${breakoutSetup.rr.toFixed(1)} ${breakoutSetup.gradeLabel}</span>`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">🔥 Wall ถูกทะลุแล้ว — Call Wall เดิมกลายเป็น Support | ห้าม Short สวนทาง!</div>`;
    } else if (d.priceBelowPutWall) {
        const vannaContractsAct = Math.abs(d.vannaExp / (d.uPrice * 100));
        const vannaMeaningfulAct = vannaContractsAct / getProfile().defaultADV > 0.005;
        const vannaConfirm = d.vannaExp > 0 && vannaMeaningfulAct;
        const swStr = fmtP(d.structPutWall.strike);
        const breakdownSetup = buildTradeSetup('short', d.structPutWall.strike, allSetupLevels, d.er1Day, d.dte, d.putWalls, d.callWalls);
        actionHtml = `<b style="color:var(--red)">Sell / Follow Short!</b> ราคาหลุด Put Wall ${swStr} ไปแล้ว -${d.putWallBreakdownDist.toFixed(0)} pts`;
        if (vannaConfirm) actionHtml += `<br>✅ Vanna ยืนยัน — Dealers ต้อง Sell = กดลงต่อ`;
        else if (!vannaMeaningfulAct) actionHtml += `<br>⚠️ Vanna แรงน้อย — ไม่มีนัยสำคัญ bounce ได้`;
        else actionHtml += `<br>⚠️ Vanna ยังไม่ยืนยัน — ถ้า IV ลดราคาอาจ bounce กลับ`;
        actionHtml += `<br><b>SL:</b> <span style="color:var(--red)">$${breakdownSetup.slStrike}</span> เหนือ Put Wall เดิม`;
        if (breakdownSetup.tps.length > 0) {
            const tpParts = breakdownSetup.tps.map((tp, i) => `TP${i + 1}: ${fmtP(tp.strike)} (-${tp.dist.toFixed(0)})`);
            actionHtml += ` | ${tpParts.join(' → ')}`;
        }
        actionHtml += `<br><span style="font-size:12px;color:${breakdownSetup.gradeColor};font-weight:700">${breakdownSetup.gradeIcon} R:R ${breakdownSetup.rr.toFixed(1)} ${breakdownSetup.gradeLabel}</span>`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">🔥 Wall ถูกทะลุแล้ว — Put Wall เดิมกลายเป็น Resistance | ห้าม Buy สวนทาง!</div>`;
    } else if (d.isLongGamma) {
        // SL buffer scales with volatility and trading style
        const slMul = STYLE_CONFIG[state.tradingStyle].slMul;
        const slBuffer = Math.max(10, Math.round(erRef * slMul));
        const nrStrike = d.nearestCall ? d.nearestCall.strike : d.maxCall.strike;
        const nsStrike = d.nearestPut ? d.nearestPut.strike : d.maxPut.strike;
        // Next walls beyond nearest (for breakout TP targets)
        const nextCallWall = d.callWalls.length > 1 ? d.callWalls[1] : null;
        const nextPutWall = d.putWalls.length > 1 ? d.putWalls[1] : null;

        if (hasBrokenWall) {
            // ── SCENARIO 0: BROKEN WALL RETEST (Volume-Confirmed) ──
            // Price has broken through a significant OI wall, intraday volume confirms
            // The broken wall becomes new support/resistance → trade the retest
            actionHtml = `<div style="display:flex;flex-direction:column;gap:12px">`;

            if (bestBrokenCall) {
                const bwStr = fmtC(bestBrokenCall.strike);
                const confIcon = bestBrokenCall.volumeConf === 'strong' ? '🔥🔥' : '⚡';
                const confPct = (bestBrokenCall.volRatio * 100).toFixed(0);
                const confLabel = bestBrokenCall.volumeConf === 'strong' ? 'Vol แรงมาก!' : 'Vol พอใช้';
                const tpTarget = nearCallStrike ? fmtC(nearCallStrike) : (d.callWalls.length > 0 ? fmtC(d.callWalls[0].strike) : fmtCyan(d.risk.gammaMean ? d.risk.gammaMean.toFixed(0) : '?'));
                const tpDist = nearCallStrike ? (nearCallStrike - bestBrokenCall.strike) : 0;

                actionHtml += `<div style="padding:16px 18px;background:linear-gradient(135deg,rgba(255,152,0,.08),rgba(38,166,154,.04));border-radius:12px;border:1px solid rgba(255,152,0,.35);border-left:5px solid var(--orange)">`;
                actionHtml += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">`;
                actionHtml += `<span style="font-size:18px">${confIcon}</span>`;
                actionHtml += `<span style="font-size:14px;font-weight:900;color:var(--orange);letter-spacing:.3px">BROKEN WALL DETECTED — Buy Retest!</span>`;
                actionHtml += `<span style="font-size:11px;padding:2px 8px;background:rgba(255,152,0,.2);border-radius:10px;color:var(--orange);font-weight:700">${confLabel} (Vol/OI: ${confPct}%)</span>`;
                actionHtml += `</div>`;
                actionHtml += `<div style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin-bottom:12px">`;
                actionHtml += `ราคาทะลุ Call Wall ${bwStr} แล้ว +${bestBrokenCall.dist.toFixed(0)} pts — Intraday Volume ยืนยันว่า Wall ถูก absorb จริง`;
                actionHtml += `<br>Wall เดิมกลายเป็น <span style="color:var(--green);font-weight:700">New Support</span> → Buy เมื่อราคา pullback กลับมา retest`;
                actionHtml += `</div>`;

                actionHtml += `<div style="padding:14px 16px;background:rgba(38,166,154,.06);border-radius:12px;border:1px solid rgba(38,166,154,.2)">`;
                actionHtml += `<div style="font-size:12px;color:var(--green);font-weight:800;margin-bottom:8px">⬆️ BUY RETEST (Wall เดิมเป็น Support ใหม่)</div>`;
                actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2.2">`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❶ รอราคา Pullback:</span> กลับมาแตะ ${bwStr}<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❷ Confirm:</span> ${styleCtx.entryMethod} ที่ ${bwStr} (Wall เดิมต้านให้)<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❸ Entry:</span> Buy ที่ ${bwStr} หรือเหนือเล็กน้อย<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❹ SL:</span> <span style="color:var(--red);font-weight:700">$${(bestBrokenCall.strike - slBuffer).toFixed(0)}</span> (ใต้ Wall ${slBuffer} pts — ถ้าหลุดกลับแปลว่า fake break)<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❺ TP:</span> ${tpTarget}${tpDist > 0 ? ` <span style="color:var(--text-muted)">(+${tpDist.toFixed(0)} pts)</span>` : ''}`;
                if (callChain) actionHtml += ` ${callChain}`;
                actionHtml += `</div></div>`;

                // ── Also show: if price doesn't pull back, follow momentum ──
                actionHtml += `<div style="padding:12px 16px;background:rgba(255,255,255,.03);border-radius:10px;border:1px dashed rgba(255,255,255,.1);margin-top:4px">`;
                actionHtml += `<div style="font-size:12px;color:var(--text-muted);line-height:1.8">`;
                actionHtml += `💡 ถ้าราคาไม่ pullback กลับ ${bwStr} → ไม่ต้องไล่ตาม — รอ Wall ถัดไป ${tpTarget} แล้ว Fade ที่นั่นแทน<br>`;
                actionHtml += `⚠️ ถ้าราคาหลุดกลับใต้ ${bwStr} = <span style="color:var(--red);font-weight:700">Fake Break</span> → ห้าม Buy, อาจ Short กลับในกรอบเดิม`;
                actionHtml += `</div></div>`;
            }

            if (bestBrokenPut) {
                const bwStr = fmtP(bestBrokenPut.strike);
                const confIcon = bestBrokenPut.volumeConf === 'strong' ? '🔥🔥' : '⚡';
                const confPct = (bestBrokenPut.volRatio * 100).toFixed(0);
                const confLabel = bestBrokenPut.volumeConf === 'strong' ? 'Vol แรงมาก!' : 'Vol พอใช้';
                const tpTarget = nearPutStrike ? fmtP(nearPutStrike) : (d.putWalls.length > 0 ? fmtP(d.putWalls[0].strike) : fmtCyan(d.risk.gammaMean ? d.risk.gammaMean.toFixed(0) : '?'));
                const tpDist = nearPutStrike ? (bestBrokenPut.strike - nearPutStrike) : 0;

                actionHtml += `<div style="padding:16px 18px;background:linear-gradient(135deg,rgba(255,152,0,.08),rgba(239,83,80,.04));border-radius:12px;border:1px solid rgba(255,152,0,.35);border-left:5px solid var(--orange)">`;
                actionHtml += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">`;
                actionHtml += `<span style="font-size:18px">${confIcon}</span>`;
                actionHtml += `<span style="font-size:14px;font-weight:900;color:var(--orange);letter-spacing:.3px">BROKEN WALL DETECTED — Sell Retest!</span>`;
                actionHtml += `<span style="font-size:11px;padding:2px 8px;background:rgba(255,152,0,.2);border-radius:10px;color:var(--orange);font-weight:700">${confLabel} (Vol/OI: ${confPct}%)</span>`;
                actionHtml += `</div>`;
                actionHtml += `<div style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin-bottom:12px">`;
                actionHtml += `ราคาหลุด Put Wall ${bwStr} แล้ว -${bestBrokenPut.dist.toFixed(0)} pts — Intraday Volume ยืนยันว่า Wall ถูก absorb จริง`;
                actionHtml += `<br>Wall เดิมกลายเป็น <span style="color:var(--red);font-weight:700">New Resistance</span> → Sell เมื่อราคา bounce กลับมา retest`;
                actionHtml += `</div>`;

                actionHtml += `<div style="padding:14px 16px;background:rgba(239,83,80,.06);border-radius:12px;border:1px solid rgba(239,83,80,.2)">`;
                actionHtml += `<div style="font-size:12px;color:var(--red);font-weight:800;margin-bottom:8px">⬇️ SELL RETEST (Wall เดิมเป็น Resistance ใหม่)</div>`;
                actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2.2">`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❶ รอราคา Bounce:</span> กลับมาแตะ ${bwStr}<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❷ Confirm:</span> ${styleCtx.entryMethod} ที่ ${bwStr} (Wall เดิมกดให้)<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❸ Entry:</span> Sell ที่ ${bwStr} หรือใต้เล็กน้อย<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❹ SL:</span> <span style="color:var(--red);font-weight:700">$${(bestBrokenPut.strike + slBuffer).toFixed(0)}</span> (เหนือ Wall ${slBuffer} pts — ถ้าทะลุกลับแปลว่า fake break)<br>`;
                actionHtml += `<span style="color:var(--text-muted);font-size:11px">❺ TP:</span> ${tpTarget}${tpDist > 0 ? ` <span style="color:var(--text-muted)">(-${tpDist.toFixed(0)} pts)</span>` : ''}`;
                if (putChain) actionHtml += ` ${putChain}`;
                actionHtml += `</div></div>`;

                actionHtml += `<div style="padding:12px 16px;background:rgba(255,255,255,.03);border-radius:10px;border:1px dashed rgba(255,255,255,.1);margin-top:4px">`;
                actionHtml += `<div style="font-size:12px;color:var(--text-muted);line-height:1.8">`;
                actionHtml += `💡 ถ้าราคาไม่ bounce กลับ ${bwStr} → ไม่ต้องไล่ตาม — รอ Wall ถัดไป ${tpTarget} แล้ว Fade ที่นั่นแทน<br>`;
                actionHtml += `⚠️ ถ้าราคาทะลุกลับเหนือ ${bwStr} = <span style="color:var(--green);font-weight:700">Fake Break</span> → ห้าม Sell, อาจ Buy กลับในกรอบเดิม`;
                actionHtml += `</div></div>`;
            }

            // ── Broken Wall Confidence Explanation ──
            actionHtml += `<div style="padding:10px 14px;background:rgba(255,152,0,.04);border-radius:8px;border:1px solid rgba(255,152,0,.12)">`;
            actionHtml += `<div style="font-size:11px;color:var(--text-muted);line-height:1.7">`;
            actionHtml += `📊 <b>วิธีอ่าน Vol/OI:</b> Intraday Volume ÷ OI ที่ strike นั้น — ยิ่งสูง = ยิ่งยืนยันว่า Wall ถูก trade through จริง<br>`;
            actionHtml += `🔥 Strong (>15%) = มั่นใจสูง | ⚡ Moderate (5-15%) = มั่นใจปานกลาง | 💤 Weak (<5%) = ไม่ค่อยมั่นใจ`;
            actionHtml += `</div></div>`;

            if (trStr) actionHtml += `<div style="margin-top:4px">${trStr}</div>`;
            actionHtml += `</div>`;  // close flex column

        } else if (nearCallZone && trendUp) {
            // ── SCENARIO A: ราคาใกล้ Call Wall + ขาขึ้น ──
            actionHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap">`;
            // Breakout Long
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(38,166,154,.08);border-radius:10px;border:1px solid rgba(38,166,154,.25)">`;
            actionHtml += `<div style="font-size:11px;color:var(--green);font-weight:800;margin-bottom:6px">🚀 BREAKOUT LONG <span style="font-size:10px;color:var(--text-muted);font-weight:400">(รอทะลุก่อนเข้า)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Trigger: ราคาทะลุ + ${styleCtx.confirmTf} เหนือ ${nrStr}<br>`;
            actionHtml += `Entry: Retest ${nrStr} เป็น Support<br>`;
            actionHtml += `SL: $${(nrStrike - slBuffer).toFixed(0)} (ใต้ Wall)<br>`;
            actionHtml += `TP₁: ${nextCallWall ? fmtC(nextCallWall.strike) : (d.callWalls.length > 0 ? fmtC(d.callWalls[d.callWalls.length - 1].strike) : nrStr)}`;
            if (callChain) actionHtml += ` ${callChain}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ ห้ามซื้อก่อนทะลุ! Long γ = fake breakout สูง</div>`;
            actionHtml += `</div>`;
            // Scalp Short (fade the wall)
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(239,83,80,.06);border-radius:10px;border:1px solid rgba(239,83,80,.15)">`;
            actionHtml += `<div style="font-size:11px;color:var(--red);font-weight:800;margin-bottom:6px">🎯 ${styleCtx.scalpLabel} SHORT <span style="font-size:10px;color:var(--text-muted);font-weight:400">(ชน Wall แล้วเด้ง)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Entry: ${nrStr} (ที่ Wall)<br>`;
            actionHtml += `SL: $${(nrStrike + slBuffer).toFixed(0)}<br>`;
            // Short TP ต้องต่ำกว่า Entry (nrStrike)
            const scalpShortTP = (d.mpStrike && d.mpStrike < nrStrike) ? mpStr
                : (d.risk.gammaMean && d.risk.gammaMean < nrStrike) ? gmStr
                    : nsStr;
            actionHtml += `TP: ${scalpShortTP}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ ${styleCtx.sizeHint}</div>`;
            actionHtml += `</div></div>`;
            if (trStr) actionHtml += `<div style="margin-top:6px">${trStr}</div>`;

        } else if (nearPutZone && trendDown) {
            // ── SCENARIO B: ราคาใกล้ Put Wall + ขาลง ──
            actionHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap">`;
            // Breakdown Short
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(239,83,80,.08);border-radius:10px;border:1px solid rgba(239,83,80,.25)">`;
            actionHtml += `<div style="font-size:11px;color:var(--red);font-weight:800;margin-bottom:6px">💧 BREAKDOWN SHORT <span style="font-size:10px;color:var(--text-muted);font-weight:400">(รอหลุดก่อนเข้า)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Trigger: ราคาหลุด + ${styleCtx.confirmTf} ใต้ ${nsStr}<br>`;
            actionHtml += `Entry: Retest ${nsStr} เป็น Resistance<br>`;
            actionHtml += `SL: $${(nsStrike + slBuffer).toFixed(0)} (เหนือ Wall)<br>`;
            actionHtml += `TP₁: ${nextPutWall ? fmtP(nextPutWall.strike) : (d.putWalls.length > 0 ? fmtP(d.putWalls[d.putWalls.length - 1].strike) : nsStr)}`;
            if (putChain) actionHtml += ` ${putChain}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ ห้ามขายก่อนหลุด! Long γ = fake breakdown สูง</div>`;
            actionHtml += `</div>`;
            // Scalp Long (bounce from wall)
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(38,166,154,.06);border-radius:10px;border:1px solid rgba(38,166,154,.15)">`;
            actionHtml += `<div style="font-size:11px;color:var(--green);font-weight:800;margin-bottom:6px">🎯 ${styleCtx.scalpLabel} LONG <span style="font-size:10px;color:var(--text-muted);font-weight:400">(ชน Wall แล้วเด้ง)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Entry: ${nsStr} (ที่ Wall)<br>`;
            actionHtml += `SL: $${(nsStrike - slBuffer).toFixed(0)}<br>`;
            // Long TP ต้องสูงกว่า Entry (nsStrike)
            const scalpLongTP = (d.mpStrike && d.mpStrike > nsStrike) ? mpStr
                : (d.risk.gammaMean && d.risk.gammaMean > nsStrike) ? gmStr
                    : nrStr;
            actionHtml += `TP: ${scalpLongTP}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ ${styleCtx.sizeHint}</div>`;
            actionHtml += `</div></div>`;
            if (trStr) actionHtml += `<div style="margin-top:6px">${trStr}</div>`;

        } else if (noEdgeZone) {
            // ── SCENARIO C: NO EDGE ZONE — ราคากลาง range ──
            actionHtml = `<div style="padding:16px 18px;background:rgba(255,152,0,.06);border-radius:10px;border:1px solid rgba(255,152,0,.2)">`;
            actionHtml += `<div style="font-size:13px;font-weight:800;color:var(--orange);margin-bottom:8px">⏳ STAND ASIDE — ไม่มี Edge</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `ราคาอยู่กลาง Range ห่างจากทุก Wall → ไม่มี Setup ที่ดี<br>`;
            actionHtml += `📍 Resistance: ${nrStr} (+${nrDist.toFixed(0)} pts) | Support: ${nsStr} (-${nsDist.toFixed(0)} pts)<br>`;
            actionHtml += `<span style="color:var(--green)">✅ เข้าเมื่อ:</span> ราคาแตะ Wall ใดก็ตาม หรือ ทะลุ Wall ชัดเจน<br>`;
            actionHtml += `<span style="color:var(--red)">⛔ ห้าม:</span> เข้า Sideway กลาง Range → โดน Shakeout แน่นอน`;
            actionHtml += `</div></div>`;
            if (trStr) actionHtml += `<div style="margin-top:6px">${trStr}</div>`;

        } else {
            // ── SCENARIO D: WALL-TO-WALL FADE (Long γ = Dealer คุม Range) ──
            // R:R calculation
            const fadeRR_short = nrDist > 0 ? ((nrDist - slBuffer) / nrDist).toFixed(1) : '?';
            const fadeRR_long = nsDist > 0 ? ((nsDist - slBuffer) / nsDist).toFixed(1) : '?';

            actionHtml = `<div style="padding:14px 18px;background:rgba(0,188,212,.04);border-radius:12px;border:1px solid rgba(0,188,212,.2);margin-bottom:12px">`;
            actionHtml += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">`;
            actionHtml += `<span style="font-size:16px">🔄</span>`;
            actionHtml += `<span style="font-size:14px;font-weight:900;color:var(--cyan);letter-spacing:.3px">WALL-TO-WALL FADE — Long γ = Dealer คุมกรอบ ราคาเด้งไปมา</span>`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-secondary);line-height:1.7;margin-bottom:10px">`;
            actionHtml += `Long γ = Dealer <span style="color:var(--cyan);font-weight:700">ขายเมื่อขึ้น + ซื้อเมื่อลง</span> → ราคาวิ่งถึง Wall แล้วเด้ง → เทรดกลับได้`;
            actionHtml += `</div></div>`;

            actionHtml += `<div style="display:flex;gap:12px;flex-wrap:wrap">`;

            // ── SHORT at Call Wall (ถึง Wall บน → Sell) ──
            actionHtml += `<div style="flex:1;min-width:220px;padding:14px 16px;background:rgba(239,83,80,.06);border-radius:12px;border:1px solid rgba(239,83,80,.2)">`;
            actionHtml += `<div style="font-size:12px;color:var(--red);font-weight:800;margin-bottom:8px">⬇️ SELL ที่ Call Wall (ถึงข้างบน → ขาย)</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2.2">`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❶ รอราคาแตะ:</span> ${nrStr}<br>`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❷ Confirm:</span> ${styleCtx.entryMethod}<br>`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❸ Entry:</span> Sell ที่ ${nrStr} (หรือรอ Reject ก่อน)<br>`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❹ SL:</span> <span style="color:var(--red);font-weight:700">$${(nrStrike + slBuffer).toFixed(0)}</span> (เหนือ Wall ${slBuffer} pts)<br>`;
            // Fade Short TP ต้องต่ำกว่า Entry (nrStrike)
            const fadeShortTP = (d.mpStrike && d.mpStrike < nrStrike) ? mpStr
                : (d.risk.gammaMean && d.risk.gammaMean < nrStrike) ? gmStr
                    : nsStr;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❺ TP₁:</span> ${fadeShortTP} <span style="color:var(--text-muted)">(กลาง Range)</span>`;
            actionHtml += ` | <span style="color:var(--text-muted);font-size:11px">TP₂:</span> ${nsStr} <span style="color:var(--text-muted)">(Wall ล่าง)</span>`;
            actionHtml += `</div></div>`;

            // ── LONG at Put Wall (ถึง Wall ล่าง → Buy) ──
            actionHtml += `<div style="flex:1;min-width:220px;padding:14px 16px;background:rgba(38,166,154,.06);border-radius:12px;border:1px solid rgba(38,166,154,.2)">`;
            actionHtml += `<div style="font-size:12px;color:var(--green);font-weight:800;margin-bottom:8px">⬆️ BUY ที่ Put Wall (ถึงข้างล่าง → ซื้อ)</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2.2">`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❶ รอราคาแตะ:</span> ${nsStr}<br>`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❷ Confirm:</span> ${styleCtx.entryMethod}<br>`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❸ Entry:</span> Buy ที่ ${nsStr} (หรือรอ Reject ก่อน)<br>`;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❹ SL:</span> <span style="color:var(--red);font-weight:700">$${(nsStrike - slBuffer).toFixed(0)}</span> (ใต้ Wall ${slBuffer} pts)<br>`;
            // Fade Long TP ต้องสูงกว่า Entry (nsStrike)
            const fadeLongTP = (d.mpStrike && d.mpStrike > nsStrike) ? mpStr
                : (d.risk.gammaMean && d.risk.gammaMean > nsStrike) ? gmStr
                    : nrStr;
            actionHtml += `<span style="color:var(--text-muted);font-size:11px">❺ TP₁:</span> ${fadeLongTP} <span style="color:var(--text-muted)">(กลาง Range)</span>`;
            actionHtml += ` | <span style="color:var(--text-muted);font-size:11px">TP₂:</span> ${nrStr} <span style="color:var(--text-muted)">(Wall บน)</span>`;
            actionHtml += `</div></div></div>`;

            // ── Important Rules ──
            actionHtml += `<div style="padding:12px 16px;background:rgba(255,152,0,.05);border-radius:10px;border:1px solid rgba(255,152,0,.15);margin-top:4px">`;
            actionHtml += `<div style="font-size:12px;font-weight:700;color:var(--orange);margin-bottom:6px">⚠️ กฎสำคัญ (Wall-to-Wall Fade)</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `✅ เข้า<b>เฉพาะที่ Wall</b> — ห้ามเข้ากลาง Range (โดน Shakeout 2 ทาง)<br>`;
            actionHtml += `✅ <b>รอแท่ง Reject</b> ก่อนเข้า — Pin Bar / Doji / Volume Spike ที่ Wall<br>`;
            actionHtml += `✅ TP กลาง Range (หรือ Max Pain) ก่อน แล้วค่อยเลื่อนไป Wall ตรงข้าม<br>`;
            actionHtml += `<span style="color:var(--red);font-weight:700">❌ ห้ามไล่ตามฆาก Breakout!</span> Long γ = Fake Breakout สูง ราคาจะเด้งกลับ<br>`;
            actionHtml += `<span style="color:var(--red);font-weight:700">${styleCtx.holdWarn}</span> ${styleCtx.noChase}`;
            actionHtml += `</div></div>`;

            if (trStr) actionHtml += `<div style="margin-top:6px">${trStr}</div>`;
        }
    } else {
        // ── Short gamma: trend following — Breakout/Breakdown ──
        const breakoutEntry = d.nearestCall ? d.nearestCall.strike : d.maxCall.strike;
        const breakdownEntry = d.nearestPut ? d.nearestPut.strike : d.maxPut.strike;

        const breakoutSetup = buildTradeSetup('long', breakoutEntry, allSetupLevels, d.er1Day, d.dte, d.putWalls, d.callWalls);
        const breakdownSetup = buildTradeSetup('short', breakdownEntry, allSetupLevels, d.er1Day, d.dte, d.putWalls, d.callWalls);

        // Override labels for breakout/breakdown
        const renderBreakoutCard = (setup, label, emoji) => {
            const isLong = setup.direction === 'long';
            const dirColor = isLong ? 'var(--green)' : 'var(--red)';
            const dirBg = isLong ? 'rgba(38,166,154,.06)' : 'rgba(239,83,80,.06)';
            const dirBorder = isLong ? 'rgba(38,166,154,.15)' : 'rgba(239,83,80,.15)';

            let html = `<div style="flex:1;min-width:240px;padding:12px 16px;background:${dirBg};border-radius:10px;border:1px solid ${dirBorder}">`;
            html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">`;
            html += `<div style="font-size:11px;color:var(--text-muted);font-weight:700">${emoji} ${label}</div>`;
            html += `<div style="font-size:11px;font-weight:800;color:${setup.gradeColor};background:${setup.gradeColor}15;padding:2px 8px;border-radius:10px;border:1px solid ${setup.gradeColor}40">${setup.gradeIcon} R:R ${setup.rr.toFixed(1)} ${setup.gradeLabel}</div>`;
            html += `</div>`;

            const entryFmt = isLong ? fmtC(setup.entryStrike) : fmtP(setup.entryStrike);
            html += `<div style="font-size:13px;color:var(--text-primary);line-height:2.0">`;
            html += `<b>Trigger:</b> ${isLong ? 'ทะลุ' : 'หลุด'} ${entryFmt}<br>`;
            html += `<b>SL:</b> <span style="color:var(--red)">$${setup.slStrike}</span> <span style="font-size:11px;color:var(--text-muted)">($${setup.risk.toFixed(0)} risk)</span><br>`;

            if (setup.tps.length > 0) {
                const tpParts = setup.tps.map((tp, i) => {
                    const tpFmt = tp.type === 'call-wall' ? fmtC(tp.strike) : tp.type === 'put-wall' ? fmtP(tp.strike) : tp.type === 'maxpain' ? fmtPink(tp.strike) : fmtCyan(tp.strike);
                    return `TP${i + 1}: ${tpFmt} (${tp.dist.toFixed(0)})`;
                });
                html += `<b>Target:</b> ${tpParts.join(' → ')}`;
            }
            html += `</div>`;

            if (!setup.isViable) {
                html += `<div style="font-size:11px;color:var(--red);margin-top:4px;padding:4px 8px;background:rgba(239,83,80,.08);border-radius:6px">⚠️ R:R ต่ำเกิน — ไม่แนะนำเทรด</div>`;
            }
            if (setup.tradeType === 'SWING') {
                html += `<div style="font-size:11px;color:var(--orange);margin-top:4px">⚠️ Size เบาๆ — กิน 2-5 วัน</div>`;
            }
            html += `</div>`;
            return html;
        };

        actionHtml = `<div style="display:flex;gap:16px;flex-wrap:wrap">`;
        actionHtml += renderBreakoutCard(breakdownSetup, 'BREAKDOWN SHORT', '🔥');
        actionHtml += renderBreakoutCard(breakoutSetup, 'BREAKOUT LONG', '🚀');
        actionHtml += `</div>`;

        // PATIENCE GUARD
        if (!breakoutSetup.isViable && !breakdownSetup.isViable) {
            actionHtml += `<div style="margin-top:10px;padding:10px 14px;background:rgba(255,23,68,.08);border:1px solid rgba(255,23,68,.25);border-radius:10px;display:flex;align-items:center;gap:10px">`;
            actionHtml += `<span style="font-size:18px">🚫</span>`;
            actionHtml += `<div><div style="font-size:13px;font-weight:800;color:#ff1744">PATIENCE GUARD — Long ↔ ราคากลาง Range → รอ!</div>`;
            actionHtml += `<div style="font-size:12px;color:var(--text-secondary)">Dealer ค้ำทั้ง 2 ทิศ → รอลากไปทาง Wall → โดย Stop ทั้งนั้น</div>`;
            actionHtml += `</div></div>`;
        }

        const dir = d.priceBelowMP ? 'ลง' : d.priceAboveMP ? 'ขึ้น' : '';
        const nrStrikeShort = d.nearestCall ? d.nearestCall.strike : d.maxCall.strike;
        const nsStrikeShort = d.nearestPut ? d.nearestPut.strike : d.maxPut.strike;
        const slBufShort = Math.max(10, Math.round(erRef * STYLE_CONFIG[state.tradingStyle].slMul));
        const biasUp = d.biasScore > 0 || d.priceBelowMP;
        const biasDown = d.biasScore < 0 || d.priceAboveMP;

        // Is price stuck between walls with tight range? (Sideway trap)
        const shortGammaSideway = d.tradeableRange < 999 && d.tradeableRange < erRef * 2;
        const shortGammaFarFromWalls = callProx > 0.5 && putProx > 0.5;

        actionHtml = `<div style="display:flex;flex-direction:column;gap:12px">`;

        // ── Current Status Assessment ──
        if (shortGammaSideway || shortGammaFarFromWalls) {
            // WAITING MODE: price is between walls, no trigger yet
            actionHtml += `<div style="padding:16px 18px;background:linear-gradient(135deg,rgba(255,87,34,.08),rgba(255,152,0,.04));border-radius:12px;border:1px solid rgba(255,87,34,.3);border-left:4px solid #ff5722">`;
            actionHtml += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">`;
            actionHtml += `<span style="font-size:18px">⏸️</span>`;
            actionHtml += `<span style="font-size:14px;font-weight:900;color:#ff5722;letter-spacing:.5px">WAITING MODE — ยังไม่ถึงเวลาเข้า!</span>`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `<span style="color:var(--red);font-weight:800">🚫 ตอนนี้ราคาอยู่กลาง Range ระหว่าง Wall → ห้ามเทรด!</span><br>`;
            actionHtml += `Short γ ไม่ได้แปลว่าต้องเข้าทุกวินาที — ต้อง <span style="color:white;font-weight:700">รอราคาทะลุ Wall ก่อน</span><br>`;
            actionHtml += `📍 ราคาปัจจุบัน: <span style="font-weight:700">$${d.uPrice.toFixed(0)}</span> | Resistance: ${nrStr} (+${nrDist.toFixed(0)}) | Support: ${nsStr} (-${nsDist.toFixed(0)})`;
            if (shortGammaSideway) {
                actionHtml += `<br><span style="color:var(--orange);font-weight:700">⚠️ Range แค่ ${d.tradeableRange.toFixed(0)} pts vs ER ${erRef.toFixed(0)} pts → Range แคบเสี่ยง Shakeout!</span>`;
            }
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.06)">`;
            actionHtml += `💡 <b>Sideway ใน Short γ อันตรายกว่า Long γ</b> — ราคาวิ่งไว ไม่มี Dealer ต้าน → Stop โดนง่าย ทั้ง 2 ทาง`;
            actionHtml += `</div></div>`;
        }

        // ── Breakout / Breakdown Trigger Setup ──
        actionHtml += `<div style="display:flex;gap:12px;flex-wrap:wrap">`;

        // LONG setup (Breakout)
        actionHtml += `<div style="flex:1;min-width:220px;padding:14px 16px;background:rgba(38,166,154,.06);border-radius:12px;border:1px solid rgba(38,166,154,.2)">`;
        actionHtml += `<div style="font-size:12px;color:var(--green);font-weight:800;margin-bottom:8px">🚀 BREAKOUT LONG</div>`;
        actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❶ Trigger:</span> ราคาทะลุ + <b>${styleCtx.confirmTf} เหนือ</b> ${nrStr}<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❷ Confirm:</span> Volume แท่ง Breakout > ค่าเฉลี่ย<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❸ Entry:</span> Buy ที่ Retest ${nrStr} เป็น Support<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❹ SL:</span> <span style="color:var(--red)">$${(nrStrikeShort - slBufShort).toFixed(0)}</span> (ใต้ Wall ${slBufShort} pts)<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❺ TP:</span> `;
        if (d.callWalls.length > 1) actionHtml += `${fmtC(d.callWalls[1].strike)} ${callChain}`;
        else actionHtml += `ER target $${(nrStrikeShort + erRef).toFixed(0)}`;
        actionHtml += `</div>`;
        actionHtml += `<div style="font-size:11px;margin-top:8px;padding:6px 8px;background:rgba(38,166,154,.1);border-radius:6px;color:var(--green);font-weight:600">`;
        actionHtml += `✅ Short γ = Dealer ซื้อตามราคา → Breakout จริงวิ่งไกล TP กว้างได้`;
        actionHtml += `</div></div>`;

        // SHORT setup (Breakdown)
        actionHtml += `<div style="flex:1;min-width:220px;padding:14px 16px;background:rgba(239,83,80,.06);border-radius:12px;border:1px solid rgba(239,83,80,.2)">`;
        actionHtml += `<div style="font-size:12px;color:var(--red);font-weight:800;margin-bottom:8px">💧 BREAKDOWN SHORT</div>`;
        actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❶ Trigger:</span> ราคาหลุด + <b>${styleCtx.confirmTf} ใต้</b> ${nsStr}<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❷ Confirm:</span> Volume แท่ง Breakdown > ค่าเฉลี่ย<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❸ Entry:</span> Sell ที่ Retest ${nsStr} เป็น Resistance<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❹ SL:</span> <span style="color:var(--red)">$${(nsStrikeShort + slBufShort).toFixed(0)}</span> (เหนือ Wall ${slBufShort} pts)<br>`;
        actionHtml += `<span style="color:var(--text-muted);font-size:11px">❺ TP:</span> `;
        if (d.putWalls.length > 1) actionHtml += `${fmtP(d.putWalls[1].strike)} ${putChain}`;
        else actionHtml += `ER target $${(nsStrikeShort - erRef).toFixed(0)}`;
        actionHtml += `</div>`;
        actionHtml += `<div style="font-size:11px;margin-top:8px;padding:6px 8px;background:rgba(239,83,80,.1);border-radius:6px;color:var(--red);font-weight:600">`;
        actionHtml += `✅ Short γ = Dealer ขายตามราคา → Breakdown จริงลงแรง TP กว้างได้`;
        actionHtml += `</div></div></div>`;

        // ── Bias Hint ──
        if (biasUp || biasDown) {
            const bClr = biasUp ? 'var(--green)' : 'var(--red)';
            const bDir = biasUp ? 'ขึ้น (Bullish)' : 'ลง (Bearish)';
            const bSetup = biasUp ? 'Breakout Long มีโอกาสสูงกว่า' : 'Breakdown Short มีโอกาสสูงกว่า';
            actionHtml += `<div style="font-size:12px;color:var(--text-secondary);padding:6px 12px;background:rgba(255,255,255,.03);border-radius:8px;border-left:3px solid ${bClr}">`;
            actionHtml += `📊 Bias: <span style="color:${bClr};font-weight:700">${bDir}</span> → ${bSetup}`;
            actionHtml += `</div>`;
        }

        if (trStr) actionHtml += `<div style="margin-top:4px">${trStr}</div>`;

        // ── Broken Wall Retest (Short Gamma) ──
        if (hasBrokenWall) {
            actionHtml += `<div style="padding:14px 18px;background:linear-gradient(135deg,rgba(255,152,0,.08),rgba(255,255,255,.02));border-radius:12px;border:1px solid rgba(255,152,0,.3);border-left:4px solid var(--orange)">`;
            actionHtml += `<div style="font-size:13px;font-weight:800;color:var(--orange);margin-bottom:8px">🔥 BROKEN WALL RETEST — Volume ยืนยัน!</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            if (bestBrokenCall) {
                const confPct = (bestBrokenCall.volRatio * 100).toFixed(0);
                actionHtml += `📍 Call Wall <span style="color:var(--call-color);font-weight:700">$${bestBrokenCall.strike}</span> ถูกทะลุแล้ว (Vol/OI: ${confPct}%) → <span style="color:var(--green);font-weight:700">New Support = Buy Retest!</span><br>`;
                actionHtml += `Entry: ถ้าราคา pullback มาแตะ $${bestBrokenCall.strike} → Buy | SL ใต้ $${(bestBrokenCall.strike - slBufShort).toFixed(0)}<br>`;
            }
            if (bestBrokenPut) {
                const confPct = (bestBrokenPut.volRatio * 100).toFixed(0);
                actionHtml += `📍 Put Wall <span style="color:var(--put-color);font-weight:700">$${bestBrokenPut.strike}</span> ถูกหลุดแล้ว (Vol/OI: ${confPct}%) → <span style="color:var(--red);font-weight:700">New Resistance = Sell Retest!</span><br>`;
                actionHtml += `Entry: ถ้าราคา bounce มาแตะ $${bestBrokenPut.strike} → Sell | SL เหนือ $${(bestBrokenPut.strike + slBufShort).toFixed(0)}<br>`;
            }
            actionHtml += `<span style="color:var(--text-muted);font-size:12px">💡 Short γ + Broken Wall = Retest มีโอกาสสูง เพราะ Dealer hedge ตาม momentum</span>`;
            actionHtml += `</div></div>`;
        }

        // ── Anti-Sideway Rules ──
        actionHtml += `<div style="padding:12px 16px;background:rgba(255,23,68,.06);border-radius:10px;border:1px solid rgba(255,23,68,.2)">`;
        actionHtml += `<div style="font-size:12px;font-weight:800;color:#ff1744;margin-bottom:6px">🚫 ห้ามทำ (Sideway Killer Rules)</div>`;
        actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
        actionHtml += `❌ ห้าม Fade สวนทาง — Short γ = วิ่งต่อไม่หยุด<br>`;
        actionHtml += `❌ ห้ามเข้าก่อนทะลุ Wall — ราคาระหว่าง Wall ยังไม่มี Setup<br>`;
        actionHtml += `❌ ห้ามเดาทิศ — ถ้าแท่งไม่ปิดเหนือ/ใต้ Wall = ยังไม่ Breakout<br>`;
        actionHtml += `❌ ห้ามเข้าซ้ำหลังโดน SL — รอ Setup ใหม่เท่านั้น ห้าม Revenge Trade`;
        actionHtml += `</div></div>`;

        // ── Why can't you fade walls in Short γ? Education box ──
        actionHtml += `<div style="padding:14px 18px;background:rgba(255,255,255,.02);border-radius:12px;border:1px dashed rgba(255,255,255,.12)">`;
        actionHtml += `<div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:10px">💡 ทำไม Sell ที่ $${nrStrikeShort} / Buy ที่ $${nsStrikeShort} ไม่ได้?</div>`;
        actionHtml += `<div style="display:flex;gap:12px;flex-wrap:wrap">`;

        // Long γ explanation
        actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(0,188,212,.06);border-radius:10px;border:1px solid rgba(0,188,212,.15)">`;
        actionHtml += `<div style="font-size:12px;font-weight:800;color:var(--cyan);margin-bottom:6px">✅ Long γ → Fade ได้!</div>`;
        actionHtml += `<div style="font-size:12px;color:var(--text-secondary);line-height:1.8">`;
        actionHtml += `Dealer <b>ขาย</b>เมื่อขึ้น + <b>ซื้อ</b>เมื่อลง<br>`;
        actionHtml += `→ ราคาถึง Wall แล้ว<b>เด้งกลับ</b><br>`;
        actionHtml += `→ Stop ไม่โดนง่าย (Wall ต้านจริง)<br>`;
        actionHtml += `→ <span style="color:var(--cyan);font-weight:700">Win Rate สูง R:R ดี</span>`;
        actionHtml += `</div></div>`;

        // Short γ explanation  
        actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(255,23,68,.06);border-radius:10px;border:1px solid rgba(255,23,68,.15)">`;
        actionHtml += `<div style="font-size:12px;font-weight:800;color:var(--red);margin-bottom:6px">❌ Short γ (ตอนนี้!) → Fade ไม่ได้!</div>`;
        actionHtml += `<div style="font-size:12px;color:var(--text-secondary);line-height:1.8">`;
        actionHtml += `Dealer <b>ซื้อ</b>เมื่อขึ้น + <b>ขาย</b>เมื่อลง<br>`;
        actionHtml += `→ ราคาถึง Wall แล้ว<b>ทะลุไปเลย</b><br>`;
        actionHtml += `→ Stop โดนทันที (Wall ไม่ต้าน)<br>`;
        actionHtml += `→ <span style="color:var(--red);font-weight:700">Win Rate ต่ำ พอร์ตแตก</span>`;
        actionHtml += `</div></div></div>`;

        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;line-height:1.7">`;
        actionHtml += `📊 สรุป: เทคนิค “Sell ที่ Wall บน / Buy ที่ Wall ล่าง” ใช้ได้เฉพาะ <span style="color:var(--cyan);font-weight:700">Long γ</span> เท่านั้น | `;
        actionHtml += `ตอนนี้เป็น <span style="color:var(--red);font-weight:700">Short γ</span> = ต้องรอ Breakout/Breakdown เท่านั้น`;
        actionHtml += `</div></div>`;

        actionHtml += `</div>`; // close flex column
    }

    // ── PRE-TRADE CHECKLIST (Always visible — the most important section) ──
    const triggerCall = d.nearestCall ? d.nearestCall.strike : d.maxCall.strike;
    const triggerPut = d.nearestPut ? d.nearestPut.strike : d.maxPut.strike;
    const erLabel = erRef.toFixed(0);

    // Auto-evaluate checks
    const chk1_atWall = nearCallZone || nearPutZone || d.priceAboveCallWall || d.priceBelowPutWall;
    const chk1_icon = chk1_atWall ? '✅' : '⬜';
    const chk1_color = chk1_atWall ? 'var(--green)' : 'var(--orange)';
    const chk1_text = chk1_atWall
        ? (nearCallZone ? `ใกล้ Call Wall $${triggerCall}` : nearPutZone ? `ใกล้ Put Wall $${triggerPut}` : d.priceAboveCallWall ? `ทะลุ Call Wall แล้ว` : `หลุด Put Wall แล้ว`)
        : `ราคายังห่าง Wall (Put ${nearPutDist.toFixed(0)} / Call ${nearCallDist.toFixed(0)} pts) — <b>รอ</b>`;

    const chk2_range = d.tradeableRange >= erRef * 1.5;
    const chk2_icon = chk2_range ? '✅' : '⬜';
    const chk2_color = chk2_range ? 'var(--green)' : 'var(--orange)';
    const chk2_text = chk2_range
        ? `Range ${d.tradeableRange.toFixed(0)} pts > 1.5× ER (${erLabel}) — R:R ดี`
        : `Range ${d.tradeableRange < 999 ? d.tradeableRange.toFixed(0) : '?'} pts < 1.5× ER (${erLabel}) — <b>Range แคบ ลดไซส์/รอ</b>`;

    const chk3_regime = true; // Always readable from data
    const regimeClear = Math.abs(d.gexVal) > 0; // just verify data exists
    const chk3_text = d.isLongGamma
        ? `Long γ → Fade strategy (ซื้อ Support / ขาย Resistance)`
        : `Short γ → Breakout strategy (รอทะลุ Wall แล้ว Follow)`;

    const chk4_risk = d.risk.totalScore < 70;
    const chk4_icon = chk4_risk ? '✅' : '⬜';
    const chk4_color = chk4_risk ? 'var(--green)' : 'var(--red)';
    const chk4_text = chk4_risk
        ? `Risk Score ${d.risk.totalScore}/100 — อยู่ในเกณฑ์`
        : `Risk Score ${d.risk.totalScore}/100 — <b>สูงมาก! ลดไซส์ หรือรอ</b>`;

    const allPass = chk1_atWall && chk2_range && chk4_risk;
    const passCount = [chk1_atWall, chk2_range, true, chk4_risk].filter(Boolean).length;
    const statusColor = allPass ? 'var(--green)' : passCount >= 3 ? 'var(--orange)' : 'var(--red)';
    const statusText = allPass ? '✅ READY — เข้าได้ตาม Setup' : passCount >= 3 ? '⚠️ เกือบพร้อม — ตรวจข้อที่ไม่ผ่าน' : '🛑 ยังไม่พร้อม — ห้ามเข้า!';

    const checklistHtml = `
    <div style="padding:18px 22px;background:linear-gradient(135deg,rgba(59,125,255,.06),rgba(255,255,255,.02));border-radius:14px;border:1px solid ${statusColor}40;border-left:5px solid ${statusColor}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:22px">📋</span>
                <span style="font-size:16px;font-weight:900;color:var(--text-primary);letter-spacing:.3px">PRE-TRADE CHECKLIST</span>
            </div>
            <div style="display:inline-flex;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:800;background:${statusColor}1a;border:1px solid ${statusColor}55;color:${statusColor}">${statusText}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px">
            <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:8px;border:1px solid ${chk1_color}22">
                <span style="font-size:18px;line-height:1">${chk1_icon}</span>
                <div>
                    <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;margin-bottom:2px">① ราคาที่ Wall</div>
                    <div style="font-size:12px;color:${chk1_color};line-height:1.5">${chk1_text}</div>
                </div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:8px;border:1px solid ${chk2_color}22">
                <span style="font-size:18px;line-height:1">${chk2_icon}</span>
                <div>
                    <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;margin-bottom:2px">② Range vs ER</div>
                    <div style="font-size:12px;color:${chk2_color};line-height:1.5">${chk2_text}</div>
                </div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:8px;border:1px solid rgba(255,255,255,.05)">
                <span style="font-size:18px;line-height:1">✅</span>
                <div>
                    <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;margin-bottom:2px">③ Regime ชัดเจน</div>
                    <div style="font-size:12px;color:var(--green);line-height:1.5">${chk3_text}</div>
                </div>
            </div>
            <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:8px;border:1px solid ${chk4_color}22">
                <span style="font-size:18px;line-height:1">${chk4_icon}</span>
                <div>
                    <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;margin-bottom:2px">④ Risk Score</div>
                    <div style="font-size:12px;color:${chk4_color};line-height:1.5">${chk4_text}</div>
                </div>
            </div>
        </div>

        <div style="display:flex;gap:12px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)">
            <div style="font-size:11px;color:var(--text-muted);line-height:1.6;flex:1">
                ⚠️ <b>ก่อนคลิก Buy/Sell:</b> ยืนยัน candle ปิดที่ Wall + Volume สูง + ไม่โดน SL มาก่อน 2 ครั้งวันนี้<br>
                🔔 ตั้ง Alert ที่ <span style="color:var(--put-color);font-weight:700">$${triggerPut}</span> และ <span style="color:var(--call-color);font-weight:700">$${triggerCall}</span> → ปิดจอ → กลับมาเฉพาะตอน Alert ดัง
            </div>
        </div>
    </div>`;

    // ── PATIENCE GUARD (Sideway warning — compact) ──
    let patienceHtml = '';
    const isChoppyLong = d.tradeableRange < 999 && d.tradeableRange < erRef * 1.5 && d.isLongGamma;
    const isChoppyShort = d.tradeableRange < 999 && d.tradeableRange < erRef * 2 && !d.isLongGamma;
    const isFarFromAllWalls = !nearCallZone && !nearPutZone;
    const isDampeningZone = d.priceAboveCallWall && d.isLongGamma;
    const isShortGammaSideway = !d.isLongGamma && (callProx > 0.5 && putProx > 0.5);

    if (isChoppyLong || isChoppyShort || (noEdgeZone && d.isLongGamma) || isDampeningZone || isShortGammaSideway) {
        const gammaLabel = d.isLongGamma ? 'Long γ' : 'Short γ';
        const dangerExplain = d.isLongGamma
            ? 'Dealer ต้านทั้ง 2 ทิศ → ราคาเด้งไปมาในกรอบ → โดน Stop ทั้งขึ้นทั้งลง'
            : 'Dealer วิ่งตามราคา → Spike ขึ้นลงรุนแรงไร้ทิศทาง → Stop โดนง่าย';
        const maxLossesInRange = d.tradeableRange > 0 ? Math.floor(erRef / (d.tradeableRange * 0.3)) : 0;

        patienceHtml = `
        <div style="padding:14px 18px;background:rgba(255,23,68,.06);border-radius:12px;border:1px solid rgba(255,23,68,.25);border-left:4px solid #ff1744">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <span style="font-size:18px">🛑</span>
                <span style="font-size:13px;font-weight:900;color:#ff1744">PATIENCE GUARD — ${gammaLabel} + ราคากลาง Range = รอ!</span>
                ${maxLossesInRange > 0 ? `<span style="font-size:11px;color:var(--red);margin-left:auto">ฝืน = โดน SL ~${maxLossesInRange}+ ครั้ง</span>` : ''}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.6">${dangerExplain}</div>
        </div>`;
    }

    // ── INSTITUTIONAL INTEL ──
    // Dynamic ADV: estimate from intraday volume data if available, else fallback to profile default
    const advDefault = getProfile().defaultADV;
    let adv = advDefault;
    if (d.sourceStrikes2 && d.sourceStrikes2.length > 0) {
        const totalIntradayVol = d.sourceStrikes2.reduce((sum, s) => sum + s.call + s.put, 0);
        // Intraday data is partial-day; scale up ~3× to approximate full-day ADV
        adv = Math.max(advDefault, totalIntradayVol * 3);
    }

    // Vanna: positive = dealers SELL (bearish), negative = dealers BUY (bullish)
    // 1 Option = 1 Futures contract equivalent (100 oz)
    const vannaContracts = Math.abs(d.vannaExp / (d.uPrice * 100));
    const vannaPctAdv = (vannaContracts / adv * 100).toFixed(1);
    const vannaColor = d.vannaExp > 0 ? 'var(--red)' : 'var(--green)';
    const vannaText = d.vannaExp > 0
        ? `IV +1% → Dealers <span style="color:var(--red);font-weight:700">SELL</span> ~${Math.round(vannaContracts).toLocaleString()} สัญญา (${vannaPctAdv}% ADV) = กดลง`
        : `IV +1% → Dealers <span style="color:var(--green);font-weight:700">BUY</span> ~${Math.round(vannaContracts).toLocaleString()} สัญญา (${vannaPctAdv}% ADV) = ดันขึ้น`;

    // Charm: positive = dealers SELL (bearish), negative = dealers BUY (bullish)
    const charmContracts = Math.abs(d.charmExp / (d.uPrice * 100));
    const charmPctAdv = (charmContracts / adv * 100).toFixed(1);
    const charmColor = d.charmExp > 0 ? 'var(--red)' : 'var(--green)';
    const charmText = d.charmExp > 0
        ? `Theta/Day → Dealers <span style="color:var(--red);font-weight:700">SELL</span> ~${Math.round(charmContracts).toLocaleString()} สัญญา (${charmPctAdv}% ADV) = กดลง`
        : `Theta/Day → Dealers <span style="color:var(--green);font-weight:700">BUY</span> ~${Math.round(charmContracts).toLocaleString()} สัญญา (${charmPctAdv}% ADV) = ดันขึ้น`;

    // Net GEX & Liquidity-Adjusted Gamma
    const gexContracts = Math.abs(d.gexVal / (d.uPrice * 100)); // GEX per $1 move
    const gexPctAdv = (gexContracts / adv * 100).toFixed(1);
    const gexSqueezeRisk = gexPctAdv > 5 ? '<span style="color:var(--orange);font-weight:700;background:rgba(255,152,0,0.1);padding:2px 6px;border-radius:4px;font-size:11px;margin-left:6px">⚠️ High Slippage Risk</span>' : '';
    const gexText = d.isLongGamma
        ? `+1 USD → Dealers <span style="color:var(--red);font-weight:700">SELL</span> ~${Math.round(gexContracts).toLocaleString()} สัญญา (${gexPctAdv}% ADV) = ต้านสมดุล`
        : `+1 USD → Dealers <span style="color:var(--green);font-weight:700">BUY</span> ~${Math.round(gexContracts).toLocaleString()} สัญญา (${gexPctAdv}% ADV) ${gexSqueezeRisk} = วิ่งตามน้ำ`;

    // Vomma: cascade risk level
    const vommaMag = Math.abs(d.vommaExp / 1e6);
    const vommaLevel = vommaMag > 50 ? 'สูง' : vommaMag > 10 ? 'ปานกลาง' : 'ต่ำ';
    const vommaLevelColor = vommaMag > 50 ? 'var(--red)' : vommaMag > 10 ? 'var(--orange)' : 'var(--green)';
    const vommaDesc = vommaMag > 50 ? 'Vol พุ่ง → Cascade รุนแรง (Dealers ยิ่ง short Vega)'
        : vommaMag > 10 ? 'Vol พุ่ง → อาจ Cascade ได้'
            : 'Vol พุ่ง → ไม่น่า Cascade';
    const vommaText = `<span style="color:${vommaLevelColor};font-weight:700">${vommaLevel}</span> — ${vommaDesc}`;

    // Dealer Flow Summary: resolves Vanna vs Charm conflicts
    const vannaDir = d.vannaExp > 0 ? 'sell' : d.vannaExp < 0 ? 'buy' : 'neutral';
    const charmDir = d.charmExp > 0 ? 'sell' : d.charmExp < 0 ? 'buy' : 'neutral';
    let flowSummaryHtml = '';

    // Expected Flow Matrix Table
    const flowMatrixHtml = `
    <div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.05);padding-top:10px;">
        <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:6px">🔮 24H FORWARD EXPECTED FLOW (Contracts)</div>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px;">
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.03)">
                <span style="color:var(--text-secondary)">1. ตลาดซึม (IV ตก, เวลาเดิน)</span>
                <span>${charmDir === 'buy' ? '<span style="color:var(--green)">Buy</span>' : charmDir === 'sell' ? '<span style="color:var(--red)">Sell</span>' : '-'} ~${Math.round(charmContracts).toLocaleString()}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.03)">
                <span style="color:var(--text-secondary)">2. ตลาดตกใจ (IV พุ่ง +10%)</span>
                <span>${vannaDir === 'buy' ? '<span style="color:var(--green)">Buy</span>' : vannaDir === 'sell' ? '<span style="color:var(--red)">Sell</span>' : '-'} ~${Math.round(vannaContracts * 10).toLocaleString()}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding:4px 0;">
                <span style="color:var(--text-secondary)">3. ราคาวิ่งแรง (+$20 USD)</span>
                <span>${d.isLongGamma ? '<span style="color:var(--red)">Sell (ต้าน)</span>' : '<span style="color:var(--green)">Buy (ตามน้ำ)</span>'} ~${Math.round(gexContracts * 20).toLocaleString()}</span>
            </div>
        </div>
    </div>`;

    if (vannaDir === charmDir && vannaDir !== 'neutral') {
        const isBull = vannaDir === 'buy';
        const clr = isBull ? 'var(--green)' : 'var(--red)';
        const arrow = isBull ? '↑' : '↓';
        flowSummaryHtml = `<span style="color:${clr};font-weight:700">✅ Vanna + Charm สอดคล้อง ${arrow}</span> ทุก Scenario → Dealers ${isBull ? 'BUY ดันขึ้น' : 'SELL กดลง'}`;
    } else if (vannaDir !== 'neutral' && charmDir !== 'neutral' && vannaDir !== charmDir) {
        const charmBull = charmDir === 'buy';
        const vannaBull = vannaDir === 'buy';
        const charmClr = charmBull ? 'var(--green)' : 'var(--red)';
        const vannaClr = vannaBull ? 'var(--green)' : 'var(--red)';
        // DTE-based dominance hint
        const dteTip = d.dte < 7
            ? `<span style="color:var(--orange);font-weight:700">DTE < 7 → Charm แรงกว่า</span> (Theta Decay เร่ง)`
            : d.dte > 30
                ? `<span style="color:var(--cyan);font-weight:700">DTE > 30 → Vanna แรงกว่า</span> (Vol Move สำคัญกว่า)`
                : `DTE ปานกลาง → ดูว่า IV จะขยับหรือไม่`;
        flowSummaryHtml = `⚔️ ขัดแย้ง: ตลาดเงียบ → <span style="color:${charmClr};font-weight:700">Charm ${charmBull ? 'ดันขึ้น' : 'กดลง'}</span> | IV พุ่ง → <span style="color:${vannaClr};font-weight:700">Vanna ${vannaBull ? 'ดันขึ้น' : 'กดลง'}</span><br><span style="font-size:12px">${dteTip}</span>`;
    } else {
        flowSummaryHtml = `<span style="color:var(--text-secondary)">🔹 แรงกดดันจาก Dealer Hedging ต่ำ</span>`;
    }

    flowSummaryHtml += flowMatrixHtml;

    const hedgeIcon = d.hedgeLabel === 'Heavy Hedge' ? '🛡️' : d.hedgeLabel === 'Moderate Hedge' ? '🛡️' : '🎰';
    const hedgeText = d.hedgeLabel === 'Heavy Hedge' ? `สถาบัน Hedge หนัก (ITM ${d.itmPct.toFixed(0)}%) — มั่นใจสูง ป้อง downside`
        : d.hedgeLabel === 'Moderate Hedge' ? `สถาบัน Hedge ปานกลาง (ITM ${d.itmPct.toFixed(0)}%)`
            : `Spec-Driven — ขาเก็งกำไรนำ (ITM ${d.itmPct.toFixed(0)}%)`;

    // ── MULTI-TIMEFRAME CONTEXT & VOLATILITY TERM STRUCTURE ──
    const tfHints = [];
    let termStructureHtml = '';

    // Volatility Term Structure Logic
    const dailyVol = tfData['current']?.er1Day > 0 ? (tfData['current'].er1Day / tfData['current'].uPrice) * Math.sqrt(365) * 100 : 0;
    const weeklyVol = tfData['friday']?.er1Day > 0 ? (tfData['friday'].er1Day / tfData['friday'].uPrice) * Math.sqrt(365) * 100 : 0;
    const monthlyVol = tfData['monthly']?.er1Day > 0 ? (tfData['monthly'].er1Day / tfData['monthly'].uPrice) * Math.sqrt(365) * 100 : 0;

    if (dailyVol > 0 && monthlyVol > 0) {
        const volRatio = dailyVol / monthlyVol;
        let tsState = '';
        let tsColor = '';
        let tsDesc = '';

        if (volRatio > 1.1) {
            tsState = 'BACKWARDATION (Panic)';
            tsColor = 'var(--red)';
            tsDesc = 'Short-term IV พุ่งสูงกว่า Long-term → ตลาดตกใจ/มีข่าวแรง (Setup ดัก Reversion)';
        } else if (volRatio < 0.9) {
            tsState = 'CONTANGO (Complacent)';
            tsColor = 'var(--cyan)';
            tsDesc = 'Short-term IV ต่ำกว่า Long-term → ตลาดชะล่าใจ (Setup ดัก Long Vol/Gamma)';
        } else {
            tsState = 'FLAT (Normal)';
            tsColor = 'var(--text-secondary)';
            tsDesc = 'โครงสร้าง Volatility ปกติ ไม่มี Edge พิเศษจาก Time Structure';
        }

        termStructureHtml = `<div style="font-size:14px;color:var(--text-secondary);padding:6px 0;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.03)">⏳ <b>Vol Term Structure:</b> <span style="color:${tsColor};font-weight:700">${tsState}</span><br><span style="font-size:12px;opacity:0.8">${tsDesc} (Daily: ${dailyVol.toFixed(1)}% vs Monthly: ${monthlyVol.toFixed(1)}%)</span></div>`;
    }

    for (const key of ['current', 'friday', 'monthly']) {
        const r = tfData[key];
        if (!r) continue;
        const lbl = key === 'current' ? 'Daily' : key === 'friday' ? 'Weekly' : 'Monthly';
        const bc = r.biasScore > 0 ? 'var(--green)' : r.biasScore < 0 ? 'var(--red)' : 'var(--text-secondary)';
        tfHints.push(`<span style="color:${bc};font-weight:700">${lbl}: ${r.biasLabel}</span>`);
    }

    // ── Regime label + Volume Confidence ──
    const volConf = d.volGEXResult || {};
    let volConfBadge = '';
    if (volConf.confidence === 'CONFIRMED') {
        volConfBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(38,166,154,.15);border:1px solid rgba(38,166,154,.4);color:var(--green);margin-left:8px">✅ Intraday Volume ยืนยัน</span>`;
    } else if (volConf.confidence === 'DIVERGING') {
        volConfBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,152,0,.15);border:1px solid rgba(255,152,0,.4);color:var(--orange);margin-left:8px">⚠️ Volume สวนทาง!</span>`;
    } else if (volConf.confidence === 'LOW_VOLUME') {
        volConfBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:var(--text-muted);margin-left:8px">📊 Volume เบา</span>`;
    } else if (volConf.confidence === 'EXPIRING') {
        volConfBadge = `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,82,82,.1);border:1px solid rgba(255,82,82,.3);color:var(--red);margin-left:8px">⏰ หมดอายุวันนี้</span>`;
    }

    const regimeLabel = d.isLongGamma
        ? `<span style="color:var(--green);font-weight:700">Long Gamma</span> <span style="color:var(--text-secondary);font-size:12px">· Mean Reversion · ราคา Stable</span>${volConfBadge}`
        : `<span style="color:var(--red);font-weight:700">Short Gamma</span> <span style="color:var(--text-secondary);font-size:12px">· Trend Following · ราคา Volatile</span>${volConfBadge}`;

    // Volume GEX detail line (shown below regime)
    const volConfDetail = volConf.detail ? `<div style="font-size:11px;color:${volConf.confidence === 'DIVERGING' ? 'var(--orange)' : 'var(--text-muted)'};margin-top:3px;line-height:1.4">${volConf.confidence === 'DIVERGING' ? '⚠️' : '📊'} ${volConf.detail}</div>` : '';

    // Hot strikes from volume (new wall formations)
    let hotStrikesHtml = '';
    if (volConf.hotStrikes && volConf.hotStrikes.length > 0) {
        const hotItems = volConf.hotStrikes.map(h => {
            const sideColor = h.side === 'call' ? 'var(--call-color)' : 'var(--put-color)';
            const sideLabel = h.side === 'call' ? 'Call' : 'Put';
            const newTag = h.isNewWall ? ' <span style="color:var(--orange);font-size:9px">🆕 NEW</span>' : '';
            return `<span style="color:${sideColor};font-weight:700">$${h.strike}</span> ${sideLabel} ${h.totalVol.toLocaleString()} vol${newTag}`;
        }).join(' · ');
        hotStrikesHtml = `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">🔥 Hot strikes: ${hotItems}</div>`;
    }

    // ── Fallback warning ──
    const fallbackHtml = isFallback ? `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:rgba(255,152,0,.1);border:1px solid rgba(255,152,0,.35);margin-bottom:14px">
            <span style="font-size:16px">⚠️</span>
            <span style="font-size:13px;color:var(--orange);font-weight:700">ราคา Futures ไม่พบในข้อมูล — ค่าทุกอย่างใช้ค่าประมาณ → รัน Scraper ใหม่</span>
        </div>` : '';

    // ── RENDER GRID LAYOUT ──
    header.innerHTML = '';
    // ── BIAS METER HTML ──
    const needlePct = Math.max(2, Math.min(98, (bias.score + 100) / 2));
    const biasGrad = bias.score >= 0
        ? `linear-gradient(135deg, rgba(38,166,154,.08), rgba(0,230,118,.04))`
        : `linear-gradient(135deg, rgba(239,83,80,.08), rgba(255,23,68,.04))`;
    const biasBorderColor = bias.color;

    // Sort signals by absolute score for display (most impactful first)
    const sortedSignals = [...bias.signals].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

    const signalBarsHtml = sortedSignals.map(s => {
        const pct = s.max > 0 ? Math.abs(s.score / s.max) * 100 : 0;
        const barColor = s.direction === 'bullish' ? 'var(--green)' : s.direction === 'bearish' ? 'var(--red)' : 'var(--text-muted)';
        const dirIcon = s.direction === 'bullish' ? '▲' : s.direction === 'bearish' ? '▼' : '—';
        const dirColor = s.direction === 'bullish' ? 'var(--green)' : s.direction === 'bearish' ? 'var(--red)' : 'var(--text-muted)';
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(0,0,0,.2);border-radius:8px;border:1px solid rgba(255,255,255,.04)">
            <span style="font-size:13px;width:18px;text-align:center">${s.icon}</span>
            <span style="font-size:11px;font-weight:700;color:var(--text-secondary);min-width:90px">${s.name}</span>
            <div style="flex:1;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden;position:relative">
                <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.15)"></div>
                ${s.score >= 0
                ? `<div style="position:absolute;left:50%;top:0;bottom:0;width:${pct / 2}%;background:${barColor};border-radius:0 3px 3px 0;transition:width .3s"></div>`
                : `<div style="position:absolute;right:50%;top:0;bottom:0;width:${pct / 2}%;background:${barColor};border-radius:3px 0 0 3px;transition:width .3s"></div>`
            }
            </div>
            <span style="font-size:11px;font-weight:800;color:${dirColor};min-width:16px;text-align:center">${dirIcon}</span>
            <span style="font-size:10px;color:var(--text-muted);flex:1.5;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${s.detail}">${s.detail}</span>
        </div>`;
    }).join('');

    // ── QUICK SETUP SUMMARY (compact action line for bias meter) ──
    const slMulQ = STYLE_CONFIG[state.tradingStyle].slMul;
    const slBufQ = Math.max(10, Math.round((d.er1Day || 50) * slMulQ));
    const bestBrokenCallQ = (d.brokenCallWalls || []).find(bw => bw.volumeConf === 'strong' || bw.volumeConf === 'moderate');
    const bestBrokenPutQ = (d.brokenPutWalls || []).find(bw => bw.volumeConf === 'strong' || bw.volumeConf === 'moderate');
    const nrStrikeQ = d.nearestCall ? d.nearestCall.strike : (d.callWalls.length > 0 ? d.callWalls[0].strike : null);
    const nsStrikeQ = d.nearestPut ? d.nearestPut.strike : (d.putWalls.length > 0 ? d.putWalls[0].strike : null);

    let quickSetupHtml = '';
    if (d.risk.noMansLand) {
        const isUp = d.risk.noMansLandSide === 'above';
        quickSetupHtml = `<div style="padding:10px 14px;background:rgba(255,23,68,.08);border-radius:10px;border:1px solid rgba(255,23,68,.25);margin-top:14px">
            <div style="font-size:13px;font-weight:800;color:#ff1744">⛔ NO MAN'S LAND — ${isUp ? 'Follow Long เท่านั้น ห้าม Short' : 'Follow Short เท่านั้น ห้าม Buy'}</div>
        </div>`;
    } else if (bestBrokenCallQ && bias.score >= -10) {
        const tp = nrStrikeQ || (d.callWalls.length > 0 ? d.callWalls[0].strike : '?');
        quickSetupHtml = `<div style="padding:10px 14px;background:rgba(255,152,0,.06);border-radius:10px;border:1px solid rgba(255,152,0,.2);margin-top:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:900;color:var(--orange)">🔥 BUY RETEST</span>
            <span style="font-size:12px;color:var(--text-primary)">Entry: <b style="color:var(--call-color)">$${bestBrokenCallQ.strike}</b></span>
            <span style="font-size:12px;color:var(--text-primary)">SL: <b style="color:var(--red)">$${(bestBrokenCallQ.strike - slBufQ).toFixed(0)}</b></span>
            <span style="font-size:12px;color:var(--text-primary)">TP: <b style="color:var(--call-color)">$${tp}</b></span>
            <span style="font-size:11px;color:var(--text-muted)">(Vol/OI: ${(bestBrokenCallQ.volRatio * 100).toFixed(0)}%)</span>
        </div>`;
    } else if (bestBrokenPutQ && bias.score <= 10) {
        const tp = nsStrikeQ || (d.putWalls.length > 0 ? d.putWalls[0].strike : '?');
        quickSetupHtml = `<div style="padding:10px 14px;background:rgba(255,152,0,.06);border-radius:10px;border:1px solid rgba(255,152,0,.2);margin-top:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:900;color:var(--orange)">🔥 SELL RETEST</span>
            <span style="font-size:12px;color:var(--text-primary)">Entry: <b style="color:var(--put-color)">$${bestBrokenPutQ.strike}</b></span>
            <span style="font-size:12px;color:var(--text-primary)">SL: <b style="color:var(--red)">$${(bestBrokenPutQ.strike + slBufQ).toFixed(0)}</b></span>
            <span style="font-size:12px;color:var(--text-primary)">TP: <b style="color:var(--put-color)">$${tp}</b></span>
            <span style="font-size:11px;color:var(--text-muted)">(Vol/OI: ${(bestBrokenPutQ.volRatio * 100).toFixed(0)}%)</span>
        </div>`;
    } else if (d.isLongGamma && !d.priceAboveCallWall && !d.priceBelowPutWall) {
        // Wall-to-Wall Fade summary
        const buyAt = nsStrikeQ ? `Buy <b style="color:var(--put-color)">$${nsStrikeQ}</b>` : '';
        const sellAt = nrStrikeQ ? `Sell <b style="color:var(--call-color)">$${nrStrikeQ}</b>` : '';
        const fadeActions = [buyAt, sellAt].filter(Boolean).join(' <span style="color:var(--text-muted)">·</span> ');
        if (fadeActions) {
            quickSetupHtml = `<div style="padding:10px 14px;background:rgba(0,188,212,.04);border-radius:10px;border:1px solid rgba(0,188,212,.15);margin-top:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
                <span style="font-size:13px;font-weight:900;color:var(--cyan)">🔄 FADE</span>
                <span style="font-size:12px;color:var(--text-primary)">${fadeActions}</span>
                <span style="font-size:11px;color:var(--text-muted)">Long γ = Fade ที่ Wall</span>
            </div>`;
        }
    } else if (!d.isLongGamma) {
        // Short gamma: breakout/breakdown trigger
        const bkoText = nrStrikeQ ? `ทะลุ <b style="color:var(--call-color)">$${nrStrikeQ}</b> = Buy` : '';
        const bkdText = nsStrikeQ ? `หลุด <b style="color:var(--put-color)">$${nsStrikeQ}</b> = Sell` : '';
        const triggers = [bkdText, bkoText].filter(Boolean).join(' <span style="color:var(--text-muted)">·</span> ');
        if (triggers) {
            quickSetupHtml = `<div style="padding:10px 14px;background:rgba(255,87,34,.04);border-radius:10px;border:1px solid rgba(255,87,34,.15);margin-top:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
                <span style="font-size:13px;font-weight:900;color:var(--orange)">🌊 TRIGGER</span>
                <span style="font-size:12px;color:var(--text-primary)">${triggers}</span>
                <span style="font-size:11px;color:var(--text-muted)">Short γ = รอทะลุ Wall</span>
            </div>`;
        }
    }

    // ── GAME THEORY PANEL HTML ──
    let gameTheoryHtml = '';
    if (d.gameTheory || d.multiAgent || d.nashEq) {
        const gt = d.gameTheory;
        const ma = d.multiAgent;
        const nash = d.nashEq;

        // Multi-Agent Pressure Gauge
        let agentGaugeHtml = '';
        if (ma) {
            const gaugePct = Math.round((ma.netPressure + 1) / 2 * 100); // -1..+1 → 0..100
            const agentRows = ['dealer', 'speculator', 'institutional'].map(key => {
                const a = ma.agents[key];
                const barPct = Math.round((a.pressure + 1) / 2 * 100);
                const barColor = a.pressure > 0 ? 'var(--green)' : a.pressure < 0 ? 'var(--red)' : 'var(--text-muted)';
                const icon = key === 'dealer' ? '🏦' : key === 'speculator' ? '📈' : '🏛️';
                const name = key === 'dealer' ? 'Dealer' : key === 'speculator' ? 'Speculator' : 'Institutional';
                return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <span style="font-size:12px;width:100px">${icon} ${name}</span>
                    <div style="flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden;position:relative">
                        <div style="position:absolute;left:50%;top:0;width:1px;height:100%;background:rgba(255,255,255,.15)"></div>
                        <div style="position:absolute;${a.pressure >= 0 ? 'left:50%' : `right:50%`};top:0;height:100%;width:${Math.abs(a.pressure) * 50}%;background:${barColor};border-radius:3px;transition:width .3s"></div>
                    </div>
                    <span style="font-size:11px;color:${barColor};width:50px;text-align:right;font-weight:700">${a.label}</span>
                    <span style="font-size:10px;color:var(--text-muted);width:30px;text-align:right">${(a.weight * 100).toFixed(0)}%</span>
                </div>`;
            }).join('');

            agentGaugeHtml = `
            <div style="margin-bottom:14px">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <span style="font-size:13px;font-weight:800">🎮 Multi-Agent Pressure</span>
                    <span style="padding:2px 8px;border-radius:8px;font-size:11px;font-weight:700;background:${ma.consensusColor}20;color:${ma.consensusColor};border:1px solid ${ma.consensusColor}40">${ma.consensus}</span>
                </div>
                ${agentRows}
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06)">
                    <span style="font-size:12px;font-weight:700">Net:</span>
                    <div style="flex:1;height:8px;background:rgba(255,255,255,.08);border-radius:4px;overflow:hidden;position:relative">
                        <div style="position:absolute;left:50%;top:0;width:1px;height:100%;background:rgba(255,255,255,.2)"></div>
                        <div style="position:absolute;${ma.netPressure >= 0 ? 'left:50%' : 'right:50%'};top:0;height:100%;width:${Math.abs(ma.netPressure) * 50}%;background:${ma.netColor};border-radius:4px"></div>
                    </div>
                    <span style="font-size:13px;font-weight:900;color:${ma.netColor}">${ma.netDirection} (${ma.netPressure > 0 ? '+' : ''}${ma.netPressure.toFixed(2)})</span>
                </div>
            </div>`;
        }

        // Nash Equilibrium
        let nashHtml = '';
        if (nash && nash.eqPrice) {
            const nashDist = (nash.eqPrice - d.uPrice).toFixed(1);
            const nashDir = nash.eqPrice > d.uPrice ? '↑' : nash.eqPrice < d.uPrice ? '↓' : '→';
            const nashColor = nash.stability === 'STABLE' ? 'var(--green)' : nash.stability === 'UNSTABLE' ? 'var(--orange)' : 'var(--red)';
            nashHtml = `
            <div style="margin-bottom:14px">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
                    <span style="font-size:13px;font-weight:800">🎯 Nash Equilibrium</span>
                    <span style="padding:2px 8px;border-radius:8px;font-size:11px;font-weight:700;background:${nashColor}20;color:${nashColor};border:1px solid ${nashColor}40">${nash.stability}</span>
                </div>
                <div style="display:flex;gap:16px;flex-wrap:wrap">
                    <div style="padding:8px 14px;background:rgba(224,64,251,.06);border-radius:10px;border:1px solid rgba(224,64,251,.2)">
                        <div style="font-size:10px;color:var(--text-muted)">Equilibrium Price</div>
                        <div style="font-size:16px;font-weight:900;color:#e040fb">$${nash.eqPrice} ${nashDir}</div>
                        <div style="font-size:11px;color:var(--text-secondary)">${nashDist > 0 ? '+' : ''}${nashDist} pts from spot</div>
                    </div>
                    <div style="padding:8px 14px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.08)">
                        <div style="font-size:10px;color:var(--text-muted)">Attraction</div>
                        <div style="font-size:14px;font-weight:800;color:var(--text-primary)">${nash.attractionDir || '—'}</div>
                        <div style="font-size:11px;color:var(--text-secondary)">ทิศทางดึงดูด</div>
                    </div>
                </div>
            </div>`;
        }

        // Wall Credibility + Payoff Matrix
        let wallCredHtml = '';
        if (gt && gt.wallCredibilities && gt.wallCredibilities.length > 0) {
            const topWalls = gt.wallCredibilities
                .sort((a, b) => Math.abs(a.wall.strike - d.uPrice) - Math.abs(b.wall.strike - d.uPrice))
                .slice(0, 6);
            const wallRows = topWalls.map(wc => {
                const w = wc.wall;
                const c = wc.credibility;
                const side = w.strike > d.uPrice ? 'CALL' : 'PUT';
                const sideColor = side === 'CALL' ? 'var(--call-color)' : 'var(--put-color)';
                const credColor = c.score >= 70 ? 'var(--green)' : c.score >= 40 ? 'var(--orange)' : 'var(--red)';
                const dist = Math.abs(w.strike - d.uPrice).toFixed(0);
                return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">
                    <span style="font-size:11px;color:${sideColor};width:35px;font-weight:700">${side}</span>
                    <span style="font-size:12px;font-weight:800;width:55px">$${w.strike}</span>
                    <span style="font-size:10px;color:var(--text-muted);width:45px">${dist}pts</span>
                    <div style="flex:1;height:5px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden">
                        <div style="width:${c.score}%;height:100%;background:${credColor};border-radius:3px"></div>
                    </div>
                    <span style="font-size:11px;font-weight:700;color:${credColor};width:65px;text-align:right">${c.label} ${c.score}</span>
                </div>`;
            }).join('');

            wallCredHtml = `
            <div style="margin-bottom:14px">
                <div style="font-size:13px;font-weight:800;margin-bottom:6px">🏰 Wall Credibility</div>
                ${wallRows}
            </div>`;
        }

        // Payoff Matrix (nearest call & put walls)
        let payoffHtml = '';
        if (gt && (gt.callPayoff || gt.putPayoff)) {
            const renderPayoff = (label, pf, sideColor) => {
                if (!pf) return '';
                const stratColor = pf.bestStrategy === 'FADE' ? 'var(--cyan)' : 'var(--orange)';
                return `<div style="padding:8px 12px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.08);flex:1;min-width:200px">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                        <span style="font-size:11px;color:${sideColor};font-weight:700">${label}</span>
                        <span style="margin-left:auto;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:700;background:${stratColor}20;color:${stratColor}">${pf.bestStrategy}</span>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
                        <div style="padding:4px;background:rgba(0,0,0,.15);border-radius:4px;text-align:center">
                            <div style="color:var(--text-muted);font-size:9px">Hold Prob</div>
                            <div style="font-weight:700;color:var(--green)">${(pf.wallHoldProb * 100).toFixed(0)}%</div>
                        </div>
                        <div style="padding:4px;background:rgba(0,0,0,.15);border-radius:4px;text-align:center">
                            <div style="color:var(--text-muted);font-size:9px">Break Prob</div>
                            <div style="font-weight:700;color:var(--red)">${(pf.wallBreakProb * 100).toFixed(0)}%</div>
                        </div>
                        <div style="padding:4px;background:rgba(0,0,0,.15);border-radius:4px;text-align:center">
                            <div style="color:var(--text-muted);font-size:9px">Fade EV</div>
                            <div style="font-weight:700;color:var(--cyan)">${pf.fadeEV.toFixed(1)}</div>
                        </div>
                        <div style="padding:4px;background:rgba(0,0,0,.15);border-radius:4px;text-align:center">
                            <div style="color:var(--text-muted);font-size:9px">Follow EV</div>
                            <div style="font-weight:700;color:var(--orange)">${pf.followEV.toFixed(1)}</div>
                        </div>
                    </div>
                </div>`;
            };
            payoffHtml = `
            <div style="margin-bottom:14px">
                <div style="font-size:13px;font-weight:800;margin-bottom:6px">📊 Dealer Payoff Matrix</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    ${renderPayoff('Nearest Resistance', gt.callPayoff, 'var(--call-color)')}
                    ${renderPayoff('Nearest Support', gt.putPayoff, 'var(--put-color)')}
                </div>
            </div>`;
        }

        // Monte Carlo Results
        let mcHtml = '';
        if (gt && (gt.callMC || gt.putMC)) {
            const renderMC = (label, mc, sideColor) => {
                if (!mc) return '';
                return `<div style="padding:8px 12px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.08);flex:1;min-width:200px">
                    <div style="font-size:11px;color:${sideColor};font-weight:700;margin-bottom:6px">${label}</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:11px">
                        <div style="text-align:center;padding:4px;background:rgba(0,0,0,.12);border-radius:4px">
                            <div style="color:var(--text-muted);font-size:9px">Hit Wall</div>
                            <div style="font-weight:700">${(mc.wallHitPct * 100).toFixed(0)}%</div>
                        </div>
                        <div style="text-align:center;padding:4px;background:rgba(0,0,0,.12);border-radius:4px">
                            <div style="color:var(--text-muted);font-size:9px">Break</div>
                            <div style="font-weight:700;color:var(--red)">${(mc.wallBreakPct * 100).toFixed(0)}%</div>
                        </div>
                        <div style="text-align:center;padding:4px;background:rgba(0,0,0,.12);border-radius:4px">
                            <div style="color:var(--text-muted);font-size:9px">Bounce</div>
                            <div style="font-weight:700;color:var(--green)">${(mc.bouncePct * 100).toFixed(0)}%</div>
                        </div>
                        <div style="text-align:center;padding:4px;background:rgba(0,0,0,.12);border-radius:4px">
                            <div style="color:var(--text-muted);font-size:9px">Cascade</div>
                            <div style="font-weight:700;color:var(--orange)">${(mc.cascadePct * 100).toFixed(0)}%</div>
                        </div>
                    </div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:4px">Median: $${mc.medianPrice.toFixed(1)} | Range: $${mc.range10.toFixed(1)}–$${mc.range90.toFixed(1)}</div>
                </div>`;
            };
            mcHtml = `
            <div style="margin-bottom:14px">
                <div style="font-size:13px;font-weight:800;margin-bottom:6px">🎲 Monte Carlo (500 sims)</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                    ${renderMC('Call Wall', gt.callMC, 'var(--call-color)')}
                    ${renderMC('Put Wall', gt.putMC, 'var(--put-color)')}
                </div>
            </div>`;
        }

        gameTheoryHtml = `
        <div style="padding:18px 24px;background:var(--bg-panel);border:1px solid rgba(224,64,251,.2);border-radius:14px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
                <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">🎮 Game Theory Analysis</div>
                <div style="font-size:10px;color:var(--text-muted);opacity:0.6">Nash · Monte Carlo · Multi-Agent</div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                <div>${agentGaugeHtml}${nashHtml}</div>
                <div>${wallCredHtml}${payoffHtml}</div>
            </div>
            ${mcHtml}
        </div>`;
    }

    const biasMeterHtml = `
    <div style="padding:20px 24px;background:${biasGrad};border:1px solid ${biasBorderColor}40;border-left:5px solid ${biasBorderColor};border-radius:14px">
        <!-- Header Row -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
            <div style="display:flex;align-items:center;gap:12px">
                <div style="font-size:28px">${bias.icon}</div>
                <div>
                    <div style="font-size:22px;font-weight:900;color:${bias.color};letter-spacing:1px;line-height:1.1">${bias.label}</div>
                    <div style="font-size:12px;color:var(--text-muted);font-weight:600;margin-top:2px">DIRECTIONAL BIAS</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
                <div style="text-align:center">
                    <div style="font-size:36px;font-weight:900;color:${bias.color};line-height:1">${bias.score > 0 ? '+' : ''}${bias.score}</div>
                    <div style="font-size:10px;color:var(--text-muted);font-weight:700;margin-top:2px">SCORE</div>
                </div>
                <div style="display:inline-flex;flex-direction:column;align-items:center;padding:6px 14px;border-radius:12px;background:${bias.confColor}15;border:1px solid ${bias.confColor}40">
                    <span style="font-size:13px">${bias.confIcon}</span>
                    <span style="font-size:10px;font-weight:800;color:${bias.confColor}">${bias.confidence}</span>
                </div>
            </div>
        </div>

        <!-- Gauge Bar -->
        <div style="position:relative;height:10px;background:linear-gradient(90deg, #ff1744 0%, #ef5350 20%, #ef9a9a 35%, rgba(255,255,255,.1) 50%, #a5d6a7 65%, #66bb6a 80%, #00e676 100%);border-radius:5px;margin-bottom:6px">
            <div style="position:absolute;left:50%;top:-2px;bottom:-2px;width:2px;background:rgba(255,255,255,.3);transform:translateX(-50%)"></div>
            <div style="position:absolute;left:${needlePct}%;top:-5px;bottom:-5px;width:4px;background:white;transform:translateX(-50%);border-radius:2px;box-shadow:0 0 8px rgba(255,255,255,.7),0 0 16px ${bias.color}"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-muted);font-weight:700;margin-bottom:14px">
            <span>STRONG SELL -100</span>
            <span>NEUTRAL 0</span>
            <span>STRONG BUY +100</span>
        </div>

        <!-- Signal Agreement -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:8px 12px;background:rgba(0,0,0,.2);border-radius:8px">
            <span style="font-size:11px;color:var(--text-muted);font-weight:700">สัญญาณ:</span>
            <span style="font-size:12px;font-weight:800;color:var(--green)">▲ ${bias.bullishCount} Bullish</span>
            <span style="font-size:12px;font-weight:800;color:var(--red)">▼ ${bias.bearishCount} Bearish</span>
            ${bias.neutralCount > 0 ? `<span style="font-size:12px;font-weight:800;color:var(--text-muted)">— ${bias.neutralCount} Neutral</span>` : ''}
        </div>

        <!-- Signal Breakdown Grid -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
            ${signalBarsHtml}
        </div>
        ${quickSetupHtml}
    </div>`;

    container.innerHTML = `
        ${fallbackHtml}

        <!-- BIAS METER — full width, top position -->
        ${biasMeterHtml}

        <!-- HERO — full width -->
        <div style="padding:20px 24px;background:linear-gradient(135deg,rgba(255,255,255,.04),transparent);border:1px solid ${bColor}40;border-radius:14px">
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:8px">
                <div style="display:inline-flex;padding:6px 16px;border-radius:20px;font-size:15px;font-weight:900;letter-spacing:.5px;background:${bColor}1a;border:1px solid ${bColor}55;color:${bColor}">${bText}</div>
                <div style="font-size:26px;font-weight:900;color:#ffffff">$${d.uPrice.toFixed(1)}</div>
                <div style="font-size:13px;color:var(--text-secondary);font-weight:700">${d.dte.toFixed(1)} DTE</div>
                <div style="display:inline-flex;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:var(--text-muted)">${styleCfg.icon} ${styleCfg.label}${styleFallback ? ' <span style="color:var(--orange)">⚠ Fallback</span>' : ''}</div>
                <div style="margin-left:auto;font-size:14px;font-weight:800;color:${d.risk.riskColor}">${d.risk.riskIcon} Risk ${d.risk.totalScore}/100</div>
            </div>
            <div style="font-size:14px;color:var(--text-secondary);margin-bottom:4px;line-height:1.6">${bDesc}</div>
            <div style="font-size:13px">${regimeLabel}</div>
            ${volConfDetail}
            ${hotStrikesHtml}
            ${d.longDteWarning ? '<div style="font-size:11px;color:var(--orange);margin-top:6px;opacity:0.8">⚠️ DTE > 60 — Greeks ใช้ r=0 (ไม่คิด carry/lease rate) ค่าประมาณอาจคลาดเคลื่อน ~1-2%</div>' : ''}
        </div>

        <!-- PRE-TRADE CHECKLIST — full width, prominent -->
        ${checklistHtml}

        <!-- BATTLE MAP — full width -->
        <div style="padding:16px 24px 12px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0">
                <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">🗺️ Battle Map</div>
                <div style="font-size:11px;color:var(--text-muted)">${displayedPutWalls.length} Put · ${displayedCallWalls.length} Call</div>
            </div>
            ${rangeBarHtml}
        </div>

        <!-- GAME THEORY ANALYSIS — full width -->
        ${gameTheoryHtml}

        <!-- 2-COLUMN ROW: Key Levels + Institutional Intel -->
        <div class="setup-grid-row">

            <!-- KEY LEVELS -->
            <div style="padding:18px 22px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;display:flex;flex-direction:column">
                <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">📍 Key Levels <span style="font-weight:400;text-transform:none;letter-spacing:0">(เรียงจากใกล้ราคา)</span></div>
                ${levelsHtml}
                ${breakoutHtml}
            </div>

            <!-- INSTITUTIONAL INTEL -->
            <div style="padding:16px 22px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;display:flex;flex-direction:column">
                <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">🏦 Institutional Intel</div>
                <div style="padding:10px 14px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid rgba(255,255,255,.06);margin-bottom:12px">
                    <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:6px">📊 DEALER FLOW SUMMARY</div>
                    <div style="font-size:14px;color:var(--text-primary);line-height:1.7">${flowSummaryHtml}</div>
                </div>
                <div style="font-size:14px;color:var(--text-secondary);padding:6px 0;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.03)">${hedgeIcon} ${hedgeText}</div>
                ${termStructureHtml}
                <div style="font-size:14px;color:var(--text-secondary);padding:6px 0;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.03)">🌊 <b>GEX (Gamma):</b> ${gexText}</div>
                <div style="font-size:14px;color:var(--text-secondary);padding:6px 0;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.03)">⚡ <b>Vanna:</b> ${vannaText}</div>
                <div style="font-size:14px;color:var(--text-secondary);padding:6px 0;line-height:1.6;border-bottom:1px solid rgba(255,255,255,.03)">⏱️ <b>Charm:</b> ${charmText}</div>
                <div style="font-size:14px;color:var(--text-secondary);padding:6px 0;line-height:1.6">🌪️ <b>Vomma:</b> ${vommaText}</div>
            </div>

        </div>

        ${patienceHtml}

        <!-- MULTI-TIMEFRAME — full width -->
        <div style="padding:10px 22px;font-size:13px;color:var(--text-secondary);display:flex;gap:16px;flex-wrap:wrap;justify-content:center">
            ${tfHints.join(' <span style="opacity:.3">|</span> ')}
        </div>
    `;
}

function renderActiveTab() {
    if (state.activeTab === 'chart') return;
    if (state.activeTab === 'analysis') {
        renderAnalysisTab();
        // Fallback to update header cleanly on load using Current data (since it's representative)
        if (state.data.current) {
            updateSummary(state.data.current.intraday, state.data.current.oi);
        }
        return;
    }

    const tabData = state.data[state.activeTab];
    if (!tabData || (!tabData.intraday && !tabData.oi)) {
        // Show placeholder
        const oiC = document.getElementById('oiContainer');
        const volC = document.getElementById('volContainer');
        oiC.innerHTML = `<div class="placeholder-msg"><div class="icon">🔒</div><div class="title">No Data Yet</div><div class="desc">This contract requires a QuikStrike scraper. Set up the Python scraper to fetch ${getProfile().contracts[state.activeTab].label} contract data.</div></div>`;
        volC.innerHTML = `<div class="placeholder-msg"><div class="icon">🔒</div><div class="title">No Data Yet</div><div class="desc">Configure the scraper to populate ${getProfile().contracts[state.activeTab].label} contract Intraday Volume.</div></div>`;

        // Clear summary
        ['sumVolSettle', 'sumExpRange', 'sumMaxOI', 'sumTotalCall', 'sumTotalPut', 'sumPCRatio', 'sumMaxPain', 'sumNetGEX', 'sumHedgePct'].forEach(id => {
            document.getElementById(id).textContent = '—';
        });
        document.getElementById('sumExpRangePrices').textContent = '';
        document.getElementById('sumMaxOIDetail').textContent = '';
        document.getElementById('sumMaxPainDetail').textContent = '';
        document.getElementById('sumNetGEXDetail').textContent = '';
        document.getElementById('sumHedgeDetail').textContent = '';
        const pe = document.getElementById('marketPulse'); if (pe) pe.innerHTML = '';
        document.getElementById('hedgeBarITM').style.flex = '0';
        document.getElementById('hedgeBarATM').style.flex = '1';
        document.getElementById('hedgeBarOTM').style.flex = '0';
        return;
    }
    renderPanel('oiContainer', tabData.oi, getProfile().oiHotThreshold);
    renderPanel('volContainer', tabData.intraday, getProfile().volHotThreshold);
    updateSummary(tabData.intraday, tabData.oi);
}

// ========== ASSET SWITCH ==========
async function switchAsset(assetId) {
    if (!ASSET_PROFILES[assetId] || assetId === state.activeAsset) return;
    state.activeAsset = assetId;

    // Reset data & chart
    state.data = { current: {}, friday: {}, monthly: {}, analysis: {}, chart: {} };
    state.chartInitialized = false;
    if (chartInstance) {
        try { chartInstance.remove(); } catch (e) { }
        chartInstance = null;
        candleSeries = null;
        wallLines = [];
    }

    // Update dropdown (in case called programmatically)
    const dd = document.getElementById('assetDropdown');
    if (dd) dd.value = assetId;

    // Update loading text
    const loadingText = document.querySelector('.loading-text');
    if (loadingText) loadingText.textContent = `Fetching ${getProfile().label} Data...`;

    // Show loading
    document.getElementById('loading').classList.remove('hidden');

    // Fetch all tabs for the new asset
    await Promise.all([
        fetchTabData('current'),
        fetchTabData('friday'),
        fetchTabData('monthly'),
    ]);

    // Update tab DTE labels
    for (const key of ['current', 'friday', 'monthly']) {
        const d = state.data[key]?.oi || state.data[key]?.intraday;
        if (d) {
            const el = document.getElementById('tabDte' + key.charAt(0).toUpperCase() + key.slice(1));
            if (el) el.textContent = `(${d.dte.toFixed(1)}d)`;
            const contractEl = document.getElementById('tabContract' + key.charAt(0).toUpperCase() + key.slice(1));
            if (contractEl && d.contract) contractEl.textContent = `[${d.contract}]`;
        } else {
            const el = document.getElementById('tabDte' + key.charAt(0).toUpperCase() + key.slice(1));
            if (el) el.textContent = '';
            const contractEl = document.getElementById('tabContract' + key.charAt(0).toUpperCase() + key.slice(1));
            if (contractEl) contractEl.textContent = '';
        }
    }

    renderActiveTab();
    document.getElementById('loading').classList.add('hidden');
    scheduleRefresh();
}

// ========== REFRESH ==========
async function refreshData() {
    const btn = document.querySelector('.refresh-btn');
    btn.textContent = '⟳ Loading...';
    btn.disa = await fetchTabData(state.activeTab);
    renderActiveTab();
    btn.textContent = '⟳ Refresh';
    btn.disabled = false;
}

// ========== WEEKEND SCHEDULE ==========
// On Sat/Sun (Thai time, UTC+7): fetch once at 13:00, then stop until next day.
// On weekdays: refresh every CONFIG.refreshIntervalMs.

function getThaiTime() {
    // Thai Standard Time = UTC+7
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcMs + 7 * 3600000);
}

function isWeekend() {
    const d = getThaiTime().getDay(); // 0=Sun, 6=Sat
    return d === 0 || d === 6;
}

function scheduleRefresh() {
    if (state.refreshTimer) {
        clearTimeout(state.refreshTimer);
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
    }

    if (!isWeekend()) {
        // Weekday: normal periodic refresh
        state.refreshTimer = setInterval(refreshData, CONFIG.refreshIntervalMs);
        return;
    }

    // Weekend: schedule a single fetch at 13:00 Thai if not yet done today
    const thai = getThaiTime();
    const thaiHour = thai.getHours();
    const thaiMin = thai.getMinutes();
    const thaiSec = thai.getSeconds();

    const todayKey = `${thai.getFullYear()}-${thai.getMonth()}-${thai.getDate()}`;

    if (state.weekendFetchedDate === todayKey) {
        // Already fetched today; check again at start of next day (midnight Thai)
        const msUntilMidnight = ((23 - thaiHour) * 3600 + (59 - thaiMin) * 60 + (60 - thaiSec)) * 1000;
        state.refreshTimer = setTimeout(() => {
            state.weekendFetchedDate = null;
            scheduleRefresh();
        }, msUntilMidnight);
        return;
    }

    const targetHour = 13;
    let msUntilTarget;
    if (thaiHour < targetHour || (thaiHour === targetHour && thaiMin === 0 && thaiSec === 0)) {
        // Before or exactly at 13:00 – wait
        msUntilTarget = ((targetHour - thaiHour) * 3600 - thaiMin * 60 - thaiSec) * 1000;
    } else {
        // After 13:00 on weekend: fetch immediately (missed window)
        msUntilTarget = 0;
    }

    state.refreshTimer = setTimeout(async () => {
        state.weekendFetchedDate = todayKey;
        await refreshData();
        scheduleRefresh(); // re-schedule (will wait until next day)
    }, msUntilTarget);
}

// ========== INIT ==========
async function init() {
    state.weekendFetchedDate = null;

    // Fetch ALL tabs in parallel
    await Promise.all([
        fetchTabData('current'),
        fetchTabData('friday'),
        fetchTabData('monthly'),
    ]);

    // Update tab DTE labels
    for (const key of ['current', 'friday', 'monthly']) {
        const d = state.data[key]?.oi || state.data[key]?.intraday;
        if (d) {
            const el = document.getElementById('tabDte' + key.charAt(0).toUpperCase() + key.slice(1));
            if (el) el.textContent = `(${d.dte.toFixed(1)}d)`;

            const contractEl = document.getElementById('tabContract' + key.charAt(0).toUpperCase() + key.slice(1));
            if (contractEl && d.contract) contractEl.textContent = `[${d.contract}]`;
        }
    }

    renderActiveTab();
    document.getElementById('loading').classList.add('hidden');

    // Mark weekend initial load as done (we just fetched on init)
    if (isWeekend()) {
        const thai = getThaiTime();
        state.weekendFetchedDate = `${thai.getFullYear()}-${thai.getMonth()}-${thai.getDate()}`;
    }
    scheduleRefresh();
}
init();
