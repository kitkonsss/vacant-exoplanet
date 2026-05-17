<script>
    import { fmtNumber } from '$lib/utils.js';

    let {
        score = 0,
        size = 'sm',
        showLabel = false,
        scale = 3
    } = $props();

    const clamped = $derived(Math.max(-scale, Math.min(scale, score || 0)));
    const pct = $derived(((clamped + scale) / (scale * 2)) * 100);
    const isPos = $derived(clamped >= 0);
    const fillLeft = $derived(isPos ? 50 : pct);
    const fillWidth = $derived(Math.abs(pct - 50));
    const tone = $derived(clamped > 0.2 ? 'up' : clamped < -0.2 ? 'down' : 'muted');
    const colorVar = $derived(
        tone === 'up' ? 'hsl(var(--up))' : tone === 'down' ? 'hsl(var(--down))' : 'hsl(var(--muted-foreground))'
    );

    const height = $derived(size === 'lg' ? 'h-2' : 'h-1.5');
    const knob   = $derived(size === 'lg' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5');
</script>

<div class="flex w-full items-center gap-3">
    <div class="relative {height} w-full rounded-full bg-muted">
        <div
            class="absolute top-0 h-full rounded-full"
            style="left:{fillLeft}%; width:{fillWidth}%; background:{colorVar};"
        ></div>
        <div
            class="absolute top-1/2 {knob} -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
            style="left:{pct}%; background:{colorVar};"
        ></div>
        <!-- center tick -->
        <div class="absolute -top-1 left-1/2 h-3 w-px -translate-x-1/2 bg-border"></div>
    </div>
    {#if showLabel}
        <span
            class="shrink-0 font-mono text-xs font-semibold tabular-nums"
            style="color:{colorVar};"
        >
            {score > 0 ? '+' : ''}{fmtNumber(score, 2)}
        </span>
    {/if}
</div>
