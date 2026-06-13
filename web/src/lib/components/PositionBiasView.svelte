<script>
    import Card from './ui/Card.svelte';
    import ContractCard from './ContractCard.svelte';
    import { cn } from '$lib/utils.js';

    let { payload = null, loading = false } = $props();

    const contracts = $derived(payload?.contracts || []);

    // One selector for the whole view: flip every contract's wall chart between
    // split (Call/Put side-by-side) and total (combined Put+Call) at once.
    let mode = $state('split'); // 'split' | 'total'
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

        <div class="grid grid-cols-1 gap-4">
            <!-- Key by index, not contract_key: after a contract roll the scraper
                 can write a duplicate contract_key across slots (e.g. tomorrow +
                 friday both pointing at the same option), which would crash the
                 keyed each with `each_key_duplicate` and blank the whole tab. -->
            {#each contracts as contract, i (i)}
                <ContractCard {contract} {mode} />
            {/each}
        </div>
    </div>
{/if}
