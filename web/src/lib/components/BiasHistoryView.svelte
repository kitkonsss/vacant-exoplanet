<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import PcrTrendChart from './PcrTrendChart.svelte';
    import { ASSET_PROFILES, CONTRACT_OPTIONS } from '$lib/config.js';
    import { cn } from '$lib/utils.js';

    let {
        history = null,
        loading = false,
        assetId = $bindable('gc'),
        contractKey = $bindable('current')
    } = $props();

    const slotLabels = {
        morning: 'Morning',
        afternoon: 'Afternoon',
        evening: 'Evening',
        night: 'Night'
    };

    const contractOptions = [
        { key: 'summary', label: 'Summary' },
        ...CONTRACT_OPTIONS
    ];

    const assetOptions = $derived(
        Object.values(ASSET_PROFILES).filter((asset) => asset.source !== 'crypto')
    );

    const records = $derived(history?.records || []);
    const filtered = $derived.by(() => {
        return records
            .filter((record) => record.asset === assetId && record.contract_key === contractKey)
            .sort((a, b) => {
                const ad = `${a.date_bangkok || ''}-${String(a.slot_order || 0).padStart(2, '0')}-${a.captured_at_utc || ''}`;
                const bd = `${b.date_bangkok || ''}-${String(b.slot_order || 0).padStart(2, '0')}-${b.captured_at_utc || ''}`;
                return ad.localeCompare(bd);
            });
    });

    const latest = $derived(filtered[filtered.length - 1] || null);
    const contractRows = $derived(filtered.filter((row) => row.contract_key !== 'summary'));
    const bullishRows = $derived(filtered.filter((row) => toneForBias(row.bias?.label, row.bias?.score) === 'up'));
    const bearishRows = $derived(filtered.filter((row) => toneForBias(row.bias?.label, row.bias?.score) === 'down'));
    const putHeavyRows = $derived(contractRows.filter((row) => Number(row.totals?.oi_put_call_ratio) > 1));
    const flowReadyRows = $derived(contractRows.filter((row) => isFlowReady(row)));
    const missingFlowRows = $derived(contractRows.filter((row) => !isFlowReady(row)));
    const volPutHeavyRows = $derived(flowReadyRows.filter((row) => Number(row.totals?.volume_put_call_ratio) > 1));

    const latestBiasStreak = $derived.by(() => {
        const tone = toneForBias(latest?.bias?.label, latest?.bias?.score);
        let n = 0;
        for (let i = filtered.length - 1; i >= 0; i -= 1) {
            if (toneForBias(filtered[i].bias?.label, filtered[i].bias?.score) === tone) n += 1;
            else break;
        }
        return n;
    });

    const putHeavyStreak = $derived.by(() => {
        let n = 0;
        for (let i = contractRows.length - 1; i >= 0; i -= 1) {
            if (Number(contractRows[i].totals?.oi_put_call_ratio) > 1) n += 1;
            else break;
        }
        return n;
    });

    const latestTone = $derived(toneForBias(latest?.bias?.label, latest?.bias?.score));

    function toneForBias(label, score) {
        const text = String(label || '').toLowerCase();
        const s = Number(score);
        if (text.includes('bull') || s > 5) return 'up';
        if (text.includes('bear') || s < -5) return 'down';
        return 'muted';
    }

    function pcrTone(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n > 1.15) return 'down';
        if (n < 0.85) return 'up';
        return 'muted';
    }

    function isFlowReady(row) {
        if (!row || row.contract_key === 'summary') return false;
        if (row.flow_ready === false) return false;
        const n = Number(row.totals?.intraday_volume);
        return Number.isFinite(n) && n > 0;
    }

    function flowLabel(row) {
        return isFlowReady(row) ? 'ready' : 'no flow';
    }

    function flowClass(row) {
        return isFlowReady(row) ? 'text-up' : 'text-muted-foreground';
    }

    function fmt(value, digits = 2) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toFixed(digits) : '-';
    }

    function fmtScore(value) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}` : '-';
    }

    function fmtFlow(row, key, digits = 2) {
        return isFlowReady(row) ? fmt(row.totals?.[key], digits) : '-';
    }

    function stamp(row) {
        if (!row) return '-';
        const raw = row.captured_at_bangkok || row.captured_at_utc || '';
        const match = String(raw).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
        const dateTime = match ? `${match[1]} ${match[2]}` : (row.date_bangkok || '-');
        const slot = slotLabels[row.slot] || row.slot || '';
        return `${dateTime} ${slot}`.trim();
    }
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Loading bias history...</span>
        </div>
    </div>
{:else}
    <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 flex-wrap items-center gap-2.5">
                <span class="h-3 w-1 rounded-sm bg-primary"></span>
                <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Bias History</span>
                <span class="font-mono text-[10px] text-muted-foreground">{records.length} records</span>
                {#if history?.load_error}
                    <span class="rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warn">
                        retry failed
                    </span>
                {/if}
                {#if history?.updated_utc}
                    <span class="font-mono text-[10px] text-muted-foreground">updated {new Date(history.updated_utc).toLocaleString()}</span>
                {/if}
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <div class="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
                    {#each assetOptions as asset}
                        <button
                            type="button"
                            onclick={() => (assetId = asset.id)}
                            class={cn(
                                'rounded px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                                assetId === asset.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {asset.shortLabel}
                        </button>
                    {/each}
                </div>
                <div class="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
                    {#each contractOptions as option}
                        <button
                            type="button"
                            onclick={() => (contractKey = option.key)}
                            class={cn(
                                'rounded px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                                contractKey === option.key ? 'bg-warn text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {option.label}
                        </button>
                    {/each}
                </div>
            </div>
        </div>

        {#if history?.load_error && !records.length}
            <Card class="p-8 text-center">
                <div class="font-semibold text-foreground">History Load Failed</div>
                <p class="mt-1 text-sm text-muted-foreground">
                    The history file did not load this time. Refresh again after the network request completes.
                </p>
            </Card>
        {:else if !filtered.length}
            <Card class="p-8 text-center">
                <div class="font-semibold text-foreground">No History Yet</div>
                <p class="mt-1 text-sm text-muted-foreground">
                    Bias snapshots will appear after the next scrape writes this asset and contract slot.
                </p>
            </Card>
        {:else}
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card class="p-3">
                    <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Latest Read</div>
                    <div class="mt-1 flex items-center justify-between gap-2">
                        <Badge variant={latestTone}>{(latest?.bias?.label || 'neutral').replaceAll('_', ' ')}</Badge>
                        <span class="font-mono text-sm tabular-nums {latestTone === 'up' ? 'text-up' : latestTone === 'down' ? 'text-down' : 'text-muted-foreground'}">
                            {fmtScore(latest?.bias?.score)}
                        </span>
                    </div>
                    <div class="mt-1 font-mono text-[10px] text-muted-foreground">{stamp(latest)}</div>
                </Card>

                <Card class="p-3">
                    {#if contractKey === 'summary'}
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bias Streak</div>
                        <div class="mt-1 font-mono text-2xl font-semibold tabular-nums {latestTone === 'up' ? 'text-up' : latestTone === 'down' ? 'text-down' : 'text-muted-foreground'}">{latestBiasStreak}</div>
                        <div class="text-[10px] text-muted-foreground">same-bias reads</div>
                    {:else}
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">OI P/C Streak</div>
                        <div class="mt-1 font-mono text-2xl font-semibold tabular-nums {putHeavyStreak ? 'text-down' : 'text-muted-foreground'}">{putHeavyStreak}</div>
                        <div class="text-[10px] text-muted-foreground">consecutive put-heavy reads</div>
                    {/if}
                </Card>

                <Card class="p-3">
                    {#if contractKey === 'summary'}
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bullish Share</div>
                        <div class="mt-1 font-mono text-2xl font-semibold tabular-nums text-up">
                            {filtered.length ? Math.round((bullishRows.length / filtered.length) * 100) : 0}%
                        </div>
                        <div class="text-[10px] text-muted-foreground">{bullishRows.length}/{filtered.length} summary records</div>
                    {:else}
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Put-Heavy Share</div>
                        <div class="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
                            {contractRows.length ? Math.round((putHeavyRows.length / contractRows.length) * 100) : 0}%
                        </div>
                        <div class="text-[10px] text-muted-foreground">{putHeavyRows.length}/{contractRows.length} contract records</div>
                    {/if}
                </Card>

                <Card class="p-3">
                    {#if contractKey === 'summary'}
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bearish Share</div>
                        <div class="mt-1 font-mono text-2xl font-semibold tabular-nums text-down">
                            {filtered.length ? Math.round((bearishRows.length / filtered.length) * 100) : 0}%
                        </div>
                        <div class="text-[10px] text-muted-foreground">{bearishRows.length}/{filtered.length} summary records</div>
                    {:else}
                        <div class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Volume P/C</div>
                        <div class="mt-1 font-mono text-2xl font-semibold tabular-nums text-foreground">
                            {flowReadyRows.length ? Math.round((volPutHeavyRows.length / flowReadyRows.length) * 100) : 0}%
                        </div>
                        <div class="text-[10px] text-muted-foreground">
                            {missingFlowRows.length ? `${missingFlowRows.length} no-flow reads skipped` : 'put-heavy ready-flow reads'}
                        </div>
                    {/if}
                </Card>
            </div>

            {#if contractKey !== 'summary'}
                <Card class="p-4">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            Put / Call Ratio Trend
                        </div>
                        <div class="flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span><span class="mr-1 inline-block h-[2px] w-5 bg-put align-middle"></span> OI P/C</span>
                            <span><span class="mr-1 inline-block h-[2px] w-5 bg-call align-middle"></span> Vol P/C</span>
                            <span><span class="mr-1 inline-block h-[1px] w-5 bg-border align-middle"></span> 1.00</span>
                        </div>
                    </div>

                    <div class="mt-3">
                        <PcrTrendChart rows={contractRows} />
                    </div>
                </Card>
            {/if}

            <Card class="overflow-hidden">
                <div class="border-b border-border px-4 py-3">
                    <div class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Snapshots</div>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left text-xs">
                        <thead>
                            <tr class="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                                <th class="px-4 py-2">Time</th>
                                <th class="px-3 py-2">Contract</th>
                                <th class="px-3 py-2 text-right">Price</th>
                                <th class="px-3 py-2 text-right">Score</th>
                                <th class="px-3 py-2">Bias</th>
                                <th class="px-3 py-2 text-right">OI P/C</th>
                                <th class="px-3 py-2 text-right">Vol P/C</th>
                                <th class="px-3 py-2">Flow</th>
                                <th class="px-3 py-2 text-right">Call Vol</th>
                                <th class="px-4 py-2 text-right">Put Vol</th>
                            </tr>
                        </thead>
                        <tbody class="font-mono tabular-nums">
                            {#each [...filtered].reverse() as row}
                                {@const tone = toneForBias(row.bias?.label, row.bias?.score)}
                                <tr class="border-b border-border/50">
                                    <td class="px-4 py-2 whitespace-nowrap text-muted-foreground">{stamp(row)}</td>
                                    <td class="px-3 py-2 text-foreground">{row.contract || row.contract_key}</td>
                                    <td class="px-3 py-2 text-right text-foreground">{fmt(row.future_price, 1)}</td>
                                    <td class="px-3 py-2 text-right {tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-muted-foreground'}">{fmtScore(row.bias?.score)}</td>
                                    <td class="px-3 py-2"><Badge variant={tone}>{(row.bias?.label || 'neutral').replaceAll('_', ' ')}</Badge></td>
                                    <td class="px-3 py-2 text-right {pcrTone(row.totals?.oi_put_call_ratio) === 'down' ? 'text-put' : pcrTone(row.totals?.oi_put_call_ratio) === 'up' ? 'text-call' : 'text-muted-foreground'}">{fmt(row.totals?.oi_put_call_ratio)}</td>
                                    <td class="px-3 py-2 text-right {pcrTone(row.totals?.volume_put_call_ratio) === 'down' && isFlowReady(row) ? 'text-put' : pcrTone(row.totals?.volume_put_call_ratio) === 'up' && isFlowReady(row) ? 'text-call' : 'text-muted-foreground'}">{fmtFlow(row, 'volume_put_call_ratio')}</td>
                                    <td class="px-3 py-2 whitespace-nowrap font-semibold uppercase tracking-wider {flowClass(row)}">{flowLabel(row)}</td>
                                    <td class="px-3 py-2 text-right text-call">{fmtFlow(row, 'call_volume', 0)}</td>
                                    <td class="px-4 py-2 text-right text-put">{fmtFlow(row, 'put_volume', 0)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </Card>
        {/if}
    </div>
{/if}
