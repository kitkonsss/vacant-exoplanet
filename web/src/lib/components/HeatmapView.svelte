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

    const atmIdx = $derived.by(() => {
        const underlying = data?.underlying || 0;
        if (underlying <= 0 || !visibleStrikes.length) return -1;
        let best = 0;
        for (let i = 1; i < visibleStrikes.length; i++) {
            if (Math.abs(visibleStrikes[i].strike - underlying) < Math.abs(visibleStrikes[best].strike - underlying)) {
                best = i;
            }
        }
        return best;
    });

    /**
     * Six discrete tiers — small/empty values stay near-gray, only the
     * genuinely large positions reach a vivid emerald. Matches CME's
     * QuikStrike feel where most cells fade and the chunky walls pop.
     *
     * The log-transformed value is mapped to thresholds (not equal width)
     * so the rare top values get the brightest tier.
     */
    const TIERS = [
        // [maxT (inclusive), background HSL]
        [0.30, 'hsl(0 0% 11%)'],     // tier 1 — gray, dim (empty-ish)
        [0.50, 'hsl(142 18% 16%)'],  // tier 2 — faintest green tint
        [0.70, 'hsl(142 32% 22%)'],  // tier 3 — light green
        [0.84, 'hsl(142 48% 30%)'],  // tier 4 — medium green
        [0.94, 'hsl(142 62% 40%)'],  // tier 5 — clear green
        [1.01, 'hsl(142 78% 52%)']   // tier 6 — vivid green (top values only)
    ];

    function oiStyle(value) {
        if (value == null || !Number.isFinite(value) || value <= 0 || maxVal <= 0) {
            return '';
        }
        const t = Math.log10(value + 1) / Math.log10(maxVal + 1);
        const clamped = Math.max(0, Math.min(1, t));
        for (const [threshold, color] of TIERS) {
            if (clamped <= threshold) return `background-color:${color};`;
        }
        return `background-color:${TIERS[TIERS.length - 1][1]};`;
    }
</script>

<Card class="flex flex-1 flex-col overflow-hidden">
    <!-- Top bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
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

    <!-- Legend: six discrete tiers from low → high -->
    {#if visibleStrikes.length}
        <div class="flex items-center gap-2 border-b border-border bg-surface px-4 py-1.5 text-[10px] text-muted-foreground">
            <span class="font-semibold uppercase tracking-widest">Scale</span>
            <span class="font-mono">low</span>
            <div class="flex gap-px">
                {#each TIERS as [, color]}
                    <span class="h-3 w-6" style="background:{color};"></span>
                {/each}
            </div>
            <span class="font-mono">high</span>
            <span class="ml-auto font-mono">max {fmtNumber(maxVal, 0)}</span>
        </div>
    {/if}

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
            <table class="hm-table">
                <thead>
                    <tr>
                        <th class="hm-strike-h">Strike</th>
                        {#each dates as d}
                            <th class="hm-date-h">{d}</th>
                        {/each}
                    </tr>
                </thead>
                <tbody>
                    {#each visibleStrikes as s, rowIdx (s.strike)}
                        {@const isATM = rowIdx === atmIdx}
                        <tr class={cn('hm-row', isATM && 'hm-row-atm')}>
                            <td class={cn('hm-strike', isATM && 'hm-strike-atm')}>
                                {fmtStrike(s.strike)}
                            </td>
                            {#each s.values as v}
                                <td class="hm-cell" style={oiStyle(v)}>
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

<style>
    .hm-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: hsl(var(--foreground));
    }

    .hm-strike-h,
    .hm-date-h {
        position: sticky;
        top: 0;
        z-index: 20;
        background: hsl(var(--surface));
        color: hsl(var(--muted-foreground));
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        padding: 8px 8px;
        border-bottom: 1px solid hsl(var(--border));
        white-space: nowrap;
    }
    .hm-strike-h {
        left: 0;
        z-index: 30;
        min-width: 72px;
        text-align: right;
        padding-right: 12px;
        border-right: 1px solid hsl(var(--border));
    }
    .hm-date-h {
        text-align: center;
        min-width: 70px;
    }

    .hm-strike {
        position: sticky;
        left: 0;
        z-index: 10;
        background: hsl(var(--surface));
        color: hsl(var(--muted-foreground));
        font-weight: 600;
        text-align: right;
        padding: 4px 12px 4px 8px;
        min-width: 72px;
        border-right: 1px solid hsl(var(--border));
        border-bottom: 1px solid hsl(var(--background));
        white-space: nowrap;
    }
    .hm-strike-atm {
        background: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
        font-weight: 800;
    }

    .hm-cell {
        padding: 4px 8px;
        text-align: right;
        min-width: 70px;
        white-space: nowrap;
        border-right: 1px solid hsl(var(--background));
        border-bottom: 1px solid hsl(var(--background));
        background-color: hsl(var(--background));
        color: hsl(var(--foreground));
        transition: filter 80ms ease;
    }

    .hm-row-atm .hm-cell {
        box-shadow:
            inset 0 2px 0 hsl(var(--primary)),
            inset 0 -2px 0 hsl(var(--primary));
    }

    .hm-row:hover .hm-cell {
        filter: brightness(1.18);
    }
    .hm-row:hover .hm-strike:not(.hm-strike-atm) {
        background: hsl(var(--surface-elevated));
        color: hsl(var(--foreground));
    }
</style>
