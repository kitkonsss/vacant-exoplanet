<script>
    import Card from './ui/Card.svelte';
    import { cn, fmtNumber } from '$lib/utils.js';
    import { expectedRange, priceSdLocation } from '$lib/vol2vol.js';

    // `data` is the parsed OIData object:
    // { contract, futPrc, futureChg, vol, dte, settle, strikes }
    let { data = null, loading = false } = $props();

    // Editable "Fix Range" override of the computed 1 SD (vol2vol behaviour).
    // null → use the IV-derived default. Reset whenever the contract changes.
    let fixRange = $state(null);
    let lastContract = $state(null);
    $effect(() => {
        const key = data?.contract ?? null;
        if (key !== lastContract) {
            lastContract = key;
            fixRange = null;
        }
    });

    const range = $derived(
        data
            ? expectedRange({ settle: data.settle, vol: data.vol, dte: data.dte, fixRange })
            : null
    );

    const loc = $derived(
        data && range ? priceSdLocation(data.futPrc, data.settle, range.sd[0]) : null
    );

    // Which SD zone the live price currently sits in (1..3), and which side.
    const activeBand = $derived(loc ? Math.min(3, Math.floor(Math.abs(loc.z)) + 1) : 0);
    const activeSide = $derived(loc ? (loc.sign < 0 ? 'buy' : loc.sign > 0 ? 'sell' : null) : null);

    const ROWS = [
        { k: 1, label: '1 SD', sub: 'เข้าสู่ 2SD' },
        { k: 2, label: '2 SD', sub: 'เข้าสู่ 3SD' },
        { k: 3, label: '3 SD', sub: 'เข้าสู่ขอบ IV' }
    ];

    function locTone() {
        if (!loc) return 'text-muted-foreground';
        if (loc.sign < 0) return 'text-down';
        if (loc.sign > 0) return 'text-up';
        return 'text-foreground';
    }
</script>

<Card class="overflow-hidden">
    <!-- Top bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-warn"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                Expected Range · ระยะวิ่ง
            </span>
            {#if data?.contract}
                <span class="truncate font-mono text-[10px] text-muted-foreground">{data.contract}</span>
            {/if}
        </div>
        {#if data}
            <div class="flex items-center gap-4 font-mono text-[11px] tabular-nums">
                <span class="text-muted-foreground">
                    Settle <span class="font-semibold text-foreground">{fmtNumber(data.settle, 1)}</span>
                </span>
                <span class="text-muted-foreground">
                    Future <span class="font-semibold text-primary">{fmtNumber(data.futPrc, 1)}</span>
                </span>
                <span class="text-muted-foreground">
                    IV <span class="font-semibold text-foreground">{fmtNumber(data.vol, 2)}%</span>
                </span>
                <span class="text-muted-foreground">
                    {fmtNumber(data.dte, 2)} DTE
                </span>
            </div>
        {/if}
    </div>

    {#if loading}
        <div class="flex h-40 items-center justify-center text-muted-foreground">
            <div class="flex items-center gap-3">
                <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                <span class="text-sm">Loading expected range…</span>
            </div>
        </div>
    {:else if !data || !range}
        <div class="flex h-40 items-center justify-center text-center">
            <div>
                <div class="text-sm font-semibold text-foreground">No expected-range data</div>
                <p class="mt-1 max-w-md text-xs text-muted-foreground">
                    Run the scraper to publish <span class="font-mono text-foreground">{`{contract}_OIData.txt`}</span>.
                </p>
            </div>
        </div>
    {:else}
        <!-- Live SD-location readout + Fix Range editor -->
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5">
            <div class="flex items-baseline gap-2">
                <span class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">ราคาอยู่ที่</span>
                <span class={cn('font-mono text-xl font-bold tabular-nums', locTone())}>
                    {#if loc}{loc.z >= 0 ? '+' : '−'}{fmtNumber(Math.abs(loc.z), 2)} SD{:else}—{/if}
                </span>
                <span class="text-[11px] text-muted-foreground">
                    {#if loc && loc.sign !== 0}
                        ({loc.sign < 0 ? 'ต่ำกว่า' : 'สูงกว่า'} settle {fmtNumber(Math.abs(data.futPrc - data.settle), 1)} pts)
                    {/if}
                </span>
            </div>

            <label class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Fix Range (1SD)
                <input
                    type="number"
                    step="0.1"
                    min="0"
                    placeholder={range.computed1sd != null ? fmtNumber(range.computed1sd, 1) : '—'}
                    value={fixRange ?? ''}
                    oninput={(e) => {
                        const v = parseFloat(e.currentTarget.value);
                        fixRange = Number.isFinite(v) && v > 0 ? v : null;
                    }}
                    class="h-7 w-24 rounded-md border border-border bg-background px-2 text-right font-mono text-xs font-medium tabular-nums text-foreground focus:border-primary focus:outline-none"
                />
                {#if fixRange != null}
                    <button
                        type="button"
                        onclick={() => (fixRange = null)}
                        class="rounded border border-border px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground hover:text-foreground"
                    >
                        reset
                    </button>
                {:else if range.computed1sd != null}
                    <span class="font-mono text-[9px] font-normal normal-case text-muted-foreground">default {fmtNumber(range.computed1sd, 1)}</span>
                {/if}
            </label>
        </div>

        <!-- SD band table -->
        <div class="overflow-x-auto">
            <table class="w-full border-collapse font-mono text-sm tabular-nums">
                <thead>
                    <tr class="bg-surface text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <th class="px-4 py-2 text-left">SD</th>
                        <th class="px-4 py-2 text-right">Range (pts)</th>
                        <th class="px-4 py-2 text-right text-up">ขอบ buy</th>
                        <th class="px-4 py-2 text-right text-down">ขอบ sell</th>
                    </tr>
                </thead>
                <tbody>
                    {#each ROWS as row (row.k)}
                        {@const isActive = activeBand === row.k}
                        <tr class={cn('border-t border-border', isActive && 'bg-warn/10')}>
                            <td class="px-4 py-2.5 text-left">
                                <div class="flex items-center gap-2">
                                    <span class={cn('font-semibold', isActive ? 'text-warn' : 'text-foreground')}>{row.label}</span>
                                    {#if isActive}
                                        <span class="rounded bg-warn/20 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-warn">ราคาอยู่โซนนี้</span>
                                    {/if}
                                </div>
                                <div class="font-sans text-[9px] uppercase tracking-wide text-muted-foreground">{row.sub}</div>
                            </td>
                            <td class="px-4 py-2.5 text-right font-semibold text-foreground">
                                {fmtNumber(range.sd[row.k - 1], 1)}
                            </td>
                            <td class={cn('px-4 py-2.5 text-right text-up', isActive && activeSide === 'buy' && 'font-bold ring-1 ring-inset ring-up/40')}>
                                {fmtNumber(range.edges.buy[row.k - 1], 1)}
                            </td>
                            <td class={cn('px-4 py-2.5 text-right text-down', isActive && activeSide === 'sell' && 'font-bold ring-1 ring-inset ring-down/40')}>
                                {fmtNumber(range.edges.sell[row.k - 1], 1)}
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <div class="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
            1SD = Settle × (IV/100) × √(DTE/365) · centred on settlement · edges = settle ± k·SD
        </div>
    {/if}
</Card>
