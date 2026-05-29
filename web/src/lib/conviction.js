// Fuse three data layers into one structural read of where positioning is
// concentrated and how strong each level really is:
//   1. OI         (PositionBias position_map)  — who is parked where, call vs put
//   2. OI heatmap (strike × day OI series)      — is that OI growing or fading
//   3. Gamma 1Pct (strike × day gamma series)   — how hard that strike PINS price
//
// The headline of this view is the WALL MAP + GAMMA PIN, not a buy/sell call.
// A directional skew is still computed but is explicitly a heuristic; the
// authoritative directional number is the server-side `position_bias` (with
// drivers) which we pass straight through as `modelBias`.
//
// Pure functions, no Svelte deps.

const NEIGHBOR_WINDOW = 10;       // strikes on each side for dominance baseline
const MIN_LATEST_OI = 5;          // ignore OI noise below this absolute level
const MIN_LATEST_GAMMA = 5;       // ignore gamma noise below this absolute level
const FRESH_BASELINE_MAX = 2;
const GROWING_DELTA_PCT = 0.5;
const STRONG_DELTA_PCT = 2.0;
const DOMINANCE_STRONG = 3;
const DOMINANCE_EMERGING = 1.5;
const FADING_DELTA_PCT = -0.3;

// Score gates and tuning. Heuristic, not calibrated against price outcomes —
// they only rank/filter, they are not a probability.
const HIGH_CONVICTION_GATE = 55;  // per-tenor score gate for skew weighting
const AGG_GATE = 90;              // aggregate score gate for cluster inclusion
const TOP_AGG_ROWS = 28;          // table size for multi-tenor wall list
const GAMMA_BLEND = 0.7;          // how much gamma sub-score adds onto OI
const PIN_AGREE_BOOST = 1.2;      // bonus when OI and gamma are both dominant

function firstNonNull(values) {
    if (!Array.isArray(values)) return null;
    for (const v of values) if (v != null && Number.isFinite(v)) return v;
    return null;
}

function avgNonNull(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    let sum = 0, n = 0;
    for (const v of values) if (v != null && Number.isFinite(v)) { sum += v; n += 1; }
    return n === 0 ? null : sum / n;
}

function medianNonZero(values) {
    const filtered = values
        .filter((v) => v != null && Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
    if (filtered.length === 0) return 0;
    const mid = Math.floor(filtered.length / 2);
    return filtered.length % 2 === 0
        ? (filtered[mid - 1] + filtered[mid]) / 2
        : filtered[mid];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Turn one strike's raw value series into latest/baseline/growth metrics.
function seriesFrom(strikesArr) {
    const map = new Map();
    for (const s of strikesArr || []) {
        const values = s.values || [];
        const latest = firstNonNull(values) ?? 0;
        const prevAvg = avgNonNull(values.slice(1)) ?? 0;
        const delta = latest - prevAvg;
        const deltaPct = prevAvg > 0 ? delta / prevAvg : (latest > 0 ? Infinity : 0);
        map.set(s.strike, { latest, prevAvg, delta, deltaPct });
    }
    return map;
}

// latest ÷ median of the ±NEIGHBOR_WINDOW neighbors for a given value map.
function dominanceAt(sortedStrikes, valueMap, idx) {
    const lo = Math.max(0, idx - NEIGHBOR_WINDOW);
    const hi = Math.min(sortedStrikes.length, idx + NEIGHBOR_WINDOW + 1);
    const neighbors = [];
    for (let j = lo; j < hi; j++) {
        if (j === idx) continue;
        neighbors.push(valueMap.get(sortedStrikes[j])?.latest ?? 0);
    }
    const med = medianNonZero(neighbors);
    const self = valueMap.get(sortedStrikes[idx])?.latest ?? 0;
    return med > 0 ? self / med : (self > 0 ? Infinity : 0);
}

function classifyTag({ prevAvg, latest, deltaPct, dominance }) {
    const isFresh = prevAvg <= FRESH_BASELINE_MAX && latest >= 3 * MIN_LATEST_OI;
    const isGrowing = Number.isFinite(deltaPct) && deltaPct >= GROWING_DELTA_PCT;
    const isStrongGrowth = !Number.isFinite(deltaPct) || deltaPct >= STRONG_DELTA_PCT;
    const isFading = Number.isFinite(deltaPct) && deltaPct <= FADING_DELTA_PCT;
    const isDominant = !Number.isFinite(dominance) || dominance >= DOMINANCE_STRONG;
    const isEmergingDom = !Number.isFinite(dominance) || dominance >= DOMINANCE_EMERGING;

    if (isDominant && isGrowing) return 'growing_wall';
    if (isFresh && isEmergingDom) return 'fresh';
    if (isStrongGrowth && isEmergingDom) return 'emerging';
    if (isDominant) return 'established';
    if (isFading && isEmergingDom) return 'fading';
    if (isGrowing) return 'building';
    return 'normal';
}

// Gamma 1Pct says how hard a strike pins. Tagged independently of the OI tag.
function classifyGammaTag({ gLatest, gDeltaPct, gDominance }) {
    if (gLatest < MIN_LATEST_GAMMA) return 'none';
    const isDominant = !Number.isFinite(gDominance) || gDominance >= DOMINANCE_STRONG;
    const isEmergingDom = !Number.isFinite(gDominance) || gDominance >= DOMINANCE_EMERGING;
    const isGrowing = Number.isFinite(gDeltaPct) && gDeltaPct >= GROWING_DELTA_PCT;
    if (isDominant) return 'pin';                 // strong gamma magnet
    if (isEmergingDom && isGrowing) return 'pin_building';
    if (isEmergingDom) return 'gamma';
    return 'none';
}

// Magnitude + growth + dominance → a single 0..~80 sub-score for one layer.
function subScore({ latest, deltaPct, dominance }, magCoeff) {
    if (!(latest > 0)) return 0;
    const magScore = Math.log10(Math.max(latest, 1)) * magCoeff;
    const growthScore = clamp(Number.isFinite(deltaPct) ? deltaPct * 12 : 36, -25, 36);
    const domScore = clamp(Number.isFinite(dominance) ? (dominance - 1) * 6 : 30, -10, 30);
    return Math.max(0, magScore + growthScore + domScore);
}

function isEmergingDominant(dom, latest, floor) {
    if (latest < floor) return false;
    return !Number.isFinite(dom) || dom >= DOMINANCE_EMERGING;
}

/**
 * Compute every qualified strike row for one (bias, OI heatmap, gamma heatmap).
 * Returns null when the OI heatmap is missing.
 */
function computeStrikeRows({ bias, heatmap, gamma }) {
    if (!heatmap?.strikes?.length) return null;

    const underlying = heatmap.underlying || bias?.future_price || 0;
    const biasMap = new Map();
    for (const lv of bias?.position_map || []) biasMap.set(lv.strike, lv);

    const oiMap = seriesFrom(heatmap.strikes);
    const gammaMap = seriesFrom(gamma?.strikes || []);

    const sorted = Array.from(new Set([...oiMap.keys(), ...gammaMap.keys()]))
        .sort((a, b) => a - b);

    let totalGamma = 0;
    for (const v of gammaMap.values()) totalGamma += v.latest;

    const rows = [];
    let peakGamma = { strike: null, value: 0 };

    for (let i = 0; i < sorted.length; i++) {
        const strike = sorted[i];
        const oi = oiMap.get(strike) || { latest: 0, prevAvg: 0, delta: 0, deltaPct: 0 };
        const g = gammaMap.get(strike) || { latest: 0, prevAvg: 0, delta: 0, deltaPct: 0 };

        if (g.latest > peakGamma.value) peakGamma = { strike, value: g.latest };
        if (oi.latest < MIN_LATEST_OI && g.latest < MIN_LATEST_GAMMA) continue;

        const oiDom = dominanceAt(sorted, oiMap, i);
        const gDom = dominanceAt(sorted, gammaMap, i);
        const gammaShare = totalGamma > 0 ? g.latest / totalGamma : 0;

        const lv = biasMap.get(strike);
        const callOi = lv?.call_oi ?? null;
        const putOi = lv?.put_oi ?? null;
        const totalOi = lv?.total_oi ?? oi.latest;

        let side = 'mixed';
        if (callOi != null && putOi != null && (callOi + putOi) > 0) {
            const callShare = callOi / (callOi + putOi);
            if (callShare > 0.65) side = 'call';
            else if (callShare < 0.35) side = 'put';
        } else {
            side = strike > underlying ? 'call' : 'put';
        }

        const oiSub = subScore({ latest: oi.latest, deltaPct: oi.deltaPct, dominance: oiDom }, 14);
        const gammaSub = subScore({ latest: g.latest, deltaPct: g.deltaPct, dominance: gDom }, 14);
        const bothDominant =
            isEmergingDominant(oiDom, oi.latest, MIN_LATEST_OI) &&
            isEmergingDominant(gDom, g.latest, MIN_LATEST_GAMMA);
        const score = (oiSub + GAMMA_BLEND * gammaSub) * (bothDominant ? PIN_AGREE_BOOST : 1.0);

        rows.push({
            strike,
            latest: oi.latest,
            prevAvg: oi.prevAvg,
            delta: oi.delta,
            deltaPct: oi.deltaPct,
            dominance: oiDom,
            gamma: g.latest,
            gammaPrevAvg: g.prevAvg,
            gammaDeltaPct: g.deltaPct,
            gammaDominance: gDom,
            gammaShare,
            hasGamma: g.latest >= MIN_LATEST_GAMMA,
            bothDominant,
            oiSub,
            gammaSub,
            totalOi,
            callOi,
            putOi,
            side,
            tag: classifyTag({ prevAvg: oi.prevAvg, latest: oi.latest, deltaPct: oi.deltaPct, dominance: oiDom }),
            gammaTag: classifyGammaTag({ gLatest: g.latest, gDeltaPct: g.deltaPct, gDominance: gDom }),
            score,
            distance: underlying > 0 ? strike - underlying : 0,
            above: underlying > 0 ? strike > underlying : false,
            fromBias: !!lv
        });
    }

    rows.sort((a, b) => b.score - a.score);
    return { underlying, rows, totalGamma, peakGamma };
}

function sideWeight(above, side) {
    if ((above && side === 'call') || (!above && side === 'put')) return 1.0;   // wall faces price
    if ((above && side === 'put') || (!above && side === 'call')) return 0.5;
    return 0.8;
}

/**
 * Per-contract analysis (preserved for unit tests / debug use).
 */
export function analyzeConviction({ bias, heatmap, gamma }) {
    const computed = computeStrikeRows({ bias, heatmap, gamma });
    if (!computed) return null;
    const { underlying, rows } = computed;

    let bullish = 0, bearish = 0;
    for (const r of rows) {
        if (r.score < HIGH_CONVICTION_GATE) continue;
        const weight = r.score * sideWeight(r.above, r.side);
        if (r.above) bearish += weight;
        else bullish += weight;
    }
    const total = bullish + bearish;
    const score = total > 0 ? ((bullish - bearish) / total) * 100 : 0;
    return {
        contract: heatmap.contract || bias?.contract || '',
        underlying,
        rows: rows.slice(0, 24),
        summary: { bullish, bearish, verdict: labelFromScore(score), score, count: rows.filter((r) => r.score >= HIGH_CONVICTION_GATE).length },
        maxScore: rows[0]?.score || 0
    };
}

function labelFromScore(score) {
    if (score >= 25) return 'bullish';
    if (score >= 8) return 'lean_bullish';
    if (score <= -25) return 'bearish';
    if (score <= -8) return 'lean_bearish';
    return 'neutral';
}

function verdictSign(label) {
    if (label === 'bullish' || label === 'lean_bullish') return 1;
    if (label === 'bearish' || label === 'lean_bearish') return -1;
    return 0;
}

/**
 * Aggregate the three layers across all available contracts.
 *
 * @param {{ contractsData: Array<{ key: string, dte: number, bias: any, heatmap: any, gamma: any }> }} params
 */
export function analyzeConvictionMulti({ contractsData }) {
    if (!contractsData || contractsData.length === 0) return null;

    // 1. Per-contract analysis
    const perTenor = contractsData
        .map((c) => {
            const computed = computeStrikeRows({ bias: c.bias, heatmap: c.heatmap, gamma: c.gamma });
            if (!computed) return null;
            let bullish = 0, bearish = 0;
            for (const r of computed.rows) {
                if (r.score < HIGH_CONVICTION_GATE) continue;
                const w = r.score * sideWeight(r.above, r.side);
                if (r.above) bearish += w; else bullish += w;
            }
            const total = bullish + bearish;
            const bScore = total > 0 ? ((bullish - bearish) / total) * 100 : 0;
            const sb = c.bias?.position_bias || null;
            return {
                key: c.key,
                dte: c.dte ?? c.bias?.dte ?? null,
                contract: c.heatmap?.contract || c.bias?.contract || '',
                underlying: computed.underlying,
                rows: computed.rows,
                totalGamma: computed.totalGamma,
                peakGamma: computed.peakGamma,
                hasGamma: computed.totalGamma > 0,
                bullish,
                bearish,
                biasScore: bScore,
                verdict: labelFromScore(bScore),
                // server-side authoritative read (with drivers), passed through
                serverScore: sb && Number.isFinite(sb.score) ? sb.score : null,
                serverLabel: sb?.label || null,
                serverConfidence: c.bias?.confidence || null
            };
        })
        .filter(Boolean);

    if (perTenor.length === 0) return null;

    const anyGamma = perTenor.some((t) => t.hasGamma);

    // Use freshest underlying we have (prefer earliest tenor / smallest DTE)
    const sortedByDte = [...perTenor].sort((a, b) => (a.dte ?? 99) - (b.dte ?? 99));
    const underlying = sortedByDte[0]?.underlying || 0;

    // 2. Strike-level aggregation across tenors
    const strikeMap = new Map();
    for (const t of perTenor) {
        for (const r of t.rows) {
            if (!strikeMap.has(r.strike)) {
                strikeMap.set(r.strike, {
                    strike: r.strike,
                    tenors: {},
                    tenorCount: 0,
                    totalOiSum: 0,
                    scoreSum: 0,
                    maxDominance: 0,
                    growthSum: 0,
                    growthN: 0,
                    gammaSum: 0,
                    gammaShareSum: 0,
                    maxGammaDominance: 0,
                    gammaGrowthSum: 0,
                    gammaGrowthN: 0,
                    gammaTenorCount: 0,
                    callOiSum: 0,
                    putOiSum: 0,
                    sideVotes: { call: 0, put: 0, mixed: 0 },
                    tags: new Set(),
                    gammaTags: new Set()
                });
            }
            const agg = strikeMap.get(r.strike);
            agg.tenors[t.key] = r;
            agg.tenorCount += 1;
            agg.totalOiSum += r.latest;
            agg.scoreSum += r.score;
            agg.maxDominance = Math.max(agg.maxDominance, Number.isFinite(r.dominance) ? r.dominance : 999);
            if (Number.isFinite(r.deltaPct)) { agg.growthSum += r.deltaPct; agg.growthN += 1; }
            agg.gammaSum += r.gamma;
            agg.gammaShareSum += r.gammaShare;
            if (r.hasGamma) agg.gammaTenorCount += 1;
            agg.maxGammaDominance = Math.max(agg.maxGammaDominance, Number.isFinite(r.gammaDominance) ? r.gammaDominance : 999);
            if (Number.isFinite(r.gammaDeltaPct)) { agg.gammaGrowthSum += r.gammaDeltaPct; agg.gammaGrowthN += 1; }
            agg.sideVotes[r.side] = (agg.sideVotes[r.side] || 0) + 1;
            if (r.callOi != null) agg.callOiSum += r.callOi;
            if (r.putOi != null) agg.putOiSum += r.putOi;
            agg.tags.add(r.tag);
            if (r.gammaTag !== 'none') agg.gammaTags.add(r.gammaTag);
        }
    }

    const walls = [];
    let gammaAbove = 0, gammaBelow = 0, gammaTotal = 0;
    for (const agg of strikeMap.values()) {
        const above = underlying > 0 ? agg.strike > underlying : false;
        let side = 'mixed';
        const totalSplit = agg.callOiSum + agg.putOiSum;
        if (totalSplit > 0) {
            const callShare = agg.callOiSum / totalSplit;
            if (callShare > 0.65) side = 'call';
            else if (callShare < 0.35) side = 'put';
        } else {
            side = above ? 'call' : 'put';
        }

        // sqrt boost rewards multi-tenor agreement sub-linearly
        const boost = Math.sqrt(agg.tenorCount);
        const aggregateScore = agg.scoreSum * boost;
        const isPin = agg.gammaTags.has('pin') || agg.maxGammaDominance >= DOMINANCE_STRONG;

        gammaTotal += agg.gammaSum;
        if (above) gammaAbove += agg.gammaSum; else gammaBelow += agg.gammaSum;

        walls.push({
            strike: agg.strike,
            tenors: agg.tenors,
            tenorCount: agg.tenorCount,
            totalOiSum: agg.totalOiSum,
            scoreSum: agg.scoreSum,
            aggregateScore,
            maxDominance: agg.maxDominance,
            avgGrowthPct: agg.growthN > 0 ? agg.growthSum / agg.growthN : null,
            gammaSum: agg.gammaSum,
            gammaShareSum: agg.gammaShareSum,
            maxGammaDominance: agg.maxGammaDominance,
            avgGammaGrowthPct: agg.gammaGrowthN > 0 ? agg.gammaGrowthSum / agg.gammaGrowthN : null,
            gammaTenorCount: agg.gammaTenorCount,
            isPin,
            callOiSum: agg.callOiSum,
            putOiSum: agg.putOiSum,
            side,
            above,
            distance: underlying > 0 ? agg.strike - underlying : 0,
            tags: Array.from(agg.tags),
            gammaTags: Array.from(agg.gammaTags)
        });
    }
    walls.sort((a, b) => b.aggregateScore - a.aggregateScore);

    // 3. Support / Resistance clusters — top-N strong walls each side of price
    const strongBelow = walls.filter((w) => !w.above && w.aggregateScore >= AGG_GATE);
    const strongAbove = walls.filter((w) => w.above && w.aggregateScore >= AGG_GATE);
    const support = strongBelow.sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance)).slice(0, 5);
    const resistance = strongAbove.sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance)).slice(0, 5);

    // 4. Gamma pin map — where price is actually magnetised
    const pin = buildPin({ walls, underlying, gammaAbove, gammaBelow, gammaTotal });

    // 5. Directional reads
    //   (a) heuristic skew from OI/gamma wall geometry (clearly labelled in UI)
    let bullishAll = 0, bearishAll = 0;
    for (const w of walls) {
        if (w.aggregateScore < AGG_GATE) continue;
        const contribution = w.aggregateScore * sideWeight(w.above, w.side);
        if (w.above) bearishAll += contribution; else bullishAll += contribution;
    }
    const totalAll = bullishAll + bearishAll;
    const skewScore = totalAll > 0 ? ((bullishAll - bearishAll) / totalAll) * 100 : 0;
    const skewLabel = labelFromScore(skewScore);

    const skewSign = verdictSign(skewLabel);
    const agreeCount = skewSign === 0 ? 0 : perTenor.filter((t) => verdictSign(t.verdict) === skewSign).length;
    const totalTenors = perTenor.length;
    let confidence = 'low';
    if (totalTenors >= 3 && agreeCount === totalTenors) confidence = 'high';
    else if (totalTenors >= 3 && agreeCount === totalTenors - 1) confidence = 'medium';
    else if (totalTenors >= 2 && agreeCount === totalTenors) confidence = 'medium';

    //   (b) authoritative server model bias, DTE-weighted (near-term heavier)
    const modelBias = buildModelBias(perTenor);

    // 6. Insight bullets — lead with structure + gamma
    const insights = buildInsights({
        skewSign, agreeCount, totalTenors, confidence,
        resistance, support, bullishAll, bearishAll, pin, anyGamma, perTenor, modelBias, underlying
    });

    return {
        underlying,
        anyGamma,
        tenorBias: perTenor.map((t) => ({
            key: t.key,
            dte: t.dte,
            contract: t.contract,
            verdict: t.verdict,
            score: t.biasScore,
            bullish: t.bullish,
            bearish: t.bearish,
            rowCount: t.rows.length,
            serverLabel: t.serverLabel,
            serverScore: t.serverScore
        })),
        walls: walls.slice(0, TOP_AGG_ROWS),
        support,
        resistance,
        pin,
        modelBias,
        // `verdict` kept for binding stability — it is the HEURISTIC skew, surfaced
        // in the UI as "Positioning Skew", not as a trade call.
        verdict: {
            label: skewLabel,
            score: skewScore,
            confidence,
            agreement: agreeCount,
            totalTenors,
            bullish: bullishAll,
            bearish: bearishAll
        },
        insights,
        tenorOrder: perTenor.map((t) => t.key)
    };
}

function buildPin({ walls, underlying, gammaAbove, gammaBelow, gammaTotal }) {
    if (gammaTotal <= 0) return null;
    // Peak gamma strike across tenors = the primary magnet.
    let peak = null;
    for (const w of walls) {
        if (!peak || w.gammaSum > peak.gammaSum) peak = w;
    }
    const skew = ((gammaBelow - gammaAbove) / gammaTotal) * 100; // + => gamma-heavy below price
    // Nearest meaningful gamma wall to spot (used as the immediate pin level).
    const gammaWalls = walls
        .filter((w) => w.gammaSum > 0 && (w.isPin || w.gammaSum >= (peak?.gammaSum || 0) * 0.25))
        .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance));
    const nearest = gammaWalls[0] || null;
    return {
        peakStrike: peak?.strike ?? null,
        peakGamma: peak?.gammaSum ?? 0,
        peakAbove: peak ? peak.above : false,
        peakDistance: peak?.distance ?? null,
        gammaAbove,
        gammaBelow,
        gammaTotal,
        skew,
        nearest: nearest
            ? { strike: nearest.strike, distance: nearest.distance, gamma: nearest.gammaSum, above: nearest.above }
            : null
    };
}

function buildModelBias(perTenor) {
    const withServer = perTenor.filter((t) => t.serverScore != null);
    if (withServer.length === 0) return null;
    let wsum = 0, wgt = 0;
    for (const t of withServer) {
        const w = 1 / (1 + Math.max(0, t.dte ?? 0)); // near-term weighted heavier
        wsum += t.serverScore * w;
        wgt += w;
    }
    const score = wgt > 0 ? wsum / wgt : 0;
    return {
        score,
        label: labelFromScore(score),
        perTenor: withServer.map((t) => ({ key: t.key, dte: t.dte, label: t.serverLabel, score: t.serverScore }))
    };
}

function buildInsights({ skewSign, agreeCount, totalTenors, confidence, resistance, support, bullishAll, bearishAll, pin, anyGamma, modelBias, underlying }) {
    const insights = [];

    // Lead with gamma pin — the mechanism that makes walls actually hold.
    if (pin && pin.peakStrike != null && anyGamma) {
        const side = pin.peakAbove ? 'above' : 'below';
        const dist = Math.abs(pin.peakDistance ?? 0);
        insights.push(
            `Primary gamma pin ${pin.peakStrike} (${Math.round(pin.peakGamma)} γ) sits ${dist.toFixed(0)}pts ${side} spot — strongest magnet/level.`
        );
        if (Math.abs(pin.skew) >= 25) {
            const dir = pin.skew > 0 ? 'below' : 'above';
            const role = pin.skew > 0 ? 'downside support is the harder wall' : 'upside is the harder ceiling';
            insights.push(`Gamma is ${Math.round(Math.abs(pin.skew))}% concentrated ${dir} price — ${role}.`);
        }
    } else if (!anyGamma) {
        insights.push('Gamma layer unavailable — walls ranked on OI + growth only (pin strength unknown).');
    }

    if (resistance.length > 0) {
        const top = resistance[0];
        const cluster = resistance.length > 1
            ? `${resistance[0].strike}–${resistance[resistance.length - 1].strike}`
            : `${top.strike}`;
        const pinTag = top.isPin ? ', gamma-pinned' : '';
        insights.push(`Resistance ${cluster} — top ${top.strike} in ${top.tenorCount} tenors, ${Math.round(top.totalOiSum)} OI${pinTag}.`);
    }
    if (support.length > 0) {
        const top = support[0];
        const cluster = support.length > 1
            ? `${support[support.length - 1].strike}–${support[0].strike}`
            : `${top.strike}`;
        const pinTag = top.isPin ? ', gamma-pinned' : '';
        insights.push(`Support ${cluster} — top ${top.strike} in ${top.tenorCount} tenors, ${Math.round(top.totalOiSum)} OI${pinTag}.`);
    }

    // Authoritative model bias (server), separate from the geometric skew.
    if (modelBias) {
        insights.push(`Model bias (server): ${modelBias.label.replace('lean_', 'lean ')} (${modelBias.score.toFixed(0)}), DTE-weighted across tenors.`);
    }

    // Skew text — strength asymmetry of the wall geometry (heuristic).
    if (bullishAll > 0 || bearishAll > 0) {
        const ratio = Math.max(bullishAll, bearishAll) / Math.max(1, Math.min(bullishAll, bearishAll));
        if (ratio > 2 && bearishAll > bullishAll) {
            insights.push('Skew (heuristic): resistance walls outweigh support by >2×.');
        } else if (ratio > 2 && bullishAll > bearishAll) {
            insights.push('Skew (heuristic): support walls outweigh resistance by >2×.');
        }
    }

    if (skewSign !== 0) {
        const dirText = skewSign > 0 ? 'support-heavy' : 'resistance-heavy';
        insights.push(`Wall geometry leans ${dirText} — ${agreeCount}/${totalTenors} tenors agree (${confidence}).`);
    } else {
        insights.push(`Wall geometry balanced across ${totalTenors} tenors — no dominant side.`);
    }

    return insights;
}

export const TAG_META = {
    growing_wall:  { label: 'Growing Wall',  tone: 'mag',   description: 'Dominant strike with rising OI' },
    fresh:         { label: 'Fresh',         tone: 'warn',  description: 'New position — prior OI ~ 0' },
    emerging:      { label: 'Emerging',      tone: 'warn',  description: 'Sharp OI growth, becoming dominant' },
    established:   { label: 'Established',   tone: 'up',    description: 'Dominant wall, stable OI' },
    building:      { label: 'Building',      tone: 'up',    description: 'OI rising but not yet dominant' },
    fading:        { label: 'Fading',        tone: 'down',  description: 'OI declining at a sizeable strike' },
    normal:        { label: 'Normal',        tone: 'muted', description: '' }
};

export const GAMMA_TAG_META = {
    pin:           { label: 'Pin',           tone: 'mag',   description: 'Dominant gamma — strong magnet/pin' },
    pin_building:  { label: 'Pin Building',  tone: 'warn',  description: 'Gamma rising and concentrating' },
    gamma:         { label: 'Gamma',         tone: 'mag',   description: 'Notable gamma vs neighbors' },
    none:          { label: '',              tone: 'muted', description: '' }
};

export const VERDICT_META = {
    bullish:       { label: 'Support-heavy', tone: 'up'    },
    lean_bullish:  { label: 'Lean Support',  tone: 'up'    },
    neutral:       { label: 'Balanced',      tone: 'muted' },
    lean_bearish:  { label: 'Lean Resist.',  tone: 'down'  },
    bearish:       { label: 'Resist.-heavy', tone: 'down'  }
};

// Authoritative directional labels (server position_bias) keep the trading words.
export const BIAS_META = {
    bullish:       { label: 'Bullish',       tone: 'up'    },
    lean_bullish:  { label: 'Lean Bullish',  tone: 'up'    },
    neutral:       { label: 'Neutral',       tone: 'muted' },
    lean_bearish:  { label: 'Lean Bearish',  tone: 'down'  },
    bearish:       { label: 'Bearish',       tone: 'down'  }
};
