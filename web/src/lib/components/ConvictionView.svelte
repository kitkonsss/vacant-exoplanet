<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import { cn, fmtNumber, fmtStrike, fmtK, toneClasses } from '$lib/utils.js';
    import { CONTRACT_OPTIONS } from '$lib/config.js';
    import { analyzeConvictionMulti, TAG_META, GAMMA_TAG_META, VERDICT_META, BIAS_META } from '$lib/conviction.js';

    let {
        contracts = [],   // [{ key, dte, bias, heatmap, gamma }, ...]
        loading = false
    } = $props();

    const analysis = $derived(analyzeConvictionMulti({ contractsData: contracts }));
    const TENOR_KEYS = CONTRACT_OPTIONS.map((c) => c.key);
    const TENOR_LABELS = Object.fromEntries(CONTRACT_OPTIONS.map((c) => [c.key, c.label]));

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
        return `${sign}${fmtNumber(Math.abs(points), 0)} (${pct.toFixed(1)}%)`;
    }

    function sideTone(side) {
        if (side === 'call') return 'call';
        if (side === 'put') return 'put';
        return 'muted';
    }

    function confidenceMeta(c) {
        switch (c) {
            case 'high':   return { label: 'High',   tone: 'up' };
            case 'medium': return { label: 'Medium', tone: 'warn' };
            default:       return { label: 'Low',    tone: 'muted' };
        }
    }

    function bestTag(tags) {
        const priority = ['growing_wall', 'emerging', 'fresh', 'building', 'established', 'fading', 'normal'];
        for (const p of priority) if (tags.includes(p)) return p;
        return 'normal';
    }

    function bestGammaTag(tags) {
        const priority = ['pin', 'pin_building', 'gamma'];
        for (const p of priority) if (tags?.includes(p)) return p;
        return 'none';
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
                    OI · OI-growth · gamma fused across {analysis.verdict.totalTenors} tenors · underlying
                    <span class="font-mono">{fmtStrike(analysis.underlying)}</span>
                    {#if !analysis.anyGamma}<span class="text-warn"> · no gamma</span>{/if}
                {:else if !loading}
                    No data
                {/if}
            </span>
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
        {:else if !analysis || analysis.walls.length === 0}
            <div class="flex h-64 items-center justify-center">
                <div class="text-center">
                    <div class="text-sm font-semibold text-foreground">No conviction signals</div>
                    <p class="mt-1 max-w-md text-xs text-muted-foreground">
                        Need PositionBias + OIHeatmap (and ideally GammaHeatmap) JSON for at least one contract.
                    </p>
                </div>
            </div>
        {:else}
            {@const pin = analysis.pin}
            {@const mb = analysis.modelBias}

            <!-- ROW 1: Gamma Pin (headline) + Model Bias -->
            <div class="grid gap-3 border-b border-border bg-surface px-4 py-3 lg:grid-cols-3">
                <!-- Gamma Pin map -->
                <div class="lg:col-span-2 rounded-md border border-mag/30 bg-background px-4 py-3">
                    <div class="flex items-baseline justify-between">
                        <span class="text-[9px] font-semibold uppercase tracking-widest text-mag">
                            Gamma Pin Map
                        </span>
                        <span class="text-[9px] text-muted-foreground">where price is magnetised</span>
                    </div>
                    {#if pin && pin.peakStrike != null}
                        <div class="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
                            <div>
                                <div class="text-[9px] uppercase tracking-widest text-muted-foreground">Primary pin</div>
                                <div class="font-mono text-2xl font-semibold text-mag">{fmtStrike(pin.peakStrike)}</div>
                                <div class="text-[10px] font-mono text-muted-foreground">
                                    {fmtDistance(pin.peakDistance, analysis.underlying)} · {Math.round(pin.peakGamma)} γ
                                </div>
                            </div>
                            {#if pin.nearest && pin.nearest.strike !== pin.peakStrike}
                                <div>
                                    <div class="text-[9px] uppercase tracking-widest text-muted-foreground">Nearest pin</div>
                                    <div class="font-mono text-lg font-semibold text-foreground">{fmtStrike(pin.nearest.strike)}</div>
                                    <div class="text-[10px] font-mono text-muted-foreground">
                                        {fmtDistance(pin.nearest.distance, analysis.underlying)}
                                    </div>
                                </div>
                            {/if}
                        </div>

                        <!-- Gamma balance: below vs above price -->
                        {#if pin.gammaTotal > 0}
                            {@const belowPct = (pin.gammaBelow / pin.gammaTotal) * 100}
                            <div class="mt-3">
                                <div class="flex justify-between text-[9px] font-mono text-muted-foreground">
                                    <span>γ below (support) {Math.round(belowPct)}%</span>
                                    <span>γ above (resist.) {Math.round(100 - belowPct)}%</span>
                                </div>
                                <div class="mt-1 flex h-2 overflow-hidden rounded-sm border border-border bg-muted">
                                    <div class="bg-up" style="width:{belowPct}%"></div>
                                    <div class="bg-down" style="width:{100 - belowPct}%"></div>
                                </div>
                            </div>
                        {/if}
                    {:else}
                        <p class="mt-3 text-[11px] text-muted-foreground">
                            Gamma data unavailable for these contracts — pin strength can't be measured.
                            Walls below are ranked on OI level, growth, and dominance only.
                        </p>
                    {/if}
                </div>

                <!-- Model bias (authoritative) + heuristic skew -->
                <div class="rounded-md border border-border bg-background px-4 py-3">
                    <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Directional Bias
                    </div>
                    {#if mb}
                        {@const bm = BIAS_META[mb.label] || BIAS_META.neutral}
                        {@const bTones = toneClasses(bm.tone)}
                        <div class={`mt-1 font-mono text-2xl font-semibold ${bTones.text}`}>{bm.label}</div>
                        <div class="text-[10px] text-muted-foreground">
                            model bias · score <span class="font-mono">{fmtNumber(mb.score, 0)}</span> · DTE-weighted (server)
                        </div>
                        <div class="mt-2 flex flex-wrap gap-1">
                            {#each mb.perTenor as t}
                                {@const tm = BIAS_META[t.label] || BIAS_META.neutral}
                                {@const tt = toneClasses(tm.tone)}
                                <span class={`rounded border ${tt.border} px-1.5 py-0.5 font-mono text-[9px] ${tt.text}`}>
                                    {TENOR_LABELS[t.key] || t.key} {t.score >= 0 ? '+' : ''}{Math.round(t.score)}
                                </span>
                            {/each}
                        </div>
                    {:else}
                        <div class="mt-1 font-mono text-base font-semibold text-muted-foreground">n/a</div>
                        <div class="text-[10px] text-muted-foreground">no server bias on these contracts</div>
                    {/if}

                    <!-- Heuristic skew — explicitly secondary -->
                    {#if analysis.verdict}
                        {@const sk = VERDICT_META[analysis.verdict.label] || VERDICT_META.neutral}
                        {@const skTones = toneClasses(sk.tone)}
                        {@const conf = confidenceMeta(analysis.verdict.confidence)}
                        <div class="mt-3 border-t border-border pt-2">
                            <div class="flex items-baseline justify-between">
                                <span class="text-[9px] uppercase tracking-widest text-muted-foreground">Wall geometry (heuristic)</span>
                                <Badge variant={conf.tone}>{conf.label}</Badge>
                            </div>
                            <div class={`mt-0.5 font-mono text-sm font-semibold ${skTones.text}`}>{sk.label}</div>
                            {#if analysis.verdict.bullish + analysis.verdict.bearish > 0}
                                {@const total = analysis.verdict.bullish + analysis.verdict.bearish}
                                {@const bullPct = (analysis.verdict.bullish / total) * 100}
                                <div class="mt-1 flex h-1.5 overflow-hidden rounded-sm border border-border bg-muted">
                                    <div class="bg-up" style="width:{bullPct}%"></div>
                                    <div class="bg-down" style="width:{100 - bullPct}%"></div>
                                </div>
                                <div class="mt-0.5 flex justify-between text-[9px] font-mono text-muted-foreground">
                                    <span>support {fmtNumber(analysis.verdict.bullish, 0)}</span>
                                    <span>{analysis.verdict.agreement}/{analysis.verdict.totalTenors} tenors</span>
                                    <span>resist. {fmtNumber(analysis.verdict.bearish, 0)}</span>
                                </div>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>

            <!-- ROW 2: Insights -->
            <div class="border-b border-border bg-background px-4 py-3">
                <div class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Key Insights
                </div>
                <ul class="mt-2 grid gap-1.5 text-[12px] text-foreground md:grid-cols-2">
                    {#each analysis.insights as ins}
                        <li class="flex gap-2">
                            <span class="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-warn"></span>
                            <span>{ins}</span>
                        </li>
                    {/each}
                </ul>
            </div>

            <!-- ROW 3: Support / Resistance -->
            <div class="grid gap-3 border-b border-border bg-background px-4 py-3 md:grid-cols-2">
                <!-- Support -->
                <div class="rounded-md border border-up/30 bg-background p-3">
                    <div class="mb-2 flex items-baseline justify-between">
                        <span class="text-[10px] font-semibold uppercase tracking-widest text-up">
                            Support Cluster (below price)
                        </span>
                        <span class="text-[9px] text-muted-foreground">{analysis.support.length} strikes</span>
                    </div>
                    {#if analysis.support.length === 0}
                        <div class="text-[11px] text-muted-foreground">No high-conviction support strikes detected.</div>
                    {:else}
                        <ul class="space-y-1">
                            {#each analysis.support as s}
                                <li class="flex items-center gap-2 text-[11px] font-mono tabular-nums">
                                    <span class="w-14 font-semibold text-foreground">{fmtStrike(s.strike)}</span>
                                    {#if s.isPin}<Badge variant="mag">Pin</Badge>{/if}
                                    <span class="w-16 text-[10px] text-muted-foreground">
                                        {fmtDistance(s.distance, analysis.underlying)}
                                    </span>
                                    <span class="flex gap-0.5">
                                        {#each TENOR_KEYS as tk}
                                            <span
                                                class={cn('h-2 w-2 rounded-full', s.tenors[tk] ? 'bg-up' : 'bg-muted')}
                                                title={TENOR_LABELS[tk]}
                                            ></span>
                                        {/each}
                                    </span>
                                    <span class="ml-auto text-muted-foreground">{fmtK(s.totalOiSum) || s.totalOiSum} OI</span>
                                    <span class="w-12 text-right font-semibold text-up">{fmtNumber(s.aggregateScore, 0)}</span>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>

                <!-- Resistance -->
                <div class="rounded-md border border-down/30 bg-background p-3">
                    <div class="mb-2 flex items-baseline justify-between">
                        <span class="text-[10px] font-semibold uppercase tracking-widest text-down">
                            Resistance Cluster (above price)
                        </span>
                        <span class="text-[9px] text-muted-foreground">{analysis.resistance.length} strikes</span>
                    </div>
                    {#if analysis.resistance.length === 0}
                        <div class="text-[11px] text-muted-foreground">No high-conviction resistance strikes detected.</div>
                    {:else}
                        <ul class="space-y-1">
                            {#each analysis.resistance as s}
                                <li class="flex items-center gap-2 text-[11px] font-mono tabular-nums">
                                    <span class="w-14 font-semibold text-foreground">{fmtStrike(s.strike)}</span>
                                    {#if s.isPin}<Badge variant="mag">Pin</Badge>{/if}
                                    <span class="w-16 text-[10px] text-muted-foreground">
                                        {fmtDistance(s.distance, analysis.underlying)}
                                    </span>
                                    <span class="flex gap-0.5">
                                        {#each TENOR_KEYS as tk}
                                            <span
                                                class={cn('h-2 w-2 rounded-full', s.tenors[tk] ? 'bg-down' : 'bg-muted')}
                                                title={TENOR_LABELS[tk]}
                                            ></span>
                                        {/each}
                                    </span>
                                    <span class="ml-auto text-muted-foreground">{fmtK(s.totalOiSum) || s.totalOiSum} OI</span>
                                    <span class="w-12 text-right font-semibold text-down">{fmtNumber(s.aggregateScore, 0)}</span>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            </div>

            <!-- ROW 4: Term Structure -->
            <div class="border-b border-border bg-background px-4 py-3">
                <div class="mb-2 flex items-center gap-2">
                    <span class="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Term Structure
                    </span>
                    <span class="text-[10px] text-muted-foreground">server bias · wall-geometry skew</span>
                </div>
                <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                    {#each analysis.tenorBias as t}
                        {@const sv = BIAS_META[t.serverLabel] || null}
                        {@const tv = VERDICT_META[t.verdict] || VERDICT_META.neutral}
                        {@const svTones = sv ? toneClasses(sv.tone) : toneClasses('muted')}
                        {@const geoTones = toneClasses(tv.tone)}
                        <div class={`rounded-md border ${svTones.border} bg-background px-3 py-2`}>
                            <div class="flex items-baseline justify-between">
                                <span class="font-mono text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                                    {TENOR_LABELS[t.key] || t.key}
                                </span>
                                <span class="font-mono text-[9px] text-muted-foreground">
                                    {t.dte != null ? `${t.dte.toFixed(1)} DTE` : ''}
                                </span>
                            </div>
                            <div class={`mt-1 font-mono text-base font-semibold ${svTones.text}`}>
                                {sv ? sv.label : '—'}
                            </div>
                            <div class="mt-0.5 flex items-center justify-between text-[10px]">
                                <span class="font-mono tabular-nums text-muted-foreground">
                                    {t.serverScore != null ? `${t.serverScore >= 0 ? '+' : ''}${t.serverScore.toFixed(0)}` : ''}
                                </span>
                                <span class={`font-mono ${geoTones.text}`}>geo {tv.label}</span>
                            </div>
                        </div>
                    {/each}
                </div>
            </div>

            <!-- ROW 5: Multi-Tenor Walls table -->
            <div class="px-4 py-3">
                <div class="mb-2 flex items-baseline justify-between">
                    <span class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Multi-Tenor Walls
                    </span>
                    <span class="text-[9px] text-muted-foreground">
                        score = OI + {0.7}×gamma, ×1.2 when both dominant, ×√tenors
                    </span>
                </div>
                <table class="cv-table">
                    <thead>
                        <tr>
                            <th class="cv-h cv-h-strike">Strike</th>
                            <th class="cv-h">Side</th>
                            <th class="cv-h cv-h-tenor">Tenors</th>
                            <th class="cv-h cv-h-num">Distance</th>
                            <th class="cv-h cv-h-num">Sum OI</th>
                            <th class="cv-h cv-h-num">Gamma</th>
                            <th class="cv-h cv-h-num">γ Dom</th>
                            <th class="cv-h cv-h-num">Δ OI%</th>
                            <th class="cv-h">Signal</th>
                            <th class="cv-h cv-h-score">Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each analysis.walls as w (w.strike)}
                            {@const tag = bestTag(w.tags)}
                            {@const tagMeta = TAG_META[tag] || TAG_META.normal}
                            {@const gTag = bestGammaTag(w.gammaTags)}
                            {@const gTagMeta = GAMMA_TAG_META[gTag] || GAMMA_TAG_META.none}
                            {@const sTones = toneClasses(sideTone(w.side))}
                            {@const dotColor = w.above ? 'bg-down' : 'bg-up'}
                            {@const pct = Math.min(100, Math.round((w.aggregateScore / Math.max(analysis.walls[0]?.aggregateScore || 1, 1)) * 100))}
                            <tr class={cn('cv-row', w.isPin && 'cv-row-pin')}>
                                <td class="cv-strike">{fmtStrike(w.strike)}</td>
                                <td class={`cv-side ${sTones.text}`}>{w.side.toUpperCase()}</td>
                                <td>
                                    <div class="flex items-center gap-0.5">
                                        {#each TENOR_KEYS as tk}
                                            <span
                                                class={cn('h-2 w-2 rounded-full', w.tenors[tk] ? dotColor : 'bg-muted')}
                                                title={TENOR_LABELS[tk]}
                                            ></span>
                                        {/each}
                                        <span class="ml-2 font-mono text-[10px] text-muted-foreground">{w.tenorCount}/4</span>
                                    </div>
                                </td>
                                <td class="cv-num cv-muted">{fmtDistance(w.distance, analysis.underlying)}</td>
                                <td class="cv-num cv-latest">{fmtNumber(w.totalOiSum, 0)}</td>
                                <td class={`cv-num ${w.gammaSum > 0 ? 'text-mag' : 'cv-muted'}`}>{fmtNumber(w.gammaSum, 0)}</td>
                                <td class="cv-num">{fmtMult(w.maxGammaDominance)}</td>
                                <td class={`cv-num ${w.avgGrowthPct != null && w.avgGrowthPct >= 0.5 ? 'text-warn' : w.avgGrowthPct != null && w.avgGrowthPct < 0 ? 'text-down' : 'cv-muted'}`}>
                                    {fmtPct(w.avgGrowthPct)}
                                </td>
                                <td>
                                    <div class="flex items-center gap-1">
                                        <Badge variant={tagMeta.tone}>{tagMeta.label}</Badge>
                                        {#if gTag !== 'none'}<Badge variant={gTagMeta.tone}>{gTagMeta.label}</Badge>{/if}
                                    </div>
                                </td>
                                <td class="cv-score">
                                    <div class="cv-bar">
                                        <div class="cv-bar-fill" style="width:{pct}%"></div>
                                    </div>
                                    <span class="cv-score-num">{fmtNumber(w.aggregateScore, 0)}</span>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>

                <div class="mt-2 text-[10px] text-muted-foreground">
                    Gamma = aggregate Gamma (1 Pct) across tenors · γ Dom = gamma ÷ median of ±10 neighbors ·
                    Pin = dominant gamma magnet · Δ OI% = avg OI growth vs prior days
                </div>
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
    .cv-h-tenor { min-width: 90px; }
    .cv-h-score { text-align: right; min-width: 140px; }

    .cv-row td {
        padding: 6px 10px;
        border-bottom: 1px solid hsl(var(--border));
        white-space: nowrap;
    }
    .cv-row:hover td {
        background: hsl(var(--surface-elevated));
    }
    .cv-row-pin td {
        background: hsl(var(--mag) / 0.06);
    }
    .cv-row-pin:hover td {
        background: hsl(var(--mag) / 0.12);
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
    .cv-row-pin .cv-strike {
        background: hsl(var(--mag) / 0.06);
    }

    .cv-side { font-weight: 700; letter-spacing: 0.08em; }
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
