<script>
    import Card from './ui/Card.svelte';
    import { cn, fmtNumber, fmtStrike } from '$lib/utils.js';
    import { ASSET_PROFILES } from '$lib/config.js';

    let {
        assetId = 'gc',
        contractKey = $bindable('current'),
        data = null,
        loading = false,
        onChangeContract = (_key) => {}
    } = $props();

    const profile = $derived(ASSET_PROFILES[assetId]);

    const contracts = [
        { key: 'current', label: 'Current' },
        { key: 'friday',  label: 'Friday' },
        { key: 'monthly', label: 'Monthly' }
    ];

    function pickContract(key) {
        contractKey = key;
        onChangeContract(key);
    }

    /**
     * Strikes filtered to ±visibleStrikeRange of underlying, sorted desc.
     * @returns {Array<{strike:number, values:Array<number|null>}>}
     */
    const visibleStrikes = $derived.by(() => {
        if (!data?.strikes?.length) return [];
        const underlying = data.underlying || 0;
        const range = profile.visibleStrikeRange;
        let strikes = data.strikes;
        if (underlying > 0) {
            strikes = strikes.filter((s) => Math.abs(s.strike - underlying) <= range);
        }
        return [...strikes].sort((a, b) => b.strike - a.strike);
    });

    const dates = $derived(data?.dates || []);

    const maxVal = $derived.by(() => {
        let m = 1;
        for (const s of visibleStrikes) {
            for (const v of s.values || []) {
                if (v != null && v > m) m = v;
            }
        }
        return m;
    });

    const atmStrike = $derived.by(() => {
        const underlying = data?.underlying || 0;
        if (underlying <= 0 || !visibleStrikes.length) return null;
        return visibleStrikes.reduce((prev, curr) =>
            Math.abs(curr.strike - underlying) < Math.abs(prev.strike - underlying) ? curr : prev,
            visibleStrikes[0]
        );
    });

    /**
     * Log-scaled cyan gradient — solid (no transparency).
     * Returns an HSL color computed from the cell value vs the global max.
     */
    function cellStyle(value) {
        if (value == null || !Number.isFinite(value) || value <= 0 || maxVal <= 0) return '';
        const t = Math.log10(value + 1) / Math.log10(maxVal + 1);
        const clamped = Math.max(0, Math.min(1, t));
        // Lightness ramps 14% (very dark) → 55% (bright cyan), with vivid saturation
        const lightness = 14 + clamped * 42;
        const saturation = 70 + clamped * 22;
        return `background:hsl(188 ${saturation.toFixed(0)}% ${lightness.toFixed(0)}%);`;
    }

    function strikeTone(strike, underlying) {
        if (!underlying) return 'text-muted-foreground';
        if (strike > underlying) return 'text-up';
        if (strike < underlying) return 'text-down';
        return 'text-foreground';
    }
</script>

<Card class="flex flex-1 flex-col overflow-hidden">
    <!-- Top bar -->
    <div class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-primary"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                OI Heatmap
            </span>
            <span class="truncate text-[10px] text-muted-foreground">
                {#if data}
                    {dates.length} days × {visibleStrikes.length} strikes
                    {#if data.contract} · <span class="font-mono">{data.contract}</span>{/if}
                {:else if !loading}
                    No data
                {/if}
            </span>
        </div>

        <!-- Contract pill switcher -->
        <div class="flex items-center gap-2">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                Contract
            </span>
            <div class="flex gap-1">
                {#each contracts as c}
                    {@const isActive = c.key === contractKey}
                    <button
                        type="button"
                        onclick={() => pickContract(c.key)}
                        class={cn(
                            'rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                            isActive
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                        )}
                    >
                        {c.label}
                    </button>
                {/each}
            </div>
        </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-auto bg-background">
        {#if loading}
            <div class="flex h-64 items-center justify-center">
                <div class="flex items-center gap-3 text-muted-foreground">
                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                    <span class="text-sm">Loading heatmap…</span>
                </div>
            </div>
        {:else if !visibleStrikes.length}
            <div class="flex h-64 items-center justify-center">
                <div class="text-center">
                    <div class="text-sm font-semibold text-foreground">No heatmap data</div>
                    <p class="mt-1 max-w-md text-xs text-muted-foreground">
                        Run the QuikStrike scraper to publish
                        <span class="font-mono text-foreground">{contractKey}_OIHeatmap.json</span>.
                    </p>
                </div>
            </div>
        {:else}
            <table class="w-full border-separate border-spacing-0 font-mono text-[11px] tabular-nums text-foreground">
                <thead>
                    <tr>
                        <th
                            class="sticky left-0 top-0 z-30 min-w-[72px] border-b border-r border-border bg-surface px-3 py-2 text-right text-[9px] font-bold uppercase tracking-widest text-muted-foreground"
                        >
                            Strike
                        </th>
                        {#each dates as d}
                            <th
                                class="sticky top-0 z-20 min-w-[64px] whitespace-nowrap border-b border-border bg-surface px-2 py-2 text-center text-[9px] font-bold uppercase tracking-widest text-muted-foreground"
                            >
                                {d}
                            </th>
                        {/each}
                    </tr>
                </thead>
                <tbody>
                    {#each visibleStrikes as s (s.strike)}
                        {@const isATM = s === atmStrike}
                        <tr>
                            <td
                                class={cn(
                                    'sticky left-0 z-10 min-w-[72px] whitespace-nowrap border-b border-r border-border px-3 py-1 text-right font-semibold',
                                    isATM
                                        ? 'bg-primary text-primary-foreground'
                                        : `bg-surface ${strikeTone(s.strike, data?.underlying)}`
                                )}
                            >
                                {fmtStrike(s.strike)}
                            </td>
                            {#each s.values as v, i}
                                <td
                                    class={cn(
                                        'whitespace-nowrap border-b border-border px-2 py-1 text-right',
                                        isATM && 'ring-1 ring-primary ring-inset'
                                    )}
                                    style={cellStyle(v)}
                                >
                                    {v == null ? '' : fmtNumber(v, 0)}
                                </td>
                            {/each}
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    </div>
</Card>
