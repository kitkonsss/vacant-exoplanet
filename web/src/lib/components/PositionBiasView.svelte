<script>
    import Card from './ui/Card.svelte';
    import ContractCard from './ContractCard.svelte';

    let { payload = null, loading = false } = $props();

    const contracts = $derived(payload?.contracts || []);
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
    <div class="grid grid-cols-1 gap-4">
        {#each contracts as contract (contract.contract_key)}
            <ContractCard {contract} />
        {/each}
    </div>
{/if}
