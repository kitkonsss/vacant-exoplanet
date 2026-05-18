<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import ContractCard from './ContractCard.svelte';
    import ScoreMeter from './ScoreMeter.svelte';
    import { biasVariant, fmtDateTime, fmtNumber, toneClasses } from '$lib/utils.js';

    let { payload = null, loading = false } = $props();

    const summary = $derived(payload?.summary);
    const contracts = $derived(payload?.contracts || []);

    const bias = $derived(
        biasVariant(summary?.position_bias?.label, summary?.position_bias?.score || 0)
    );
    const tones = $derived(toneClasses(bias.tone));
    const score = $derived(summary?.position_bias?.score ?? 0);
    const accentColor = $derived(
        tones.text === 'text-up' ? 'hsl(var(--up))'
        : tones.text === 'text-down' ? 'hsl(var(--down))'
        : 'hsl(var(--muted-foreground))'
    );
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Loading position bias…</span>
        </div>
    </div>
{:else if !summary && contracts.length === 0}
    <Card class="p-8 text-center">
        <div class="font-semibold text-foreground">No Position Bias Data</div>
        <p class="mt-1 text-sm text-muted-foreground">
            The scraper has not published position-bias JSON yet.
        </p>
    </Card>
{:else}
    <!-- Summary header -->
    <Card class="relative overflow-hidden">
        <!-- top accent strip -->
        <div class="absolute inset-x-0 top-0 h-[2px]" style="background: {accentColor};"></div>
        <div class="grid gap-5 p-5 xl:grid-cols-[auto_minmax(0,_1fr)_auto] xl:items-center">
            <div class="shrink-0">
                <div class="flex items-center gap-2">
                    <span class="h-1.5 w-1.5 rounded-full" style="background: {accentColor};"></span>
                    <div class="text-[10px] font-semibold uppercase tracking-widest-2 text-muted-foreground">
                        {summary?.asset_name || '—'}
                    </div>
                </div>
                <div class="mt-1 font-mono text-2xl font-semibold uppercase tracking-tight leading-none {tones.text}">
                    {bias.label}
                </div>
            </div>

            <div class="flex min-w-0 flex-col gap-2">
                <div class="flex justify-between text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    <span>Bearish</span>
                    <span>Neutral</span>
                    <span>Bullish</span>
                </div>
                <ScoreMeter {score} scale={20} size="lg" />
                <div class="text-center font-mono text-xs font-semibold tabular-nums {tones.text}">
                    {score > 0 ? '+' : ''}{fmtNumber(score, 2)}
                </div>
            </div>

            <div class="grid gap-3 text-left sm:grid-cols-2 xl:grid-cols-1 xl:justify-items-end xl:text-right">
                <div>
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Contracts
                    </div>
                    <div class="font-mono text-sm font-semibold tabular-nums text-foreground">
                        {fmtNumber(contracts.length)}
                    </div>
                </div>
                <div>
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Updated
                    </div>
                    <div class="font-mono text-[10px] text-foreground">
                        {fmtDateTime(summary?.generated_at)}
                    </div>
                </div>
            </div>
        </div>
    </Card>

    <!-- Contract cards -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {#each contracts as contract (contract.contract_key)}
            <ContractCard {contract} />
        {/each}
    </div>
{/if}
