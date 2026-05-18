// Cross-reference position-bias snapshot with OI-heatmap time-series to surface
// "conviction" — strikes whose wall stature is backed by clear OI growth or
// outsized dominance vs neighbors. Aggregates across all 4 expiries (current /
// tomorrow / friday / monthly) so multi-tenor agreement counts as high-confidence.
// Pure functions, no Svelte deps.

const NEIGHBOR_WINDOW = 10;       // strikes on each side for dominance baseline
const MIN_LATEST_OI = 5;          // ignore noise below this absolute OI
const FRESH_BASELINE_MAX = 2;
const GROWING_DELTA_PCT = 0.5;
const STRONG_DELTA_PCT = 2.0;
const DOMINANCE_STRONG = 3;
const DOMINANCE_EMERGING = 1.5;
const FADING_DELTA_PCT = -0.3;

// Score gates and tuning
const HIGH_CONVICTION_GATE = 55;  // per-contract score gate for tenor bias sum
const AGG_GATE = 90;              // aggregate score gate for cluster inclusion
const TOP_AGG_ROWS = 28;          // table size for multi-tenor wall list

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

function compositeScore({ latest, deltaPct, dominance }) {
    const magScore = Math.log10(Math.max(latest, 1)) * 14;
    const growthScore = clamp(
        Number.isFinite(deltaPct) ? deltaPct * 12 : 36,
        -25, 36
    );
    const domScore = clamp(
        Number.isFinite(dominance) ? (dominance - 1) * 6 : 30,
        -10, 30
    );
    return Math.max(0, magScore + growthScore + domScore);
}

/**
 * Compute every qualified strike row for one (bias, heatmap) pair.
 * Returns null when heatmap is missing.
 */
function computeStrikeRows({ bias, heatmap }) {
    if (!heatmap?.strikes?.length) return null;

    const underlying = heatmap.underlying || bias?.future_price || 0;
    const biasMap = new Map();
    for (const lv of bias?.position_map || []) biasMap.set(lv.strike, lv);

    const stage1 = heatmap.strikes.map((s) => {
        const values = s.values || [];
        const latest = firstNonNull(values) ?? 0;
        const prevAvg = avgNonNull(values.slice(1)) ?? 0;
        const delta = latest - prevAvg;
        const deltaPct = prevAvg > 0 ? delta / prevAvg : (latest > 0 ? Infinity : 0);
        return { strike: s.strike, latest, prevAvg, delta, deltaPct };
    });

    const rows = [];
    for (let i = 0; i < stage1.length; i++) {
        const r = stage1[i];
        if (r.latest < MIN_LATEST_OI) continue;

        const lo = Math.max(0, i - NEIGHBOR_WINDOW);
        const hi = Math.min(stage1.length, i + NEIGHBOR_WINDOW + 1);
        const neighbors = [];
        for (let j = lo; j < hi; j++) if (j !== i) neighbors.push(stage1[j].latest);
        const med = medianNonZero(neighbors);
        const dominance = med > 0 ? r.latest / med : (r.latest > 0 ? Infinity : 0);

        const biasLv = biasMap.get(r.strike);
        const callOi = biasLv?.call_oi ?? null;
        const putOi = biasLv?.put_oi ?? null;
        const totalOi = biasLv?.total_oi ?? r.latest;

        let side = 'mixed';
        if (callOi != null && putOi != null && (callOi + putOi) > 0) {
            const callShare = callOi / (callOi + putOi);
            if (callShare > 0.65) side = 'call';
            else if (callShare < 0.35) side = 'put';
        } else {
            side = r.strike > underlying ? 'call' : 'put';
        }

        const tag = classifyTag({ prevAvg: r.prevAvg, latest: r.latest, deltaPct: r.deltaPct, dominance });
        const score = compositeScore({ latest: r.latest, deltaPct: r.deltaPct, dominance });

        rows.push({
            strike: r.strike,
            latest: r.latest,
            prevAvg: r.prevAvg,
            delta: r.delta,
            deltaPct: r.deltaPct,
            dominance,
            totalOi,
            callOi,
            putOi,
            side,
            tag,
            score,
            distance: underlying > 0 ? r.strike - underlying : 0,
            above: underlying > 0 ? r.strike > underlying : false,
            fromBias: !!biasLv
        });
    }

    rows.sort((a, b) => b.score - a.score);
    return { underlying, rows };
}

/**
 * Per-contract conviction analysis (preserved for unit tests / debug use).
 */
export function analyzeConviction({ bias, heatmap }) {
    const computed = computeStrikeRows({ bias, heatmap });
    if (!computed) return null;
    const { underlying, rows } = computed;

    let bullish = 0, bearish = 0;
    for (const r of rows) {
        if (r.score < HIGH_CONVICTION_GATE) continue;
        const weight = r.score * (
            (r.above && r.side === 'call') || (!r.above && r.side === 'put') ? 1.0 :
            (r.above && r.side === 'put') || (!r.above && r.side === 'call') ? 0.5 :
            0.8
        );
        if (r.above) bearish += weight;
        else bullish += weight;
    }
    const total = bullish + bearish;
    const score = total > 0 ? ((bullish - bearish) / total) * 100 : 0;
    const verdict = labelFromScore(score);
    return {
        contract: heatmap.contract || bias?.contract || '',
        underlying,
        rows: rows.slice(0, 24),
        summary: { bullish, bearish, verdict, score, count: rows.filter((r) => r.score >= HIGH_CONVICTION_GATE).length },
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
 * Aggregate conviction across all available contracts.
 *
 * @param {{ contractsData: Array<{ key: string, dte: number, bias: any, heatmap: any }> }} params
 * @returns {null | {
 *   underlying: number,
 *   tenorBias: Array,
 *   walls: Array,
 *   support: Array, resistance: Array,
 *   verdict: { label: string, score: number, confidence: string, bullish: number, bearish: number, agreement: number, totalTenors: number },
 *   insights: string[]
 * }}
 */
export function analyzeConvictionMulti({ contractsData }) {
    if (!contractsData || contractsData.length === 0) return null;

    // 1. Per-contract analysis
    const perTenor = contractsData
        .map((c) => {
            const computed = computeStrikeRows({ bias: c.bias, heatmap: c.heatmap });
            if (!computed) return null;
            let bullish = 0, bearish = 0;
            for (const r of computed.rows) {
                if (r.score < HIGH_CONVICTION_GATE) continue;
                const w = r.score * (
                    (r.above && r.side === 'call') || (!r.above && r.side === 'put') ? 1.0 :
                    (r.above && r.side === 'put') || (!r.above && r.side === 'call') ? 0.5 :
                    0.8
                );
                if (r.above) bearish += w; else bullish += w;
            }
            const total = bullish + bearish;
            const bScore = total > 0 ? ((bullish - bearish) / total) * 100 : 0;
            return {
                key: c.key,
                dte: c.dte ?? c.bias?.dte ?? null,
                contract: c.heatmap?.contract || c.bias?.contract || '',
                underlying: computed.underlying,
                rows: computed.rows,
                bullish,
                bearish,
                biasScore: bScore,
                verdict: labelFromScore(bScore)
            };
        })
        .filter(Boolean);

    if (perTenor.length === 0) return null;

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
                    callOiSum: 0,
                    putOiSum: 0,
                    sideVotes: { call: 0, put: 0, mixed: 0 },
                    tags: new Set()
                });
            }
            const agg = strikeMap.get(r.strike);
            agg.tenors[t.key] = r;
            agg.tenorCount += 1;
            agg.totalOiSum += r.latest;
            agg.scoreSum += r.score;
            agg.maxDominance = Math.max(
                agg.maxDominance,
                Number.isFinite(r.dominance) ? r.dominance : 999
            );
            if (Number.isFinite(r.deltaPct)) { agg.growthSum += r.deltaPct; agg.growthN += 1; }
            agg.sideVotes[r.side] = (agg.sideVotes[r.side] || 0) + 1;
            if (r.callOi != null) agg.callOiSum += r.callOi;
            if (r.putOi != null) agg.putOiSum += r.putOi;
            agg.tags.add(r.tag);
        }
    }

    const walls = [];
    for (const agg of strikeMap.values()) {
        const above = underlying > 0 ? agg.strike > underlying : false;
        // Side resolution: prefer call/put split if either side dominates; otherwise position vs price.
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

        walls.push({
            strike: agg.strike,
            tenors: agg.tenors,
            tenorCount: agg.tenorCount,
            totalOiSum: agg.totalOiSum,
            scoreSum: agg.scoreSum,
            aggregateScore,
            maxDominance: agg.maxDominance,
            avgGrowthPct: agg.growthN > 0 ? agg.growthSum / agg.growthN : null,
            callOiSum: agg.callOiSum,
            putOiSum: agg.putOiSum,
            side,
            above,
            distance: underlying > 0 ? agg.strike - underlying : 0,
            tags: Array.from(agg.tags)
        });
    }
    walls.sort((a, b) => b.aggregateScore - a.aggregateScore);

    // 3. Support / Resistance clusters — top-N strong walls each side of price
    const strongBelow = walls.filter((w) => !w.above && w.aggregateScore >= AGG_GATE);
    const strongAbove = walls.filter((w) => w.above && w.aggregateScore >= AGG_GATE);

    const support = strongBelow
        .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
        .slice(0, 5);
    const resistance = strongAbove
        .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
        .slice(0, 5);

    // 4. Overall verdict — bullish/bearish weights aggregated from all qualified strikes
    let bullishAll = 0, bearishAll = 0;
    for (const w of walls) {
        if (w.aggregateScore < AGG_GATE) continue;
        const sideWeight = (
            (w.above && w.side === 'call') || (!w.above && w.side === 'put') ? 1.0 :
            (w.above && w.side === 'put') || (!w.above && w.side === 'call') ? 0.5 :
            0.8
        );
        const contribution = w.aggregateScore * sideWeight;
        if (w.above) bearishAll += contribution; else bullishAll += contribution;
    }
    const totalAll = bullishAll + bearishAll;
    const overallScore = totalAll > 0 ? ((bullishAll - bearishAll) / totalAll) * 100 : 0;
    const overallLabel = labelFromScore(overallScore);

    // Tenor agreement: how many tenors share the overall direction sign
    const overallSign = verdictSign(overallLabel);
    const agreeCount = overallSign === 0
        ? 0
        : perTenor.filter((t) => verdictSign(t.verdict) === overallSign).length;
    const totalTenors = perTenor.length;

    let confidence = 'low';
    if (totalTenors >= 3 && agreeCount === totalTenors) confidence = 'high';
    else if (totalTenors >= 3 && agreeCount === totalTenors - 1) confidence = 'medium';
    else if (totalTenors >= 2 && agreeCount === totalTenors) confidence = 'medium';

    // 5. Auto-generated insight bullets
    const insights = [];
    if (overallSign !== 0) {
        const dirText = overallSign > 0 ? 'bullish' : 'bearish';
        insights.push(`${agreeCount} of ${totalTenors} contracts align ${dirText} (${confidence} agreement).`);
    } else {
        insights.push(`Mixed: ${totalTenors} contracts show no dominant direction.`);
    }

    if (resistance.length > 0) {
        const top = resistance[0];
        const cluster = resistance.length > 1
            ? `${resistance[0].strike}–${resistance[resistance.length - 1].strike}`
            : `${top.strike}`;
        insights.push(
            `Resistance cluster ${cluster} — top strike ${top.strike} active in ${top.tenorCount}/${totalTenors} tenors, ${Math.round(top.totalOiSum)} aggregate OI.`
        );
    }
    if (support.length > 0) {
        const top = support[0];
        const cluster = support.length > 1
            ? `${support[support.length - 1].strike}–${support[0].strike}`
            : `${top.strike}`;
        insights.push(
            `Support cluster ${cluster} — top strike ${top.strike} active in ${top.tenorCount}/${totalTenors} tenors, ${Math.round(top.totalOiSum)} aggregate OI.`
        );
    }

    // Skew text — compare strength asymmetry
    if (bullishAll > 0 || bearishAll > 0) {
        const ratio = Math.max(bullishAll, bearishAll) / Math.max(1, Math.min(bullishAll, bearishAll));
        if (ratio > 2 && bearishAll > bullishAll) {
            insights.push('Skew: upside capped — resistance outweighs support by >2×.');
        } else if (ratio > 2 && bullishAll > bearishAll) {
            insights.push('Skew: downside protected — support outweighs resistance by >2×.');
        }
    }

    // Term-structure shift (e.g. near-term bearish, monthly bullish)
    if (totalTenors >= 2) {
        const byDte = [...perTenor].sort((a, b) => (a.dte ?? 99) - (b.dte ?? 99));
        const near = byDte[0];
        const far = byDte[byDte.length - 1];
        if (near && far && verdictSign(near.verdict) !== 0 && verdictSign(far.verdict) !== 0
            && verdictSign(near.verdict) !== verdictSign(far.verdict)) {
            insights.push(
                `Term-structure shift: near-term ${near.verdict.replace('lean_', 'lean ')} (${near.dte?.toFixed(1) || '?'} DTE) vs longer-dated ${far.verdict.replace('lean_', 'lean ')} (${far.dte?.toFixed(0) || '?'} DTE).`
            );
        }
    }

    return {
        underlying,
        tenorBias: perTenor.map((t) => ({
            key: t.key,
            dte: t.dte,
            contract: t.contract,
            verdict: t.verdict,
            score: t.biasScore,
            bullish: t.bullish,
            bearish: t.bearish,
            rowCount: t.rows.length
        })),
        walls: walls.slice(0, TOP_AGG_ROWS),
        support,
        resistance,
        verdict: {
            label: overallLabel,
            score: overallScore,
            confidence,
            agreement: agreeCount,
            totalTenors,
            bullish: bullishAll,
            bearish: bearishAll
        },
        insights,
        // expose tenor order for dot indicators
        tenorOrder: perTenor.map((t) => t.key)
    };
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

export const VERDICT_META = {
    bullish:       { label: 'Bullish',       tone: 'up'    },
    lean_bullish:  { label: 'Lean Bullish',  tone: 'up'    },
    neutral:       { label: 'Neutral',       tone: 'muted' },
    lean_bearish:  { label: 'Lean Bearish',  tone: 'down'  },
    bearish:       { label: 'Bearish',       tone: 'down'  }
};
