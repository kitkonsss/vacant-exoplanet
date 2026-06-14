<script>
    import Card from './ui/Card.svelte';
    import ContractCard from './ContractCard.svelte';
    import { fetchOIData } from '$lib/data.js';
    import { cn } from '$lib/utils.js';

    let { payload = null, loading = false, livePrice = null, assetId = 'gc' } = $props();

    const contracts = $derived(payload?.contracts || []);

    // One selector for the whole view: flip every contract's wall chart between
    // split (Call/Put side-by-side) and total (combined Put+Call) at once.
    let mode = $state('split'); // 'split' | 'total'
    let showIv = $state(true);  // overlay the per-strike IV smile on every chart

    // Per-strike IV smile per contract — pulled from the raw OIData "Vol Settle"
    // column (the only place the full smile lives) and aligned to `contracts` by
    // index as {strike: ivPct} maps (null where a contract has no vol data).
    let ivMaps = $state([]);
    $effect(() => {
        const cs = contracts;
        const a = assetId;
        let stopped = false;
        (async () => {
            const maps = await Promise.all(
                cs.map(async (c) => {
                    const oi = await fetchOIData(a, c.contract_key);
                    if (!oi?.strikes) return null;
                    const m = {};
                    for (const s of oi.strikes) {
                        if (Number.isFinite(s.strike) && s.volSettle > 0) m[s.strike] = s.volSettle * 100;
                    }
                    return Object.keys(m).length ? m : null;
                })
            );
            if (!stopped) ivMaps = maps;
        })();
        return () => { stopped = true; };
    });
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Loading position bias…</span>
        </div>
    </div>
{:else if contracts.length === 0}
    <Card class="p-8 text-center">
        <div class="font-semibold text-foreground">No Position Bias Data</div>
        <p class="mt-1 text-sm text-muted-foreground">
            The scraper has not published position-bias JSON yet.
        </p>
    </Card>
{:else}
    <div class="flex flex-col gap-3">
        <!-- View-level Split/Total selector — controls every wall chart below -->
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2.5">
                <span class="h-3 w-1 rounded-sm bg-primary"></span>
                <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">OI Walls</span>
                <span class="text-[10px] text-muted-foreground">{contracts.length} contract{contracts.length === 1 ? '' : 's'}</span>
            </div>
            <div class="flex items-center gap-2">
                <button
                    type="button"
                    onclick={() => (showIv = !showIv)}
                    title="ทาบเส้น IV smile (วอลแต่ละ strike) ลงบนแท่ง OI"
                    class={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        showIv ? 'border-[#c084fc] text-[#c084fc]' : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                >
                    <span class="inline-block h-[2px] w-3 rounded-sm bg-[#c084fc]"></span> IV smile
                </button>
                <div class="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
                    {#each [['split', 'Call / Put'], ['total', 'Total']] as [key, label]}
                        <button
                            type="button"
                            onclick={() => (mode = key)}
                            class={cn(
                                'rounded px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                                mode === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {label}
                        </button>
                    {/each}
                </div>
            </div>
        </div>

        <div class="grid grid-cols-1 gap-4">
            <!-- Key by index, not contract_key: after a contract roll the scraper
                 can write a duplicate contract_key across slots (e.g. tomorrow +
                 friday both pointing at the same option), which would crash the
                 keyed each with `each_key_duplicate` and blank the whole tab. -->
            {#each contracts as contract, i (i)}
                <ContractCard {contract} {mode} {livePrice} ivByStrike={ivMaps[i] || null} {showIv} />
            {/each}
        </div>
    </div>
{/if}
