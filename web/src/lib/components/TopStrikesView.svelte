<script>
    import { onMount, onDestroy, untrack } from 'svelte';
    import Card from './ui/Card.svelte';
    import { cn, fmtStrike, fmtK, fmtNumber } from '$lib/utils.js';
    import { ASSET_PROFILES, CONTRACT_OPTIONS } from '$lib/config.js';

    /**
     * Aggregate "Top Strikes" view — bars of strikes ranked by total
     * open interest (or gamma) summed across all contract tenors.
     *
     * Uses ECharts, dynamic-imported on mount so the static build stays
     * SSR-safe and the lib only loads when this tab is opened.
     *
     * Props:
     *  - assetId:            'gc' | 'nq' …
     *  - oiByContract:       { contractKey: heatmapJson }
     *  - gammaByContract:    { contractKey: heatmapJson }
     *  - loading:            boolean
     */
    let {
        assetId = 'gc',
        oiByContract = {},
        gammaByContract = {},
        loading = false
    } = $props();

    let mode = $state('oi');                // 'oi' | 'gamma'
    let topN = $state(20);                  // how many strikes to show
    let nearAtmOnly = $state(true);         // restrict to profile.visibleStrikeRange around underlying

    /** @type {HTMLDivElement | null} */
    let chartEl = $state(null);
    let chart = null;
    let echartsMod = null;

    const profile = $derived(ASSET_PROFILES[assetId]);

    // Pick the right cache for the current mode.
    const sourceByContract = $derived(mode === 'gamma' ? gammaByContract : oiByContract);

    // Contracts we actually have data for, preserving CONTRACT_OPTIONS order.
    const availableContracts = $derived(
        CONTRACT_OPTIONS
            .map((c) => ({ key: c.key, label: c.label, data: sourceByContract[c.key] }))
            .filter((c) => c?.data?.strikes?.length)
    );

    // Pick the most reliable underlying price across contracts (max nonzero).
    const underlying = $derived.by(() => {
        let best = 0;
        for (const c of availableContracts) {
            const u = c.data.underlying;
            if (u && u > best) best = u;
        }
        return best;
    });

    /**
     * Aggregate latest-snapshot value per strike, stacked by contract.
     *
     * Why latest column only: open interest and gamma are stock measures
     * (level at a point in time), not flow — summing across history would
     * double-count carry-over positions. The most recent date column is
     * the current OI/gamma at that strike, per contract.
     */
    const rows = $derived.by(() => {
        // strike -> { strike, perContract: {key: value}, total }
        const byStrike = new Map();
        for (const c of availableContracts) {
            const strikes = c.data.strikes || [];
            for (const s of strikes) {
                const latest = (s.values || [])[0];
                if (latest == null || !Number.isFinite(latest) || latest <= 0) continue;
                let row = byStrike.get(s.strike);
                if (!row) {
                    row = { strike: s.strike, perContract: {}, total: 0 };
                    byStrike.set(s.strike, row);
                }
                row.perContract[c.key] = (row.perContract[c.key] || 0) + latest;
                row.total += latest;
            }
        }
        let arr = Array.from(byStrike.values());
        if (nearAtmOnly && underlying > 0 && profile?.visibleStrikeRange) {
            arr = arr.filter((r) => Math.abs(r.strike - underlying) <= profile.visibleStrikeRange);
        }
        arr.sort((a, b) => b.total - a.total);
        return arr.slice(0, topN);
    });

    // Per-contract tone colors (match Tailwind tokens used elsewhere — magenta/up/warn/down).
    const CONTRACT_COLORS = {
        current:  'hsl(142 78% 52%)', // up / primary
        tomorrow: 'hsl(190 80% 56%)', // teal-cyan
        friday:   'hsl( 38 92% 56%)', // warn / amber
        monthly:  'hsl(320 78% 60%)'  // mag
    };

    const valueDecimals = $derived(mode === 'gamma' ? 0 : 0);

    function buildOption(currentRows) {
        if (!currentRows.length) return null;
        const reversed = [...currentRows].reverse();             // largest at top in horizontal bar
        const categories = reversed.map((r) => fmtStrike(r.strike));
        const series = availableContracts.map((c) => ({
            name: c.label,
            type: 'bar',
            stack: 'total',
            barCategoryGap: '28%',
            itemStyle: {
                color: CONTRACT_COLORS[c.key] || 'hsl(220 12% 60%)',
                borderRadius: 0
            },
            emphasis: { focus: 'series' },
            data: reversed.map((r) => r.perContract[c.key] || 0)
        }));
        const atmIdx = (() => {
            if (!underlying) return -1;
            let best = -1;
            let bestDist = Infinity;
            reversed.forEach((r, i) => {
                const d = Math.abs(r.strike - underlying);
                if (d < bestDist) { bestDist = d; best = i; }
            });
            return best;
        })();

        return {
            backgroundColor: 'transparent',
            animationDuration: 250,
            grid: { left: 64, right: 28, top: 8, bottom: 28, containLabel: false },
            legend: {
                top: 0,
                right: 8,
                show: false      // we have our own pill switcher above
            },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                backgroundColor: 'rgba(15, 15, 18, 0.95)',
                borderColor: 'rgba(255,255,255,0.08)',
                borderWidth: 1,
                textStyle: { color: 'hsl(0 0% 92%)', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
                valueFormatter: (v) => fmtNumber(v, valueDecimals),
                extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.5);'
            },
            xAxis: {
                type: 'value',
                axisLine:  { lineStyle: { color: 'hsl(0 0% 22%)' } },
                axisLabel: { color: 'hsl(0 0% 64%)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
                             formatter: (v) => fmtK(v) || v },
                splitLine: { lineStyle: { color: 'hsl(0 0% 14%)' } }
            },
            yAxis: {
                type: 'category',
                data: categories,
                inverse: false,
                axisLine:  { lineStyle: { color: 'hsl(0 0% 22%)' } },
                axisTick:  { show: false },
                axisLabel: {
                    color: 'hsl(0 0% 78%)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    formatter: (val, idx) => idx === atmIdx ? `▶ ${val}` : val,
                    rich: {}
                }
            },
            series
        };
    }

    async function loadEcharts() {
        if (echartsMod) return echartsMod;
        echartsMod = await import('echarts');
        return echartsMod;
    }

    async function ensureChart() {
        if (!chartEl) return;
        const ec = await loadEcharts();
        if (!chart) {
            chart = ec.init(chartEl, null, { renderer: 'canvas' });
        }
        const opt = buildOption(rows);
        if (opt) {
            chart.setOption(opt, true);
        } else {
            chart.clear();
        }
    }

    function handleResize() {
        if (chart) chart.resize();
    }

    onMount(() => {
        void ensureChart();
        window.addEventListener('resize', handleResize);
    });

    onDestroy(() => {
        window.removeEventListener('resize', handleResize);
        if (chart) {
            chart.dispose();
            chart = null;
        }
    });

    // Re-render whenever the underlying derived rows change (mode/toggle/data).
    $effect(() => {
        rows;                                  // dep
        untrack(() => { void ensureChart(); });
    });
</script>

<Card class="flex flex-1 flex-col overflow-hidden">
    <!-- Top bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-mag"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                Top Strikes
            </span>
            <span class="truncate text-[10px] text-muted-foreground">
                {#if availableContracts.length}
                    aggregated across {availableContracts.length} contract{availableContracts.length === 1 ? '' : 's'}
                    · top <span class="font-mono">{rows.length}</span> by latest {mode === 'gamma' ? 'gamma' : 'OI'}
                    {#if underlying > 0} · underlying <span class="font-mono">{fmtStrike(underlying)}</span>{/if}
                {:else if !loading}
                    No data
                {/if}
            </span>
        </div>

        <div class="flex items-center gap-3">
            <!-- Mode toggle: OI / Gamma -->
            <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Source</span>
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

            <!-- Top-N picker -->
            <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Show</span>
                <div class="flex gap-1">
                    {#each [10, 20, 30] as n}
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

            <!-- ATM filter -->
            <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <input type="checkbox" bind:checked={nearAtmOnly} class="h-3 w-3 accent-mag" />
                near ATM
            </label>
        </div>
    </div>

    <!-- Per-contract legend -->
    {#if availableContracts.length}
        <div class="flex items-center gap-3 border-b border-border bg-surface px-4 py-1.5 text-[10px] text-muted-foreground">
            <span class="font-semibold uppercase tracking-widest">Stack</span>
            {#each availableContracts as c}
                <span class="inline-flex items-center gap-1.5">
                    <span class="h-2.5 w-3 rounded-sm" style="background:{CONTRACT_COLORS[c.key] || '#888'};"></span>
                    <span class="font-mono">{c.label}</span>
                </span>
            {/each}
            <span class="ml-auto font-mono">latest snapshot</span>
        </div>
    {/if}

    <!-- Body -->
    <div class="flex-1 overflow-hidden bg-background">
        {#if loading && !availableContracts.length}
            <div class="flex h-64 items-center justify-center">
                <div class="flex items-center gap-3 text-muted-foreground">
                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-mag"></div>
                    <span class="text-sm">Loading top strikes…</span>
                </div>
            </div>
        {:else if !rows.length}
            <div class="flex h-64 items-center justify-center">
                <div class="text-center">
                    <div class="text-sm font-semibold text-foreground">No strikes to show</div>
                    <p class="mt-1 max-w-md text-xs text-muted-foreground">
                        Need {mode === 'gamma' ? 'Gamma' : 'OI'} heatmap JSON for at least one contract.
                        Try toggling
                        <span class="font-mono">{mode === 'gamma' ? 'OI' : 'Gamma'}</span>
                        or unchecking "near ATM".
                    </p>
                </div>
            </div>
        {/if}
        <div bind:this={chartEl} class="h-full w-full" style="min-height: 360px; {rows.length ? '' : 'display:none;'}"></div>
    </div>
</Card>
