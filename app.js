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
function calcNetGEX(strikes, F, dte) {
    if (!strikes || strikes.length === 0 || dte <= 0) return { netGEX: 0, flipStrike: null };
    const t = dte / 365;
    const contractMultiplier = 100; // Gold options = 100 oz
    let netGEX = 0;
    let gexByStrike = [];
    for (const s of strikes) {
        const g = calcGamma(F, s.strike, s.volSettle, t);
        const callGEX = g * s.call * contractMultiplier * F * F * 0.01;
        const putGEX = g * s.put * contractMultiplier * F * F * 0.01;
        // Dealers are typically short calls (long gamma) and short puts (short gamma)
        // Net GEX = Call GEX - Put GEX
        const strikeGEX = callGEX - putGEX;
        netGEX += strikeGEX;
        gexByStrike.push({ strike: s.strike, gex: strikeGEX });
    }
    // Find GEX flip point (where cumulative crosses zero)
    let flipStrike = null;
    gexByStrike.sort((a, b) => a.strike - b.strike);
    let cumGEX = 0;
    for (let i = 0; i < gexByStrike.length; i++) {
        const prev = cumGEX;
        cumGEX += gexByStrike[i].gex;
        if (prev <= 0 && cumGEX > 0 && i > 0) {
            flipStrike = gexByStrike[i].strike;
            break;
        }
    }
    return { netGEX, flipStrike };
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

// Net Vanna Exposure: aggregate vanna × OI across all strikes
// Positive = vol spike causes selling, Negative = vol spike causes buying
function calcNetVannaExposure(strikes, F, dte) {
    if (!strikes || strikes.length === 0 || dte <= 0) return 0;
    const t = dte / 365;
    const contractMultiplier = 100;
    let netVanna = 0;
    for (const s of strikes) {
        const v = calcVanna(F, s.strike, s.volSettle, t);
        // Dealers short calls → call vanna exposure is negative
        // Dealers short puts → put vanna exposure is positive
        const callVannaExp = -v * s.call * contractMultiplier * F * 0.01;
        const putVannaExp = v * s.put * contractMultiplier * F * 0.01;
        netVanna += callVannaExp + putVannaExp;
    }
    return netVanna; // Negative = vol spike → dealers sell → bearish cascade
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
            // Find range containing 80% of gamma
            gammaByStrike.sort((a, b) => b.gamma - a.gamma);
            let cum = 0;
            let gammaHigh = -Infinity, gammaLow = Infinity;
            for (const gs of gammaByStrike) {
                cum += gs.gamma;
                gammaHigh = Math.max(gammaHigh, gs.strike);
                gammaLow = Math.min(gammaLow, gs.strike);
                if (cum / totalGammaWeight >= 0.80) break;
            }
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
            itmOI    += (cd > 0.70 ? s.call : 0) + (pd > 0.70 ? s.put : 0);
            atmOI_h  += (cd >= 0.30 && cd <= 0.70 ? s.call : 0) + (pd >= 0.30 && pd <= 0.70 ? s.put : 0);
            otmOI    += (cd < 0.30 ? s.call : 0) + (pd < 0.30 ? s.put : 0);
        });
        const totalHedgeOI = (itmOI + atmOI_h + otmOI) || 1;
        const itmPct  = itmOI  / totalHedgeOI * 100;
        const atmPct  = atmOI_h / totalHedgeOI * 100;
        const otmPct  = otmOI  / totalHedgeOI * 100;
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
let callLine = null;
let putLine = null;

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

function plotWallsOnChart() {
    if (!candleSeries) return;

    // Clear existing lines
    if (callLine) candleSeries.removePriceLine(callLine);
    if (putLine) candleSeries.removePriceLine(putLine);
    callLine = null;
    putLine = null;

    const tData = state.data['current']; // use current DTE for walls
    if (!tData || !tData.oi || !tData.oi.strikes) return;

    let maxCallVal = 0;
    let maxCallStrike = 0;
    let maxPutVal = 0;
    let maxPutStrike = 0;

    tData.oi.strikes.forEach(s => {
        if (s.call > maxCallVal) { maxCallVal = s.call; maxCallStrike = s.strike; }
        if (s.put > maxPutVal) { maxPutVal = s.put; maxPutStrike = s.strike; }
    });

    if (maxCallStrike > 0) {
        callLine = candleSeries.createPriceLine({
            price: maxCallStrike,
            color: '#26a69a',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Max Call (Resist)',
        });
    }

    if (maxPutStrike > 0) {
        putLine = candleSeries.createPriceLine({
            price: maxPutStrike,
            color: '#ef5350',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Max Put (Support)',
        });
    }
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

        const callsAbove = data.strikes.filter(s => s.strike >= uPrice && s.call > 0);
        const putsBelow = data.strikes.filter(s => s.strike <= uPrice && s.put > 0);
        let maxCall = callsAbove.length > 0
            ? callsAbove.reduce((p, c) => c.call > p.call ? c : p)
            : data.strikes.reduce((p, c) => c.call > p.call ? c : p);
        let maxPut = putsBelow.length > 0
            ? putsBelow.reduce((p, c) => c.put > p.put ? c : p)
            : data.strikes.reduce((p, c) => c.put > p.put ? c : p);

        // Structural walls: highest OI across ALL strikes (for breakout detection)
        // maxCall/maxPut only look above/below price — structural walls are the TRUE walls
        const structCallWall = data.strikes.reduce((p, c) => c.call > p.call ? c : p);
        const structPutWall = data.strikes.reduce((p, c) => c.put > p.put ? c : p);
        const priceAboveCallWall = uPrice > structCallWall.strike;
        const priceBelowPutWall = uPrice < structPutWall.strike;
        const callWallBreakoutDist = uPrice - structCallWall.strike;
        const putWallBreakdownDist = structPutWall.strike - uPrice;

        if (Math.abs(uPrice - maxCall.strike) < 30 && tc > tp) biasScore += 1;
        else if (Math.abs(uPrice - maxPut.strike) < 30 && tp > tc) biasScore -= 1;

        const mpStrike = calcMaxPain(data.strikes);
        const mpDist = mpStrike !== null ? (uPrice - mpStrike) : 0;
        const priceAboveMP = mpStrike !== null && uPrice > mpStrike;
        const priceBelowMP = mpStrike !== null && uPrice < mpStrike;

        const gexResult = calcNetGEX(data.strikes, uPrice, data.dte);
        const gexVal = gexResult.netGEX;
        const isLongGamma = gexVal >= 0;

        const distToCallWall = maxCall.strike - uPrice;
        const distToPutWall = uPrice - maxPut.strike;
        const nearCallWall = distToCallWall < 40;
        const nearPutWall = distToPutWall < 40;

        const sourceStrikes2 = intraday?.strikes?.length > 0 ? intraday.strikes : null;
        const atm2 = data.strikes.reduce((p, c) => Math.abs(c.strike - uPrice) < Math.abs(p.strike - uPrice) ? c : p);
        const er1DayForRisk = atm2.volSettle > 0 ? uPrice * atm2.volSettle * Math.sqrt(1 / 365) : 50;
        const risk = calcBreakdownRisk(data.strikes, sourceStrikes2, uPrice, data.dte, gexResult.flipStrike, er1DayForRisk);
        const vannaExp = calcNetVannaExposure(data.strikes, uPrice, data.dte);

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
            distToCallWall, distToPutWall, nearCallWall, nearPutWall,
            risk, vannaExp, hedgeLabel, itmPct, dte: data.dte
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
    } else if (d.priceAboveCallWall) {
        const vannaConfirm = d.vannaExp > 0;
        bText = vannaConfirm ? '🚀 BREAKOUT + Vanna' : '🚀 BREAKOUT';
        bColor = 'var(--green)';
        bDesc = `ราคาทะลุ Call Wall $${d.structCallWall.strike} ไปแล้ว +${d.callWallBreakoutDist.toFixed(0)} pts`;
        if (vannaConfirm) bDesc += ` — Vanna ยืนยัน: Dealers ต้อง Buy ดันราคาต่อ`;
        else bDesc += ` — Vanna ยังไม่ confirm ระวัง pullback`;
    } else if (d.priceBelowPutWall) {
        const vannaConfirm = d.vannaExp < 0;
        bText = vannaConfirm ? '💧 CASCADE + Vanna' : '💧 CASCADE';
        bColor = 'var(--red)';
        bDesc = `ราคาหลุด Put Wall $${d.structPutWall.strike} ไปแล้ว -${d.putWallBreakdownDist.toFixed(0)} pts`;
        if (vannaConfirm) bDesc += ` — Vanna ยืนยัน: Dealers ต้อง Sell กดราคาต่อ`;
        else bDesc += ` — Vanna ยังไม่ confirm ระวัง bounce`;
    } else if (d.nearCallWall && d.gexVal >= 0) {
        bText = '⚡ ชน Resistance'; bColor = '#ffd54f';
        bDesc = `ใกล้ Call Wall $${d.maxCall.strike} → ทะลุ=Squeeze / ย่อ=Short`;
    } else if (d.nearPutWall && d.gexVal >= 0) {
        bText = '⚡ ชน Support'; bColor = '#ffd54f';
        bDesc = `ใกล้ Put Wall $${d.maxPut.strike} → หลุด=Cascade / เด้ง=Long`;
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

    // ── KEY LEVELS ──
    const levels = [];
    // Put Wall — show as broken if price is below it
    if (d.priceBelowPutWall) {
        levels.push({ price: d.structPutWall.strike, label: '💔 Broken Put Wall', color: 'var(--orange)', icon: '💔', dist: d.structPutWall.strike - d.uPrice, action: 'ราคาหลุดแล้ว → กลายเป็น Resistance (SL zone)' });
        if (d.maxPut.strike !== d.structPutWall.strike) {
            levels.push({ price: d.maxPut.strike, label: 'Next Put Wall', color: 'var(--put-color)', icon: '🟢', dist: d.maxPut.strike - d.uPrice, action: 'Support ถัดไป (TP target)' });
        }
    } else {
        levels.push({ price: d.maxPut.strike, label: 'Put Wall (Support)', color: 'var(--put-color)', icon: '🟢', dist: d.maxPut.strike - d.uPrice, action: 'ซื้อ/Long ถ้าราคาลงมาถึง' });
    }
    if (d.risk.gammaMean) levels.push({ price: +d.risk.gammaMean.toFixed(0), label: 'Gamma Mean', color: 'var(--cyan)', icon: '🔵', dist: d.risk.gammaMean - d.uPrice, action: 'จุดสมดุล — TP ชั้นดี' });
    if (d.mpStrike) levels.push({ price: d.mpStrike, label: 'Max Pain', color: 'var(--pink)', icon: '🟣', dist: d.mpStrike - d.uPrice, action: 'จุดดึงดูดราคา (Expiry Magnet)' });
    if (d.gexResult.flipStrike) {
        const fd = d.gexResult.flipStrike - d.uPrice;
        const fw = Math.abs(fd) < 60 ? ' ⚠️' : '';
        levels.push({ price: d.gexResult.flipStrike, label: 'GEX Flip' + fw, color: 'var(--accent)', icon: '⚡', dist: fd, action: 'ข้ามนี้ = เปลี่ยน regime (Long↔Short γ)' });
    }
    // Call Wall — show as broken if price is above it
    if (d.priceAboveCallWall) {
        levels.push({ price: d.structCallWall.strike, label: '💔 Broken Call Wall', color: 'var(--orange)', icon: '💔', dist: d.structCallWall.strike - d.uPrice, action: 'ราคาทะลุแล้ว → กลายเป็น Support (SL zone)' });
        if (d.maxCall.strike !== d.structCallWall.strike) {
            levels.push({ price: d.maxCall.strike, label: 'Next Call Wall', color: 'var(--call-color)', icon: '🔴', dist: d.maxCall.strike - d.uPrice, action: 'Resistance ถัดไป (TP target)' });
        }
    } else {
        levels.push({ price: d.maxCall.strike, label: 'Call Wall (Resistance)', color: 'var(--call-color)', icon: '🔴', dist: d.maxCall.strike - d.uPrice, action: 'ขาย/Short ถ้าราคาขึ้นไปถึง' });
    }
    levels.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));

    const levelsHtml = levels.map(l => {
        const ds = l.dist >= 0 ? `+${l.dist.toFixed(0)}` : l.dist.toFixed(0);
        const dc = Math.abs(l.dist) < 40 ? 'var(--orange)' : 'var(--text-muted)';
        return `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)">
            <span style="font-size:15px;width:22px;text-align:center">${l.icon}</span>
            <span style="font-size:14px;font-weight:700;color:${l.color};min-width:150px">${l.label}</span>
            <span style="font-size:16px;font-weight:800;color:var(--text-primary);min-width:70px">$${l.price}</span>
            <span style="font-size:13px;font-weight:700;color:${dc};min-width:50px">(${ds})</span>
            <span style="font-size:12px;color:var(--text-secondary);flex:1">${l.action}</span>
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

    // ── VISUAL RANGE BAR ──
    const barLow = d.maxPut.strike;
    const barHigh = d.maxCall.strike;
    const barRange = barHigh - barLow || 1;
    const pricePct = Math.max(2, Math.min(98, ((d.uPrice - barLow) / barRange) * 100));
    const markers = [];
    if (d.risk.gammaMean) markers.push({ pct: Math.max(0, Math.min(100, ((d.risk.gammaMean - barLow) / barRange) * 100)), color: 'var(--cyan)', label: 'GM' });
    if (d.mpStrike) markers.push({ pct: Math.max(0, Math.min(100, ((d.mpStrike - barLow) / barRange) * 100)), color: 'var(--pink)', label: 'MP' });
    if (d.gexResult.flipStrike) markers.push({ pct: Math.max(0, Math.min(100, ((d.gexResult.flipStrike - barLow) / barRange) * 100)), color: 'var(--accent)', label: 'Flip' });

    const mkHtml = markers.map(m => `
        <div style="position:absolute;left:${m.pct}%;top:-2px;transform:translateX(-50%)">
            <div style="width:2px;height:16px;background:${m.color};margin:0 auto;border-radius:1px"></div>
            <div style="font-size:9px;color:${m.color};font-weight:700;text-align:center;margin-top:2px;white-space:nowrap">${m.label}</div>
        </div>`).join('');

    const rangeBarHtml = `
    <div style="padding:8px 0;margin:6px 0 10px">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:6px">
            <span style="color:var(--put-color);font-weight:700">$${barLow} Support</span>
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

    // ── ACTION LINE ──
    const sStr = `<span style="color:var(--put-color);font-weight:700">$${d.maxPut.strike}</span>`;
    const rStr = `<span style="color:var(--call-color);font-weight:700">$${d.maxCall.strike}</span>`;
    const mpStr = d.mpStrike ? `<span style="color:var(--pink);font-weight:700">$${d.mpStrike}</span>` : '';
    const gmStr = d.risk.gammaMean ? `<span style="color:var(--cyan);font-weight:700">$${d.risk.gammaMean.toFixed(0)}</span>` : '';

    let tpTarget = mpStr, tpLabel = 'Max Pain';
    if (d.risk.gammaMean && d.mpStrike) {
        if (d.priceAboveMP && d.risk.gammaMean < d.uPrice && d.risk.gammaMean > d.mpStrike) { tpTarget = gmStr; tpLabel = 'Gamma Mean'; }
        else if (d.priceBelowMP && d.risk.gammaMean > d.uPrice && d.risk.gammaMean < d.mpStrike) { tpTarget = gmStr; tpLabel = 'Gamma Mean'; }
    }

    let actionHtml;
    if (d.risk.noMansLand) {
        const isUp = d.risk.noMansLandSide === 'above';
        actionHtml = isUp
            ? `<b style="color:#ff1744">ห้าม Short!</b> ราคานอก Gamma Zone — Follow ขึ้นอย่างเดียว | SL ใต้ High ล่าสุด`
            : `<b style="color:#ff1744">ห้าม Buy!</b> ราคานอก Gamma Zone — Follow ลงอย่างเดียว | SL เหนือ Low ล่าสุด`;
    } else if (d.priceAboveCallWall) {
        // === CONFIRMED BREAKOUT ABOVE CALL WALL ===
        const vannaConfirm = d.vannaExp > 0;
        const swStr = `<span style="color:var(--call-color);font-weight:700">$${d.structCallWall.strike}</span>`;
        const nextR = d.maxCall.strike !== d.structCallWall.strike
            ? `<span style="color:var(--call-color);font-weight:700">$${d.maxCall.strike}</span>` : '';
        actionHtml = `<b style="color:var(--green)">Buy / Follow Long!</b> ราคาทะลุ Call Wall ${swStr} ไปแล้ว +${d.callWallBreakoutDist.toFixed(0)} pts`;
        if (vannaConfirm) actionHtml += `<br>✅ Vanna ยืนยัน — Dealers ต้อง Buy = ดัน squeeze ต่อ`;
        else actionHtml += `<br>⚠️ Vanna ยังไม่ยืนยัน — ถ้า IV ลดราคาอาจ pullback กลับ`;
        actionHtml += `<br>SL ใต้ Call Wall เดิม ${swStr}`;
        if (nextR) actionHtml += ` | TP ที่ Resistance ถัดไป ${nextR}`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">🔥 Wall ถูกทะลุแล้ว — Call Wall เดิมกลายเป็น Support | ห้าม Short สวนทาง!</div>`;
    } else if (d.priceBelowPutWall) {
        // === CONFIRMED BREAKDOWN BELOW PUT WALL ===
        const vannaConfirm = d.vannaExp < 0;
        const swStr = `<span style="color:var(--put-color);font-weight:700">$${d.structPutWall.strike}</span>`;
        const nextS = d.maxPut.strike !== d.structPutWall.strike
            ? `<span style="color:var(--put-color);font-weight:700">$${d.maxPut.strike}</span>` : '';
        actionHtml = `<b style="color:var(--red)">Sell / Follow Short!</b> ราคาหลุด Put Wall ${swStr} ไปแล้ว -${d.putWallBreakdownDist.toFixed(0)} pts`;
        if (vannaConfirm) actionHtml += `<br>✅ Vanna ยืนยัน — Dealers ต้อง Sell = กดลงต่อ`;
        else actionHtml += `<br>⚠️ Vanna ยังไม่ยืนยัน — ถ้า IV ลดราคาอาจ bounce กลับ`;
        actionHtml += `<br>SL เหนือ Put Wall เดิม ${swStr}`;
        if (nextS) actionHtml += ` | TP ที่ Support ถัดไป ${nextS}`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">🔥 Wall ถูกทะลุแล้ว — Put Wall เดิมกลายเป็น Resistance | ห้าม Buy สวนทาง!</div>`;
    } else if (d.isLongGamma) {
        if (d.priceAboveMP) {
            actionHtml = `<b>Sell</b> ที่ Call Wall ${rStr} (+${d.distToCallWall.toFixed(0)}) → TP ${tpTarget} (${tpLabel})`;
            if (d.maxPut.strike !== d.mpStrike) actionHtml += `<br><b>Buy</b> รับ Put Wall ${sStr} (-${d.distToPutWall.toFixed(0)}) ถ้าย่อ`;
        } else if (d.priceBelowMP) {
            actionHtml = `<b>Buy</b> ที่ Put Wall ${sStr} (-${d.distToPutWall.toFixed(0)}) → TP ${tpTarget} (${tpLabel})`;
            if (d.maxCall.strike !== d.mpStrike) actionHtml += `<br><b>Sell</b> รับ Call Wall ${rStr} (+${d.distToCallWall.toFixed(0)}) ถ้าเด้ง`;
        } else {
            actionHtml = `Sideway — <b>Buy</b> ${sStr} / <b>Sell</b> ${rStr} เทรดกรอบ`;
        }
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">❌ ห้ามไล่ซื้อ breakout ใน Wall (Long γ = fake breakout สูง เมื่อราคายังไม่ทะลุ Wall)</div>`;
    } else {
        const dir = d.priceBelowMP ? 'ลง' : d.priceAboveMP ? 'ขึ้น' : '';
        actionHtml = `Breakout > ${rStr} → <b style="color:var(--green)">Long</b> | Breakdown < ${sStr} → <b style="color:var(--red)">Short</b>`;
        if (dir) actionHtml += ` <span style="font-size:10px;opacity:.8">(bias ${dir})</span>`;
        actionHtml += `<div style="font-size:12px;color:var(--text-muted);margin-top:6px">❌ ห้าม Fade สวนทาง (Short γ = วิ่งต่อไม่หยุด)</div>`;
    }

    // ── INSTITUTIONAL INTEL ──
    const vannaColor = d.vannaExp < 0 ? 'var(--red)' : 'var(--green)';
    const vannaText = d.vannaExp < 0
        ? `IV↑ → Dealers <span style="color:var(--red);font-weight:700">SELL</span> $${Math.abs(d.vannaExp/1e6).toFixed(1)}M = กดลง`
        : `IV↑ → Dealers <span style="color:var(--green);font-weight:700">BUY</span> $${Math.abs(d.vannaExp/1e6).toFixed(1)}M = ดันขึ้น`;

    const hedgeIcon = d.hedgeLabel === 'Heavy Hedge' ? '🛡️' : d.hedgeLabel === 'Moderate Hedge' ? '🛡️' : '🎰';
    const hedgeText = d.hedgeLabel === 'Heavy Hedge' ? `สถาบัน Hedge หนัก (ITM ${d.itmPct.toFixed(0)}%) — มั่นใจสูง ป้อง downside`
        : d.hedgeLabel === 'Moderate Hedge' ? `สถาบัน Hedge ปานกลาง (ITM ${d.itmPct.toFixed(0)}%)`
        : `Spec-Driven — ขาเก็งกำไรนำ (ITM ${d.itmPct.toFixed(0)}%)`;

    // ── MULTI-TIMEFRAME CONTEXT ──
    const tfHints = [];
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

    // ── RENDER SINGLE PANEL ──
    header.innerHTML = '';
    container.innerHTML = `
    <div style="max-width:760px;margin:0 auto">
        ${fallbackHtml}

        <!-- HERO -->
        <div style="padding:20px 24px;background:linear-gradient(135deg,rgba(255,255,255,.04),transparent);border:1px solid ${bColor}40;border-radius:14px;margin-bottom:16px">
            <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:8px">
                <div style="display:inline-flex;padding:6px 16px;border-radius:20px;font-size:15px;font-weight:900;letter-spacing:.5px;background:${bColor}1a;border:1px solid ${bColor}55;color:${bColor}">${bText}</div>
                <div style="font-size:26px;font-weight:900;color:#ffffff">$${d.uPrice.toFixed(1)}</div>
                <div style="font-size:13px;color:var(--text-secondary);font-weight:700">${d.dte.toFixed(1)} DTE</div>
                <div style="margin-left:auto;font-size:14px;font-weight:800;color:${d.risk.riskColor}">${d.risk.riskIcon} Risk ${d.risk.totalScore}/100</div>
            </div>
            <div style="font-size:14px;color:var(--text-secondary);margin-bottom:4px;line-height:1.6">${bDesc}</div>
            <div style="font-size:13px">${regimeLabel}</div>
        </div>

        <!-- KEY LEVELS -->
        <div style="padding:18px 22px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;margin-bottom:16px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">📍 Key Levels <span style="font-weight:400;text-transform:none;letter-spacing:0">(เรียงจากใกล้ราคา)</span></div>
            ${rangeBarHtml}
            ${levelsHtml}
            ${breakoutHtml}
        </div>

        <!-- INSTITUTIONAL INTEL -->
        <div style="padding:16px 22px;background:var(--bg-panel);border:1px solid var(--border);border-radius:14px;margin-bottom:16px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">🏦 Institutional Intel</div>
            <div style="font-size:14px;color:var(--text-secondary);padding:5px 0;line-height:1.6">${hedgeIcon} ${hedgeText}</div>
            <div style="font-size:14px;color:var(--text-secondary);padding:5px 0;line-height:1.6">⚡ Vanna: ${vannaText}</div>
        </div>

        <!-- ACTION -->
        <div style="padding:18px 22px;background:rgba(0,0,0,.3);border:1px solid ${bColor}30;border-left:4px solid ${bColor};border-radius:14px;margin-bottom:16px">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">📋 What to Do</div>
            <div style="font-size:15px;color:var(--text-primary);line-height:1.9;font-weight:600">${actionHtml}</div>
        </div>

        <!-- MULTI-TIMEFRAME -->
        <div style="padding:10px 22px;font-size:13px;color:var(--text-secondary);display:flex;gap:16px;flex-wrap:wrap;justify-content:center">
            ${tfHints.join(' <span style="opacity:.3">|</span> ')}
        </div>
    </div>`;
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
