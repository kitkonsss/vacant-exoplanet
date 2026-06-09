<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import OILadder from './OILadder.svelte';
    import { fmtNumber, fmtStrike, toneClasses } from '$lib/utils.js';

    let { contract = null, compact = false, mode = 'split' } = $props();

    const totals = $derived(contract?.totals || {});
    const walls = $derived(contract?.walls || {});
    const pcr = $derived(totals.oi_put_call_ratio);
    const nearCall = $derived(walls.nearest_call_above?.distance?.points);
    const nearPut = $derived(walls.nearest_put_below?.distance?.points);

    function pcrTone(v) {
        if (v == null) return 'muted';
        if (v > 1.05) return 'put';
        if (v < 0.95) return 'call';
        return 'muted';
    }
    const pcrTones = $derived(toneClasses(pcrTone(pcr)));
</script>

<Card class="h-full overflow-hidden">
    <div class={`flex h-full flex-col ${compact ? 'gap-3 p-4' : 'gap-4 p-5'}`}>
        <!-- Header row -->
        <header class="flex items-start justify-between gap-3 min-w-0">
            <div class="flex flex-col gap-1 min-w-0">
                <div class={`flex flex-wrap items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
                    <Badge variant="muted" class={compact ? 'px-1.5 text-[9px]' : ''}>{contract?.contract_key?.toUpperCase() || '—'}</Badge>
                    {#if contract?.confidence}
                        <Badge variant="outline" class={compact ? 'px-1.5 text-[9px]' : ''}>
                            {contract.confidence} conf.
                        </Badge>
                    {/if}
                </div>
                <span class={`truncate font-mono font-semibold tracking-tight leading-none text-foreground ${compact ? 'text-lg' : 'text-xl'}`}>
                    {contract?.contract || '—'}
                </span>
            </div>
            <div class="flex flex-col items-end gap-0.5 shrink-0">
                <span class={`font-mono tabular-nums text-muted-foreground ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
                    {fmtNumber(contract?.dte, 1)} DTE
                </span>
                <span class={`font-mono font-medium tabular-nums text-primary ${compact ? 'text-sm' : 'text-base'}`}>
                    {fmtStrike(contract?.future_price)}
                </span>
            </div>
        </header>

        <!-- OI Ladder -->
        <OILadder positionMap={contract?.position_map} futurePrice={contract?.future_price} {compact} {mode} />

        <!-- Metrics row -->
        <div class={`grid grid-cols-4 ${compact ? 'gap-1.5' : 'gap-2'}`}>
            <div class={`rounded-md border border-border bg-background ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}>
                <div class={`font-semibold uppercase tracking-widest text-muted-foreground ${compact ? 'mb-0.5 text-[8px]' : 'mb-1 text-[9px]'}`}>
                    OI · C / P
                </div>
                <div class={`font-mono font-semibold tabular-nums ${compact ? 'text-xs' : 'text-sm'}`}>
                    <span class="text-call">{fmtNumber(totals.call_oi)}</span>
                    <span class="text-muted-foreground">/</span>
                    <span class="text-put">{fmtNumber(totals.put_oi)}</span>
                </div>
            </div>
            <div class={`rounded-md border border-border bg-background ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}>
                <div class={`font-semibold uppercase tracking-widest text-muted-foreground ${compact ? 'mb-0.5 text-[8px]' : 'mb-1 text-[9px]'}`}>
                    P/C Ratio
                </div>
                <div class={`font-mono font-semibold tabular-nums ${compact ? 'text-xs' : 'text-sm'} ${pcrTones.text}`}>
                    {fmtNumber(pcr, 2)}
                </div>
            </div>
            <div class={`rounded-md border border-border bg-background ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}>
                <div class={`font-semibold uppercase tracking-widest text-muted-foreground ${compact ? 'mb-0.5 text-[8px]' : 'mb-1 text-[9px]'}`}>
                    Call Wall
                </div>
                <div class={`font-mono font-semibold tabular-nums text-call ${compact ? 'text-xs' : 'text-sm'}`}>
                    {nearCall != null ? `+${fmtNumber(Math.abs(nearCall), 0)}` : '—'}
                    <span class={`ml-0.5 font-sans text-muted-foreground ${compact ? 'text-[9px]' : 'text-[10px]'}`}>pts</span>
                </div>
            </div>
            <div class={`rounded-md border border-border bg-background ${compact ? 'px-2 py-1.5' : 'px-2.5 py-2'}`}>
                <div class={`font-semibold uppercase tracking-widest text-muted-foreground ${compact ? 'mb-0.5 text-[8px]' : 'mb-1 text-[9px]'}`}>
                    Put Wall
                </div>
                <div class={`font-mono font-semibold tabular-nums text-put ${compact ? 'text-xs' : 'text-sm'}`}>
                    {nearPut != null ? `${fmtNumber(Math.abs(nearPut), 0)}` : '—'}
                    <span class={`ml-0.5 font-sans text-muted-foreground ${compact ? 'text-[9px]' : 'text-[10px]'}`}>pts</span>
                </div>
            </div>
        </div>
    </div>
</Card>
