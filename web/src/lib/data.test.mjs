import assert from 'node:assert/strict';
import test from 'node:test';

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return data; },
        async text() { return JSON.stringify(data); }
    };
}

function textResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return JSON.parse(data); },
        async text() { return data; }
    };
}

test('position-bias requests coalesce and keep the last good expected range', { concurrency: false }, async () => {
    const calls = [];
    let failExpectedRange = false;
    globalThis.fetch = async (input) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.searchParams.get('path') || url.pathname;
        calls.push(path);
        await new Promise((resolve) => setTimeout(resolve, 5));

        if (path.endsWith('expected_range.json')) {
            return failExpectedRange
                ? jsonResponse({}, 503)
                : jsonResponse({ marker: 'last-good-range', tenors: [] });
        }
        return jsonResponse({ contract_key: path.match(/(current|tomorrow|friday|monthly)/)?.[1] || 'current' });
    };

    const data = await import(`./data.js?position-cache=${Date.now()}`);
    const [first, second] = await Promise.all([
        data.fetchPositionBias('gc'),
        data.fetchPositionBias('gc')
    ]);

    assert.strictEqual(first, second);
    assert.equal(first.contracts.length, 4);
    assert.equal(first.expectedRange.marker, 'last-good-range');
    assert.equal(calls.length, 5, 'four contracts plus one expected-range request should be shared');

    failExpectedRange = true;
    const refreshed = await data.fetchPositionBias('gc', { force: true });
    assert.equal(refreshed.expectedRange.marker, 'last-good-range');
});

test('concurrent OI data reads share one request', { concurrency: false }, async () => {
    let calls = 0;
    const oiText = [
        'Option Contract: Test FutPrc: 4100 Vol: 0.25',
        'Strike,Call,Put,Vol Settle',
        '4000,10,20,0.30',
        '4100,15,25,0.28'
    ].join('\n');

    globalThis.fetch = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return textResponse(oiText);
    };

    const data = await import(`./data.js?oi-cache=${Date.now()}`);
    const [first, second] = await Promise.all([
        data.fetchOIData('gc', 'current'),
        data.fetchOIData('gc', 'current')
    ]);

    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    assert.equal(first.strikes.length, 2);
});
