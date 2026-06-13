// Cloudflare Worker entry — serves the static SvelteKit build via the ASSETS
// binding and a same-origin live-price API at /api/price. Same origin means the
// browser fetch is never CORS-blocked (Yahoo's endpoint sends no CORS header, so
// it can't be called from the browser directly). Implied vol still comes from
// the 15-min scrape; only the futures PRICE is fetched live here.
//
// Free on the Workers plan: static-asset requests are free/unlimited; Worker
// invocations (only /api/price hits the script) are 100k/day free.

const ALLOWED = new Set(['GC=F', 'NQ=F']);

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json',
            // CF edge + browser coalesce polls -> hit Yahoo ~1x/15s (dodges 429).
            'cache-control': 'public, max-age=15',
        },
    });
}

async function price(request) {
    const sym = new URL(request.url).searchParams.get('sym') || 'GC=F';
    if (!ALLOWED.has(sym)) return json({ error: 'bad sym' }, 400);
    try {
        const upstream = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
            {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                cf: { cacheTtl: 15, cacheEverything: true },
            }
        );
        if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502);
        const j = await upstream.json();
        const m = j?.chart?.result?.[0]?.meta || {};
        return json({
            sym,
            price: m.regularMarketPrice ?? null,
            time: m.regularMarketTime ?? null,
            exch: m.fullExchangeName ?? null,
        });
    } catch (e) {
        return json({ error: String(e) }, 502);
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/api/price') return price(request);
        // Everything else: serve the static SvelteKit build.
        return env.ASSETS.fetch(request);
    },
};
