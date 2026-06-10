<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';

    let { expectedRange = null, log = [], scorecard = null, optionFlow = null, wallBacktest = null, loading = false } = $props();

    const verdictMeta = {
        edge_confirmed: { label: 'EDGE ✓', variant: 'up' },
        no_edge: { label: 'NO EDGE', variant: 'down' },
        inconclusive: { label: 'INCONCLUSIVE', variant: 'warn' },
        insufficient_n: { label: 'NEED MORE N', variant: 'muted' }
    };
    function ciText(ci) {
        return ci ? `${(ci[0] * 100).toFixed(0)}–${(ci[1] * 100).toFixed(0)}%` : '—';
    }

    const er = $derived(expectedRange);
    const tenors = $derived(er?.tenors || []);
    const bands = $derived(er?.bands_1d || null);

    const flow = $derived(optionFlow);
    const flow1h = $derived(flow?.windows?.last_1h || null);
    const flowImb = $derived(flow?.imbalance_1h || null);
    const flowMagnet = $derived(flow?.flow_magnet_1h || null);
    const flowWalls = $derived(flow?.wall_activity_1h || []);
    function imbVariant(label) {
        if (label === 'upside_flow') return 'up';
        if (label === 'downside_flow') return 'down';
        return 'muted';
    }

    // Newest first; signal_eval appends statuses in place.
    const recent = $derived([...log].reverse().slice(0, 50));

    const kindMeta = {
        breakout: { label: 'Breakout', variant: 'warn' },
        zone_touch: { label: 'Zone Touch', variant: 'mag' },
        band_touch: { label: 'Band ±2σ', variant: 'call' },
        approach: { label: 'Approach', variant: 'outline' }
    };
    const statusMeta = {
        win: { label: 'WIN', variant: 'up' },
        loss: { label: 'LOSS', variant: 'down' },
        open: { label: 'OPEN', variant: 'warn' },
        expired: { label: 'EXPIRED', variant: 'muted' },
        info: { label: 'INFO', variant: 'outline' },
        unscorable: { label: 'N/A', variant: 'muted' }
    };

    function fmt(n, d = 1) {
        if (n == null) return '—';
        return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
    }
    function fmtPct(n) {
        return n == null ? '—' : `${(n * 100).toFixed(0)}%`;
    }
    function fmtTs(ts) {
        if (!ts) return '—';
        const d = new Date(ts);
        return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    }
    function termVariant(shape) {
        if (!shape) return 'muted';
        if (shape.startsWith('inverted')) return 'down';
        if (shape.startsWith('contango')) return 'up';
        return 'muted';
    }
    function skewVariant(read) {
        if (!read) return 'muted';
        if (read.startsWith('put')) return 'down';
        if (read.startsWith('call')) return 'up';
        return 'muted';
    }
    const byKind = $derived(Object.entries(scorecard?.by_kind || {}));
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Loading signals…</span>
        </div>
    </div>
{:else}
    <div class="flex flex-col gap-4">
        <!-- ===== IV Expected Range ===== -->
        {#if er}
            <Card class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex flex-wrap items-center gap-3">
                        <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            Expected Range (IV) — 1 Day
                        </span>
                        <span class="font-mono text-lg tabular-nums text-foreground">±{fmt(er.expected_move_1d)}</span>
                        <span class="text-xs text-muted-foreground">
                            ATM IV {fmt(er.atm_iv_pct_1d_basis, 1)}% · {er.basis_tenor?.symbol} ({fmt(er.basis_tenor?.dte, 2)} DTE)
                        </span>
                    </div>
                    {#if er.generated_at}
                        <span class="font-mono text-[10px] text-muted-foreground">{new Date(er.generated_at).toLocaleString()}</span>
                    {/if}
                </div>

                {#if bands}
                    <div class="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                        {#each [['minus3', '-3σ'], ['minus2', '-2σ'], ['minus1', '-1σ'], ['plus1', '+1σ'], ['plus2', '+2σ'], ['plus3', '+3σ']] as [k, label]}
                            <div class="rounded-md border border-border bg-background p-2 text-center">
                                <div class="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
                                <div class="font-mono text-sm tabular-nums {k.startsWith('minus') ? 'text-down' : 'text-up'}">{fmt(bands[k])}</div>
                            </div>
                        {/each}
                    </div>
                {/if}

                <div class="mt-3 flex flex-wrap items-center gap-2">
                    {#if er.term_structure}
                        <Badge variant={termVariant(er.term_structure.shape)}>term: {er.term_structure.shape?.split(' ')[0]}</Badge>
                        <span class="text-xs text-muted-foreground">
                            {er.term_structure.short_tenor} − {er.term_structure.long_tenor} = {fmt(er.term_structure.slope_volpts_short_minus_monthly, 1)} vol pts
                        </span>
                    {/if}
                    {#if er.skew}
                        <Badge variant={skewVariant(er.skew.read)}>skew: {er.skew.read?.split(' ')[0]}</Badge>
                        <span class="text-xs text-muted-foreground">
                            put +{fmt(er.skew.put_skew_volpts, 1)} / call +{fmt(er.skew.call_skew_volpts, 1)} vol pts @ ±{er.skew.measured_at_pct}%
                        </span>
                    {/if}
                </div>

                {#if tenors.length}
                    <div class="mt-3 overflow-x-auto">
                        <table class="w-full text-left text-xs">
                            <thead>
                                <tr class="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                                    <th class="py-1.5 pr-3">Tenor</th>
                                    <th class="py-1.5 pr-3">Symbol</th>
                                    <th class="py-1.5 pr-3 text-right">DTE</th>
                                    <th class="py-1.5 pr-3 text-right">ATM IV</th>
                                    <th class="py-1.5 pr-3 text-right">1σ to expiry</th>
                                    <th class="py-1.5 text-right">±2σ range</th>
                                </tr>
                            </thead>
                            <tbody class="font-mono tabular-nums">
                                {#each tenors as t}
                                    <tr class="border-b border-border/50">
                                        <td class="py-1.5 pr-3 capitalize">{t.contract_key}</td>
                                        <td class="py-1.5 pr-3">{t.symbol}</td>
                                        <td class="py-1.5 pr-3 text-right">{fmt(t.dte, 2)}</td>
                                        <td class="py-1.5 pr-3 text-right">{fmt(t.atm_iv_pct, 1)}%</td>
                                        <td class="py-1.5 pr-3 text-right">±{fmt(t.expected_move_to_expiry)}</td>
                                        <td class="py-1.5 text-right text-muted-foreground">{fmt(t.bands_to_expiry?.minus2)} – {fmt(t.bands_to_expiry?.plus2)}</td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </Card>
        {/if}

        <!-- ===== Intraday option flow (Phase 2a) ===== -->
        <Card class="p-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex flex-wrap items-center gap-3">
                    <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        Intraday Option Flow — 1h
                    </span>
                    {#if flowImb}
                        <Badge variant={imbVariant(flowImb.label)}>{flowImb.label}</Badge>
                        {#if flowImb.score != null}
                            <span class="font-mono text-sm tabular-nums {flowImb.score > 0 ? 'text-up' : flowImb.score < 0 ? 'text-down' : 'text-muted-foreground'}">
                                {flowImb.score > 0 ? '+' : ''}{flowImb.score}
                            </span>
                        {/if}
                    {/if}
                </div>
                {#if flow?.generated_at}
                    <span class="font-mono text-[10px] text-muted-foreground">{new Date(flow.generated_at).toLocaleString()}</span>
                {/if}
            </div>

            {#if flow1h}
                <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Calls Added</div>
                        <div class="font-mono text-xl tabular-nums text-call">+{fmt(flow1h.call_added, 0)}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Puts Added</div>
                        <div class="font-mono text-xl tabular-nums text-put">+{fmt(flow1h.put_added, 0)}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Above / Below Spot</div>
                        <div class="font-mono text-xl tabular-nums text-foreground">{fmt(flow1h.added_above_spot, 0)} / {fmt(flow1h.added_below_spot, 0)}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Flow Magnet</div>
                        <div class="font-mono text-xl tabular-nums {flowMagnet?.side === 'above' ? 'text-up' : 'text-down'}">
                            {flowMagnet ? fmt(flowMagnet.strike) : '—'}
                        </div>
                    </div>
                </div>

                {#if flowWalls.length}
                    <div class="mt-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Flow hitting strategy walls</div>
                        <div class="mt-1.5 overflow-x-auto">
                            <table class="w-full text-left text-xs">
                                <thead>
                                    <tr class="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                                        <th class="py-1.5 pr-3 text-right">Wall</th>
                                        <th class="py-1.5 pr-3 text-right">Added 1h</th>
                                        <th class="py-1.5 pr-3 text-right">Share</th>
                                        <th class="py-1.5 pr-3">Side</th>
                                        <th class="py-1.5">Sources</th>
                                    </tr>
                                </thead>
                                <tbody class="font-mono tabular-nums">
                                    {#each flowWalls as w}
                                        <tr class="border-b border-border/50">
                                            <td class="py-1.5 pr-3 text-right font-semibold">{fmt(w.strike)}</td>
                                            <td class="py-1.5 pr-3 text-right">+{fmt(w.added, 0)}</td>
                                            <td class="py-1.5 pr-3 text-right">{w.share_pct}%</td>
                                            <td class="py-1.5 pr-3 {w.side === 'above' ? 'text-up' : 'text-down'}">{w.side} ({w.distance_points > 0 ? '+' : ''}{fmt(w.distance_points)})</td>
                                            <td class="py-1.5 text-muted-foreground">×{w.confluence}: {(w.sources || []).join(', ')}</td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    </div>
                {/if}

                {#if flow1h.top_strikes?.length}
                    <div class="mt-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Most active strikes (1h)</div>
                        <div class="mt-1.5 flex flex-wrap gap-2">
                            {#each flow1h.top_strikes.slice(0, 6) as t}
                                <div class="rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs tabular-nums">
                                    <span class="font-semibold">{fmt(t.strike)}</span>
                                    <span class="text-muted-foreground">({t.contract})</span>
                                    {#if t.call_added}<span class="text-call"> +{fmt(t.call_added, 0)}C</span>{/if}
                                    {#if t.put_added}<span class="text-put"> +{fmt(t.put_added, 0)}P</span>{/if}
                                </div>
                            {/each}
                        </div>
                    </div>
                {/if}
            {:else}
                <p class="mt-2 text-sm text-muted-foreground">
                    Warming up — flow needs at least an hour of intraday snapshots
                    ({flow?.snapshots_in_history ?? 0} stored so far at ~10-min cadence).
                </p>
            {/if}
        </Card>

        <!-- ===== Scorecard ===== -->
        <Card class="p-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Signal Scorecard
                </span>
                {#if scorecard?.updated_at}
                    <span class="font-mono text-[10px] text-muted-foreground">{new Date(scorecard.updated_at).toLocaleString()}</span>
                {/if}
            </div>
            {#if scorecard && scorecard.total_signals > 0}
                <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Win Rate</div>
                        <div class="font-mono text-xl tabular-nums {scorecard.overall_win_rate >= 0.5 ? 'text-up' : 'text-down'}">
                            {fmtPct(scorecard.overall_win_rate)}
                        </div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Signals</div>
                        <div class="font-mono text-xl tabular-nums text-foreground">{scorecard.total_signals}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Open</div>
                        <div class="font-mono text-xl tabular-nums text-warn">{scorecard.open}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Horizon</div>
                        <div class="font-mono text-xl tabular-nums text-foreground">{scorecard.horizon_hours}h</div>
                    </div>
                </div>
                {#if byKind.length}
                    <div class="mt-3 grid gap-2 sm:grid-cols-2">
                        {#each byKind as [kind, b]}
                            <div class="rounded-md border border-border bg-background p-3">
                                <div class="flex items-center justify-between">
                                    <Badge variant={kindMeta[kind]?.variant || 'outline'}>{kindMeta[kind]?.label || kind}</Badge>
                                    <Badge variant={verdictMeta[b.verdict]?.variant || 'muted'}>{verdictMeta[b.verdict]?.label || b.verdict}</Badge>
                                </div>
                                <div class="mt-2 flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
                                    <span class="text-up">{b.win}W</span>
                                    <span class="text-down">{b.loss}L</span>
                                    <span class="text-muted-foreground">{b.expired}E</span>
                                    <span class="text-foreground">{fmtPct(b.win_rate)}</span>
                                    <span class="text-muted-foreground">CI {ciText(b.win_rate_ci95)}</span>
                                    {#if b.breakeven_win_rate != null}
                                        <span class="text-muted-foreground">b/e {fmtPct(b.breakeven_win_rate)}</span>
                                    {/if}
                                </div>
                                <div class="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums text-muted-foreground">
                                    {#if b.expectancy_points != null}
                                        <span class={b.expectancy_points > 0 ? 'text-up' : 'text-down'}>
                                            E[{b.expectancy_points > 0 ? '+' : ''}{b.expectancy_points} pts/trade]
                                        </span>
                                    {/if}
                                    <span class={b.total_net_points > 0 ? 'text-up' : b.total_net_points < 0 ? 'text-down' : ''}>
                                        net {b.total_net_points > 0 ? '+' : ''}{b.total_net_points} pts
                                    </span>
                                    {#if b.avg_hours_to_resolution != null}
                                        <span>~{b.avg_hours_to_resolution}h</span>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                    {#if scorecard.total_net_points != null}
                        <div class="mt-2 text-xs text-muted-foreground">
                            Net total (after {scorecard.cost_points_per_trade} pt cost/trade):
                            <span class="font-mono {scorecard.total_net_points > 0 ? 'text-up' : 'text-down'}">
                                {scorecard.total_net_points > 0 ? '+' : ''}{scorecard.total_net_points} pts
                                (≈ ${scorecard.total_net_usd_mgc}/MGC)
                            </span>
                            — verdicts need n ≥ {scorecard.min_n_for_verdict} AND the full CI clear of breakeven.
                        </div>
                    {/if}
                {/if}
            {:else}
                <p class="mt-2 text-sm text-muted-foreground">
                    No scored signals yet — the watcher logs every Telegram alert here, and the
                    hourly evaluator marks each one win / loss / expired against 15-minute candles.
                </p>
            {/if}
        </Card>

        <!-- ===== Wall backtest (historical evidence) ===== -->
        {#if wallBacktest?.days_evaluated}
            <Card class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        Wall Backtest — {wallBacktest.days_evaluated} days
                        ({wallBacktest.date_range?.[0]} → {wallBacktest.date_range?.[1]})
                    </span>
                    {#if wallBacktest.generated_at}
                        <span class="font-mono text-[10px] text-muted-foreground">{new Date(wallBacktest.generated_at).toLocaleString()}</span>
                    {/if}
                </div>
                <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Touch Rate (D+1)</div>
                        <div class="font-mono text-xl tabular-nums text-foreground">{fmtPct(wallBacktest.touch?.rate)}</div>
                        <div class="font-mono text-[10px] text-muted-foreground">n={wallBacktest.touch?.n_wall_days} · CI {ciText(wallBacktest.touch?.ci95)}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Respect | Touch</div>
                        <div class="font-mono text-xl tabular-nums {(wallBacktest.respect_given_touch?.ci95?.[0] ?? 0) > 0.5 ? 'text-up' : 'text-foreground'}">
                            {fmtPct(wallBacktest.respect_given_touch?.rate)}
                        </div>
                        <div class="font-mono text-[10px] text-muted-foreground">n={wallBacktest.respect_given_touch?.n_touches} · CI {ciText(wallBacktest.respect_given_touch?.ci95)}</div>
                    </div>
                    <div class="rounded-md border border-border bg-background p-3 text-center">
                        <div class="text-[10px] font-semibold uppercase text-muted-foreground">Magnet Pull</div>
                        <div class="font-mono text-xl tabular-nums text-foreground">{fmtPct(wallBacktest.magnet_pull?.rate)}</div>
                        <div class="font-mono text-[10px] text-muted-foreground">n={wallBacktest.magnet_pull?.n} · CI {ciText(wallBacktest.magnet_pull?.ci95)}</div>
                    </div>
                </div>
                <p class="mt-2 text-xs text-muted-foreground">
                    A stat only counts as edge when its whole CI clears 50%. Sample grows daily as snapshots accumulate.
                </p>
            </Card>
        {/if}

        <!-- ===== Signal log ===== -->
        <Card class="p-4">
            <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Signal Log {recent.length ? `(latest ${recent.length})` : ''}
            </span>
            {#if recent.length}
                <div class="mt-3 overflow-x-auto">
                    <table class="w-full text-left text-xs">
                        <thead>
                            <tr class="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                                <th class="py-1.5 pr-3">Time (UTC)</th>
                                <th class="py-1.5 pr-3">Kind</th>
                                <th class="py-1.5 pr-3">Dir</th>
                                <th class="py-1.5 pr-3 text-right">Level</th>
                                <th class="py-1.5 pr-3 text-right">Price@Alert</th>
                                <th class="py-1.5 pr-3 text-right">Target</th>
                                <th class="py-1.5 pr-3 text-right">Invalid.</th>
                                <th class="py-1.5 pr-3">Status</th>
                                <th class="py-1.5 pr-3 text-right">MFE</th>
                                <th class="py-1.5">Context</th>
                            </tr>
                        </thead>
                        <tbody class="font-mono tabular-nums">
                            {#each recent as s}
                                <tr class="border-b border-border/50">
                                    <td class="py-1.5 pr-3 whitespace-nowrap">{fmtTs(s.ts)}</td>
                                    <td class="py-1.5 pr-3"><Badge variant={kindMeta[s.kind]?.variant || 'outline'}>{kindMeta[s.kind]?.label || s.kind}</Badge></td>
                                    <td class="py-1.5 pr-3 {s.direction === 'long' ? 'text-up' : s.direction === 'short' ? 'text-down' : 'text-muted-foreground'}">
                                        {s.direction || '—'}
                                    </td>
                                    <td class="py-1.5 pr-3 text-right">{fmt(s.level)}</td>
                                    <td class="py-1.5 pr-3 text-right">{fmt(s.price_at_alert)}</td>
                                    <td class="py-1.5 pr-3 text-right">{fmt(s.target)}</td>
                                    <td class="py-1.5 pr-3 text-right">{fmt(s.invalidation)}</td>
                                    <td class="py-1.5 pr-3"><Badge variant={statusMeta[s.status]?.variant || 'muted'}>{statusMeta[s.status]?.label || s.status}</Badge></td>
                                    <td class="py-1.5 pr-3 text-right text-muted-foreground">{s.mfe_points != null ? fmt(s.mfe_points) : '—'}</td>
                                    <td class="py-1.5 max-w-64 truncate text-muted-foreground" title={[s.label, s.context, s.bias && `bias: ${s.bias}`, s.regime && `regime: ${s.regime}`].filter(Boolean).join(' · ')}>
                                        {[s.label, s.context].filter(Boolean).join(' · ') || '—'}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {:else}
                <p class="mt-2 text-sm text-muted-foreground">
                    No signals fired yet. The price watcher (every 15 min) alerts on breakout
                    triggers, mean-reversion zone touches, and high-confluence approaches —
                    each alert lands in Telegram and is recorded here.
                </p>
            {/if}
        </Card>
    </div>
{/if}
