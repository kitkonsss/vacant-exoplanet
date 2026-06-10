<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';

    let { expectedRange = null, log = [], scorecard = null, loading = false } = $props();

    const er = $derived(expectedRange);
    const tenors = $derived(er?.tenors || []);
    const bands = $derived(er?.bands_1d || null);

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
                            <div class="flex items-center justify-between rounded-md border border-border bg-background p-3">
                                <Badge variant={kindMeta[kind]?.variant || 'outline'}>{kindMeta[kind]?.label || kind}</Badge>
                                <div class="flex items-center gap-3 font-mono text-xs tabular-nums">
                                    <span class="text-up">{b.win}W</span>
                                    <span class="text-down">{b.loss}L</span>
                                    <span class="text-muted-foreground">{b.expired}E</span>
                                    <span class="text-foreground">{fmtPct(b.win_rate)}</span>
                                    {#if b.avg_hours_to_resolution != null}
                                        <span class="text-muted-foreground">~{b.avg_hours_to_resolution}h</span>
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            {:else}
                <p class="mt-2 text-sm text-muted-foreground">
                    No scored signals yet — the watcher logs every Telegram alert here, and the
                    hourly evaluator marks each one win / loss / expired against 15-minute candles.
                </p>
            {/if}
        </Card>

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
                                <th class="py-1.5 pr-3 text-right">Target</th>
                                <th class="py-1.5 pr-3 text-right">Invalid.</th>
                                <th class="py-1.5 pr-3">Status</th>
                                <th class="py-1.5 text-right">MFE</th>
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
                                    <td class="py-1.5 pr-3 text-right">{fmt(s.target)}</td>
                                    <td class="py-1.5 pr-3 text-right">{fmt(s.invalidation)}</td>
                                    <td class="py-1.5 pr-3"><Badge variant={statusMeta[s.status]?.variant || 'muted'}>{statusMeta[s.status]?.label || s.status}</Badge></td>
                                    <td class="py-1.5 text-right text-muted-foreground">{s.mfe_points != null ? fmt(s.mfe_points) : '—'}</td>
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
