<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import { TrendingUp, TrendingDown, ArrowRight, ShieldAlert } from 'lucide-svelte';

    let { strategy = null, loading = false } = $props();

    const bias = $derived(strategy?.directional_bias || null);

    function biasVariant(label) {
        if (label === 'bullish' || label === 'lean_bullish') return 'up';
        if (label === 'bearish' || label === 'lean_bearish') return 'down';
        return 'muted';
    }
    function biasText(label) {
        return (label || 'neutral').replace('lean_', 'lean ').replace('_', ' ');
    }
    function confVariant(c) {
        return c === 'high' ? 'up' : c === 'medium' ? 'warn' : 'muted';
    }
    function compVariant(label) {
        if (label === 'bullish' || label === 'tailwind' || label === 'lean_bullish') return 'up';
        if (label === 'bearish' || label === 'headwind' || label === 'lean_bearish') return 'down';
        return 'muted';
    }

    // present components in a fixed order with friendly names
    const COMP_ORDER = [
        ['positioning', 'Options Positioning'],
        ['macro', 'Macro'],
        ['cot', 'COT (Funds)'],
    ];
    const comps = $derived(
        COMP_ORDER
            .map(([k, name]) => {
                const c = strategy?.components?.[k];
                return c ? { key: k, name, c } : null;
            })
            .filter(Boolean)
    );

    function fmtNum(n) {
        return n == null ? '—' : n.toLocaleString();
    }
    // map a -100..100 score to a 0..100% bar width and left/right fill
    function barPct(score) {
        return Math.min(100, Math.abs(score || 0));
    }
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Synthesizing strategy…</span>
        </div>
    </div>
{:else if !strategy}
    <Card class="p-8 text-center">
        <div class="font-semibold text-foreground">No Daily Strategy Yet</div>
        <p class="mt-1 text-sm text-muted-foreground">
            strategy_fetch.py has not published daily_strategy.json. It blends position
            bias + macro + COT — run the “Fetch Macro + COT” workflow.
        </p>
    </Card>
{:else}
    <div class="flex flex-col gap-4">
        <!-- ===== Headline directional read ===== -->
        <Card class="p-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                    {#if bias}
                        {#if bias.score > 0}<TrendingUp class="h-6 w-6 text-up" />{:else if bias.score < 0}<TrendingDown class="h-6 w-6 text-down" />{/if}
                        <div>
                            <div class="flex items-center gap-2">
                                <span class="text-xl font-bold uppercase tracking-wide {bias.score > 0 ? 'text-up' : bias.score < 0 ? 'text-down' : 'text-foreground'}">
                                    {biasText(bias.label)}
                                </span>
                                <span class="font-mono text-sm tabular-nums text-muted-foreground">{bias.score > 0 ? '+' : ''}{bias.score}</span>
                            </div>
                            <div class="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                                <Badge variant={confVariant(bias.confidence)}>{bias.confidence} confidence</Badge>
                                {#if strategy.agreement}
                                    <span>{strategy.agreement.aligned}/{strategy.agreement.total} layers aligned</span>
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>
                <div class="text-right">
                    {#if strategy.future_price != null}
                        <div class="font-mono text-lg font-semibold tabular-nums text-foreground">{fmtNum(strategy.future_price)}</div>
                    {/if}
                    {#if strategy.generated_at}
                        <div class="font-mono text-[10px] text-muted-foreground">{new Date(strategy.generated_at).toLocaleString()}</div>
                    {/if}
                </div>
            </div>
        </Card>

        <!-- ===== Component breakdown ===== -->
        {#if comps.length}
            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                {#each comps as { key, name, c } (key)}
                    {@const variant = compVariant(c.label)}
                    <Card class="p-3">
                        <div class="flex items-center justify-between">
                            <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{name}</span>
                            <span class="font-mono text-[10px] text-muted-foreground">w {c.weight}</span>
                        </div>
                        <div class="mt-1 flex items-center justify-between">
                            <Badge variant={variant}>{(c.label || '').replace('_', ' ')}</Badge>
                            <span class="font-mono text-sm tabular-nums {c.score > 0 ? 'text-up' : c.score < 0 ? 'text-down' : 'text-muted-foreground'}">{c.score > 0 ? '+' : ''}{c.score}</span>
                        </div>
                        <!-- signed bar -->
                        <div class="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
                            <div class="flex w-1/2 justify-end">
                                {#if c.score < 0}<div class="h-full rounded-l-full bg-down" style="width:{barPct(c.score)}%"></div>{/if}
                            </div>
                            <div class="flex w-1/2">
                                {#if c.score > 0}<div class="h-full rounded-r-full bg-up" style="width:{barPct(c.score)}%"></div>{/if}
                            </div>
                        </div>
                        {#if c.note}<p class="mt-2 text-[11px] leading-snug text-muted-foreground">{c.note}</p>{/if}
                        {#if c.drivers?.length}
                            <ul class="mt-2 flex flex-col gap-0.5">
                                {#each c.drivers as d}<li class="text-[11px] leading-snug text-muted-foreground">• {d}</li>{/each}
                            </ul>
                        {/if}
                    </Card>
                {/each}
            </div>
        {/if}

        <!-- ===== Key levels ===== -->
        {#if strategy.key_levels}
            <Card class="p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Key Levels</div>
                <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-down">Resistance</div>
                        <div class="mt-1 flex flex-wrap gap-1.5">
                            {#each strategy.key_levels.resistances || [] as r}<Badge variant="down">{fmtNum(r)}</Badge>{/each}
                            {#if !(strategy.key_levels.resistances || []).length}<span class="text-xs text-muted-foreground">—</span>{/if}
                        </div>
                    </div>
                    <div>
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-warn">Magnet</div>
                        <div class="mt-1">
                            {#if strategy.key_levels.magnet != null}<Badge variant="warn">{fmtNum(strategy.key_levels.magnet)}</Badge>{:else}<span class="text-xs text-muted-foreground">—</span>{/if}
                        </div>
                    </div>
                    <div>
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-up">Support</div>
                        <div class="mt-1 flex flex-wrap gap-1.5">
                            {#each strategy.key_levels.supports || [] as s}<Badge variant="up">{fmtNum(s)}</Badge>{/each}
                            {#if !(strategy.key_levels.supports || []).length}<span class="text-xs text-muted-foreground">—</span>{/if}
                        </div>
                    </div>
                </div>
            </Card>
        {/if}

        <!-- ===== Scenarios ===== -->
        {#if strategy.scenarios?.length}
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                {#each strategy.scenarios as sc}
                    <Card class="p-4">
                        <Badge variant={sc.bias === 'upside' ? 'up' : 'down'}>{sc.bias}</Badge>
                        <div class="mt-2 flex flex-col gap-1.5 text-sm">
                            <div class="flex items-start gap-2"><ArrowRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span class="text-foreground"><span class="text-muted-foreground">if</span> {sc.trigger}</span></div>
                            <div class="flex items-start gap-2"><ArrowRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span class="text-foreground"><span class="text-muted-foreground">then</span> {sc.then}</span></div>
                            <div class="flex items-start gap-2"><ShieldAlert class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" /><span class="text-muted-foreground">invalidation: {sc.invalidation}</span></div>
                        </div>
                    </Card>
                {/each}
            </div>
        {/if}

        <!-- ===== What would change my mind ===== -->
        {#if strategy.what_would_change_my_mind}
            <Card class="p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">What Would Change My Mind</div>
                <p class="mt-1.5 text-sm text-foreground">{strategy.what_would_change_my_mind}</p>
            </Card>
        {/if}

        {#if strategy.disclaimer}
            <p class="px-1 text-[10px] leading-relaxed text-muted-foreground">{strategy.disclaimer}</p>
        {/if}
    </div>
{/if}
