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

    // "3h ago" / "2d ago" from an ISO timestamp (for data-freshness chips)
    function ageStr(iso) {
        if (!iso) return null;
        const t = new Date(iso).getTime();
        if (Number.isNaN(t)) return null;
        const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (mins < 60) return `${mins}m`;
        const hrs = mins / 60;
        if (hrs < 24) return `${Math.round(hrs)}h`;
        return `${Math.round(hrs / 24)}d`;
    }
    function freshVariant(iso, staleHours) {
        if (!iso) return 'muted';
        const hrs = (Date.now() - new Date(iso).getTime()) / 3600000;
        return Number.isNaN(hrs) ? 'muted' : hrs > staleHours ? 'warn' : 'up';
    }

    const regime = $derived(strategy?.regime || null);
    const momentum = $derived(strategy?.momentum || null);
    const meanRev = $derived(strategy?.mean_reversion || null);
    const fresh = $derived(strategy?.data_freshness || null);
    // freshness chips: [label, iso|date, stale-after-hours]
    const freshChips = $derived(
        fresh
            ? [
                  ['Positioning', fresh.positioning, 6],
                  ['Macro', fresh.macro, 12],
                  ['VWAP', fresh.vwap, 6],
              ].filter(([, v]) => v)
            : []
    );
    function playbookText(p) {
        return p === 'mean_reversion' ? 'mean-reversion' : p === 'both' ? 'both modes' : p || '—';
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
                    {#if freshChips.length || fresh?.cot_report_date}
                        <div class="mt-1 flex flex-wrap justify-end gap-1">
                            {#each freshChips as [label, iso, stale]}
                                <Badge variant={freshVariant(iso, stale)}>{label} {ageStr(iso)}</Badge>
                            {/each}
                            {#if fresh?.cot_report_date}
                                <Badge variant="muted">COT {fresh.cot_report_date}</Badge>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
        </Card>

        <!-- ===== Today's Plan (hero synthesis) ===== -->
        {#if regime || momentum?.trigger || meanRev?.zones?.length}
            <Card class="border-primary/30 bg-primary/5 p-5">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                        <Crosshair class="h-3.5 w-3.5" /> Today's Plan
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5">
                        {#if bias}<Badge variant={biasVariant(bias.label)}>{biasText(bias.label)}</Badge>{/if}
                        {#if regime}<Badge variant={regime.regime === 'trending' ? 'warn' : regime.regime === 'range' ? 'up' : 'muted'}>{regime.regime} → lead: {playbookText(regime.lead_playbook)}</Badge>{/if}
                    </div>
                </div>

                <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <!-- lead playbook detail -->
                    {#if regime?.lead_playbook === 'mean_reversion'}
                        <div class="rounded-md border border-up/30 bg-up/5 p-3">
                            <div class="text-[10px] font-semibold uppercase tracking-wider text-up">🔄 Fade plan (lead)</div>
                            {#each meanRev?.zones || [] as z}
                                <div class="mt-1 text-sm text-foreground">{z.action} <span class="font-mono">{fmtNum(z.at)}</span> → <span class="font-mono">{fmtNum(z.target)}</span> <span class="text-[11px] text-muted-foreground">(stop {fmtNum(z.invalidation)})</span></div>
                            {/each}
                        </div>
                    {:else}
                        <div class="rounded-md border border-warn/30 bg-warn/5 p-3">
                            <div class="text-[10px] font-semibold uppercase tracking-wider text-warn">📈 Momentum plan{regime?.lead_playbook === 'momentum' ? ' (lead)' : ''}</div>
                            <div class="mt-1 text-sm text-foreground">{momentum?.trigger || 'no clean trigger — wait'}</div>
                            {#if momentum?.targets?.length}<div class="mt-0.5 text-[12px] text-muted-foreground">→ targets {momentum.targets.join(', ')}{#if momentum.invalidation} · stop {momentum.invalidation}{/if}</div>{/if}
                        </div>
                    {/if}

                    <!-- focus + invalidation -->
                    <div class="rounded-md border border-border/60 p-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Focus level / magnet</div>
                        <div class="mt-1 text-sm text-foreground">{strategy.execution_read?.confluence_focus || strategy.execution_read?.gamma_magnet || '—'}</div>
                        {#if strategy.expected_range}
                            <div class="mt-1.5 text-[11px] text-muted-foreground">Expected day ±{fmtNum(strategy.expected_range.expected_move)} · range {fmtNum(strategy.expected_range.day_low_est)}–{fmtNum(strategy.expected_range.day_high_est)}</div>
                        {/if}
                    </div>
                </div>
                {#if strategy.contrarian_flag && strategy.contrarian_flag !== 'none'}
                    <div class="mt-2 flex items-center gap-1.5 text-[11px] text-warn"><ShieldAlert class="h-3.5 w-3.5" /> COT {strategy.contrarian_flag.replaceAll('_', ' ')} — น้ำหนักโหมดสวนเพิ่ม</div>
                {/if}
            </Card>
        {/if}

        <!-- ===== Regime & volatility (VWAP / expected range) ===== -->
        {#if strategy.regime || strategy.expected_range || strategy.vwap?.daily}
            <Card class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        <Gauge class="h-3.5 w-3.5" /> Regime & Volatility
                        {#if strategy.regime}
                            <Badge variant={strategy.regime.regime === 'trending' ? 'warn' : strategy.regime.regime === 'range' ? 'up' : 'muted'}>
                                {strategy.regime.regime} · {strategy.regime.lead_playbook?.replaceAll('_', ' ')}
                            </Badge>
                        {/if}
                    </div>
                    {#if strategy.regime?.reasons?.length}
                        <div class="text-[11px] text-muted-foreground">{strategy.regime.reasons.join(' · ')}</div>
                    {/if}
                </div>
                <div class="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                    {#if strategy.expected_range}
                        <div>
                            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Expected move (ATR)</div>
                            <div class="font-mono text-foreground">±{fmtNum(strategy.expected_range.expected_move)}</div>
                        </div>
                        <div>
                            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Day range est</div>
                            <div class="font-mono text-foreground">{fmtNum(strategy.expected_range.day_low_est)}–{fmtNum(strategy.expected_range.day_high_est)}</div>
                        </div>
                    {/if}
                    {#if strategy.vwap?.daily}
                        <div>
                            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Session VWAP</div>
                            <div class="font-mono text-foreground">{fmtNum(strategy.vwap.daily.vwap)} <span class="text-muted-foreground">±{fmtNum(strategy.vwap.daily.sd)}</span></div>
                        </div>
                        <div>
                            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Price vs band</div>
                            <div class="font-mono text-foreground">{strategy.vwap.price_vs_band || '—'}</div>
                        </div>
                    {/if}
                </div>
                {#if strategy.vwap?.daily?.bands}
                    <div class="mt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">VWAP SD ladder (mean-reversion fades)</div>
                    <div class="mt-1 flex flex-wrap gap-1.5">
                        {#each [['+3sd', 'plus3'], ['+2sd', 'plus2'], ['+1sd', 'plus1'], ['-1sd', 'minus1'], ['-2sd', 'minus2'], ['-3sd', 'minus3']] as [lbl, key]}
                            {#if strategy.vwap.daily.bands[key] != null}
                                <Badge variant={lbl[0] === '+' ? 'down' : 'up'}>{lbl} {fmtNum(strategy.vwap.daily.bands[key])}</Badge>
                            {/if}
                        {/each}
                    </div>
                {/if}
                {#if strategy.contrarian_flag && strategy.contrarian_flag !== 'none'}
                    <div class="mt-3 flex items-center gap-1.5 text-[11px] text-warn">
                        <ShieldAlert class="h-3.5 w-3.5" /> COT {strategy.contrarian_flag.replaceAll('_', ' ')} — โหมดสวนน้ำหนักขึ้น (mean-reversion)
                    </div>
                {/if}
            </Card>
        {/if}

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

        <!-- ===== Dual-mode plan: Momentum + Mean-reversion ===== -->
        {#if momentum?.trigger || meanRev?.zones?.length}
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <!-- Momentum -->
                {#if momentum}
                    <Card class="p-4 {momentum.aligned_with_regime ? 'border-warn/40' : ''}">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">
                                <TrendingUp class="h-3.5 w-3.5" /> Momentum (trend)
                            </div>
                            {#if momentum.aligned_with_regime}<Badge variant="warn">regime lead</Badge>{/if}
                        </div>
                        <div class="mt-2 flex flex-col gap-1.5 text-sm">
                            <div class="flex items-start gap-2"><ArrowRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span class="text-foreground"><span class="text-muted-foreground">trigger</span> {momentum.trigger || '— no clean trigger; wait for a side'}</span></div>
                            {#if momentum.targets?.length}<div class="flex items-start gap-2"><ArrowRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span class="text-foreground"><span class="text-muted-foreground">targets</span> {momentum.targets.join(', ')}</span></div>{/if}
                            {#if momentum.invalidation}<div class="flex items-start gap-2"><ShieldAlert class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" /><span class="text-muted-foreground">invalidation: {momentum.invalidation}</span></div>{/if}
                        </div>
                        {#if momentum.rationale}<p class="mt-2 text-[11px] leading-snug text-muted-foreground">{momentum.rationale}</p>{/if}
                    </Card>
                {/if}

                <!-- Mean-reversion -->
                {#if meanRev}
                    <Card class="p-4 {meanRev.aligned_with_regime ? 'border-up/40' : ''}">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-up">
                                <Layers class="h-3.5 w-3.5" /> Mean-reversion (fade)
                            </div>
                            {#if meanRev.aligned_with_regime}<Badge variant="up">regime lead</Badge>{/if}
                        </div>
                        {#if meanRev.vwap != null}<div class="mt-1 text-[11px] text-muted-foreground">VWAP target <span class="font-mono text-foreground">{fmtNum(meanRev.vwap)}</span></div>{/if}
                        <div class="mt-2 flex flex-col gap-2 text-sm">
                            {#each meanRev.zones || [] as z}
                                <div class="rounded-md border border-border/60 p-2">
                                    <div class="text-foreground">{z.action} at <span class="font-mono">{fmtNum(z.at)}</span> → <span class="font-mono">{fmtNum(z.target)}</span> <span class="text-[11px] text-muted-foreground">(stop {fmtNum(z.invalidation)})</span></div>
                                    <div class="mt-0.5 flex flex-wrap items-center gap-1">
                                        <span class="text-[10px] uppercase tracking-wide text-muted-foreground">{z.band?.replaceAll('_', ' ')}</span>
                                        {#each z.confluence_with || [] as s}<span class="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">{s.replaceAll('_', ' ')}</span>{/each}
                                    </div>
                                    {#if z.confirm}<div class="mt-0.5 text-[11px] text-warn">✓ {z.confirm}</div>{/if}
                                </div>
                            {/each}
                            {#if !(meanRev.zones || []).length}<div class="text-[11px] text-muted-foreground">No VWAP SD bands available.</div>{/if}
                        </div>
                        {#if meanRev.rationale}<p class="mt-2 text-[11px] leading-snug text-muted-foreground">{meanRev.rationale}</p>{/if}
                    </Card>
                {/if}
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
