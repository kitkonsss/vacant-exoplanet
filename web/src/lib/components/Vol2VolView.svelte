<script>
    import ExpectedRangeView from './ExpectedRangeView.svelte';
    import StrikeOITable from './StrikeOITable.svelte';
    import { cn } from '$lib/utils.js';
    import { CONTRACT_OPTIONS } from '$lib/config.js';

    let {
        contractKey = $bindable('current'),
        availableContracts = [],
        data = null, // parsed OIData for the active contract
        heatmap = null, // {contract}_OIHeatmap.json for the active contract (ΔOI)
        loading = false,
        onChangeContract = (_key) => {}
    } = $props();

    const contracts = $derived(
        CONTRACT_OPTIONS.filter(({ key }) => availableContracts.includes(key))
    );

    function pickContract(key) {
        contractKey = key;
        onChangeContract(key);
    }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
    <!-- Contract pill switcher (mirrors HeatmapView) -->
    {#if contracts.length}
        <div class="flex shrink-0 items-center gap-2">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Contract</span>
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

    <div class="shrink-0">
        <ExpectedRangeView {data} {loading} />
    </div>

    <StrikeOITable {data} {heatmap} {loading} />
</div>
