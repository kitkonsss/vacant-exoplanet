// Consolidated "today's target" math: turns daily_strategy.json into ONE plain
// read — how far price is likely to travel today, what TP to set, and the
// probability price reaches each level. Pure functions, no I/O.
//
// It reuses what the pipeline already computed (expected_move = 1 SD from the
// options IV smile, regime, directional bias, gamma/confluence walls) so the
// page needs no new data source — just a clearer synthesis of the existing one.
import { ASSET_PROFILES } from './config.js';

// Standard normal CDF — Zelen & Severo (A&S 7.1.26) rational approximation,
// max abs error ~7.5e-8. Good enough for displaying touch probabilities.
export function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
}

// Probability price TOUCHES a level k standard deviations away at some point in
// the horizon (reflection principle for driftless Brownian motion): 2·P(Z>k).
// Touch — not "close beyond" — is what fills a take-profit, and it's ~2× the
// close-beyond probability. Symmetric in k (we pass a magnitude).
export function touchProb(k) {
    if (!Number.isFinite(k)) return null;
    const p = 2 * (1 - normalCdf(Math.abs(k)));
    return Math.max(0, Math.min(1, p));
}

// TP sizing as a fraction of the 1 SD expected move, by regime. Ranging markets
// round-trip → take a small, high-probability target; trending markets follow
// through → aim wider and trail. Neutral sits in between.
function tpMultiplier(regime) {
    if (regime === 'trending') return 1.6;
    if (regime === 'range' || regime === 'ranging') return 0.6;
    return 1.0;
}

function dirFromBias(label) {
    if (!label) return 'neutral';
    if (label.includes('bull')) return 'long';
    if (label.includes('bear')) return 'short';
    return 'neutral';
}

// Collect candidate price magnets (walls) from the strongest aggregated sources
// the strategy already exposes: confluence levels (OI∩gamma∩round∩build) first,
// supplemented by the gamma-1pct nearest/major walls.
function collectWalls(strategy) {
    const walls = [];
    for (const c of strategy?.confluence_levels || []) {
        if (c?.level != null) walls.push({ price: c.level, label: `×${c.confluence ?? 0}`, strength: c.confluence ?? 0 });
    }
    const g = strategy?.gamma_1pct;
    for (const w of [g?.nearest_upside_wall, g?.major_upside_wall, g?.nearest_downside_wall, g?.major_downside_wall]) {
        if (w?.strike != null) walls.push({ price: w.strike, label: `γ${Math.round(w.gamma_1pct ?? 0)}`, strength: 2 });
    }
    return walls;
}

// Nearest wall on a side, ignoring any closer than `minDist` — a wall hugging
// the current price (e.g. the round number price is sitting on) isn't a
// meaningful target and would otherwise collapse the TP to ~0.
function nearestWall(walls, price, side, minDist = 0) {
    return (
        walls
            .filter((w) => (side === 'above' ? w.price - price >= minDist : price - w.price >= minDist))
            .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0] || null
    );
}

/**
 * Build the consolidated target read from a daily_strategy.json payload.
 * Returns null if the expected-move basis isn't available.
 *
 * `livePrice` (optional) is only the current marker. The SD grid stays anchored
 * to `expected_range.anchor_price` (or the scrape-time price for older payloads)
 * so the target levels do not chase price while the page is open.
 */
export function buildTarget(strategy, assetId = 'gc', livePrice = null) {
    const er = strategy?.expected_range;
    const scrapePrice = strategy?.future_price ?? er?.current_price ?? er?.future_price ?? null;
    const anchorPrice = er?.anchor_price ?? er?.future_price ?? scrapePrice;
    const baseEm = er?.expected_move ?? er?.expected_move_1d ?? null; // fixed 1 SD points at the anchor price
    if (!anchorPrice || !baseEm || baseEm <= 0) return null;

    const isLive = Number.isFinite(livePrice) && livePrice > 0;
    const price = isLive ? livePrice : (er?.current_price ?? scrapePrice ?? anchorPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    const em = baseEm;
    const currentSd = (price - anchorPrice) / em;

    const profile = ASSET_PROFILES[assetId] || {};
    const regime = strategy?.regime?.regime || 'neutral';
    const direction = dirFromBias(strategy?.directional_bias?.label);
    const k = tpMultiplier(regime);

    const walls = collectWalls(strategy);
    // Skip walls within ~1/3 of the expected move — too close to be a real target.
    const minWallDist = 0.33 * em;
    const wallUp = nearestWall(walls, price, 'above', minWallDist);
    const wallDown = nearestWall(walls, price, 'below', minWallDist);

    function bandLevel(side, multiple) {
        const key = `${side === 'above' ? 'plus' : 'minus'}${multiple}`;
        const fixedBand = er?.bands_1d?.[key];
        if (Number.isFinite(fixedBand)) return fixedBand;
        return side === 'above' ? anchorPrice + multiple * em : anchorPrice - multiple * em;
    }

    // Suggested TP per side, capped so we never target beyond the nearest wall.
    function tpForSide(side) {
        let tpPrice = bandLevel(side, k);
        const wall = side === 'above' ? wallUp : wallDown;
        let cappedBy = null;
        if (wall) {
            const wallDist = Math.abs(wall.price - price);
            const targetDist = side === 'above' ? tpPrice - price : price - tpPrice;
            if (targetDist > 0 && wallDist > 0 && wallDist < targetDist) {
                tpPrice = wall.price;
                cappedBy = wall;
            }
        }
        const rawDist = side === 'above' ? tpPrice - price : price - tpPrice;
        const touched = rawDist <= 0;
        const dist = Math.max(0, rawDist);
        return { side, dist, tpPrice, prob: touched ? 1 : touchProb(dist / em), cappedBy, touched };
    }

    const targets = [];
    if (direction === 'long' || direction === 'neutral') targets.push(tpForSide('above'));
    if (direction === 'short' || direction === 'neutral') targets.push(tpForSide('below'));

    // Probability ladder: 0.5 / 1 / 1.5 / 2 SD each side (above first, descending).
    const ladder = [];
    for (const m of [2, 1.5, 1, 0.5]) {
        const level = bandLevel('above', m);
        const dist = level - price;
        ladder.push({
            side: 'above',
            k: m,
            price: level,
            prob: dist <= 0 ? 1 : touchProb(dist / em),
            touched: dist <= 0,
            dist: Math.max(0, dist),
        });
    }
    for (const m of [0.5, 1, 1.5, 2]) {
        const level = bandLevel('below', m);
        const dist = price - level;
        ladder.push({
            side: 'below',
            k: m,
            price: level,
            prob: dist <= 0 ? 1 : touchProb(dist / em),
            touched: dist <= 0,
            dist: Math.max(0, dist),
        });
    }

    // How a habitual fixed TP scores TODAY (teaching the user's exact pain point).
    const fixedTp = profile.fixedTpRef ?? null;
    const fixedRef = fixedTp ? { dist: fixedTp, k: fixedTp / em, prob: touchProb(fixedTp / em) } : null;

    return {
        price,
        scrapePrice,
        anchorPrice,
        isLive,
        em,
        currentSd,
        priceSdFromAnchor: Number.isFinite(er?.price_sd_from_anchor) && !isLive ? er.price_sd_from_anchor : currentSd,
        unit: profile.unit || '',
        pointValueUsd: profile.pointValueUsd ?? null,
        microPointValueUsd: profile.microPointValueUsd ?? null,
        regime,
        direction,
        k,
        atmIvPct: er?.atm_iv_pct ?? null,
        atr: er?.atr ?? null,
        termShape: er?.term_structure?.shape ?? null,
        dayHigh: er?.day_high_est ?? bandLevel('above', 1),
        dayLow: er?.day_low_est ?? bandLevel('below', 1),
        wallUp,
        wallDown,
        targets,
        ladder,
        fixedRef,
    };
}
