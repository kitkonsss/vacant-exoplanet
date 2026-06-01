<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import BriefInfographic from './BriefInfographic.svelte';
    import { fmtBangkok } from '$lib/utils.js';
    import { TrendingUp, TrendingDown, ArrowRight, ShieldAlert, Activity, Crosshair, Gauge, Layers } from 'lucide-svelte';

    let { strategy = null, brief = null, loading = false } = $props();

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
    function fmtSigned(n) {
        if (n == null) return '—';
        return `${n > 0 ? '+' : ''}${fmtNum(n)}`;
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
        <!-- ===== LLM narrative brief (top) — rendered as an infographic ===== -->
        {#if brief}
            <BriefInfographic {brief} {bias} generatedAt={strategy.generated_at} />
        {/if}

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
                        <div class="font-mono text-[10px] text-muted-foreground">{fmtBangkok(strategy.generated_at)}</div>
                    {/if}
                </div>
            </div>
        </Card>

        <!-- ===== Practical execution read ===== -->
        {#if strategy.execution_read}
            <Card class="p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Crosshair class="h-3.5 w-3.5" /> Execution Read
                        </div>
                        <div class="mt-2 text-sm font-semibold text-foreground">{strategy.execution_read.primary_path?.replaceAll('_', ' ')}</div>
                        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{strategy.execution_read.how_to_use}</p>
                    </div>
                    <div class="grid min-w-[240px] grid-cols-2 gap-2 text-xs">
                        <div>
                            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Support wall</div>
                            <div class="font-mono text-up">{fmtNum(strategy.execution_read.nearest_wall_band?.support)}</div>
                        </div>
                        <div>
                            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Resistance wall</div>
                            <div class="font-mono text-down">{fmtNum(strategy.execution_read.nearest_wall_band?.resistance)}</div>
                        </div>
                    </div>
                </div>
                <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                    <div class="rounded-md border border-border/60 p-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Contract build-up</div>
                        <div class="mt-1 text-sm text-foreground">{strategy.execution_read.contract_build_up || '—'}</div>
                    </div>
                    <div class="rounded-md border border-border/60 p-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Upside limit</div>
                        <div class="mt-1 text-sm text-foreground">{strategy.execution_read.upside_limit || '—'}</div>
                    </div>
                    <div class="rounded-md border border-border/60 p-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Downside limit</div>
                        <div class="mt-1 text-sm text-foreground">{strategy.execution_read.downside_limit || '—'}</div>
                    </div>
                </div>
                {#if strategy.execution_read.confluence_focus || strategy.execution_read.oi_magnet || strategy.execution_read.gamma_magnet}
                    <div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                        <div class="rounded-md border border-warn/40 bg-warn/5 p-3">
                            <div class="text-[10px] font-semibold uppercase tracking-wider text-warn">Confluence focus</div>
                            <div class="mt-1 text-sm text-foreground">{strategy.execution_read.confluence_focus || '—'}</div>
                        </div>
                        <div class="rounded-md border border-border/60 p-3">
                            <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">OI magnet</div>
                            <div class="mt-1 text-sm text-foreground">{strategy.execution_read.oi_magnet || '—'}</div>
                        </div>
                        <div class="rounded-md border border-border/60 p-3">
                            <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Gamma magnet</div>
                            <div class="mt-1 text-sm text-foreground">{strategy.execution_read.gamma_magnet || '—'}</div>
                        </div>
                    </div>
                {/if}
            </Card>
        {/if}

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

        <!-- ===== Confluence levels (OI ∩ gamma ∩ round# ∩ build) ===== -->
        {#if strategy.confluence_levels?.length}
            <Card class="p-4">
                <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    <Crosshair class="h-3.5 w-3.5" /> Confluence Levels
                </div>
                <p class="mt-1 text-[11px] text-muted-foreground">จุดที่ OI wall / gamma / round number / fresh build ทับกัน ≥2 แหล่ง = เลเวลน้ำหนักสูงสุด (เรียงตาม confluence แล้วระยะใกล้)</p>
                <div class="mt-2 flex flex-col gap-1.5">
                    {#each strategy.confluence_levels as c}
                        <div class="flex items-center justify-between gap-2 rounded-md border border-border/60 p-2">
                            <div class="flex items-center gap-2">
                                <span class="font-mono text-sm font-semibold tabular-nums {c.side === 'above' ? 'text-down' : c.side === 'below' ? 'text-up' : 'text-foreground'}">{fmtNum(c.level)}</span>
                                <Badge variant={c.confluence >= 3 ? 'warn' : 'muted'}>×{c.confluence}</Badge>
                                <span class="text-[10px] text-muted-foreground">{c.side}{c.distance_points != null ? ` · ${fmtSigned(c.distance_points)} pts` : ''}</span>
                            </div>
                            <div class="flex flex-wrap justify-end gap-1">
                                {#each c.sources as s}<span class="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">{s.replaceAll('_', ' ')}</span>{/each}
                            </div>
                        </div>
                    {/each}
                </div>
            </Card>
        {/if}

        <!-- ===== Heatmap / Gamma / Vol2Vol evidence ===== -->
        {#if strategy.heatmap_contract_flow || strategy.gamma_1pct || strategy.vol2vol_walls}
            <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {#if strategy.heatmap_contract_flow}
                    <Card class="p-4">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                <Activity class="h-3.5 w-3.5" /> Heatmap Build
                            </div>
                            <Badge variant={strategy.heatmap_contract_flow.bias === 'upside_magnet' ? 'up' : strategy.heatmap_contract_flow.bias === 'downside_magnet' ? 'down' : 'muted'}>
                                {strategy.heatmap_contract_flow.bias?.replaceAll('_', ' ')}
                            </Badge>
                        </div>
                        <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
                            <div>
                                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Support build (puts ↓)</div>
                                <div class="font-mono text-up">{fmtSigned(strategy.heatmap_contract_flow.support_build)}</div>
                            </div>
                            <div>
                                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Resistance build (calls ↑)</div>
                                <div class="font-mono text-down">{fmtSigned(strategy.heatmap_contract_flow.resistance_build)}</div>
                            </div>
                        </div>
                        {#if strategy.heatmap_contract_flow.magnet}
                            <div class="mt-2 text-[10px] text-muted-foreground">
                                OI magnet <span class="font-mono text-warn">{fmtNum(strategy.heatmap_contract_flow.magnet.strike)}</span>
                                <span class="uppercase">{strategy.heatmap_contract_flow.magnet.oi_type || ''}</span> · {fmtNum(strategy.heatmap_contract_flow.magnet.latest_oi)} OI
                            </div>
                        {/if}
                        <div class="mt-3 flex flex-col gap-1.5">
                            {#each (strategy.heatmap_contract_flow.top_additions || []).slice(0, 4) as row}
                                <div class="flex items-center justify-between gap-2 text-xs">
                                    <span class="truncate text-muted-foreground">{row.contract_key} · {row.wall_role || row.side}{row.oi_type ? ` · ${row.oi_type}` : ''}</span>
                                    <span class="font-mono text-foreground">{fmtNum(row.strike)} <span class={row.wall_role === 'resistance' ? 'text-down' : row.wall_role === 'support' ? 'text-up' : 'text-warn'}>{fmtSigned(row.change_1d)}</span></span>
                                </div>
                            {/each}
                        </div>
                    </Card>
                {/if}

                {#if strategy.gamma_1pct}
                    <Card class="p-4">
                        <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Gauge class="h-3.5 w-3.5" /> Gamma 1 Pct
                        </div>
                        <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
                            <div>
                                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Room → 1st wall</div>
                                <div class="font-mono text-foreground"><span class="text-up">{fmtNum(strategy.gamma_1pct.upside_room_points)}</span> / <span class="text-down">{fmtNum(strategy.gamma_1pct.downside_room_points)}</span> pts</div>
                            </div>
                            <div>
                                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Room → major wall</div>
                                <div class="font-mono text-foreground"><span class="text-up">{fmtNum(strategy.gamma_1pct.upside_room_to_major)}</span> / <span class="text-down">{fmtNum(strategy.gamma_1pct.downside_room_to_major)}</span> pts</div>
                            </div>
                        </div>
                        {#if strategy.gamma_1pct.gamma_magnet}
                            <div class="mt-2 text-[10px] text-muted-foreground">
                                Gamma magnet <span class="font-mono text-warn">{fmtNum(strategy.gamma_1pct.gamma_magnet.strike)}</span> (γ {fmtNum(strategy.gamma_1pct.gamma_magnet.gamma_1pct)})
                            </div>
                        {/if}
                        <div class="mt-3 flex flex-col gap-1.5">
                            {#each (strategy.gamma_1pct.top_walls || []).slice(0, 4) as row}
                                <div class="flex items-center justify-between gap-2 text-xs">
                                    <span class="truncate text-muted-foreground">{row.contract_key} · {row.side}</span>
                                    <span class="font-mono text-foreground">{fmtNum(row.strike)} <span class="text-warn">{fmtNum(row.gamma_1pct)}</span></span>
                                </div>
                            {/each}
                        </div>
                    </Card>
                {/if}

                {#if strategy.vol2vol_walls}
                    <Card class="p-4">
                        <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Layers class="h-3.5 w-3.5" /> Vol2Vol Walls
                        </div>
                        <div class="mt-3 flex flex-col gap-1.5">
                            {#each (strategy.vol2vol_walls.top_walls || []).slice(0, 6) as row}
                                <div class="flex items-center justify-between gap-2 text-xs">
                                    <span class="truncate text-muted-foreground">{row.contract_key} · {row.side}</span>
                                    <span class="font-mono text-foreground">{fmtNum(row.strike)} <span class="text-muted-foreground">{fmtNum(row.total_oi)} OI</span></span>
                                </div>
                            {/each}
                        </div>
                    </Card>
                {/if}
            </div>
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
