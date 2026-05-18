<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import { cn, fmtNumber, fmtStrike, fmtK, toneClasses } from '$lib/utils.js';
    import { ASSET_PROFILES, CONTRACT_OPTIONS } from '$lib/config.js';
    import { analyzeConviction, TAG_META } from '$lib/conviction.js';

    let {
        assetId = 'gc',
        contractKey = $bindable('current'),
        availableContracts = [],
        bias = null,
        heatmap = null,
        loading = false,
        onChangeContract = (_key) => {}
    } = $props();

    const profile = $derived(ASSET_PROFILES[assetId]);
    const contractPills = $derived(
        CONTRACT_OPTIONS.filter(({ key }) => availableContracts.includes(key))
    );

    const analysis = $derived(analyzeConviction({ bias, heatmap }));

    function pickContract(key) {
        contractKey = key;
        onChangeContract(key);
    }

    function fmtPct(value) {
        if (value == null) return '—';
        if (!Number.isFinite(value)) return '∞';
        const pct = value * 100;
        const sign = pct > 0 ? '+' : '';
        return `${sign}${pct.toFixed(0)}%`;
    }

    function fmtMult(value) {
        if (value == null) return '—';
        if (!Number.isFinite(value)) return '∞';
        return `${value.toFixed(1)}×`;
    }

    function fmtDistance(points, underlying) {
        if (points == null || !Number.isFinite(points)) return '—';
        const sign = points >= 0 ? '+' : '−';
        const pct = underlying > 0 ? (Math.abs(points) / underlying) * 100 : 0;
        return `${sign}${fmtNumber(Math.abs(points), 0)} pts (${pct.toFixed(1)}%)`;
    }

    function deltaTone(deltaPct, tag) {
        if (tag === 'fading') return 'down';
        if (!Number.isFinite(deltaPct)) return 'warn';
        if (deltaPct >= 0.5) return 'warn';
        if (deltaPct > 0) return 'up';
        if (deltaPct < -0.1) return 'down';
        return 'muted';
    }

    function sideTone(side) {
        if (side === 'call') return 'call';
        if (side === 'put') return 'put';
        return 'muted';
    }

    function verdictMeta(v) {
        switch (v) {
            case 'bullish':       return { label: 'Bullish',       tone: 'up' };
            case 'lean_bullish':  return { label: 'Lean Bullish',  tone: 'up' };
            case 'bearish':       return { label: 'Bearish',       tone: 'down' };
            case 'lean_bearish':  return { label: 'Lean Bearish',  tone: 'down' };
            default:              return { label: 'Neutral',       tone: 'muted' };
        }
    }
</script>

<Card class="flex flex-1 flex-col overflow-hidden">
    <!-- Top bar -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-warn"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                Conviction
            </span>
            <span class="truncate text-[10px] text-muted-foreground">
                {#if analysis}
                    {analysis.rows.length} signals
                    {#if analysis.contract} · <span class="font-mono">{analysis.contract}</span>{/if}
                {:else if !loading}
                    No data
                {/if}
            </span>
        </div>

        <div class="flex items-center gap-2">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                Contract
            </span>
            <div class="flex gap-1">
                {#each contractPills as c}
                    {@const isActive = c.key === contractKey}
                    <button
                        type="button"
                        onclick={() => pickContract(c.key)}
                        class={cn(
                            'rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                            isActive
                                ? 'border-warn bg-warn text-background'
                                : 'border-border bg-surface text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
                        )}
                    >
                        {c.label}
                    </button>
                {/each}
            </div>
        </div>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-auto bg-background">
        {#if loading}
            <div class="flex h-64 items-center justify-center">
                <div class="flex items-center gap-3 text-muted-foreground">
                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-warn"></div>
                    <span class="text-sm">Loading conviction…</span>
                </div>
            </div>
        {:else if !analysis || analysis.rows.length === 0}
            <div class="flex h-64 items-center justify-center">
                <div class="text-center">
                    <div class="text-sm font-semibold text-foreground">No conviction signals</div>
                    <p class="mt-1 max-w-md text-xs text-muted-foreground">
                        Need both <span class="font-mono text-foreground">{contractKey}_PositionBias.json</span>
                        and <span class="font-mono text-foreground">{contractKey}_OIHeatmap.json</span> to compute growth & dominance.
                    </p>
                </div>
            </div>
        {:else}
            {@const v = verdictMeta(analysis.summary.verdict)}
            {@const vTones = toneClasses(v.tone)}

            <!-- Summary strip -->
            <div class="grid grid-cols-2 gap-3 border-b border-border bg-surface px-4 py-3 md:grid-cols-4">
                <div class="rounded-md border border-border bg-background px-3 py-2">
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Conviction Verdict
                    </div>
                    <div class={`mt-1 font-mono text-base font-semibold ${vTones.text}`}>
                        {v.label}
                    </div>
                    <div class="mt-0.5 text-[10px] text-muted-foreground">
                        score {fmtNumber(analysis.summary.score, 0)} · {analysis.summary.count} strikes
                    </div>
                </div>

                <div class="rounded-md border border-border bg-background px-3 py-2">
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Bullish Support
                    </div>
                    <div class="mt-1 font-mono text-base font-semibold text-up tabular-nums">
                        {fmtNumber(analysis.summary.bullish, 0)}
                    </div>
                    <div class="mt-0.5 text-[10px] text-muted-foreground">
                        put walls below price
                    </div>
                </div>

                <div class="rounded-md border border-border bg-background px-3 py-2">
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Bearish Resistance
                    </div>
                    <div class="mt-1 font-mono text-base font-semibold text-down tabular-nums">
                        {fmtNumber(analysis.summary.bearish, 0)}
                    </div>
                    <div class="mt-0.5 text-[10px] text-muted-foreground">
                        call walls above price
                    </div>
                </div>

                <div class="rounded-md border border-border bg-background px-3 py-2">
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Underlying
                    </div>
                    <div class="mt-1 font-mono text-base font-semibold text-primary tabular-nums">
                        {fmtStrike(analysis.underlying)}
                    </div>
                    <div class="mt-0.5 text-[10px] text-muted-foreground">
                        ranked by composite score
                    </div>
                </div>
            </div>

            <!-- Table -->
            <table class="cv-table">
                <thead>
                    <tr>
                        <th class="cv-h cv-h-strike">Strike</th>
                        <th class="cv-h">Side</th>
                        <th class="cv-h cv-h-tag">Signal</th>
                        <th class="cv-h cv-h-num">Latest OI</th>
                        <th class="cv-h cv-h-num">Prev Avg</th>
                        <th class="cv-h cv-h-num">Δ%</th>
                        <th class="cv-h cv-h-num">Dominance</th>
                        <th class="cv-h cv-h-num">Distance</th>
                        <th class="cv-h cv-h-num">Call / Put</th>
                        <th class="cv-h cv-h-score">Score</th>
                    </tr>
                </thead>
                <tbody>
                    {#each analysis.rows as row (row.strike)}
                        {@const meta = TAG_META[row.tag] || TAG_META.normal}
                        {@const sTones = toneClasses(sideTone(row.side))}
                        {@const dTones = toneClasses(deltaTone(row.deltaPct, row.tag))}
                        {@const pct = Math.min(100, Math.round((row.score / Math.max(analysis.maxScore, 1)) * 100))}
                        <tr class="cv-row">
                            <td class="cv-strike">{fmtStrike(row.strike)}</td>
                            <td class={`cv-side ${sTones.text}`}>{row.side.toUpperCase()}</td>
                            <td class="cv-tag">
                                <Badge variant={meta.tone}>{meta.label}</Badge>
                            </td>
                            <td class="cv-num cv-latest">{fmtNumber(row.latest, 0)}</td>
                            <td class="cv-num cv-muted">{fmtNumber(row.prevAvg, row.prevAvg < 10 ? 1 : 0)}</td>
                            <td class={`cv-num ${dTones.text}`}>{fmtPct(row.deltaPct)}</td>
                            <td class="cv-num">{fmtMult(row.dominance)}</td>
                            <td class="cv-num cv-muted">{fmtDistance(row.distance, analysis.underlying)}</td>
                            <td class="cv-num cv-muted">
                                {#if row.callOi != null && row.putOi != null}
                                    <span class="text-call">{fmtK(row.callOi) || '0'}</span>
                                    <span class="text-muted-foreground"> / </span>
                                    <span class="text-put">{fmtK(row.putOi) || '0'}</span>
                                {:else}
                                    —
                                {/if}
                            </td>
                            <td class="cv-score">
                                <div class="cv-bar">
                                    <div class="cv-bar-fill" style="width:{pct}%"></div>
                                </div>
                                <span class="cv-score-num">{fmtNumber(row.score, 0)}</span>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>

            <div class="border-t border-border bg-surface px-4 py-2 text-[10px] text-muted-foreground">
                <span class="font-semibold uppercase tracking-widest">Legend</span>
                <span class="ml-2">growth Δ vs avg of prior {heatmap?.dates?.length ? heatmap.dates.length - 1 : '~11'} days · dominance = latest ÷ median of ±10 neighboring strikes</span>
            </div>
        {/if}
    </div>
</Card>

<style>
    .cv-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: hsl(var(--foreground));
    }

    .cv-h {
        position: sticky;
        top: 0;
        z-index: 20;
        background: hsl(var(--surface));
        color: hsl(var(--muted-foreground));
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        padding: 8px 10px;
        border-bottom: 1px solid hsl(var(--border));
        white-space: nowrap;
        text-align: left;
    }
    .cv-h-strike { left: 0; z-index: 30; border-right: 1px solid hsl(var(--border)); }
    .cv-h-num { text-align: right; }
    .cv-h-tag { text-align: left; }
    .cv-h-score { text-align: right; min-width: 140px; }

    .cv-row td {
        padding: 6px 10px;
        border-bottom: 1px solid hsl(var(--border));
        white-space: nowrap;
    }
    .cv-row:hover td {
        background: hsl(var(--surface-elevated));
    }

    .cv-strike {
        position: sticky;
        left: 0;
        background: hsl(var(--surface));
        color: hsl(var(--foreground));
        font-weight: 700;
        border-right: 1px solid hsl(var(--border));
        min-width: 80px;
    }
    .cv-row:hover .cv-strike {
        background: hsl(var(--surface-elevated));
    }

    .cv-side { font-weight: 700; letter-spacing: 0.08em; }
    .cv-tag { padding-right: 12px; }
    .cv-num { text-align: right; }
    .cv-latest { font-weight: 600; }
    .cv-muted { color: hsl(var(--muted-foreground)); }

    .cv-score {
        text-align: right;
        min-width: 140px;
    }
    .cv-bar {
        display: inline-block;
        width: 80px;
        height: 6px;
        margin-right: 8px;
        background: hsl(var(--muted) / 0.4);
        border-radius: 2px;
        overflow: hidden;
        vertical-align: middle;
    }
    .cv-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, hsl(var(--primary)) 0%, hsl(var(--warn)) 100%);
        border-radius: 2px;
    }
    .cv-score-num {
        display: inline-block;
        min-width: 32px;
        text-align: right;
        font-weight: 700;
    }
</style>
