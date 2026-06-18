<script>
    import Card from './ui/Card.svelte';
    import { cn, fmtNumber, fmtStrike } from '$lib/utils.js';
    import { ASSET_PROFILES, CONTRACT_OPTIONS } from '$lib/config.js';

    let {
        assetId = 'gc',
        contractKey = $bindable('current'),
        availableContracts = [],
        data = null,
        loading = false,
        onChangeContract = (_key) => {},
        title = 'OI Heatmap',
        valueDecimals = 0,
        heatScale = 'log', // 'log' for OI counts, 'linear' for small floats like gamma
        emptyFile = '_OIHeatmap.json',
        columnLabel = 'Date',    // column-header label shown above each data column
        showChangeToggle = false
    } = $props();

    let viewMode = $state('oi');

    const profile = $derived(ASSET_PROFILES[assetId]);
    const contracts = $derived(
        CONTRACT_OPTIONS.filter(({ key }) => availableContracts.includes(key))
    );

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
    const canShowChange = $derived(showChangeToggle && emptyFile === '_OIHeatmap.json' && dates.length > 1);
    const displayDates = $derived(viewMode === 'change' && canShowChange ? dates.slice(0, -1) : dates);

    $effect(() => {
        if (!canShowChange && viewMode === 'change') viewMode = 'oi';
    });

    function deltaValues(values = []) {
        return values.slice(0, -1).map((value, idx) => {
            if (value == null || !Number.isFinite(value)) return null;
            const previous = values.slice(idx + 1).find((v) => v != null && Number.isFinite(v));
            return previous == null ? null : value - previous;
        });
    }

    const displayStrikes = $derived.by(() => {
        const isChange = viewMode === 'change' && canShowChange;
        return visibleStrikes.map((strike) => ({
            ...strike,
            displayValues: isChange ? deltaValues(strike.values || []) : (strike.values || [])
        }));
    });

    const maxVal = $derived.by(() => {
        let m = 1;
        for (const s of displayStrikes) {
            for (const v of s.displayValues || []) {
                const abs = Math.abs(v || 0);
                if (v != null && abs > m) m = abs;
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
     * `text` is 'light' (white on dark cell) or 'dark' (near-black on
     * bright cell) — flips at the tier where the green is too bright
     * for white text to stay readable.
     */
    const TIERS = [
        // [maxT, background, text]
        [0.30, 'hsl(0 0% 11%)',     'light'],
        [0.50, 'hsl(142 18% 16%)',  'light'],
        [0.70, 'hsl(142 32% 22%)',  'light'],
        [0.84, 'hsl(142 48% 30%)',  'light'],
        [0.94, 'hsl(142 62% 40%)',  'dark'],
        [1.01, 'hsl(142 78% 52%)',  'dark']
    ];
    const DELTA_POS_TIERS = ['hsl(142 18% 16%)', 'hsl(142 32% 22%)', 'hsl(142 48% 30%)', 'hsl(142 62% 40%)', 'hsl(142 78% 52%)'];
    const DELTA_NEG_TIERS = ['hsl(0 22% 16%)', 'hsl(0 36% 22%)', 'hsl(0 52% 30%)', 'hsl(0 70% 42%)', 'hsl(0 84% 64%)'];
    const DELTA_NEG_LEGEND = [...DELTA_NEG_TIERS].reverse();

    const DARK_TEXT = 'hsl(0 0% 6%)';
    const WALL_HEAT = 0.92;
    const HOT_STRIKE_HEAT = 0.80;
    const isChangeMode = $derived(viewMode === 'change' && canShowChange);

    function heatRatio(value) {
        const abs = Math.abs(value || 0);
        if (value == null || !Number.isFinite(value) || abs <= 0 || maxVal <= 0) {
            return 0;
        }
        const ratio = heatScale === 'linear' && !isChangeMode
            ? abs / maxVal
            : Math.log10(abs + 1) / Math.log10(maxVal + 1);
        return Math.max(0, Math.min(1, ratio));
    }

    function strikeHeat(strike) {
        let heat = 0;
        for (const v of strike.displayValues || []) {
            heat = Math.max(heat, heatRatio(v));
        }
        return heat;
    }

    function deltaStyle(value) {
        const clamped = heatRatio(value);
        if (clamped <= 0) return '';
        const palette = value < 0 ? DELTA_NEG_TIERS : DELTA_POS_TIERS;
        const idx = Math.min(palette.length - 1, Math.max(0, Math.ceil(clamped * palette.length) - 1));
        const text = idx >= 3 ? `color:${DARK_TEXT};font-weight:700;` : '';
        return `background-color:${palette[idx]};${text}`;
    }

    function oiStyle(value) {
        if (isChangeMode) return deltaStyle(value);
        const clamped = heatRatio(value);
        if (clamped <= 0) {
            return '';
        }
        for (const [threshold, bg, mode] of TIERS) {
            if (clamped <= threshold) {
                return mode === 'dark'
                    ? `background-color:${bg};color:${DARK_TEXT};font-weight:700;`
                    : `background-color:${bg};`;
            }
        }
        const last = TIERS[TIERS.length - 1];
        return `background-color:${last[1]};color:${DARK_TEXT};font-weight:700;`;
    }

    function cellClass(value) {
        if (heatRatio(value) < WALL_HEAT) return '';
        if (!isChangeMode) return 'hm-cell-wall';
        return value < 0 ? 'hm-cell-delta-hot-down' : 'hm-cell-delta-hot-up';
    }

    function fmtCell(value) {
        if (value == null) return '';
        if (!isChangeMode) return fmtNumber(value, valueDecimals);
        return `${value > 0 ? '+' : ''}${fmtNumber(value, valueDecimals)}`;
    }
</script>

<Card class="flex flex-1 flex-col overflow-hidden">
    <!-- Top bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-primary"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                {title}
            </span>
            <span class="truncate text-[10px] text-muted-foreground">
                {#if data}
                    {displayDates.length} {columnLabel.toLowerCase() === 'expiration' ? 'expirations' : 'days'} × {visibleStrikes.length} strikes
                    {#if data.contract} · <span class="font-mono">{data.contract}</span>{/if}
                {:else if !loading}
                    No data
                {/if}
            </span>
        </div>

        <!-- Contract pill switcher (only when caller provided contracts) -->
        {#if canShowChange}
            <div class="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
                <button
                    type="button"
                    aria-pressed={viewMode === 'oi'}
                    onclick={() => (viewMode = 'oi')}
                    class={cn(
                        'min-w-12 rounded px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        viewMode === 'oi' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    OI
                </button>
                <button
                    type="button"
                    aria-pressed={viewMode === 'change'}
                    onclick={() => (viewMode = 'change')}
                    class={cn(
                        'min-w-12 rounded px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        viewMode === 'change' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    ΔOI
                </button>
            </div>
        {/if}

        {#if contracts.length}
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
        {/if}
    </div>

    <!-- Legend: six discrete tiers from low → high -->
    {#if visibleStrikes.length}
        <div class="flex items-center gap-2 border-b border-border bg-surface px-4 py-1.5 text-[10px] text-muted-foreground">
            {#if isChangeMode}
                <span class="font-semibold uppercase tracking-widest">ΔOI</span>
                <span class="font-mono">−</span>
                <div class="flex gap-px">
                    {#each DELTA_NEG_LEGEND as color}
                        <span class="h-3 w-5" style="background:{color};"></span>
                    {/each}
                    <span class="h-3 w-5 bg-background"></span>
                    {#each DELTA_POS_TIERS as color}
                        <span class="h-3 w-5" style="background:{color};"></span>
                    {/each}
                </div>
                <span class="font-mono">+</span>
                <span class="ml-auto font-mono">max Δ {fmtNumber(maxVal, valueDecimals)}</span>
            {:else}
                <span class="font-semibold uppercase tracking-widest">Scale</span>
                <span class="font-mono">low</span>
                <div class="flex gap-px">
                    {#each TIERS as [, color]}
                        <span class="h-3 w-6" style="background:{color};"></span>
                    {/each}
                </div>
                <span class="font-mono">high</span>
                <span class="ml-auto font-mono">max {fmtNumber(maxVal, valueDecimals)}</span>
            {/if}
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
                        <span class="font-mono text-foreground">{contracts.length ? contractKey + emptyFile : emptyFile}</span>.
                    </p>
                </div>
            </div>
        {:else}
            <table class="hm-table">
                <thead>
                    <tr>
                        <th class="hm-strike-h">Strike</th>
                        {#each displayDates as d}
                            <th class="hm-date-h">{d}</th>
                        {/each}
                    </tr>
                </thead>
                <tbody>
                    {#each displayStrikes as s, rowIdx (s.strike)}
                        {@const isATM = rowIdx === atmIdx}
                        {@const isHotStrike = strikeHeat(s) >= HOT_STRIKE_HEAT}
                        <tr class={cn('hm-row', isChangeMode && 'hm-row-delta', isATM && 'hm-row-atm', isHotStrike && 'hm-row-hot')}>
                            <td class={cn('hm-strike', isATM && 'hm-strike-atm', isHotStrike && 'hm-strike-hot')}>
                                {fmtStrike(s.strike)}
                            </td>
                            {#each s.displayValues as v}
                                <td class={cn('hm-cell', cellClass(v))} style={oiStyle(v)}>
                                    {fmtCell(v)}
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
        position: relative;
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

    .hm-row-hot .hm-cell {
        border-top: 1px solid hsl(142 86% 64%);
        border-bottom: 1px solid hsl(142 86% 64%);
    }
    .hm-row-delta.hm-row-hot .hm-cell {
        border-top-color: hsl(var(--warn));
        border-bottom-color: hsl(var(--warn));
    }

    .hm-strike-hot:not(.hm-strike-atm) {
        background: hsl(142 48% 18%);
        color: hsl(142 86% 70%);
        text-shadow: 0 0 10px hsl(142 86% 56%);
    }

    .hm-cell-wall {
        z-index: 1;
        outline: 1px solid hsl(142 92% 72%);
        outline-offset: -2px;
        box-shadow:
            inset 0 0 0 1px hsl(142 92% 72%),
            inset 0 0 14px hsl(142 86% 30%),
            0 0 12px hsl(142 86% 42%);
        text-shadow: 0 0 7px hsl(0 0% 100%);
    }

    .hm-cell-delta-hot-up,
    .hm-cell-delta-hot-down {
        z-index: 1;
        outline-offset: -2px;
        text-shadow: 0 0 7px hsl(0 0% 100%);
    }
    .hm-cell-delta-hot-up {
        outline: 1px solid hsl(142 92% 72%);
        box-shadow:
            inset 0 0 0 1px hsl(142 92% 72%),
            inset 0 0 14px hsl(142 86% 30%),
            0 0 12px hsl(142 86% 42%);
    }
    .hm-cell-delta-hot-down {
        outline: 1px solid hsl(0 94% 78%);
        box-shadow:
            inset 0 0 0 1px hsl(0 94% 78%),
            inset 0 0 14px hsl(0 74% 34%),
            0 0 12px hsl(0 84% 52%);
    }

    .hm-row-atm .hm-cell {
        box-shadow:
            inset 0 2px 0 hsl(var(--primary)),
            inset 0 -2px 0 hsl(var(--primary));
    }

    .hm-row-atm .hm-cell-wall {
        box-shadow:
            inset 0 2px 0 hsl(var(--primary)),
            inset 0 -2px 0 hsl(var(--primary)),
            inset 0 0 0 1px hsl(142 92% 72%),
            inset 0 0 14px hsl(142 86% 30%),
            0 0 12px hsl(142 86% 42%);
    }
    .hm-row-atm .hm-cell-delta-hot-up {
        box-shadow:
            inset 0 2px 0 hsl(var(--primary)),
            inset 0 -2px 0 hsl(var(--primary)),
            inset 0 0 0 1px hsl(142 92% 72%),
            inset 0 0 14px hsl(142 86% 30%),
            0 0 12px hsl(142 86% 42%);
    }
    .hm-row-atm .hm-cell-delta-hot-down {
        box-shadow:
            inset 0 2px 0 hsl(var(--primary)),
            inset 0 -2px 0 hsl(var(--primary)),
            inset 0 0 0 1px hsl(0 94% 78%),
            inset 0 0 14px hsl(0 74% 34%),
            0 0 12px hsl(0 84% 52%);
    }

    .hm-row:hover .hm-cell {
        filter: brightness(1.18);
    }
    .hm-row:hover .hm-strike:not(.hm-strike-atm) {
        background: hsl(var(--surface-elevated));
        color: hsl(var(--foreground));
    }
</style>
