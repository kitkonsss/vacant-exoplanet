<script>
    import { fmtK, fmtNumber, fmtStrike } from '$lib/utils.js';

    // Vertical grouped-bar "wall profile": strikes along the X axis (low → high),
    // wall strength (OI + volume) as bar height. Two view modes (driven by the
    // `mode` prop — a single Split/Total selector lives on the Position Bias view):
    //   • split — Put (orange) and Call (cyan) bars side-by-side at each strike.
    //   • total — one combined (green) bar per strike = Put + Call.
    // Each bar is split into two shades: solid base = today's intraday volume
    // (flow), faded top = open interest (the resting "wall") — so you can read
    // both the wall height and how much of it is fresh flow.
    let {
        positionMap = [],
        futurePrice = null,
        compact = false,
        mode = 'split',
        ivByStrike = null,
        showIv = false,
        sdBands = []
    } = $props();

    // ascending strike → left-to-right on the X axis
    const sorted = $derived([...(positionMap || [])].sort((a, b) => a.strike - b.strike));

    function callTotal(l) {
        return (l.call_oi || 0) + (l.call_volume || 0);
    }
    function putTotal(l) {
        return (l.put_oi || 0) + (l.put_volume || 0);
    }

    // Axis scale tracks the active mode: tallest single side in split view,
    // tallest combined Put+Call in total view (≈2× taller, so it needs its own max).
    const maxSplit = $derived(Math.max(...sorted.flatMap((l) => [callTotal(l), putTotal(l)]), 1));
    const maxTotal = $derived(Math.max(...sorted.map((l) => callTotal(l) + putTotal(l)), 1));
    const maxVal = $derived(mode === 'total' ? maxTotal : maxSplit);

    function hPct(v) {
        // floor so even tiny walls show a sliver; cap at 80% to leave headroom
        // above the tallest bar for its (now larger) contract-count label.
        return (v || 0) > 0 ? Math.max(((v || 0) / maxVal) * 80, 2) : 0;
    }

    function isKey(lv) {
        const p = futurePrice || 0;
        const isCallWall = (lv.side === 'call_wall' || lv.side === 'call') && lv.strike > p;
        const isPutWall = (lv.side === 'put_wall' || lv.side === 'put') && lv.strike < p;
        return isCallWall || isPutWall;
    }

    // future-price marker as a % across the evenly-spaced strike columns
    // (interpolated between the centres of the two bracketing strikes)
    function strikePos(level, clamp = false) {
        const n = sorted.length;
        if (!n || level == null || !Number.isFinite(level)) return null;
        if (n === 1) return 50;
        const p = level;
        if (p < sorted[0].strike) return clamp ? (0.5 / n) * 100 : null;
        if (p > sorted[n - 1].strike) return clamp ? ((n - 0.5) / n) * 100 : null;
        if (p === sorted[0].strike) return (0.5 / n) * 100;
        if (p === sorted[n - 1].strike) return ((n - 0.5) / n) * 100;
        for (let i = 0; i < n - 1; i++) {
            const a = sorted[i].strike;
            const b = sorted[i + 1].strike;
            if (p >= a && p <= b) {
                const frac = b === a ? 0 : (p - a) / (b - a);
                return ((i + 0.5 + frac) / n) * 100;
            }
        }
        return null;
    }

    const pricePos = $derived.by(() => {
        return strikePos(futurePrice, true);
    });

    const sdMarkers = $derived.by(() => {
        const markers = [];
        for (const raw of sdBands || []) {
            const level = Number(raw?.level);
            const x = strikePos(level, false);
            if (x == null) continue;
            const side = raw.side === 'minus' ? 'minus' : 'plus';
            const group = raw.group || 'expiry';
            markers.push({
                ...raw,
                level,
                x,
                side,
                group,
                color: raw.color || (group === 'day' ? '#38bdf8' : '#f59e0b'),
                label: raw.label || `${side === 'plus' ? '+' : '-'}${raw.k || ''}${group === 'day' ? 'D' : 'E'}`
            });
        }
        return markers;
    });
    const sdShown = $derived(sdMarkers.length > 0);
    const daySdShown = $derived(sdMarkers.some((m) => m.group === 'day'));
    const expSdShown = $derived(sdMarkers.some((m) => m.group === 'expiry'));

    function sdLabelTop(sd) {
        if (sd.group === 'day') return sd.side === 'minus' ? '26px' : '2px';
        return sd.side === 'minus' ? '38px' : '14px';
    }

    // --- per-strike IV smile overlay (from OIData Vol Settle), aligned to the
    // same strike scale as the bars. Use every visible raw IV strike, not only
    // strikes that have an OI wall, then render the curve as a monotone cubic
    // spline so it reads closer to QuikStrike without inventing extra extrema.
    const IV_COLOR = '#c084fc';
    const ivPoints = $derived.by(() => {
        if (!showIv || !ivByStrike) return [];
        const pts = [];
        for (const [strikeKey, rawIv] of Object.entries(ivByStrike)) {
            const strike = Number(strikeKey);
            const iv = Number(rawIv);
            const x = strikePos(strike, false);
            if (Number.isFinite(strike) && Number.isFinite(iv) && iv > 0 && x != null) {
                pts.push({ strike, iv, x });
            }
        }
        return pts.sort((a, b) => a.strike - b.strike);
    });
    const ivRange = $derived.by(() => {
        if (ivPoints.length < 2) return null;
        const vs = ivPoints.map((p) => p.iv);
        let lo = Math.min(...vs);
        let hi = Math.max(...vs);
        if (hi - lo < 1) { hi += 0.5; lo -= 0.5; } // avoid a flat divide-by-zero
        return { lo, hi };
    });
    // viewBox y (0 top .. 100 bottom): highest IV near the top (8), lowest at 78.
    function ivY(iv) {
        if (!ivRange) return 50;
        const f = (iv - ivRange.lo) / (ivRange.hi - ivRange.lo);
        return 8 + (1 - f) * 70;
    }
    function pathNum(v) {
        return Number.isFinite(v) ? v.toFixed(2) : '0.00';
    }
    function endpointTangent(h0, h1, d0, d1) {
        let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if (m * d0 <= 0) return 0;
        if (d0 * d1 < 0 && Math.abs(m) > Math.abs(3 * d0)) return 3 * d0;
        return m;
    }
    function ivCurvePath(points) {
        const pts = points
            .map((p) => ({ x: p.x, y: ivY(p.iv) }))
            .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
            .sort((a, b) => a.x - b.x);

        if (pts.length < 2) return '';
        let d = `M ${pathNum(pts[0].x)} ${pathNum(pts[0].y)}`;
        if (pts.length === 2) {
            return `${d} L ${pathNum(pts[1].x)} ${pathNum(pts[1].y)}`;
        }

        const n = pts.length;
        const h = [];
        const slope = [];
        for (let i = 0; i < n - 1; i++) {
            h[i] = pts[i + 1].x - pts[i].x;
            slope[i] = h[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / h[i];
        }

        const m = Array(n).fill(0);
        m[0] = endpointTangent(h[0], h[1], slope[0], slope[1]);
        m[n - 1] = endpointTangent(h[n - 2], h[n - 3], slope[n - 2], slope[n - 3]);
        for (let i = 1; i < n - 1; i++) {
            if (slope[i - 1] * slope[i] <= 0) {
                m[i] = 0;
            } else {
                const w1 = 2 * h[i] + h[i - 1];
                const w2 = h[i] + 2 * h[i - 1];
                m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
            }
        }

        for (let i = 0; i < n - 1; i++) {
            if (h[i] <= 0) continue;
            const c1x = pts[i].x + h[i] / 3;
            const c1y = pts[i].y + (m[i] * h[i]) / 3;
            const c2x = pts[i + 1].x - h[i] / 3;
            const c2y = pts[i + 1].y - (m[i + 1] * h[i]) / 3;
            d += ` C ${pathNum(c1x)} ${pathNum(c1y)} ${pathNum(c2x)} ${pathNum(c2y)} ${pathNum(pts[i + 1].x)} ${pathNum(pts[i + 1].y)}`;
        }
        return d;
    }
    const ivPath = $derived(ivCurvePath(ivPoints));
    const ivShown = $derived(showIv && ivPoints.length >= 2 && ivRange != null);

    let hovered = $state(null);

    const chartHeight = $derived(compact ? 160 : 230);
    const barMax = $derived(compact ? '12px' : '18px');
    const totalBarMax = $derived(compact ? '20px' : '30px');
    const labelSize = $derived(compact ? 'text-[8px]' : 'text-[9px]');

    const TONES = {
        call: { solid: 'bg-call/90 group-hover:bg-call', faded: 'bg-call/35 group-hover:bg-call/55' },
        put: { solid: 'bg-put/90 group-hover:bg-put', faded: 'bg-put/35 group-hover:bg-put/55' },
        total: { solid: 'bg-up/90 group-hover:bg-up', faded: 'bg-up/35 group-hover:bg-up/55' }
    };
</script>

{#snippet bar(oi, vol, tone)}
    {@const o = oi || 0}
    {@const v = vol || 0}
    {@const total = o + v}
    <div
        class="flex h-full flex-col items-center justify-end"
        style={`max-width:${tone === 'total' ? totalBarMax : barMax}`}
    >
        {#if total > 0}
            <!-- contract count for this bar (OI + intraday volume), vertical so it fits the thin column -->
            <span
                class={`mb-0.5 font-mono font-semibold leading-none tabular-nums text-foreground/75 [writing-mode:vertical-rl] rotate-180 ${compact ? 'text-[8px]' : 'text-[10px]'}`}
            >{fmtK(total)}</span>
        {/if}
        <div class="flex w-full flex-col overflow-hidden rounded-t-sm" style={`height:${hPct(total)}%`}>
            {#if v > 0}
                <!-- intraday volume (today's flow) — solid shade, sits on top -->
                <div
                    class={`transition-colors ${TONES[tone].solid}`}
                    style={`height:${total > 0 ? (v / total) * 100 : 0}%`}
                ></div>
            {/if}
            {#if o > 0}
                <!-- open interest (the resting wall) — faded shade, sits at the base -->
                <div
                    class={`transition-colors ${TONES[tone].faded}`}
                    style={`height:${total > 0 ? (o / total) * 100 : 0}%`}
                ></div>
            {/if}
        </div>
    </div>
{/snippet}

{#if sorted.length === 0}
    <div class="rounded-md border border-border bg-background py-6 text-center text-xs text-muted-foreground">
        No position data
    </div>
{:else}
    <div class={`rounded-md border border-border bg-background ${compact ? 'p-2.5' : 'p-3'}`}>
        <!-- Legend + live readout (Split/Total selector lives on the Position Bias view) -->
        <div class={`mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
            <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                {#if mode === 'total'}
                    <span class="flex items-center gap-1">
                        <span class="inline-block h-2 w-2 rounded-sm bg-up"></span>
                        <span class="text-muted-foreground">Total</span>
                    </span>
                {:else}
                    <span class="flex items-center gap-1">
                        <span class="inline-block h-2 w-2 rounded-sm bg-put"></span>
                        <span class="text-muted-foreground">Put</span>
                    </span>
                    <span class="flex items-center gap-1">
                        <span class="inline-block h-2 w-2 rounded-sm bg-call"></span>
                        <span class="text-muted-foreground">Call</span>
                    </span>
                {/if}
                <span class="mx-0.5 h-2.5 w-px bg-border"></span>
                <span class="flex items-center gap-1" title="faded = open interest (resting wall)">
                    <span class="inline-block h-2 w-2 rounded-sm bg-foreground/35"></span>
                    <span class="text-muted-foreground">OI</span>
                </span>
                <span class="flex items-center gap-1" title="solid = intraday volume (today's flow)">
                    <span class="inline-block h-2 w-2 rounded-sm bg-foreground/90"></span>
                    <span class="text-muted-foreground">Vol</span>
                </span>
                {#if ivShown}
                    <span class="mx-0.5 h-2.5 w-px bg-border"></span>
                    <span class="flex items-center gap-1" title="IV smile — วอล (ความผันผวน) ของแต่ละ strike">
                        <span class="inline-block h-[2px] w-3 rounded-sm" style={`background:${IV_COLOR}`}></span>
                        <span class="text-muted-foreground">IV</span>
                    </span>
                {/if}
                {#if daySdShown}
                    <span class="mx-0.5 h-2.5 w-px bg-border"></span>
                    <span class="flex items-center gap-1" title="1-day standard-deviation bands">
                        <span class="inline-block h-3 w-[2px] rounded-sm bg-[#38bdf8]"></span>
                        <span class="text-muted-foreground">1D SD</span>
                    </span>
                {/if}
                {#if expSdShown}
                    <span class="mx-0.5 h-2.5 w-px bg-border"></span>
                    <span class="flex items-center gap-1" title="To-expiry standard-deviation bands">
                        <span class="inline-block h-3 w-[2px] rounded-sm bg-[#f59e0b]"></span>
                        <span class="text-muted-foreground">Exp SD</span>
                    </span>
                {/if}
            </div>
            {#if hovered != null && sorted[hovered]}
                {@const lv = sorted[hovered]}
                {#if mode === 'total'}
                    <div class="hidden truncate font-mono tabular-nums sm:block">
                        <span class="font-semibold text-foreground">{fmtStrike(lv.strike)}</span>
                        <span class="text-up">· OI {fmtK((lv.put_oi || 0) + (lv.call_oi || 0)) || 0}+Vol {fmtK((lv.put_volume || 0) + (lv.call_volume || 0)) || 0}</span>
                        {#if ivByStrike?.[lv.strike]}<span style={`color:${IV_COLOR}`}>· IV {fmtNumber(ivByStrike[lv.strike], 1)}%</span>{/if}
                    </div>
                {:else}
                    <div class="hidden truncate font-mono tabular-nums sm:block">
                        <span class="font-semibold text-foreground">{fmtStrike(lv.strike)}</span>
                        <span class="text-put">· P {fmtK(lv.put_oi) || 0}+{fmtK(lv.put_volume) || 0}</span>
                        <span class="text-call">· C {fmtK(lv.call_oi) || 0}+{fmtK(lv.call_volume) || 0}</span>
                        {#if ivByStrike?.[lv.strike]}<span style={`color:${IV_COLOR}`}>· IV {fmtNumber(ivByStrike[lv.strike], 1)}%</span>{/if}
                    </div>
                {/if}
            {:else}
                <div class="hidden truncate font-mono tabular-nums text-muted-foreground sm:block">
                    Future <span class="font-semibold text-primary">{fmtStrike(futurePrice)}</span>
                </div>
            {/if}
        </div>

        <!-- Plot area -->
        <div class="relative" style={`height:${chartHeight}px`}>
            <!-- horizontal gridlines -->
            {#each [0.25, 0.5, 0.75] as g}
                <div class="absolute left-0 right-0 border-t border-border/40" style={`bottom:${g * 100}%`}></div>
            {/each}
            <!-- baseline -->
            <div class="absolute left-0 right-0 bottom-0 border-t border-border"></div>

            <!-- future-price line -->
            {#if pricePos != null}
                <div class="absolute top-0 bottom-0 z-10 border-l border-dashed border-primary/70" style={`left:${pricePos}%`}>
                    <span class={`absolute -top-px -translate-x-1/2 leading-none text-primary ${compact ? 'text-[7px]' : 'text-[8px]'}`}>▾</span>
                </div>
            {/if}

            <!-- SD bands, aligned to the same strike scale -->
            {#each sdMarkers as sd (sd.label + '-' + sd.level)}
                <div
                    class="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-dashed"
                    style={`left:${sd.x}%;border-color:${sd.color}99`}
                >
                    <span
                        class={`absolute -translate-x-1/2 rounded-sm bg-background/90 px-0.5 font-mono font-semibold leading-none ${sd.k > 1 ? 'hidden sm:inline' : ''} ${compact ? 'text-[7px]' : 'text-[8px]'}`}
                        style={`top:${sdLabelTop(sd)};color:${sd.color}`}
                    >{sd.label}</span>
                </div>
            {/each}

            <!-- IV smile overlay (per-strike vol), drawn over the bars -->
            {#if ivShown}
                <svg class="pointer-events-none absolute inset-0 z-20 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                    <path
                        d={ivPath}
                        fill="none"
                        stroke={IV_COLOR}
                        stroke-width="1.6"
                        vector-effect="non-scaling-stroke"
                        stroke-linejoin="round"
                        stroke-linecap="round"
                    />
                </svg>
                <span class="pointer-events-none absolute right-0.5 z-20 -translate-y-1/2 font-mono text-[8px]" style={`top:${ivY(ivRange.hi)}%;color:${IV_COLOR}`}>{fmtNumber(ivRange.hi, 0)}%</span>
                <span class="pointer-events-none absolute right-0.5 z-20 -translate-y-1/2 font-mono text-[8px]" style={`top:${ivY(ivRange.lo)}%;color:${IV_COLOR}`}>{fmtNumber(ivRange.lo, 0)}%</span>
            {/if}

            <!-- grouped bars -->
            <div class="absolute inset-0 flex items-end">
                {#each sorted as lv, i (lv.strike + '-' + i)}
                    <button
                        type="button"
                        class={`group flex h-full flex-1 items-end justify-center gap-px p-0 ${hovered === i ? 'bg-surface-elevated/60' : ''}`}
                        onmouseenter={() => (hovered = i)}
                        onmouseleave={() => (hovered = null)}
                        onfocus={() => (hovered = i)}
                        onblur={() => (hovered = null)}
                        aria-label={`Strike ${fmtStrike(lv.strike)}: put oi ${lv.put_oi || 0} vol ${lv.put_volume || 0}, call oi ${lv.call_oi || 0} vol ${lv.call_volume || 0}`}
                    >
                        {#if mode === 'total'}
                            {@render bar((lv.put_oi || 0) + (lv.call_oi || 0), (lv.put_volume || 0) + (lv.call_volume || 0), 'total')}
                        {:else}
                            {@render bar(lv.put_oi, lv.put_volume, 'put')}
                            {@render bar(lv.call_oi, lv.call_volume, 'call')}
                        {/if}
                    </button>
                {/each}
            </div>
        </div>

        <!-- X-axis strike labels -->
        <div class="mt-1 flex">
            {#each sorted as lv, i (lv.strike + '-' + i)}
                <div
                    class={`flex-1 text-center font-mono tabular-nums leading-none ${labelSize} ${
                        isKey(lv) ? 'font-semibold text-foreground' : 'text-muted-foreground'
                    } ${hovered === i ? 'text-foreground' : ''}`}
                >
                    {fmtStrike(lv.strike)}
                </div>
            {/each}
        </div>
    </div>
{/if}
