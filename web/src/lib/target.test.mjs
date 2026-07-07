import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTarget, touchProb } from './target.js';

function strategy() {
    return {
        future_price: 4400,
        directional_bias: { label: 'neutral' },
        regime: { regime: 'mixed' },
        expected_range: {
            anchor_price: 4400,
            current_price: 4400,
            future_price: 4400,
            expected_move: 50,
            expected_move_1d: 50,
            day_high_est: 4450,
            day_low_est: 4350,
            bands_1d: {
                plus1: 4450,
                minus1: 4350,
                plus2: 4500,
                minus2: 4300,
                plus3: 4550,
                minus3: 4250,
            },
            price_sd_from_anchor: 0,
        },
    };
}

test('buildTarget keeps SD bands fixed when live price changes', () => {
    const atAnchor = buildTarget(strategy(), 'gc', 4400);
    const liveHigher = buildTarget(strategy(), 'gc', 4425);

    assert.equal(atAnchor.em, 50);
    assert.equal(liveHigher.em, 50);
    assert.equal(atAnchor.dayHigh, 4450);
    assert.equal(liveHigher.dayHigh, 4450);
    assert.equal(atAnchor.dayLow, 4350);
    assert.equal(liveHigher.dayLow, 4350);
    assert.equal(atAnchor.ladder.find((row) => row.side === 'above' && row.k === 1).price, 4450);
    assert.equal(liveHigher.ladder.find((row) => row.side === 'above' && row.k === 1).price, 4450);
});

test('buildTarget updates SD location and remaining distance from live price', () => {
    const t = buildTarget(strategy(), 'gc', 4425);
    const up = t.targets.find((row) => row.side === 'above');

    assert.equal(t.anchorPrice, 4400);
    assert.equal(t.price, 4425);
    assert.equal(t.currentSd, 0.5);
    assert.equal(t.priceSdFromAnchor, 0.5);
    assert.equal(up.tpPrice, 4450);
    assert.equal(up.dist, 25);
    assert.equal(up.prob, touchProb(0.5));
});

test('buildTarget marks an anchored target as touched without moving it', () => {
    const t = buildTarget(strategy(), 'gc', 4460);
    const up = t.targets.find((row) => row.side === 'above');

    assert.equal(up.tpPrice, 4450);
    assert.equal(up.dist, 0);
    assert.equal(up.touched, true);
    assert.equal(up.prob, 1);
});
