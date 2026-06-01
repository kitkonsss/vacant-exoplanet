<script>
    import { onMount, onDestroy, untrack } from 'svelte';
    import Card from './ui/Card.svelte';
    import { cn, fmtStrike, fmtK, fmtNumber } from '$lib/utils.js';
    import { CONTRACT_OPTIONS } from '$lib/config.js';
    import { fetchOHLC } from '$lib/data.js';

    /**
     * Price Chart — daily candlestick of the underlying futures with
     * horizontal price lines drawn at the top N option walls (strikes
     * with the largest current OI / Gamma, aggregated across tenors).
     *
     * Uses TradingView Lightweight Charts, dynamic-imported on mount so
     * the static build stays SSR-safe and the lib only loads when the
     * user opens this tab.
     *
     * Props:
     *  - assetId:           'gc'
     *  - oiByContract:      { contractKey: heatmapJson }
     *  - gammaByContract:   { contractKey: heatmapJson }
     *  - loading:           boolean
     */
    let {
        assetId = 'gc',
        oiByContract = {},
        gammaByContract = {},
        loading = false
    } = $props();

    let mode = $state('oi');                 // 'oi' | 'gamma'
    let timeframe = $state('1h');            // '1h' | '1d' — primary intraday view
    let topN = $state(10);
    let showSupport = $state(true);
    let showResistance = $state(true);

    /** @type {HTMLDivElement | null} */
    let chartEl = $state(null);
    let chart = null;
    let candleSeries = null;
    let lcMod = null;
    let priceLines = [];            // tracked so we can remove on rebuild

    /** @type {any} */
    let ohlc = $state(null);
    let ohlcLoading = $state(false);
    let ohlcError = $state(false);
    /** @type {string | null} */ let lastLoadedKey = null;    // `${asset}|${tf}`

    const sourceByContract = $derived(mode === 'gamma' ? gammaByContract : oiByContract);

    const availableContracts = $derived(
        CONTRACT_OPTIONS
            .map((c) => ({ key: c.key, label: c.label, data: sourceByContract[c.key] }))
            .filter((c) => c?.data?.strikes?.length)
    );

    const underlyingFromOptions = $derived.by(() => {
        let best = 0;
        for (const c of availableContracts) {
            const u = c.data.underlying;
            if (u && u > best) best = u;
        }
        return best;
    });

    const lastClose = $derived.by(() => {
        const c = ohlc?.candles;
        if (!c?.length) return null;
        return c[c.length - 1]?.close ?? null;
    });

    const referencePrice = $derived(underlyingFromOptions || lastClose || 0);

    /**
     * Aggregated latest-snapshot value per strike across all tenors.
     * Sorted desc, sliced to topN. Each entry tagged "above" or "below"
     * the reference price so we can paint resistance vs support.
     */
    const walls = $derived.by(() => {
        const byStrike = new Map();
        for (const c of availableContracts) {
            for (const s of c.data.strikes || []) {
                const latest = (s.values || [])[0];
                if (latest == null || !Number.isFinite(latest) || latest <= 0) continue;
                let row = byStrike.get(s.strike);
                if (!row) {
                    row = { strike: s.strike, total: 0, tenors: 0 };
                    byStrike.set(s.strike, row);
                }
                row.total += latest;
                row.tenors += 1;
            }
        }
        const arr = Array.from(byStrike.values())
            .sort((a, b) => b.total - a.total)
            .slice(0, topN);
        if (referencePrice > 0) {
            for (const w of arr) {
                w.above = w.strike > referencePrice;
            }
        }
        return arr;
    });

    const visibleWalls = $derived(
        walls.filter((w) => (w.above ? showResistance : showSupport))
    );

    async function loadOHLC() {
        const key = `${assetId}|${timeframe}`;
        if (lastLoadedKey === key && ohlc) return;
        ohlcLoading = true;
        ohlcError = false;
        try {
            const data = await fetchOHLC(assetId, timeframe);
            ohlc = data;
            ohlcError = !data?.candles?.length;
            lastLoadedKey = key;
        } catch {
            ohlcError = true;
        } finally {
            ohlcLoading = false;
        }
    }

    async function loadLightweightCharts() {
        if (lcMod) return lcMod;
        lcMod = await import('lightweight-charts');
        return lcMod;
    }

    async function ensureChart() {
        if (!chartEl) return;
        const lc = await loadLightweightCharts();
        if (!chart) {
            chart = lc.createChart(chartEl, {
                layout: {
                    background: { type: 'solid', color: 'transparent' },
                    textColor: 'hsl(0 0% 78%)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11
                },
                grid: {
                    vertLines: { color: 'hsl(0 0% 12%)' },
                    horzLines: { color: 'hsl(0 0% 12%)' }
                },
                rightPriceScale: {
                    borderColor: 'hsl(0 0% 18%)',
                    scaleMargins: { top: 0.08, bottom: 0.08 }
                },
                timeScale: {
                    borderColor: 'hsl(0 0% 18%)',
                    rightOffset: 4,
                    barSpacing: timeframe === '1h' ? 4 : 8,
                    timeVisible: timeframe === '1h',
                    secondsVisible: false
                },
                crosshair: {
                    mode: 1,
                    vertLine: { color: 'hsl(0 0% 30%)', width: 1, style: 0 },
                    horzLine: { color: 'hsl(0 0% 30%)', width: 1, style: 0 }
                },
                autoSize: true
            });
            candleSeries = chart.addSeries(lc.CandlestickSeries, {
                upColor:       'hsl(142 78% 52%)',
                downColor:     'hsl(0 76% 60%)',
                wickUpColor:   'hsl(142 78% 52%)',
                wickDownColor: 'hsl(0 76% 60%)',
                borderVisible: false
            });
        }
        if (ohlc?.candles?.length) {
            candleSeries.setData(ohlc.candles);
            chart.timeScale().fitContent();
        }
        rebuildPriceLines();
    }

    function rebuildPriceLines() {
        if (!candleSeries) return;
        for (const pl of priceLines) {
            try { candleSeries.removePriceLine(pl); } catch { /* noop */ }
        }
        priceLines = [];
        const maxTotal = visibleWalls[0]?.total || 1;
        for (const w of visibleWalls) {
            const ratio = w.total / maxTotal;
            const above = w.above;
            const color = above ? 'hsl(0 76% 60%)' : 'hsl(142 78% 52%)';
            const line = candleSeries.createPriceLine({
                price: w.strike,
                color,
                lineWidth: ratio > 0.66 ? 2 : 1,
                lineStyle: ratio > 0.66 ? 0 : 2,        // 0=Solid, 2=Dashed
                axisLabelVisible: true,
                title: `${fmtStrike(w.strike)} · ${fmtK(w.total) || w.total}`
            });
            priceLines.push(line);
        }
        if (referencePrice > 0) {
            const line = candleSeries.createPriceLine({
                price: referencePrice,
                color: 'hsl(48 96% 60%)',
                lineWidth: 1,
                lineStyle: 1,                            // Dotted
                axisLabelVisible: true,
                title: 'last'
            });
            priceLines.push(line);
        }
    }

    onMount(() => {
        void loadOHLC().then(() => ensureChart());
    });

    onDestroy(() => {
        if (chart) {
            chart.remove();
            chart = null;
            candleSeries = null;
            priceLines = [];
        }
    });

    // Reload OHLC when asset OR timeframe switches.
    $effect(() => {
        assetId; timeframe;
        untrack(() => {
            ohlc = null;
            void loadOHLC().then(() => {
                // setData() with a different time format (string -> number)
                // confuses Lightweight Charts; recreate the series cleanly.
                if (chart) {
                    chart.remove();
                    chart = null;
                    candleSeries = null;
                    priceLines = [];
                }
                void ensureChart();
            });
        });
    });

    // Re-render candles / lines whenever the data or controls change.
    $effect(() => {
        ohlc; visibleWalls;
        untrack(() => { void ensureChart(); });
    });
</script>

<Card class="flex flex-1 flex-col overflow-hidden">
    <!-- Top bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-mag"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                Price Chart
            </span>
            <span class="truncate text-[10px] text-muted-foreground">
                {#if ohlc?.candles?.length}
                    {ohlc.candles.length} {ohlc.interval || timeframe} candles · {ohlc.symbol || assetId.toUpperCase()}
                    {#if ohlc.rollovers_adjusted}
                        · <span class="text-warn">{ohlc.rollovers_adjusted} rollover{ohlc.rollovers_adjusted === 1 ? '' : 's'} adjusted</span>
                    {/if}
                    {#if referencePrice > 0} · ref <span class="font-mono">{fmtStrike(referencePrice)}</span>{/if}
                    · top <span class="font-mono">{visibleWalls.length}</span> {mode === 'gamma' ? 'gamma' : 'OI'} walls
                {:else if !ohlcLoading}
                    No OHLC data
                {/if}
            </span>
        </div>

        <div class="flex items-center gap-3">
            <!-- Timeframe toggle -->
            <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">TF</span>
                <div class="flex gap-1">
                    {#each [{ k: '1h', l: '1H' }, { k: '1d', l: '1D' }] as t}
                        {@const isActive = timeframe === t.k}
                        <button
                            type="button"
                            onclick={() => (timeframe = t.k)}
                            class={cn(
                                'rounded-md border px-2.5 py-1 font-mono text-[10px] font-semibold transition-colors',
                                isActive
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                            )}
                        >
                            {t.l}
                        </button>
                    {/each}
                </div>
            </div>

            <!-- Source toggle -->
            <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Walls</span>
                <div class="flex gap-1">
                    {#each [{ k: 'oi', l: 'OI' }, { k: 'gamma', l: 'Gamma' }] as o}
                        {@const isActive = mode === o.k}
                        <button
                            type="button"
                            onclick={() => (mode = o.k)}
                            class={cn(
                                'rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                                isActive
                                    ? 'border-mag bg-mag text-background'
                                    : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                            )}
                        >
                            {o.l}
                        </button>
                    {/each}
                </div>
            </div>

            <!-- Top-N -->
            <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Top</span>
                <div class="flex gap-1">
                    {#each [5, 10, 15] as n}
                        {@const isActive = topN === n}
                        <button
                            type="button"
                            onclick={() => (topN = n)}
                            class={cn(
                                'rounded-md border px-2 py-1 font-mono text-[10px] font-semibold transition-colors',
                                isActive
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                            )}
                        >
                            {n}
                        </button>
                    {/each}
                </div>
            </div>

            <!-- Side filters -->
            <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
                <label class="inline-flex items-center gap-1">
                    <input type="checkbox" bind:checked={showResistance} class="h-3 w-3 accent-down" />
                    <span class="text-down">resistance</span>
                </label>
                <label class="inline-flex items-center gap-1">
                    <input type="checkbox" bind:checked={showSupport} class="h-3 w-3 accent-up" />
                    <span class="text-up">support</span>
                </label>
            </div>
        </div>
    </div>

    <!-- Legend strip -->
    <div class="flex items-center gap-4 border-b border-border bg-surface px-4 py-1.5 text-[10px] text-muted-foreground">
        <span class="inline-flex items-center gap-1.5">
            <span class="inline-block h-0.5 w-6 bg-down"></span>
            <span>resistance (strike &gt; price)</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
            <span class="inline-block h-0.5 w-6 bg-up"></span>
            <span>support (strike &lt; price)</span>
        </span>
        <span class="inline-flex items-center gap-1.5">
            <span class="inline-block h-0.5 w-6" style="background:hsl(48 96% 60%);"></span>
            <span>last / underlying</span>
        </span>
        <span class="ml-auto font-mono">solid = top tier · dashed = lower</span>
    </div>

    <!-- Chart body -->
    <div class="flex-1 overflow-hidden bg-background">
        {#if ohlcLoading && !ohlc}
            <div class="flex h-64 items-center justify-center">
                <div class="flex items-center gap-3 text-muted-foreground">
                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-mag"></div>
                    <span class="text-sm">Loading OHLC…</span>
                </div>
            </div>
        {:else if ohlcError || !ohlc?.candles?.length}
            <div class="flex h-64 items-center justify-center">
                <div class="text-center">
                    <div class="text-sm font-semibold text-foreground">No OHLC data</div>
                    <p class="mt-1 max-w-md text-xs text-muted-foreground">
                        Run the scraper to publish
                        <span class="font-mono text-foreground">OHLC.json</span>.
                        Until then the chart stays empty.
                    </p>
                </div>
            </div>
        {/if}
        <div bind:this={chartEl} class="h-full w-full" style="min-height: 420px; {(ohlcError || !ohlc?.candles?.length) ? 'display:none;' : ''}"></div>
    </div>
</Card>
