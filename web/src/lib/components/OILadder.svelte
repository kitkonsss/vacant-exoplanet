<script>
    import { fmtK, fmtStrike } from '$lib/utils.js';

    // Vertical grouped-bar "wall profile": strikes along the X axis (low → high),
    // wall strength (OI + volume) as bar height, Put (orange) and Call (cyan) bars
    // sitting side-by-side at each strike. Each bar is split into two shades:
    // solid base = open interest (the resting "wall"), faded top = today's intraday
    // volume (flow) — so you can read both the wall height and how much is fresh flow.
    let { positionMap = [], futurePrice = null, compact = false } = $props();

    // ascending strike → left-to-right on the X axis
    const sorted = $derived([...(positionMap || [])].sort((a, b) => a.strike - b.strike));

    function callTotal(l) {
        return (l.call_oi || 0) + (l.call_volume || 0);
    }
    function putTotal(l) {
        return (l.put_oi || 0) + (l.put_volume || 0);
    }

    const maxVal = $derived(
        Math.max(...sorted.flatMap((l) => [callTotal(l), putTotal(l)]), 1)
    );

    function hPct(v) {
        // floor so even tiny walls show a sliver
        return (v || 0) > 0 ? Math.max(((v || 0) / maxVal) * 100, 2) : 0;
    }

    function isKey(lv) {
        const p = futurePrice || 0;
        const isCallWall = (lv.side === 'call_wall' || lv.side === 'call') && lv.strike > p;
        const isPutWall = (lv.side === 'put_wall' || lv.side === 'put') && lv.strike < p;
        return isCallWall || isPutWall;
    }

    // future-price marker as a % across the evenly-spaced strike columns
    // (interpolated between the centres of the two bracketing strikes)
    const pricePos = $derived.by(() => {
        const n = sorted.length;
        if (!n || futurePrice == null) return null;
        const p = futurePrice;
        if (p <= sorted[0].strike) return (0.5 / n) * 100;
        if (p >= sorted[n - 1].strike) return ((n - 0.5) / n) * 100;
        for (let i = 0; i < n - 1; i++) {
            const a = sorted[i].strike;
            const b = sorted[i + 1].strike;
            if (p >= a && p <= b) {
                const frac = b === a ? 0 : (p - a) / (b - a);
                return ((i + 0.5 + frac) / n) * 100;
            }
        }
        return null;
    });

    let hovered = $state(null);

    const chartHeight = $derived(compact ? 120 : 172);
    const barMax = $derived(compact ? '8px' : '11px');
    const labelSize = $derived(compact ? 'text-[7px]' : 'text-[8px]');
</script>

{#snippet bar(oi, vol, isCall)}
    {@const o = oi || 0}
    {@const v = vol || 0}
    {@const total = o + v}
    <div
        class="flex w-full flex-col overflow-hidden rounded-t-sm"
        style={`height:${hPct(total)}%;max-width:${barMax}`}
    >
        {#if v > 0}
            <!-- intraday volume (flow) — faded shade, sits on top -->
            <div
                class={`transition-colors ${isCall ? 'bg-call/35 group-hover:bg-call/55' : 'bg-put/35 group-hover:bg-put/55'}`}
                style={`height:${total > 0 ? (v / total) * 100 : 0}%`}
            ></div>
        {/if}
        {#if o > 0}
            <!-- open interest (the wall) — solid shade, sits at the base -->
            <div
                class={`transition-colors ${isCall ? 'bg-call/90 group-hover:bg-call' : 'bg-put/90 group-hover:bg-put'}`}
                style={`height:${total > 0 ? (o / total) * 100 : 0}%`}
            ></div>
        {/if}
    </div>
{/snippet}

{#if sorted.length === 0}
    <div class="rounded-md border border-border bg-background py-6 text-center text-xs text-muted-foreground">
        No position data
    </div>
{:else}
    <div class={`rounded-md border border-border bg-background ${compact ? 'p-2.5' : 'p-3'}`}>
        <!-- Legend + live readout -->
        <div class={`mb-2 flex items-center justify-between gap-2 ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
            <div class="flex items-center gap-2.5">
                <span class="flex items-center gap-1">
                    <span class="inline-block h-2 w-2 rounded-sm bg-put"></span>
                    <span class="text-muted-foreground">Put</span>
                </span>
                <span class="flex items-center gap-1">
                    <span class="inline-block h-2 w-2 rounded-sm bg-call"></span>
                    <span class="text-muted-foreground">Call</span>
                </span>
                <span class="mx-0.5 h-2.5 w-px bg-border"></span>
                <span class="flex items-center gap-1" title="solid = open interest">
                    <span class="inline-block h-2 w-2 rounded-sm bg-foreground/90"></span>
                    <span class="text-muted-foreground">OI</span>
                </span>
                <span class="flex items-center gap-1" title="faded = intraday volume">
                    <span class="inline-block h-2 w-2 rounded-sm bg-foreground/35"></span>
                    <span class="text-muted-foreground">Vol</span>
                </span>
            </div>
            {#if hovered != null && sorted[hovered]}
                {@const lv = sorted[hovered]}
                <div class="truncate font-mono tabular-nums">
                    <span class="font-semibold text-foreground">{fmtStrike(lv.strike)}</span>
                    <span class="text-put">· P {fmtK(lv.put_oi) || 0}+{fmtK(lv.put_volume) || 0}</span>
                    <span class="text-call">· C {fmtK(lv.call_oi) || 0}+{fmtK(lv.call_volume) || 0}</span>
                </div>
            {:else}
                <div class="font-mono tabular-nums text-muted-foreground">
                    Future <span class="font-semibold text-primary">{fmtStrike(futurePrice)}</span>
                </div>
            {/if}
        </div>

        <!-- Plot area -->
        <div class="relative" style={`height:${chartHeight}px`}>
            <!-- horizontal gridlines -->
            {#each [0.25, 0.5, 0.75] as g}
                <div class="absolute left-0 right-0 border-t border-border/40" style={`bottom:${g * 100}%`}></div>
            {/each}
            <!-- baseline -->
            <div class="absolute left-0 right-0 bottom-0 border-t border-border"></div>

            <!-- future-price line -->
            {#if pricePos != null}
                <div class="absolute top-0 bottom-0 z-10 border-l border-dashed border-primary/70" style={`left:${pricePos}%`}>
                    <span class={`absolute -top-px -translate-x-1/2 leading-none text-primary ${compact ? 'text-[7px]' : 'text-[8px]'}`}>▾</span>
                </div>
            {/if}

            <!-- grouped bars -->
            <div class="absolute inset-0 flex items-end">
                {#each sorted as lv, i (lv.strike + '-' + i)}
                    <button
                        type="button"
                        class={`group flex h-full flex-1 items-end justify-center gap-px p-0 ${hovered === i ? 'bg-surface-elevated/60' : ''}`}
                        onmouseenter={() => (hovered = i)}
                        onmouseleave={() => (hovered = null)}
                        onfocus={() => (hovered = i)}
                        onblur={() => (hovered = null)}
                        aria-label={`Strike ${fmtStrike(lv.strike)}: put oi ${lv.put_oi || 0} vol ${lv.put_volume || 0}, call oi ${lv.call_oi || 0} vol ${lv.call_volume || 0}`}
                    >
                        {@render bar(lv.put_oi, lv.put_volume, false)}
                        {@render bar(lv.call_oi, lv.call_volume, true)}
                    </button>
                {/each}
            </div>
        </div>

        <!-- X-axis strike labels -->
        <div class="mt-1 flex">
            {#each sorted as lv, i (lv.strike + '-' + i)}
                <div
                    class={`flex-1 text-center font-mono tabular-nums leading-none ${labelSize} ${
                        isKey(lv) ? 'font-semibold text-foreground' : 'text-muted-foreground'
                    } ${hovered === i ? 'text-foreground' : ''}`}
                >
                    {fmtStrike(lv.strike)}
                </div>
            {/each}
        </div>
    </div>
{/if}
