// Cloudflare Pages Function — same-origin realtime price proxy.
//
// The dashboard is a static site; browsers can't read Yahoo's quote endpoint
// directly because Yahoo sends no Access-Control-Allow-Origin header. This
// function runs server-side (no CORS applies to server->server fetch) and is
// served from the SAME origin as the app (/api/price), so the browser fetch is
// same-origin and never blocked. Implied vol still comes from the 15-min
// scrape; only the futures PRICE is fetched live here.
//
// Route: GET /api/price?sym=GC=F  (or NQ=F)  -> { sym, price, time, exch }
// Free on Cloudflare Pages Functions (Workers free pool, 100k req/day).

const ALLOWED = new Set(['GC=F', 'NQ=F']);

function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'content-type': 'application/json',
            // Let the CF edge + browser coalesce polls so we hit Yahoo at most
            // ~1x/15s regardless of how many tabs are open (dodges Yahoo 429).
            'cache-control': 'public, max-age=15',
        },
    });
}

export async function onRequestGet({ request }) {
    const sym = new URL(request.url).searchParams.get('sym') || 'GC=F';
    if (!ALLOWED.has(sym)) return json({ error: 'bad sym' }, 400);
    try {
        const upstream = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
            {
                // Yahoo 429s requests without a browser-like UA.
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
