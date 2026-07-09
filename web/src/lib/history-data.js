import { biasHistoryApiUrl, biasHistorySliceUrl } from './config.js';

const SOFT_FETCH_RETRY_MS = 250;
const jsonLastGood = new Map();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonSoft(url, { retries = 1, useLastGood = false } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const res = await fetch(url, { cache: 'default' });
            if (res.ok) {
                const data = await res.json();
                if (useLastGood) jsonLastGood.set(url, data);
                return data;
            }
            lastError = new Error(`HTTP ${res.status}`);
        } catch (e) {
            lastError = e;
        }

        if (attempt < retries) {
            await delay(SOFT_FETCH_RETRY_MS * (attempt + 1));
        }
    }

    console.warn(`fetch failed: ${url}`, lastError);
    return useLastGood ? jsonLastGood.get(url) ?? null : null;
}

export async function fetchBiasHistory({ assetId = 'gc', contractKey = 'current' } = {}) {
    const data = await fetchJsonSoft(biasHistoryApiUrl(assetId, contractKey), {
        retries: 2,
        useLastGood: true
    }) || await fetchJsonSoft(biasHistorySliceUrl(assetId, contractKey), {
        retries: 2,
        useLastGood: true
    });
    if (!data) {
        return {
            load_error: true,
            error_message: 'Bias history could not be loaded. Keeping the last successful read if available.',
            records: []
        };
    }
    return {
        ...data,
        records: Array.isArray(data?.records) ? data.records : []
    };
}
