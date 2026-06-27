import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker.js';

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function withMockedFetch(mock, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        await fn();
    } finally {
        globalThis.fetch = original;
    }
}

function assertOneDayRange(snapshot) {
    const expectedMove = 60000 * 0.6 * Math.sqrt(1 / 365);
    assert.equal(snapshot.expected_range.atm_iv_pct, 60);
    assert.equal(snapshot.expected_range.atm_iv_pct_1d_basis, 60);
    assert.equal(snapshot.expected_range.horizon_days, 1);
    assert.ok(Math.abs(snapshot.expected_range.expected_move_1d - expectedMove) < 0.01);
    assert.equal(snapshot.oi_data.current.vol, 60);
}

test('Deribit crypto snapshot normalizes percent IV and interpolates ATM IV', async () => {
    const rows = [
        { instrument_name: 'BTC-25DEC30-59000-C', mark_iv: 50, underlying_price: 60000, estimated_delivery_price: 60000, open_interest: 10, volume: 1, volume_usd: 60000 },
        { instrument_name: 'BTC-25DEC30-59000-P', mark_iv: 40, underlying_price: 60000, estimated_delivery_price: 60000, open_interest: 10, volume: 1, volume_usd: 60000 },
        { instrument_name: 'BTC-25DEC30-61000-C', mark_iv: 70, underlying_price: 60000, estimated_delivery_price: 60000, open_interest: 10, volume: 1, volume_usd: 60000 },
        { instrument_name: 'BTC-25DEC30-61000-P', mark_iv: 80, underlying_price: 60000, estimated_delivery_price: 60000, open_interest: 10, volume: 1, volume_usd: 60000 },
    ];

    await withMockedFetch(async (input) => {
        const url = String(input);
        if (url.includes('/get_index_price')) return jsonResponse({ result: { index_price: 60000 } });
        if (url.includes('/get_book_summary_by_currency')) return jsonResponse({ result: rows });
        throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
        const response = await worker.fetch(new Request('https://example.test/api/crypto/snapshot?asset=btc&venue=deribit'), {});
        assert.equal(response.status, 200);
        assertOneDayRange(await response.json());
    });
});

test('OKX crypto snapshot keeps decimal IV units and interpolates ATM IV', async () => {
    const optionRows = [
        { instId: 'BTC-USD-301225-59000-C', markVol: '0.50', bidVol: '0.49', askVol: '0.51', fwdPx: '60000' },
        { instId: 'BTC-USD-301225-59000-P', markVol: '0.40', bidVol: '0.39', askVol: '0.41', fwdPx: '60000' },
        { instId: 'BTC-USD-301225-61000-C', markVol: '0.70', bidVol: '0.69', askVol: '0.71', fwdPx: '60000' },
        { instId: 'BTC-USD-301225-61000-P', markVol: '0.80', bidVol: '0.79', askVol: '0.81', fwdPx: '60000' },
    ];
    const oiRows = optionRows.map((row) => ({ instId: row.instId, oi: '10', oiCcy: '10', oiUsd: '600000' }));

    await withMockedFetch(async (input) => {
        const url = String(input);
        if (url.includes('/api/v5/market/ticker')) return jsonResponse({ code: '0', data: [{ last: '60000' }] });
        if (url.includes('/api/v5/public/funding-rate')) return jsonResponse({ code: '0', data: [{ fundingRate: '0.0001', nextFundingTime: '1924387200000', premium: '0' }] });
        if (url.includes('/api/v5/public/opt-summary')) return jsonResponse({ code: '0', data: optionRows });
        if (url.includes('/api/v5/public/open-interest') && url.includes('instType=OPTION')) return jsonResponse({ code: '0', data: oiRows });
        if (url.includes('/api/v5/public/open-interest') && url.includes('instType=SWAP')) return jsonResponse({ code: '0', data: [{ oi: '1', oiCcy: '1', oiUsd: '60000' }] });
        throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
        const response = await worker.fetch(new Request('https://example.test/api/crypto/snapshot?asset=btc&venue=okx'), {});
        assert.equal(response.status, 200);
        assertOneDayRange(await response.json());
    });
});
