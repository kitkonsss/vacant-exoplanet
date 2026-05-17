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

    /** @type {'oi' | 'delta'} */
    let viewMode = $state('oi');

    const views = [
        { key: 'oi',    label: 'OI',  hint: 'Absolute open interest' },
        { key: 'delta', label: 'ΔOI', hint: 'Day-over-day change vs previous date' }
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

    /**
     * Day-over-day delta for each (strike, date) — dates are sorted recent→old
     * so the "previous day" for column i is column i+1.
     * @type {Array<Array<number | null>>}
     */
    const deltas = $derived.by(() => {
        return visibleStrikes.map((s) => {
            const vals = s.values || [];
            return vals.map((v, i) => {
                const prev = vals[i + 1];
                if (v == null || prev == null) return null;
                return v - prev;
            });
        });
    });

    /**
     * Reference magnitude used to normalize the diverging delta ramp.
     * Use a high quantile rather than absolute max so a single outlier
     * doesn't wash out the rest of the grid.
     */
    const deltaScale = $derived.by(() => {
        const abs = [];
        for (const row of deltas) {
            for (const d of row) {
                if (d != null && d !== 0) abs.push(Math.abs(d));
            }
        }
        if (!abs.length) return 1;
        abs.sort((a, b) => a - b);
        // 90th percentile so the visible range stays meaningful
        const idx = Math.floor(abs.length * 0.9);
        return Math.max(abs[idx] || abs[abs.length - 1], 1);
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
     * Log-scaled emerald ramp for absolute OI values. Muted so the grid
     * doesn't strain the eyes.
     */
    function oiStyle(value) {
        if (value == null || !Number.isFinite(value) || value <= 0 || maxVal <= 0) return '';
        const t = Math.log10(value + 1) / Math.log10(maxVal + 1);
        const clamped = Math.max(0, Math.min(1, t));
        const lightness = 10 + clamped * 24;
        const saturation = 10 + clamped * 40;
        return `background-color:hsl(142 ${saturation.toFixed(0)}% ${lightness.toFixed(0)}%);`;
    }

    /**
     * Diverging palette for day-over-day delta.
     *   - positive delta (added OI) → emerald (hue 142)
     *   - negative delta (removed OI) → red (hue 0)
     *   - near-zero → background (no color)
     * Intensity scales with |delta| / deltaScale, capped at 1.
     */
    function deltaStyle(delta) {
        if (delta == null || !Number.isFinite(delta)) return '';
        const ratio = Math.max(-1, Math.min(1, delta / deltaScale));
        const mag = Math.abs(ratio);
        // Anything below ~3% of the reference magnitude stays neutral
        if (mag < 0.03) return '';
        const hue = ratio >= 0 ? 142 : 0;
        // Cap intensity below "screaming" — saturation 25-65%, lightness 12-36%
        const saturation = 25 + mag * 40;
        const lightness = 12 + mag * 24;
        return `background-color:hsl(${hue} ${saturation.toFixed(0)}% ${lightness.toFixed(0)}%);`;
    }

    function cellStyle(value, delta) {
        return viewMode === 'delta' ? deltaStyle(delta) : oiStyle(value);
    }

    function cellText(value, delta) {
        if (viewMode === 'delta') {
            if (delta == null) return '';
            if (delta === 0) return '0';
            const sign = delta > 0 ? '+' : '';
            return `${sign}${fmtNumber(delta, 0)}`;
        }
        return value == null ? '' : fmtNumber(value, 0);
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

        <div class="flex flex-wrap items-center gap-4">
            <!-- View-mode pills -->
            <div class="flex items-center gap-2">
                <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    View
                </span>
                <div class="flex gap-1">
                    {#each views as v}
                        {@const isActive = v.key === viewMode}
                        <button
                            type="button"
                            title={v.hint}
                            onclick={() => (viewMode = v.key)}
                            class={cn(
                                'rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                                isActive
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                            )}
                        >
                            {v.label}
                        </button>
                    {/each}
                </div>
            </div>

            <!-- Contract pills -->
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
    </div>

    <!-- Legend strip (only for delta view, to teach the colors) -->
    {#if viewMode === 'delta' && visibleStrikes.length}
        <div class="flex items-center gap-3 border-b border-border bg-surface px-4 py-1.5 text-[10px] text-muted-foreground">
            <span class="font-semibold uppercase tracking-widest">Legend</span>
            <span class="inline-flex items-center gap-1.5">
                <span class="h-2.5 w-4 rounded-sm" style="background:hsl(0 65% 36%);"></span>
                Removed
            </span>
            <span class="inline-flex items-center gap-1.5">
                <span class="h-2.5 w-4 rounded-sm" style="background:hsl(142 65% 36%);"></span>
                Added
            </span>
            <span class="ml-auto font-mono">scale ±{fmtNumber(deltaScale, 0)} (90p)</span>
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
                            {#each s.values as v, i}
                                {@const d = deltas[rowIdx]?.[i] ?? null}
                                <td class="hm-cell" style={cellStyle(v, d)}>
                                    {cellText(v, d)}
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
        filter: brightness(1.15);
    }
    .hm-row:hover .hm-strike:not(.hm-strike-atm) {
        background: hsl(var(--surface-elevated));
        color: hsl(var(--foreground));
    }
</style>
