<script>
    import { fmtK, fmtStrike } from '$lib/utils.js';

    let { positionMap = [], futurePrice = null, compact = false } = $props();

    const sorted = $derived([...(positionMap || [])].sort((a, b) => b.strike - a.strike));
    function callTotal(l) {
        return (l.call_oi || 0) + (l.call_volume || 0);
    }
    function putTotal(l) {
        return (l.put_oi || 0) + (l.put_volume || 0);
    }
    const maxOI = $derived(
        Math.max(
            ...sorted.flatMap((l) => [callTotal(l), putTotal(l)]),
            1
        )
    );

    function isKey(lv, price) {
        const isCallWall = (lv.side === 'call_wall' || lv.side === 'call') && lv.strike > (price || 0);
        const isPutWall = (lv.side === 'put_wall' || lv.side === 'put') && lv.strike < (price || 0);
        return isCallWall || isPutWall;
    }

    function pctOf(value) {
        return Math.min(Math.round(((value || 0) / maxOI) * 100), 100);
    }

    const strikeColumnWidth = $derived(compact ? '64px' : '72px');
    const oiNumberWidth = $derived(compact ? '30px' : '34px');
</script>

{#if sorted.length === 0}
    <div class="rounded-md border border-border bg-background py-6 text-center text-xs text-muted-foreground">
        No position data
    </div>
{:else}
    <div class={`overflow-hidden rounded-md border border-border bg-background ${compact ? 'py-1' : 'py-1.5'}`}>
        <div
            class={`grid items-center border-b border-border font-mono font-semibold uppercase tracking-widest text-muted-foreground ${compact ? 'gap-1.5 px-2.5 pb-1 text-[8px]' : 'gap-2 px-3 pb-1.5 text-[9px]'}`}
            style={`grid-template-columns: 1fr ${strikeColumnWidth} 1fr;`}
        >
            <span class="text-left">Put</span>
            <span class="text-center">Strike</span>
            <span class="text-right">Call</span>
        </div>

        {#each sorted as lv, idx (lv.strike + '-' + idx)}
            {@const insertPriceBefore =
                futurePrice != null &&
                lv.strike < futurePrice &&
                (idx === 0 || sorted[idx - 1].strike >= futurePrice)}

            {#if insertPriceBefore}
                <div
                    class={`my-1 grid items-center ${compact ? 'gap-1.5 px-2.5 h-[18px]' : 'gap-2 px-3 h-5'}`}
                    style={`grid-template-columns: 1fr ${strikeColumnWidth} 1fr;`}
                >
                    <div class="h-px bg-primary"></div>
                    <div class={`rounded text-center font-mono font-bold text-primary-foreground bg-primary ${compact ? 'px-1 py-0 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'}`}>
                        {fmtStrike(futurePrice)}
                    </div>
                    <div class="h-px bg-primary"></div>
                </div>
            {/if}

            {@const key = isKey(lv, futurePrice)}
            <div
                class={`grid items-center ${compact ? 'gap-1.5 px-2.5 h-[18px]' : 'gap-2 px-3 h-5'} ${key ? 'bg-surface-elevated' : ''}`}
                style={`grid-template-columns: 1fr ${strikeColumnWidth} 1fr;`}
            >
                <!-- Put side -->
                <div class={`flex items-center min-w-0 ${compact ? 'gap-1.5' : 'gap-2'}`}>
                    <span class={`shrink-0 text-right font-mono tabular-nums text-muted-foreground ${compact ? 'text-[9px]' : 'text-[10px]'}`} style={`min-width:${oiNumberWidth}`}>
                        {fmtK(putTotal(lv))}
                    </span>
                    <div class={`flex flex-1 justify-end overflow-hidden rounded-sm bg-muted ${compact ? 'h-1' : 'h-1.5'}`}>
                        <div class="h-full rounded-sm bg-put" style="width:{pctOf(putTotal(lv))}%"></div>
                    </div>
                </div>

                <!-- Strike -->
                <div
                    class={`text-center font-mono tabular-nums ${compact ? 'text-[10px]' : 'text-[11px]'} ${key ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}
                >
                    {fmtStrike(lv.strike)}
                </div>

                <!-- Call side -->
                <div class={`flex items-center min-w-0 ${compact ? 'gap-1.5' : 'gap-2'}`}>
                    <div class={`flex flex-1 justify-start overflow-hidden rounded-sm bg-muted ${compact ? 'h-1' : 'h-1.5'}`}>
                        <div class="h-full rounded-sm bg-call" style="width:{pctOf(callTotal(lv))}%"></div>
                    </div>
                    <span class={`shrink-0 text-left font-mono tabular-nums text-muted-foreground ${compact ? 'text-[9px]' : 'text-[10px]'}`} style={`min-width:${oiNumberWidth}`}>
                        {fmtK(callTotal(lv))}
                    </span>
                </div>
            </div>
        {/each}

        {#if futurePrice != null && sorted.every((s) => s.strike >= futurePrice)}
            <div
                class={`my-1 grid items-center ${compact ? 'gap-1.5 px-2.5 h-[18px]' : 'gap-2 px-3 h-5'}`}
                style={`grid-template-columns: 1fr ${strikeColumnWidth} 1fr;`}
            >
                <div class="h-px bg-primary"></div>
                <div class={`rounded text-center font-mono font-bold text-primary-foreground bg-primary ${compact ? 'px-1 py-0 text-[9px]' : 'px-1.5 py-0.5 text-[10px]'}`}>
                    {fmtStrike(futurePrice)}
                </div>
                <div class="h-px bg-primary"></div>
            </div>
        {/if}
    </div>
{/if}
