// Cross-reference position-bias snapshot with OI-heatmap time-series to surface
// "conviction" — strikes whose wall stature is backed by clear OI growth or
// outsized dominance vs neighbors. Pure functions, no Svelte deps.

const NEIGHBOR_WINDOW = 10;       // strikes on each side for dominance baseline
const MIN_LATEST_OI = 5;          // ignore noise below this absolute OI
const FRESH_BASELINE_MAX = 2;     // prev_avg at/below this → "fresh" position
const GROWING_DELTA_PCT = 0.5;    // +50% vs prior days
const STRONG_DELTA_PCT = 2.0;     // +200%
const DOMINANCE_STRONG = 3;       // 3x neighbors → established wall
const DOMINANCE_EMERGING = 1.5;   // 1.5x neighbors → emerging
const FADING_DELTA_PCT = -0.3;    // -30%
const TOP_N = 24;                 // table rows
const HIGH_CONVICTION_THRESHOLD = 55; // composite score gate for net-bias sum

function firstNonNull(values) {
    if (!Array.isArray(values)) return null;
    for (const v of values) {
        if (v != null && Number.isFinite(v)) return v;
    }
    return null;
}

function avgNonNull(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    let sum = 0;
    let n = 0;
    for (const v of values) {
        if (v != null && Number.isFinite(v)) {
            sum += v;
            n += 1;
        }
    }
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

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute a per-strike conviction signal table from heatmap + position bias.
 *
 * @param {{ bias: any, heatmap: any }} params
 * @returns {null | {
 *   contract: string,
 *   underlying: number,
 *   rows: Array<any>,
 *   summary: { bullish: number, bearish: number, verdict: string, score: number, count: number },
 *   maxScore: number
 * }}
 */
export function analyzeConviction({ bias, heatmap }) {
    if (!heatmap?.strikes?.length) return null;

    const underlying = heatmap.underlying || bias?.future_price || 0;
    const biasMap = new Map();
    for (const lv of bias?.position_map || []) {
        biasMap.set(lv.strike, lv);
    }

    // Precompute per-strike rollups so we can do neighbor lookups in one pass.
    const computed = heatmap.strikes.map((s) => {
        const values = s.values || [];
        const latest = firstNonNull(values);
        const tail = values.slice(1);
        const prevAvg = avgNonNull(tail);
        const baseline = prevAvg != null ? prevAvg : 0;
        const delta = (latest ?? 0) - baseline;
        const deltaPct = baseline > 0 ? delta / baseline : (latest > 0 ? Infinity : 0);
        return {
            strike: s.strike,
            latest: latest ?? 0,
            prevAvg: baseline,
            delta,
            deltaPct
        };
    });

    // Dominance: latest vs median of neighboring strikes' latest OI
    // (window excludes the strike itself).
    const decorated = computed.map((row, idx) => {
        const lo = Math.max(0, idx - NEIGHBOR_WINDOW);
        const hi = Math.min(computed.length, idx + NEIGHBOR_WINDOW + 1);
        const neighbors = [];
        for (let i = lo; i < hi; i++) {
            if (i !== idx) neighbors.push(computed[i].latest);
        }
        const med = medianNonZero(neighbors);
        const dominance = med > 0 ? row.latest / med : (row.latest > 0 ? Infinity : 0);
        return { ...row, dominance };
    });

    // Filter, classify, score
    const rows = [];
    for (const r of decorated) {
        if (r.latest < MIN_LATEST_OI) continue;
        const biasLv = biasMap.get(r.strike);
        const callOi = biasLv?.call_oi ?? null;
        const putOi = biasLv?.put_oi ?? null;
        const totalOi = biasLv?.total_oi ?? r.latest;
        const distance = underlying > 0 ? r.strike - underlying : 0;
        const above = distance > 0;

        // Determine bias side: prefer call/put split from PositionBias.
        // If absent, fall back to position relative to underlying.
        let side = 'mixed';
        if (callOi != null && putOi != null) {
            const total = callOi + putOi;
            if (total > 0) {
                const callShare = callOi / total;
                if (callShare > 0.65) side = 'call';
                else if (callShare < 0.35) side = 'put';
                else side = 'mixed';
            }
        } else {
            side = above ? 'call' : 'put';
        }

        // Classification tag
        let tag = 'normal';
        const isFresh = r.prevAvg <= FRESH_BASELINE_MAX && r.latest >= 3 * MIN_LATEST_OI;
        const isGrowing = r.deltaPct >= GROWING_DELTA_PCT && Number.isFinite(r.deltaPct);
        const isStrongGrowth = r.deltaPct >= STRONG_DELTA_PCT || !Number.isFinite(r.deltaPct);
        const isFading = r.deltaPct <= FADING_DELTA_PCT;
        const isDominant = r.dominance >= DOMINANCE_STRONG || !Number.isFinite(r.dominance);
        const isEmergingDom = r.dominance >= DOMINANCE_EMERGING;

        if (isDominant && isGrowing) tag = 'growing_wall';
        else if (isFresh && isEmergingDom) tag = 'fresh';
        else if (isStrongGrowth && isEmergingDom) tag = 'emerging';
        else if (isDominant) tag = 'established';
        else if (isFading && isEmergingDom) tag = 'fading';
        else if (isGrowing) tag = 'building';

        // Composite score: log-magnitude × growth × dominance.
        const magScore = Math.log10(Math.max(r.latest, 1)) * 14;            // ~0..70
        const growthScore = clamp(
            Number.isFinite(r.deltaPct) ? r.deltaPct * 12 : 36,             // cap inf-growth contribution
            -25, 36
        );
        const domScore = clamp(
            Number.isFinite(r.dominance) ? (r.dominance - 1) * 6 : 30,
            -10, 30
        );
        const score = Math.max(0, magScore + growthScore + domScore);

        rows.push({
            strike: r.strike,
            latest: r.latest,
            prevAvg: r.prevAvg,
            delta: r.delta,
            deltaPct: r.deltaPct,
            dominance: r.dominance,
            totalOi,
            callOi,
            putOi,
            side,
            tag,
            score,
            distance,
            above,
            fromBias: !!biasLv
        });
    }

    rows.sort((a, b) => b.score - a.score);
    const top = rows.slice(0, TOP_N);

    // Net bias: sum scores on each side from rows that pass the conviction gate.
    // Position relative to price drives the support/resistance read (matches how
    // PositionBias frames the "position_pressure" driver). Side label below
    // refines weight only when it agrees with position.
    let bullish = 0;
    let bearish = 0;
    for (const r of rows) {
        if (r.score < HIGH_CONVICTION_THRESHOLD) continue;
        const weight = r.score * (
            // amplify when side aligns with position (put + below, call + above),
            // dampen when it contradicts (put above, call below)
            (r.above && r.side === 'call') || (!r.above && r.side === 'put') ? 1.0 :
            (r.above && r.side === 'put') || (!r.above && r.side === 'call') ? 0.5 :
            0.8
        );
        if (r.above) bearish += weight;        // wall above price = resistance
        else if (r.strike < underlying) bullish += weight; // wall below = support
    }
    const total = bullish + bearish;
    const score = total > 0 ? ((bullish - bearish) / total) * 100 : 0;
    let verdict = 'neutral';
    if (score >= 25) verdict = 'bullish';
    else if (score >= 8) verdict = 'lean_bullish';
    else if (score <= -25) verdict = 'bearish';
    else if (score <= -8) verdict = 'lean_bearish';

    const maxScore = top.length > 0 ? top[0].score : 0;

    return {
        contract: heatmap.contract || bias?.contract || '',
        underlying,
        rows: top,
        summary: {
            bullish,
            bearish,
            verdict,
            score,
            count: rows.filter((r) => r.score >= HIGH_CONVICTION_THRESHOLD).length
        },
        maxScore
    };
}

export const TAG_META = {
    growing_wall:  { label: 'Growing Wall',  tone: 'mag',  description: 'Dominant strike with rising OI' },
    fresh:         { label: 'Fresh',         tone: 'warn', description: 'New position — prior OI ~ 0' },
    emerging:      { label: 'Emerging',      tone: 'warn', description: 'Sharp OI growth, becoming dominant' },
    established:   { label: 'Established',   tone: 'up',   description: 'Dominant wall, stable OI' },
    building:      { label: 'Building',      tone: 'up',   description: 'OI rising but not yet dominant' },
    fading:        { label: 'Fading',        tone: 'down', description: 'OI declining at a sizeable strike' },
    normal:        { label: 'Normal',        tone: 'muted', description: '' }
};
