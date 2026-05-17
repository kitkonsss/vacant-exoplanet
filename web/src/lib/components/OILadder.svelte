<script>
    import { fmtK, fmtStrike } from '$lib/utils.js';

    let { positionMap = [], futurePrice = null } = $props();

    const sorted = $derived([...(positionMap || [])].sort((a, b) => b.strike - a.strike));
    const maxOI = $derived(
        Math.max(
            ...sorted.flatMap((l) => [l.call_oi || 0, l.put_oi || 0]),
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
</script>

{#if sorted.length === 0}
    <div class="rounded-md border border-border bg-background py-6 text-center text-xs text-muted-foreground">
        No position data
    </div>
{:else}
    <div class="overflow-hidden rounded-md border border-border bg-background py-1.5">
        <div
            class="grid grid-cols-[1fr_72px_1fr] gap-2 border-b border-border px-3 pb-1.5 text-[9px] font-mono font-semibold uppercase tracking-widest text-muted-foreground"
        >
            <span class="text-left">Put OI</span>
            <span class="text-center">Strike</span>
            <span class="text-right">Call OI</span>
        </div>

        {#each sorted as lv, idx (lv.strike + '-' + idx)}
            {@const insertPriceBefore =
                futurePrice != null &&
                lv.strike < futurePrice &&
                (idx === 0 || sorted[idx - 1].strike >= futurePrice)}

            {#if insertPriceBefore}
                <div class="my-1 grid grid-cols-[1fr_72px_1fr] items-center gap-2 px-3 h-5">
                    <div class="h-px bg-primary"></div>
                    <div class="rounded px-1.5 py-0.5 text-center font-mono text-[10px] font-bold text-primary-foreground bg-primary">
                        {fmtStrike(futurePrice)}
                    </div>
                    <div class="h-px bg-primary"></div>
                </div>
            {/if}

            {@const key = isKey(lv, futurePrice)}
            <div
                class="grid grid-cols-[1fr_72px_1fr] items-center gap-2 px-3 h-5 {key ? 'bg-surface-elevated' : ''}"
            >
                <!-- Put side -->
                <div class="flex items-center gap-2 min-w-0">
                    <span class="shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground" style="min-width:34px">
                        {fmtK(lv.put_oi)}
                    </span>
                    <div class="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted flex justify-end">
                        <div class="h-full rounded-sm bg-put" style="width:{pctOf(lv.put_oi)}%"></div>
                    </div>
                </div>

                <!-- Strike -->
                <div
                    class="text-center font-mono text-[11px] tabular-nums {key ? 'text-foreground font-semibold' : 'text-muted-foreground'}"
                >
                    {fmtStrike(lv.strike)}
                </div>

                <!-- Call side -->
                <div class="flex items-center gap-2 min-w-0">
                    <div class="h-1.5 flex-1 overflow-hidden rounded-sm bg-muted flex justify-start">
                        <div class="h-full rounded-sm bg-call" style="width:{pctOf(lv.call_oi)}%"></div>
                    </div>
                    <span class="shrink-0 text-left font-mono text-[10px] tabular-nums text-muted-foreground" style="min-width:34px">
                        {fmtK(lv.call_oi)}
                    </span>
                </div>
            </div>
        {/each}

        {#if futurePrice != null && sorted.every((s) => s.strike >= futurePrice)}
            <div class="my-1 grid grid-cols-[1fr_72px_1fr] items-center gap-2 px-3 h-5">
                <div class="h-px bg-primary"></div>
                <div class="rounded px-1.5 py-0.5 text-center font-mono text-[10px] font-bold text-primary-foreground bg-primary">
                    {fmtStrike(futurePrice)}
                </div>
                <div class="h-px bg-primary"></div>
            </div>
        {/if}
    </div>
{/if}
