// Cloudflare Worker entry — serves the static SvelteKit build via the ASSETS
// binding and a same-origin live-price API at /api/price. Same origin means the
// browser fetch is never CORS-blocked (Yahoo's endpoint sends no CORS header, so
// it can't be called from the browser directly). Implied vol still comes from
// the 15-min scrape; only the futures PRICE is fetched live here.
//
// Free on the Workers plan: static-asset requests are free/unlimited; Worker
// invocations (only /api/price hits the script) are 100k/day free.

const ALLOWED = new Set(['GC=F', 'NQ=F']);

// Third Friday of (year, month=1..12) — CME equity-index expiry.
function thirdFriday(year, month) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const offset = (5 - first.getUTCDay() + 7) % 7; // days to the first Friday
    return new Date(Date.UTC(year, month - 1, 1 + offset + 14));
}

// Map a front-month symbol to the LEAD (most-active) contract. Yahoo's `NQ=F`
// stays pinned to the expiring front month until last trade, reading ~300 pts
// below the contract liquidity has rolled to. NQ rolls quarterly (Mar/Jun/Sep/
// Dec), liquidity rolls 8 days before the 3rd-Friday expiry. GC keeps `GC=F`
// (Yahoo already tracks its liquid contract; inter-contract spread is tiny).
function leadSymbol(front) {
    if (front !== 'NQ=F') return front;
    const now = Date.now();
    const ROLL_MS = 8 * 86400000;
    const y = new Date(now).getUTCFullYear();
    const months = [3, 6, 9, 12];
    const candidates = [...months.map((m) => [y, m]), ...months.map((m) => [y + 1, m])];
    for (const [cy, cm] of candidates) {
        if (now < thirdFriday(cy, cm).getTime() - ROLL_MS) {
            const letter = 'FGHJKMNQUVXZ'[cm - 1];
            const yy = String(cy % 100).padStart(2, '0');
            return `NQ${letter}${yy}.CME`;
        }
    }
    return front;
}

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
    // Resolve the requested front-month token to the lead contract liquidity
    // has rolled to, so the live marker matches what traders are watching.
    const target = leadSymbol(sym);
    try {
        const upstream = await fetch(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(target)}?interval=1d&range=1d`,
            {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                cf: { cacheTtl: 15, cacheEverything: true },
            }
        );
        if (!upstream.ok) return json({ error: 'upstream', status: upstream.status }, 502);
        const j = await upstream.json();
        const m = j?.chart?.result?.[0]?.meta || {};
        return json({
            sym: target,        // the lead contract actually quoted
            front: sym,         // the front-month token requested
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
