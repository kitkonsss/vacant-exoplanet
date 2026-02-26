// ========== CONFIG ==========
const PAGETH_BASE = 'https://raw.githubusercontent.com/pageth/Vol2VolData/main';
const MY_BASE = 'https://raw.githubusercontent.com/kitkonsss/vacant-exoplanet/main';

const CONFIG = {
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
        chart: { label: 'Live Chart' } // Dummy for the chart tab
    },
    refreshIntervalMs: 1800000, // 30 minutes
    visibleStrikeRange: 350,
    barMaxWidth: 180,
    oiHotThreshold: 100,
    volHotThreshold: 80,
};

let state = {
    activeTab: 'analysis',
    data: { current: {}, friday: {}, monthly: {}, analysis: {}, chart: {} },
    refreshTimer: null,
    chartInitialized: false
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
    const contractMultiplier = 100; // Gold options = 100 oz

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
    const step = 5; // $5 grid — fine enough for gold, with interpolation for sub-dollar precision
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
    const contractMultiplier = 100;
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
    const contractMultiplier = 100;
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
    const contractMultiplier = 100;
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

// ========== MULTI-WALL DETECTION (Quant-Grade) ==========
// Finds ALL significant OI walls, clusters nearby strikes, and classifies by tier
// Returns array sorted by distance from price (nearest first)
function findSignificantWalls(strikes, uPrice, side, proximityRange = 100) {
    const oiKey = side === 'call' ? 'call' : 'put';
    // Filter to correct side of price
    const filtered = side === 'call'
        ? strikes.filter(s => s.strike > uPrice && s[oiKey] > 0)
        : strikes.filter(s => s.strike < uPrice && s[oiKey] > 0);

    if (filtered.length === 0) return [];

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
    const cMatch1 = header.match(/Contract:\s+(\S+)/);
    const cMatch2 = header.match(/\)\s+(\S+)\s+\(/);
    if (cMatch1) contract = cMatch1[1];
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
    const cfg = CONFIG.contracts[tabKey];
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
        s.strike >= underlying - CONFIG.visibleStrikeRange &&
        s.strike <= underlying + CONFIG.visibleStrikeRange &&
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
    document.getElementById('contractName').textContent = 'Gold (GC)';
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
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:14px;">⏳ Loading Gold chart data...</div>';

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

    // Fetch GC=F Data via CORS proxies (Yahoo Finance blocks direct browser calls)
    const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=15m&range=5d';
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

        const uPrice = globalUnderlying > 0 ? globalUnderlying : data.underlying;
        let tc = data.totalCall !== undefined ? data.totalCall : data.strikes.reduce((sum, s) => sum + s.call, 0);
        let tp = data.totalPut !== undefined ? data.totalPut : data.strikes.reduce((sum, s) => sum + s.put, 0);
        const pcr = tc > 0 ? (tp / tc) : 1;
        let biasScore = 0;
        if (pcr > 1.2) biasScore = -1;
        else if (pcr < 0.8) biasScore = 1;

        // ── Multi-Wall Detection ──
        const sourceStrikes2 = intraday?.strikes?.length > 0 ? intraday.strikes : null;
        const atm2 = data.strikes.reduce((p, c) => Math.abs(c.strike - uPrice) < Math.abs(p.strike - uPrice) ? c : p);
        const er1Day = atm2.volSettle > 0 ? uPrice * atm2.volSettle * Math.sqrt(1 / 365) : 50;

        const callWalls = findSignificantWalls(data.strikes, uPrice, 'call', er1Day * 2);
        const putWalls = findSignificantWalls(data.strikes, uPrice, 'put', er1Day * 2);
        const callSummary = getWallSummary(callWalls);
        const putSummary = getWallSummary(putWalls);

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

        // Structural walls: highest OI across ALL strikes (for breakout detection)
        const structCallWall = data.strikes.reduce((p, c) => c.call > p.call ? c : p);
        const structPutWall = data.strikes.reduce((p, c) => c.put > p.put ? c : p);
        const priceAboveCallWall = uPrice > structCallWall.strike;
        const priceBelowPutWall = uPrice < structPutWall.strike;
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

        // Use NEAREST wall for proximity detection (dynamic threshold = 1-day ER)
        const distToNearestCall = nearestCall ? nearestCall.dist : (maxCall.strike - uPrice);
        const distToNearestPut = nearestPut ? nearestPut.dist : (uPrice - maxPut.strike);
        const proximityThreshold = Math.max(er1Day * 0.8, 20); // dynamic, min 20
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
            gexResult, gexVal, isLongGamma,
            distToCallWall: maxCall.strike - uPrice, distToPutWall: uPrice - maxPut.strike,
            nearCallWall, nearPutWall,
            nearestCall, nearestPut, callWalls, putWalls, callSummary, putSummary,
            tradeableRange, er1Day, sourceStrikes2,
            risk, vannaExp, charmExp, vommaExp, hedgeLabel, itmPct, dte: data.dte
        };
    }

    // ── Primary = Daily ──
    const d = tfData.current;
    if (!d) {
        header.innerHTML = `<div class="placeholder-msg" style="padding:40px"><div class="icon">📊</div><div class="title">No Data</div><div class="desc">Loading or no daily data available.</div></div>`;
        container.innerHTML = '';
        return;
    }

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
        const vannaConfirm = d.vannaExp < 0; // negative = dealers BUY = confirms upside
        bText = vannaConfirm ? '🚀 BREAKOUT + Vanna' : '🚀 BREAKOUT';
        bColor = 'var(--green)';
        bDesc = `ราคาทะลุ Call Wall $${d.structCallWall.strike} ไปแล้ว +${d.callWallBreakoutDist.toFixed(0)} pts`;
        if (vannaConfirm) bDesc += ` — Vanna ยืนยัน: Dealers ต้อง Buy ดันราคาต่อ`;
        else bDesc += ` — Vanna ยังไม่ confirm ระวัง pullback`;
    } else if (d.priceBelowPutWall) {
        const vannaConfirm = d.vannaExp > 0; // positive = dealers SELL = confirms downside
        bText = vannaConfirm ? '💧 CASCADE + Vanna' : '💧 CASCADE';
        bColor = 'var(--red)';
        bDesc = `ราคาหลุด Put Wall $${d.structPutWall.strike} ไปแล้ว -${d.putWallBreakdownDist.toFixed(0)} pts`;
        if (vannaConfirm) bDesc += ` — Vanna ยืนยัน: Dealers ต้อง Sell กดราคาต่อ`;
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
    for (const w of d.putWalls) {
        const tierBadge = tierLabel(w.tier);
        const clusterInfo = w.clusterCount > 1 ? ` [${w.clusterCount} strikes, ${w.clusterOI.toLocaleString()} total]` : '';
        const migrationTag = checkWallMigration(w.strike, 'put', w.oi, d.sourceStrikes2);
        levels.push({
            price: w.strike, label: `Put Wall ${migrationTag}`, color: 'var(--put-color)',
            icon: tierIcon(w.tier), dist: -(w.dist), oi: w.oi, tier: w.tier,
            action: `Support ${w.isNearby ? '📍 ใกล้!' : ''} OI: ${w.oi.toLocaleString()}${clusterInfo}`
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
    for (const w of d.callWalls) {
        const tierBadge = tierLabel(w.tier);
        const clusterInfo = w.clusterCount > 1 ? ` [${w.clusterCount} strikes, ${w.clusterOI.toLocaleString()} total]` : '';
        const migrationTag = checkWallMigration(w.strike, 'call', w.oi, d.sourceStrikes2);
        levels.push({
            price: w.strike, label: `Call Wall ${migrationTag}`, color: 'var(--call-color)',
            icon: tierIcon(w.tier), dist: w.dist, oi: w.oi, tier: w.tier,
            action: `Resistance ${w.isNearby ? '📍 ใกล้!' : ''} OI: ${w.oi.toLocaleString()}${clusterInfo}`
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

    // ── VISUAL RANGE BAR (Multi-Wall) ──
    const barLow = d.putSummary.primary ? d.putSummary.primary.strike : d.maxPut.strike;
    const barHigh = d.callSummary.primary ? d.callSummary.primary.strike : d.maxCall.strike;
    const barRange = barHigh - barLow || 1;
    const pricePct = Math.max(2, Math.min(98, ((d.uPrice - barLow) / barRange) * 100));
    const markers = [];

    // Wall markers (multi-wall)
    for (const w of d.putWalls) {
        const pct = Math.max(0, Math.min(100, ((w.strike - barLow) / barRange) * 100));
        const h = w.tier === 'primary' ? 18 : w.tier === 'secondary' ? 13 : 8;
        markers.push({ pct, color: 'var(--put-color)', label: '', height: h, opacity: w.tier === 'tertiary' ? 0.5 : 1 });
    }
    for (const w of d.callWalls) {
        const pct = Math.max(0, Math.min(100, ((w.strike - barLow) / barRange) * 100));
        const h = w.tier === 'primary' ? 18 : w.tier === 'secondary' ? 13 : 8;
        markers.push({ pct, color: 'var(--call-color)', label: '', height: h, opacity: w.tier === 'tertiary' ? 0.5 : 1 });
    }

    // Structural markers
    if (d.risk.gammaMean) markers.push({ pct: Math.max(0, Math.min(100, ((d.risk.gammaMean - barLow) / barRange) * 100)), color: 'var(--cyan)', label: 'GM', height: 16, opacity: 1 });
    if (d.mpStrike) markers.push({ pct: Math.max(0, Math.min(100, ((d.mpStrike - barLow) / barRange) * 100)), color: 'var(--pink)', label: 'MP', height: 16, opacity: 1 });
    if (d.gexResult.flipStrike) markers.push({ pct: Math.max(0, Math.min(100, ((d.gexResult.flipStrike - barLow) / barRange) * 100)), color: 'var(--accent)', label: 'Flip', height: 16, opacity: 1 });

    const mkHtml = markers.map(m => `
        <div style="position:absolute;left:${m.pct}%;top:-2px;transform:translateX(-50%);opacity:${m.opacity}">
            <div style="width:${m.label ? 2 : 3}px;height:${m.height}px;background:${m.color};margin:0 auto;border-radius:1px"></div>
            ${m.label ? `<div style="font-size:9px;color:${m.color};font-weight:700;text-align:center;margin-top:2px;white-space:nowrap">${m.label}</div>` : ''}
        </div>`).join('');

    const rangeBarHtml = `
    <div style="padding:8px 0;margin:6px 0 10px">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:6px">
            <span style="color:var(--put-color);font-weight:700">$${barLow} Support</span>
            <span style="font-size:10px;color:var(--text-muted)">${d.putWalls.length}P + ${d.callWalls.length}C walls</span>
            <span style="color:var(--call-color);font-weight:700">Resistance $${barHigh}</span>
        </div>
        <div style="position:relative;height:12px;background:rgba(255,255,255,.07);border-radius:6px;overflow:visible">
            <div style="position:absolute;left:0;top:0;height:100%;width:${pricePct}%;background:linear-gradient(to right,var(--put-color)22,var(--cyan)33,transparent);border-radius:6px 0 0 6px"></div>
            ${mkHtml}
            <div style="position:absolute;left:${pricePct}%;top:-6px;transform:translateX(-50%);z-index:2">
                <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:7px solid white;margin:0 auto"></div>
                <div style="font-size:10px;color:white;font-weight:800;text-align:center;margin-top:1px">$${d.uPrice.toFixed(0)}</div>
            </div>
        </div>
    </div>`;

    // ── ACTION LINE (Day-Trade Calibrated, Multi-Wall) ──
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
    const mpStr = d.mpStrike ? fmtPink(d.mpStrike) : '';
    const gmStr = d.risk.gammaMean ? fmtCyan(d.risk.gammaMean.toFixed(0)) : '';

    // Build wall chain: "→ $5250 (234) → $5300 (1,139)"
    const callChain = d.callWalls.slice(1, 3).map(w => `→ ${fmtC(w.strike)} (${w.oi.toLocaleString()})`).join(' ');
    const putChain = d.putWalls.slice(1, 3).map(w => `→ ${fmtP(w.strike)} (${w.oi.toLocaleString()})`).join(' ');

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
        const vannaConfirm = d.vannaExp < 0;
        const swStr = fmtC(d.structCallWall.strike);
        actionHtml = `<b style="color:var(--green)">Buy / Follow Long!</b> ราคาทะลุ Call Wall ${swStr} ไปแล้ว +${d.callWallBreakoutDist.toFixed(0)} pts`;
        if (vannaConfirm) actionHtml += `<br>✅ Vanna ยืนยัน — Dealers ต้อง Buy = ดัน squeeze ต่อ`;
        else actionHtml += `<br>⚠️ Vanna ยังไม่ยืนยัน — ถ้า IV ลดราคาอาจ pullback กลับ`;
        actionHtml += `<br>SL ใต้ Call Wall เดิม ${swStr}`;
        if (d.callWalls.length > 0) actionHtml += ` | TP ที่ ${fmtC(d.callWalls[0].strike)} ${callChain}`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">🔥 Wall ถูกทะลุแล้ว — Call Wall เดิมกลายเป็น Support | ห้าม Short สวนทาง!</div>`;
    } else if (d.priceBelowPutWall) {
        const vannaConfirm = d.vannaExp > 0;
        const swStr = fmtP(d.structPutWall.strike);
        actionHtml = `<b style="color:var(--red)">Sell / Follow Short!</b> ราคาหลุด Put Wall ${swStr} ไปแล้ว -${d.putWallBreakdownDist.toFixed(0)} pts`;
        if (vannaConfirm) actionHtml += `<br>✅ Vanna ยืนยัน — Dealers ต้อง Sell = กดลงต่อ`;
        else actionHtml += `<br>⚠️ Vanna ยังไม่ยืนยัน — ถ้า IV ลดราคาอาจ bounce กลับ`;
        actionHtml += `<br>SL เหนือ Put Wall เดิม ${swStr}`;
        if (d.putWalls.length > 0) actionHtml += ` | TP ที่ ${fmtP(d.putWalls[0].strike)} ${putChain}`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">🔥 Wall ถูกทะลุแล้ว — Put Wall เดิมกลายเป็น Resistance | ห้าม Buy สวนทาง!</div>`;
    } else if (d.isLongGamma) {
        const slBuffer = 15;
        const nrStrike = d.nearestCall ? d.nearestCall.strike : d.maxCall.strike;
        const nsStrike = d.nearestPut ? d.nearestPut.strike : d.maxPut.strike;
        // Next walls beyond nearest (for breakout TP targets)
        const nextCallWall = d.callWalls.length > 1 ? d.callWalls[1] : null;
        const nextPutWall = d.putWalls.length > 1 ? d.putWalls[1] : null;

        if (nearCallZone && trendUp) {
            // ── SCENARIO A: ราคาใกล้ Call Wall + ขาขึ้น ──
            actionHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap">`;
            // Breakout Long
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(38,166,154,.08);border-radius:10px;border:1px solid rgba(38,166,154,.25)">`;
            actionHtml += `<div style="font-size:11px;color:var(--green);font-weight:800;margin-bottom:6px">🚀 BREAKOUT LONG <span style="font-size:10px;color:var(--text-muted);font-weight:400">(รอทะลุก่อนเข้า)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Trigger: ราคาทะลุ + ยืนเหนือ ${nrStr}<br>`;
            actionHtml += `Entry: Retest ${nrStr} เป็น Support<br>`;
            actionHtml += `SL: $${(nrStrike - slBuffer).toFixed(0)} (ใต้ Wall)<br>`;
            actionHtml += `TP₁: ${nextCallWall ? fmtC(nextCallWall.strike) : (d.callWalls.length > 0 ? fmtC(d.callWalls[d.callWalls.length - 1].strike) : nrStr)}`;
            if (callChain) actionHtml += ` ${callChain}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ ห้ามซื้อก่อนทะลุ! Long γ = fake breakout สูง</div>`;
            actionHtml += `</div>`;
            // Scalp Short (fade the wall)
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(239,83,80,.06);border-radius:10px;border:1px solid rgba(239,83,80,.15)">`;
            actionHtml += `<div style="font-size:11px;color:var(--red);font-weight:800;margin-bottom:6px">🎯 SCALP SHORT <span style="font-size:10px;color:var(--text-muted);font-weight:400">(ชน Wall แล้วเด้ง)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Entry: ${nrStr} (ที่ Wall)<br>`;
            actionHtml += `SL: $${(nrStrike + slBuffer).toFixed(0)}<br>`;
            actionHtml += `TP: ${mpStr || gmStr || nsStr}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ Size เล็ก — สวนเทรน scalp เท่านั้น</div>`;
            actionHtml += `</div></div>`;
            if (trStr) actionHtml += `<div style="margin-top:6px">${trStr}</div>`;

        } else if (nearPutZone && trendDown) {
            // ── SCENARIO B: ราคาใกล้ Put Wall + ขาลง ──
            actionHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap">`;
            // Breakdown Short
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(239,83,80,.08);border-radius:10px;border:1px solid rgba(239,83,80,.25)">`;
            actionHtml += `<div style="font-size:11px;color:var(--red);font-weight:800;margin-bottom:6px">💧 BREAKDOWN SHORT <span style="font-size:10px;color:var(--text-muted);font-weight:400">(รอหลุดก่อนเข้า)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Trigger: ราคาหลุด + อยู่ใต้ ${nsStr}<br>`;
            actionHtml += `Entry: Retest ${nsStr} เป็น Resistance<br>`;
            actionHtml += `SL: $${(nsStrike + slBuffer).toFixed(0)} (เหนือ Wall)<br>`;
            actionHtml += `TP₁: ${nextPutWall ? fmtP(nextPutWall.strike) : (d.putWalls.length > 0 ? fmtP(d.putWalls[d.putWalls.length - 1].strike) : nsStr)}`;
            if (putChain) actionHtml += ` ${putChain}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ ห้ามขายก่อนหลุด! Long γ = fake breakdown สูง</div>`;
            actionHtml += `</div>`;
            // Scalp Long (bounce from wall)
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(38,166,154,.06);border-radius:10px;border:1px solid rgba(38,166,154,.15)">`;
            actionHtml += `<div style="font-size:11px;color:var(--green);font-weight:800;margin-bottom:6px">🎯 SCALP LONG <span style="font-size:10px;color:var(--text-muted);font-weight:400">(ชน Wall แล้วเด้ง)</span></div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:2">`;
            actionHtml += `Entry: ${nsStr} (ที่ Wall)<br>`;
            actionHtml += `SL: $${(nsStrike - slBuffer).toFixed(0)}<br>`;
            actionHtml += `TP: ${mpStr || gmStr || nrStr}`;
            actionHtml += `</div>`;
            actionHtml += `<div style="font-size:11px;color:var(--orange);margin-top:6px;font-weight:600">⚠️ Size เล็ก — สวนเทรน scalp เท่านั้น</div>`;
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
            // ── SCENARIO D: DEFAULT — แสดง Short/Long setup ที่ walls ──
            actionHtml = `<div style="display:flex;gap:12px;flex-wrap:wrap">`;
            // Short setup at nearest resistance
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(239,83,80,.06);border-radius:10px;border:1px solid rgba(239,83,80,.15)">`;
            actionHtml += `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:4px">🎯 SHORT SETUP</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:1.8">`;
            actionHtml += `Entry → ${nrStr} (+${nrDist.toFixed(0)} pts)<br>`;
            actionHtml += `SL: $${(nrStrike + slBuffer).toFixed(0)}<br>`;
            actionHtml += `TP₁: ${mpStr || gmStr || nsStr}`;
            if (d.nearestPut) actionHtml += ` | TP₂: ${nsStr}`;
            actionHtml += `</div></div>`;
            // Long setup at nearest support
            actionHtml += `<div style="flex:1;min-width:200px;padding:12px 14px;background:rgba(38,166,154,.06);border-radius:10px;border:1px solid rgba(38,166,154,.15)">`;
            actionHtml += `<div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:4px">🎯 LONG SETUP</div>`;
            actionHtml += `<div style="font-size:13px;color:var(--text-primary);line-height:1.8">`;
            actionHtml += `Entry → ${nsStr} (-${nsDist.toFixed(0)} pts)<br>`;
            actionHtml += `SL: $${(nsStrike - slBuffer).toFixed(0)}<br>`;
            actionHtml += `TP₁: ${mpStr || gmStr || nrStr}`;
            if (d.nearestCall) actionHtml += ` | TP₂: ${nrStr}`;
            actionHtml += `</div></div></div>`;
            if (trStr) actionHtml += `<div style="margin-top:6px">${trStr}</div>`;
            actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">❌ ห้ามไล่ซื้อ breakout ใน Wall (Long γ = fake breakout สูง เมื่อราคายังไม่ทะลุ Wall)</div>`;
        }
    } else {
        // Short gamma: trend following with nearest walls
        const dir = d.priceBelowMP ? 'ลง' : d.priceAboveMP ? 'ขึ้น' : '';
        actionHtml = `Breakout > ${nrStr} → <b style="color:var(--green)">Long</b> ${callChain ? `(next: ${callChain})` : ''}`;
        actionHtml += `<br>Breakdown < ${nsStr} → <b style="color:var(--red)">Short</b> ${putChain ? `(next: ${putChain})` : ''}`;
        if (dir) actionHtml += ` <span style="font-size:10px;opacity:.8">(bias ${dir})</span>`;
        if (trStr) actionHtml += `<br>${trStr}`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">❌ ห้าม Fade สวนทาง (Short γ = วิ่งต่อไม่หยุด)</div>`;
    }

    // ── PATIENCE GUARD (Anti-Shakeout) ──
    let patienceHtml = '';
    const isChoppy = d.tradeableRange < 999 && d.tradeableRange < erRef * 1.5 && d.isLongGamma;
    const isFarFromAllWalls = !nearCallZone && !nearPutZone;
    const isDampeningZone = d.priceAboveCallWall && d.isLongGamma; // Above Call Wall + Long γ = no momentum

    if (isChoppy || (noEdgeZone && d.isLongGamma) || isDampeningZone) {
        const triggerCall = d.nearestCall ? `$${d.nearestCall.strike}` : `$${d.maxCall.strike}`;
        const triggerPut = d.nearestPut ? `$${d.nearestPut.strike}` : `$${d.maxPut.strike}`;
        const rangeLabel = d.tradeableRange < 999 ? `${d.tradeableRange.toFixed(0)}` : '—';
        const erLabel = erRef.toFixed(0);
        const sizeAdvice = isChoppy ? 'Range แคบกว่า 1.5× ER → ลดขนาด 50% หรืองดเทรด' : '';

        patienceHtml = `
        <div style="padding:14px 18px;background:linear-gradient(135deg,rgba(255,152,0,.08),rgba(255,87,34,.05));border-radius:12px;border:1px solid rgba(255,152,0,.3);border-left:4px solid var(--orange)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                <span style="font-size:18px">🧘</span>
                <span style="font-size:13px;font-weight:900;color:var(--orange);letter-spacing:.5px">PATIENCE GUARD — ห้ามเข้าตอน SIDEWAY</span>
            </div>
            <div style="font-size:13px;color:var(--text-primary);line-height:2">
                <span style="color:var(--red);font-weight:700">⛔ Long γ + ราคากลาง Range = โดน Shakeout แน่นอน</span><br>
                ✅ เข้าเฉพาะเมื่อ: ราคาแตะ Wall (${triggerPut} / ${triggerCall}) หรือ ทะลุ Wall ชัดเจน<br>
                📏 Range: ${rangeLabel} pts vs ER: ${erLabel} pts ${isChoppy ? `<span style="color:var(--red);font-weight:700">— Range < 1.5× ER → ลดขนาด 50%!</span>` : ''}
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05)">
                💡 ขาดทุนรัวๆ จาก Sideway เสียหายมากกว่าพลาดโอกาส — รอจนมีเงื่อนไขครบก่อนเข้า
            </div>
        </div>`;
    }

    // ── INSTITUTIONAL INTEL ──
    const adv = 200000; // Estimated Daily Gold Futures Volume (Contracts)

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

    // ── Regime label ──
    const regimeLabel = d.isLongGamma
        ? `<span style="color:var(--green);font-weight:700">Long Gamma</span> <span style="color:var(--text-secondary);font-size:12px">· Mean Reversion · ราคา Stable</span>`
        : `<span style="color:var(--red);font-weight:700">Short Gamma</span> <span style="color:var(--text-secondary);font-size:12px">· Trend Following · ราคา Volatile</span>`;

    // ── Fallback warning ──
    const fallbackHtml = isFallback ? `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;background:rgba(255,152,0,.1);border:1px solid rgba(255,152,0,.35);margin-bottom:14px">
            <span style="font-size:16px">⚠️</span>
            <span style="font-size:13px;color:var(--orange);font-weight:700">ราคา Futures ไม่พบในข้อมูล — ค่าทุกอย่างใช้ค่าประมาณ → รัน Scraper ใหม่</span>
        </div>` : '';

    // ── RENDER GRID LAYOUT ──
    header.innerHTML = '';
    container.innerHTML = `
        ${fallbackHtml}

        <!-- HERO — full width -->
        <div style="padding:20px 24px;background:linear-gradient(135deg,rgba(255,255,255,.04),transparent);border:1px solid ${bColor}40;border-radius:14px">
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:8px">
                <div style="display:inline-flex;padding:6px 16px;border-radius:20px;font-size:15px;font-weight:900;letter-spacing:.5px;background:${bColor}1a;border:1px solid ${bColor}55;color:${bColor}">${bText}</div>
                <div style="font-size:26px;font-weight:900;color:#ffffff">$${d.uPrice.toFixed(1)}</div>
                <div style="font-size:13px;color:var(--text-secondary);font-weight:700">${d.dte.toFixed(1)} DTE</div>
                <div style="margin-left:auto;font-size:14px;font-weight:800;color:${d.risk.riskColor}">${d.risk.riskIcon} Risk ${d.risk.totalScore}/100</div>
            </div>
            <div style="font-size:14px;color:var(--text-secondary);margin-bottom:4px;line-height:1.6">${bDesc}</div>
            <div style="font-size:13px">${regimeLabel}</div>
        </div>

        <!-- 2-COLUMN ROW: Key Levels + Institutional Intel -->
        <div class="setup-grid-row">

            <!-- KEY LEVELS -->
            <div style="padding:18px 22px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;display:flex;flex-direction:column">
                <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">📍 Key Levels <span style="font-weight:400;text-transform:none;letter-spacing:0">(เรียงจากใกล้ราคา)</span></div>
                ${rangeBarHtml}
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

        <!-- ACTION — full width -->
        <div style="padding:18px 22px;background:rgba(0,0,0,.3);border:1px solid ${bColor}30;border-left:4px solid ${bColor};border-radius:14px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">📋 What to Do</div>
            <div style="font-size:15px;color:var(--text-primary);line-height:1.9;font-weight:600">${actionHtml}</div>
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
        return;
    }

    const tabData = state.data[state.activeTab];
    if (!tabData || (!tabData.intraday && !tabData.oi)) {
        // Show placeholder
        const oiC = document.getElementById('oiContainer');
        const volC = document.getElementById('volContainer');
        oiC.innerHTML = `<div class="placeholder-msg"><div class="icon">🔒</div><div class="title">No Data Yet</div><div class="desc">This contract requires a QuikStrike scraper. Set up the Python scraper to fetch ${CONFIG.contracts[state.activeTab].label} contract data.</div></div>`;
        volC.innerHTML = `<div class="placeholder-msg"><div class="icon">🔒</div><div class="title">No Data Yet</div><div class="desc">Configure the scraper to populate ${CONFIG.contracts[state.activeTab].label} contract Intraday Volume.</div></div>`;

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
    renderPanel('oiContainer', tabData.oi, CONFIG.oiHotThreshold);
    renderPanel('volContainer', tabData.intraday, CONFIG.volHotThreshold);
    updateSummary(tabData.intraday, tabData.oi);
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
