<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import ScoreMeter from './ScoreMeter.svelte';
    import OILadder from './OILadder.svelte';
    import { biasVariant, fmtNumber, fmtStrike, toneClasses } from '$lib/utils.js';

    let { contract = null } = $props();

    const bias = $derived(biasVariant(contract?.position_bias?.label, contract?.position_bias?.score || 0));
    const tones = $derived(toneClasses(bias.tone));
    const score = $derived(contract?.position_bias?.score ?? 0);
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

<Card class="overflow-hidden">
    <div class="flex flex-col gap-4 p-5">
        <!-- Header row -->
        <header class="flex items-start justify-between gap-3 min-w-0">
            <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2">
                    <Badge variant="muted">{contract?.contract_key?.toUpperCase() || '—'}</Badge>
                    {#if contract?.confidence}
                        <Badge variant="outline">
                            {contract.confidence} conf.
                        </Badge>
                    {/if}
                </div>
                <span class="truncate font-mono text-xl font-semibold tracking-tight text-foreground">
                    {contract?.contract || '—'}
                </span>
            </div>
            <div class="flex flex-col items-end gap-0.5 shrink-0">
                <span class="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {fmtNumber(contract?.dte, 1)} DTE
                </span>
                <span class="font-mono text-base font-medium tabular-nums text-primary">
                    {fmtStrike(contract?.future_price)}
                </span>
            </div>
        </header>

        <!-- Bias row -->
        <div class="flex items-center gap-3 min-w-0">
            <Badge variant={bias.tone === 'up' ? 'up' : bias.tone === 'down' ? 'down' : 'muted'} class="text-[11px]">
                {bias.label}
            </Badge>
            <span class="font-mono text-[11px] tabular-nums {tones.text} shrink-0">
                {score > 0 ? '+' : ''}{fmtNumber(score, 2)}
            </span>
            <ScoreMeter {score} scale={20} />
        </div>

        <!-- OI Ladder -->
        <OILadder positionMap={contract?.position_map} futurePrice={contract?.future_price} />

        <!-- Metrics row -->
        <div class="grid grid-cols-3 gap-2">
            <div class="rounded-md border border-border bg-background px-2.5 py-2">
                <div class="mb-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    P/C Ratio
                </div>
                <div class="font-mono text-sm font-semibold tabular-nums {pcrTones.text}">
                    {fmtNumber(pcr, 2)}
                </div>
            </div>
            <div class="rounded-md border border-border bg-background px-2.5 py-2">
                <div class="mb-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Call Wall
                </div>
                <div class="font-mono text-sm font-semibold tabular-nums text-call">
                    {nearCall != null ? `+${fmtNumber(Math.abs(nearCall), 0)}` : '—'}
                    <span class="ml-0.5 font-sans text-[10px] text-muted-foreground">pts</span>
                </div>
            </div>
            <div class="rounded-md border border-border bg-background px-2.5 py-2">
                <div class="mb-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Put Wall
                </div>
                <div class="font-mono text-sm font-semibold tabular-nums text-put">
                    {nearPut != null ? `${fmtNumber(Math.abs(nearPut), 0)}` : '—'}
                    <span class="ml-0.5 font-sans text-[10px] text-muted-foreground">pts</span>
                </div>
            </div>
        </div>
    </div>
</Card>
