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
    const sortedStrikes = $derived(sorted.map((l) => Number(l.strike)).filter((s) => Number.isFinite(s)));

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

    function medianStep(values) {
        const diffs = [];
        for (let i = 1; i < values.length; i++) {
            const d = values[i] - values[i - 1];
            if (d > 0) diffs.push(d);
        }
        if (!diffs.length) return 1;
        diffs.sort((a, b) => a - b);
        return diffs[Math.floor(diffs.length / 2)] || 1;
    }

    const strikeDomain = $derived.by(() => {
        if (!sortedStrikes.length) return null;
        let lo = Math.min(...sortedStrikes);
        let hi = Math.max(...sortedStrikes);
        const step = medianStep(sortedStrikes);
        if (lo === hi) {
            lo -= step;
            hi += step;
        }
        const pad = Math.max(step * 0.5, (hi - lo) * 0.01);
        return { lo: lo - pad, hi: hi + pad };
    });

    // CME/QuikStrike uses strike as a continuous x-axis, not an equal-width
    // category column per wall. Keep every overlay on that same strike scale.
    function strikePos(level, clamp = false) {
        if (!strikeDomain || level == null || !Number.isFinite(level)) return null;
        const span = strikeDomain.hi - strikeDomain.lo;
        if (span <= 0) return null;
        const x = ((level - strikeDomain.lo) / span) * 100;
        if (x < 0) return clamp ? 0 : null;
        if (x > 100) return clamp ? 100 : null;
        return x;
    }

    const xLabels = $derived.by(() => {
        const out = [];
        const minGap = compact ? 8 : 3.6;
        let lastShownX = -Infinity;
        for (let i = 0; i < sorted.length; i++) {
            const lv = sorted[i];
            const x = strikePos(lv.strike, true);
            if (x == null) continue;
            const important = i === 0 || i === sorted.length - 1 || isKey(lv);
            if (important || x - lastShownX >= minGap) {
                out.push({ lv, i, x });
                lastShownX = x;
            }
        }
        return out;
    });

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

    // --- per-strike IV smile overlay (from OIData Vol Settle).
    // QuikStrike renders a fitted Vol Settle smile over a continuous strike axis.
    // Fit a low-degree polynomial to the visible raw IV strikes, then sample it
    // densely so the plotted line reads as one smooth smile instead of point joins.
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
    function pathNum(v) {
        return Number.isFinite(v) ? v.toFixed(2) : '0.00';
    }

    function solveLinearSystem(matrix, vector) {
        const n = vector.length;
        const a = matrix.map((row, i) => [...row, vector[i]]);
        for (let col = 0; col < n; col++) {
            let pivot = col;
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
            }
            if (Math.abs(a[pivot][col]) < 1e-10) return null;
            if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];

            const divisor = a[col][col];
            for (let c = col; c <= n; c++) a[col][c] /= divisor;
            for (let row = 0; row < n; row++) {
                if (row === col) continue;
                const factor = a[row][col];
                for (let c = col; c <= n; c++) a[row][c] -= factor * a[col][c];
            }
        }
        return a.map((row) => row[n]);
    }

    function fitPolynomial(points, degree, center, scale) {
        const order = degree + 1;
        const xtx = Array.from({ length: order }, () => Array(order).fill(0));
        const xty = Array(order).fill(0);

        for (const p of points) {
            const t = (p.strike - center) / scale;
            const powers = [1];
            for (let i = 1; i < order; i++) powers[i] = powers[i - 1] * t;
            for (let r = 0; r < order; r++) {
                xty[r] += powers[r] * p.iv;
                for (let c = 0; c < order; c++) xtx[r][c] += powers[r] * powers[c];
            }
        }

        // Tiny ridge keeps the matrix stable when visible strikes are clustered.
        for (let i = 0; i < order; i++) xtx[i][i] += 1e-8;
        const coeffs = solveLinearSystem(xtx, xty);
        if (!coeffs) return null;
        return (strike) => {
            const t = (strike - center) / scale;
            let y = 0;
            let power = 1;
            for (const c of coeffs) {
                y += c * power;
                power *= t;
            }
            return y;
        };
    }

    function linearIv(points, strike) {
        if (strike <= points[0].strike) return points[0].iv;
        if (strike >= points[points.length - 1].strike) return points[points.length - 1].iv;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            if (strike >= a.strike && strike <= b.strike) {
                const f = b.strike === a.strike ? 0 : (strike - a.strike) / (b.strike - a.strike);
                return a.iv + (b.iv - a.iv) * f;
            }
        }
        return points[0].iv;
    }

    function buildSmileModel(points) {
        if (points.length < 2 || !strikeDomain) return null;
        const rawLo = Math.min(...points.map((p) => p.iv));
        const rawHi = Math.max(...points.map((p) => p.iv));
        const pad = Math.max((rawHi - rawLo) * 0.08, 0.35);
        const minStrike = points[0].strike;
        const maxStrike = points[points.length - 1].strike;
        const center = Number.isFinite(futurePrice) ? futurePrice : (strikeDomain.lo + strikeDomain.hi) / 2;
        const scale = Math.max((strikeDomain.hi - strikeDomain.lo) / 2, 1);
        const degree = Math.min(points.length - 1, points.length >= 7 ? 3 : points.length >= 4 ? 2 : 1);
        const fitted = degree >= 2 ? fitPolynomial(points, degree, center, scale) : null;
        const evalIv = fitted || ((strike) => linearIv(points, strike));
        return {
            minStrike,
            maxStrike,
            eval(strike) {
                const iv = evalIv(strike);
                return Math.min(rawHi + pad, Math.max(rawLo - pad, iv));
            }
        };
    }

    const ivModel = $derived.by(() => buildSmileModel(ivPoints));
    const ivCurveSamples = $derived.by(() => {
        if (!ivModel || !strikeDomain) return [];
        const start = Math.max(ivModel.minStrike, strikeDomain.lo);
        const end = Math.min(ivModel.maxStrike, strikeDomain.hi);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

        const count = 140;
        const out = [];
        for (let i = 0; i < count; i++) {
            const strike = start + ((end - start) * i) / (count - 1);
            const x = strikePos(strike, false);
            const iv = ivModel.eval(strike);
            if (x != null && Number.isFinite(iv)) out.push({ strike, iv, x });
        }
        return out;
    });

    const ivRange = $derived.by(() => {
        if (ivCurveSamples.length < 2) return null;
        const vs = ivCurveSamples.map((p) => p.iv);
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
    function ivCurvePath(points) {
        return points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${pathNum(p.x)} ${pathNum(ivY(p.iv))}`)
            .join(' ');
    }
    const ivPath = $derived(ivCurvePath(ivCurveSamples));
    const ivShown = $derived(showIv && ivCurveSamples.length >= 2 && ivRange != null);

    let hovered = $state(null);

    const chartHeight = $derived(compact ? 160 : 230);
    const barMax = $derived(compact ? '12px' : '18px');
    const totalBarMax = $derived(compact ? '20px' : '30px');
    const barClusterWidth = $derived(
        mode === 'total'
            ? (compact ? 'clamp(14px, 2vw, 22px)' : 'clamp(16px, 1.8vw, 30px)')
            : (compact ? 'clamp(18px, 3vw, 28px)' : 'clamp(20px, 2.4vw, 34px)')
    );
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
        class="flex h-full min-w-0 w-full flex-col items-center justify-end"
        style={`max-width:${tone === 'total' ? totalBarMax : barMax}`}
    >
        {#if total > 0}
            <!-- contract count for this bar (OI + intraday volume), vertical so it fits the thin column -->
            <span
                class={`mb-0.5 hidden font-mono font-semibold leading-none tabular-nums text-foreground/75 [writing-mode:vertical-rl] rotate-180 sm:inline ${compact ? 'text-[8px]' : 'text-[10px]'}`}
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
            <div class="absolute inset-0">
                {#each sorted as lv, i (lv.strike + '-' + i)}
                    {@const x = strikePos(lv.strike, true)}
                    {#if x != null}
                        <button
                            type="button"
                            class={`group absolute bottom-0 top-0 flex items-end justify-center gap-px p-0 ${hovered === i ? 'bg-surface-elevated/60' : ''}`}
                            style={`left:${x}%;width:${barClusterWidth};transform:translateX(-50%)`}
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
                    {/if}
                {/each}
            </div>
        </div>

        <!-- X-axis strike labels -->
        <div class="relative mt-1 h-3">
            {#each xLabels as item (item.lv.strike + '-' + item.i)}
                <div
                    class={`absolute hidden -translate-x-1/2 text-center font-mono tabular-nums leading-none sm:block ${labelSize} ${
                        isKey(item.lv) ? 'font-semibold text-foreground' : 'text-muted-foreground'
                    } ${hovered === item.i ? 'text-foreground' : ''}`}
                    style={`left:${item.x}%;width:${compact ? '34px' : '44px'}`}
                >
                    {fmtStrike(item.lv.strike)}
                </div>
            {/each}
        </div>
    </div>
{/if}
