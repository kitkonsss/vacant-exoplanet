<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import { TrendingUp, TrendingDown, Minus } from 'lucide-svelte';

    let { assetId = 'gc', macro = null, cot = null, loading = false } = $props();

    // 'gc' -> the macro file keys its interpretation under 'gold'; 'nq' -> 'nq'.
    const macroKey = $derived(assetId === 'gc' ? 'gold' : 'nq');
    const interp = $derived(macro?.interpretation?.[macroKey] || null);
    const series = $derived(macro?.series || {});

    // Which series to show, in display order. label -> friendly heading.
    const SERIES_ORDER = [
        ['real_yield_10y', '10Y Real Yield'],
        ['nominal_10y', '10Y Yield'],
        ['nominal_2y', '2Y Yield'],
        ['breakeven_10y', '10Y Breakeven'],
        ['curve_2s10s', '2s10s Curve'],
        ['dxy', 'Dollar (DXY)'],
        ['vix_live', 'VIX'],
    ];
    const seriesCards = $derived(
        SERIES_ORDER
            .map(([k, title]) => {
                // fall back to FRED variants when the live/preferred key is absent
                const s = series[k]
                    || (k === 'dxy' ? series.dxy_broad : null)
                    || (k === 'vix_live' ? series.vix : null);
                return s ? { key: k, title, s } : null;
            })
            .filter(Boolean)
    );

    function fmtVal(s) {
        if (s == null || s.value == null) return '—';
        return s.unit === 'pct' ? `${s.value.toFixed(2)}%` : s.value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    function fmtChg(s) {
        // prefer basis-point change for rate series, else raw / pct
        if (s.chg_5d_bp != null) return `${s.chg_5d_bp > 0 ? '+' : ''}${s.chg_5d_bp}bp`;
        if (s.pct_5d != null) return `${s.pct_5d > 0 ? '+' : ''}${s.pct_5d.toFixed(2)}%`;
        if (s.chg_5d != null) return `${s.chg_5d > 0 ? '+' : ''}${s.chg_5d}`;
        return '';
    }
    function chgDir(s) {
        const v = s.chg_5d_bp ?? s.pct_5d ?? s.chg_5d ?? 0;
        return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    }

    function labelVariant(label) {
        if (label === 'tailwind' || label === 'bullish') return 'up';
        if (label === 'headwind' || label === 'bearish') return 'down';
        return 'muted';
    }
    function fmtNum(n) {
        if (n == null) return '—';
        return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }
    function fmtSigned(n) {
        if (n == null) return '—';
        return `${n > 0 ? '+' : ''}${fmtNum(n)}`;
    }
    function trendVariant(t) {
        if (t === 'rising') return 'up';
        if (t === 'falling') return 'down';
        return 'muted';
    }

    // COT trader groups vary by asset (gold = Disaggregated, NQ = TFF).
    const cotGroups = $derived.by(() => {
        if (!cot) return [];
        if (cot.managed_money) {
            return [
                { name: 'Managed Money', g: cot.managed_money, primary: true },
                { name: 'Producer/Merchant', g: cot.producer_merchant },
                { name: 'Swap Dealer', g: cot.swap_dealer },
            ].filter((x) => x.g);
        }
        return [
            { name: 'Leveraged Funds', g: cot.leveraged_funds, primary: true },
            { name: 'Asset Managers', g: cot.asset_manager, primary: true },
            { name: 'Dealers', g: cot.dealer },
        ].filter((x) => x.g);
    });
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Loading macro &amp; COT…</span>
        </div>
    </div>
{:else if !macro && !cot}
    <Card class="p-8 text-center">
        <div class="font-semibold text-foreground">No Macro / COT Data</div>
        <p class="mt-1 text-sm text-muted-foreground">
            The macro fetcher has not published data/macro.json yet. Run the
            “Fetch Macro + COT” workflow.
        </p>
    </Card>
{:else}
    <div class="flex flex-col gap-4">
        <!-- ===== Macro regime banner ===== -->
        {#if interp}
            <Card class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex items-center gap-3">
                        <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            Macro Regime — {assetId.toUpperCase()}
                        </span>
                        <Badge variant={labelVariant(interp.label)}>{interp.label}</Badge>
                        <span class="font-mono text-sm tabular-nums {interp.score > 0 ? 'text-up' : interp.score < 0 ? 'text-down' : 'text-muted-foreground'}">
                            {interp.score > 0 ? '+' : ''}{interp.score}
                        </span>
                    </div>
                    {#if macro?.generated_at}
                        <span class="font-mono text-[10px] text-muted-foreground">
                            {new Date(macro.generated_at).toLocaleString()}
                        </span>
                    {/if}
                </div>
                {#if interp.drivers?.length}
                    <ul class="mt-3 flex flex-col gap-1.5">
                        {#each interp.drivers as d}
                            <li class="text-sm text-foreground">• {d}</li>
                        {/each}
                    </ul>
                {/if}
            </Card>
        {/if}

        <!-- ===== Macro series grid ===== -->
        {#if seriesCards.length}
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {#each seriesCards as { key, title, s } (key)}
                    {@const dir = chgDir(s)}
                    <Card class="p-3">
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
                        <div class="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{fmtVal(s)}</div>
                        <div class="mt-1 flex items-center gap-1 text-xs {dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-muted-foreground'}">
                            {#if dir === 'up'}<TrendingUp class="h-3 w-3" />{:else if dir === 'down'}<TrendingDown class="h-3 w-3" />{:else}<Minus class="h-3 w-3" />{/if}
                            <span class="font-mono tabular-nums">{fmtChg(s)}</span>
                            <span class="text-muted-foreground">5d</span>
                        </div>
                    </Card>
                {/each}
            </div>
        {/if}

        <!-- ===== COT positioning ===== -->
        {#if cot}
            <Card class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        CFTC COT — {cot.asset}
                    </span>
                    <div class="flex items-center gap-2">
                        {#if cot.interpretation?.label}
                            <Badge variant={labelVariant(cot.interpretation.label)}>{cot.interpretation.label}</Badge>
                        {/if}
                        {#if cot.report_date}
                            <span class="font-mono text-[10px] text-muted-foreground">report {cot.report_date}</span>
                        {/if}
                    </div>
                </div>

                {#if cot.interpretation?.note}
                    <p class="mt-2 text-sm text-foreground">{cot.interpretation.note}</p>
                {/if}

                <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
                    {#each cotGroups as { name, g, primary } (name)}
                        <div class="rounded-md border border-border p-3 {primary ? '' : 'opacity-80'}">
                            <div class="flex items-center justify-between">
                                <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{name}</span>
                                <Badge variant={trendVariant(g.trend)}>{g.trend}</Badge>
                            </div>
                            <div class="mt-1 font-mono text-base font-semibold tabular-nums {g.net > 0 ? 'text-up' : g.net < 0 ? 'text-down' : 'text-foreground'}">
                                net {fmtSigned(g.net)}
                            </div>
                            <div class="mt-1 flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
                                <span>L {fmtNum(g.long)}</span>
                                <span>S {fmtNum(g.short)}</span>
                                {#if g.net_chg_1w != null}<span>1w {fmtSigned(g.net_chg_1w)}</span>{/if}
                            </div>
                        </div>
                    {/each}
                </div>

                {#if cot.open_interest != null}
                    <div class="mt-2 font-mono text-[10px] text-muted-foreground">
                        Total OI {fmtNum(cot.open_interest)} · {cot.source || 'CFTC'}
                    </div>
                {/if}
            </Card>
        {/if}
    </div>
{/if}
