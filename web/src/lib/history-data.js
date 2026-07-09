import { biasHistoryApiUrl, biasHistoryLegacyApiUrl, biasHistorySliceUrl, biasHistoryUrl } from './config.js';

const SOFT_FETCH_RETRY_MS = 150;
const jsonLastGood = new Map();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheBustUrl(url) {
    const absolute = /^https?:\/\//.test(url);
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const parsed = new URL(url, base);
    parsed.searchParams.set('_', String(Date.now()));
    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function fetchJsonSoft(url, {
    retries = 1,
    useLastGood = false,
    cacheBust = false,
    cache = 'no-store',
    stopRetryStatuses = [400, 404, 502]
} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const requestUrl = cacheBust ? cacheBustUrl(url) : url;
        try {
            const res = await fetch(requestUrl, { cache });
            if (res.ok) {
                const data = await res.json();
                if (useLastGood) jsonLastGood.set(url, data);
                return data;
            }
            lastError = new Error(`HTTP ${res.status}`);
            if (stopRetryStatuses.includes(res.status)) break;
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
    const candidates = [
        biasHistoryApiUrl(assetId, contractKey),
        biasHistorySliceUrl(assetId, contractKey),
        biasHistoryLegacyApiUrl(),
        biasHistoryUrl()
    ];
    let data = null;
    for (const url of candidates) {
        data = await fetchJsonSoft(url, {
            retries: 1,
            useLastGood: true,
            cacheBust: url !== biasHistoryLegacyApiUrl()
        });
        if (data) break;
    }
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
