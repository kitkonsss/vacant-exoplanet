<script>
    import Card from './ui/Card.svelte';
    import { cn, fmtNumber, fmtStrike } from '$lib/utils.js';

    // `data`   = parsed OIData ({ strikes:[{strike,call,put,volSettle}], futPrc, ... })
    // `heatmap`= {contract}_OIHeatmap.json ({ dates:[], strikes:[{strike, values:[]}] })
    //            → ΔOI vs previous day = values[0] − values[1].
    let { data = null, heatmap = null, loading = false } = $props();

    let mode = $state('total'); // 'total' | 'callput'
    let sortKey = $state('total'); // strike | call | put | total | volSettle | delta
    let sortDir = $state('desc'); // 'asc' | 'desc'

    const prevDate = $derived(heatmap?.dates?.[1] ?? null);

    // strike → ΔOI (today − previous day) from the OI heatmap.
    const deltaByStrike = $derived.by(() => {
        const map = new Map();
        for (const s of heatmap?.strikes || []) {
            const cur = s.values?.[0];
            const prev = s.values?.[1];
            if (Number.isFinite(cur) && Number.isFinite(prev)) {
                map.set(s.strike, cur - prev);
            }
        }
        return map;
    });

    const rows = $derived(
        (data?.strikes || []).map((s) => {
            const total = (s.call || 0) + (s.put || 0);
            const delta = deltaByStrike.get(s.strike);
            return {
                strike: s.strike,
                call: s.call || 0,
                put: s.put || 0,
                total,
                volSettle: s.volSettle || 0,
                delta: Number.isFinite(delta) ? delta : null
            };
        })
    );

    const totals = $derived.by(() => {
        let call = 0, put = 0;
        for (const r of rows) { call += r.call; put += r.put; }
        return { call, put, total: call + put, pcr: call ? put / call : null };
    });

    // Visible/sortable columns depend on the toggle.
    const visibleKeys = $derived(
        mode === 'callput'
            ? new Set(['strike', 'call', 'put', 'volSettle', 'delta'])
            : new Set(['strike', 'total', 'volSettle', 'delta'])
    );

    const effectiveSortKey = $derived(visibleKeys.has(sortKey) ? sortKey : 'total');

    const sortedRows = $derived.by(() => {
        const k = effectiveSortKey;
        const dir = sortDir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => {
            const av = a[k] ?? -Infinity;
            const bv = b[k] ?? -Infinity;
            if (av === bv) return a.strike - b.strike;
            return (av - bv) * dir;
        });
    });

    // Top-N by total OI (always), with the call/put breakdown — like vol2vol's "Top OI".
    const topRows = $derived([...rows].sort((a, b) => b.total - a.total).slice(0, 5));

    function setSort(key) {
        if (sortKey === key) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            sortKey = key;
            sortDir = key === 'strike' ? 'asc' : 'desc';
        }
    }
    function arrow(key) {
        if (effectiveSortKey !== key) return '⇅';
        return sortDir === 'asc' ? '▲' : '▼';
    }

    function isATM(strike) {
        const p = data?.futPrc;
        if (p == null) return false;
        return Math.abs(strike - p) <= 2.5;
    }
</script>

<Card class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <!-- Top bar: title + Call/Put|Total toggle -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div class="flex items-center gap-3 min-w-0">
            <span class="h-3 w-1 rounded-sm bg-mag"></span>
            <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
                Strike OI {#if data?.contract}<span class="ml-1 font-mono text-muted-foreground">· {data.contract}</span>{/if}
            </span>
            <span class="text-[10px] text-muted-foreground">{rows.length} strikes</span>
        </div>
        <div class="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
            {#each [['callput', 'Call / Put'], ['total', 'Total']] as [key, label]}
                <button
                    type="button"
                    onclick={() => (mode = key)}
                    class={cn(
                        'rounded px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        mode === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                    )}
                >
                    {label}
                </button>
            {/each}
        </div>
    </div>

    <!-- Summary strip -->
    {#if data}
        <div class="flex items-center gap-5 border-b border-border bg-surface px-4 py-2 font-mono text-[11px] tabular-nums">
            <span class="text-muted-foreground">Total OI <span class="font-semibold text-foreground">{fmtNumber(totals.total)}</span></span>
            <span class="text-muted-foreground">Call <span class="font-semibold text-call">{fmtNumber(totals.call)}</span></span>
            <span class="text-muted-foreground">Put <span class="font-semibold text-put">{fmtNumber(totals.put)}</span></span>
            <span class="text-muted-foreground">P/C <span class="font-semibold text-foreground">{fmtNumber(totals.pcr, 2)}</span></span>
            {#if prevDate}<span class="ml-auto text-[10px] text-muted-foreground">Δ vs {prevDate}</span>{/if}
        </div>
    {/if}

    {#if loading}
        <div class="flex h-48 items-center justify-center text-muted-foreground">
            <div class="flex items-center gap-3">
                <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                <span class="text-sm">Loading strike OI…</span>
            </div>
        </div>
    {:else if !rows.length}
        <div class="flex h-48 items-center justify-center text-center">
            <div>
                <div class="text-sm font-semibold text-foreground">No strike OI data</div>
                <p class="mt-1 max-w-md text-xs text-muted-foreground">
                    Run the scraper to publish <span class="font-mono text-foreground">{`{contract}_OIData.txt`}</span>.
                </p>
            </div>
        </div>
    {:else}
        <div class="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1fr_300px]">
            <!-- Sortable strike table -->
            <div class="min-h-0 overflow-auto">
                <table class="w-full border-collapse font-mono text-xs tabular-nums">
                    <thead class="sticky top-0 z-10">
                        <tr class="bg-surface text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                            <th class="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground" onclick={() => setSort('strike')}>Strike <span class="text-[8px]">{arrow('strike')}</span></th>
                            {#if mode === 'callput'}
                                <th class="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground" onclick={() => setSort('call')}>Call <span class="text-[8px]">{arrow('call')}</span></th>
                                <th class="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground" onclick={() => setSort('put')}>Put <span class="text-[8px]">{arrow('put')}</span></th>
                            {:else}
                                <th class="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground" onclick={() => setSort('total')}>Total <span class="text-[8px]">{arrow('total')}</span></th>
                            {/if}
                            <th class="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground" onclick={() => setSort('volSettle')}>Vol Settle <span class="text-[8px]">{arrow('volSettle')}</span></th>
                            <th class="cursor-pointer select-none px-3 py-2 text-right hover:text-foreground" onclick={() => setSort('delta')}>Δ OI <span class="text-[8px]">{arrow('delta')}</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each sortedRows as r (r.strike)}
                            {@const atm = isATM(r.strike)}
                            <tr class={cn('border-t border-border/60 hover:bg-surface-elevated/50', atm && 'bg-primary/10')}>
                                <td class={cn('px-3 py-1.5 text-right font-semibold', atm ? 'text-primary' : 'text-foreground')}>{fmtStrike(r.strike)}</td>
                                {#if mode === 'callput'}
                                    <td class="px-3 py-1.5 text-right text-call">{r.call ? fmtNumber(r.call) : '·'}</td>
                                    <td class="px-3 py-1.5 text-right text-put">{r.put ? fmtNumber(r.put) : '·'}</td>
                                {:else}
                                    <td class="px-3 py-1.5 text-right font-semibold text-foreground">{r.total ? fmtNumber(r.total) : '·'}</td>
                                {/if}
                                <td class="px-3 py-1.5 text-right text-muted-foreground">{r.volSettle ? fmtNumber(r.volSettle * 100, 2) : '·'}</td>
                                <td class={cn('px-3 py-1.5 text-right', r.delta == null ? 'text-muted-foreground' : r.delta > 0 ? 'text-up' : r.delta < 0 ? 'text-down' : 'text-muted-foreground')}>
                                    {#if r.delta == null}·
                                    {:else if r.delta === 0}0
                                    {:else}{r.delta > 0 ? '▲' : '▼'} {fmtNumber(Math.abs(r.delta))}{/if}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>

            <!-- Top-N ranking -->
            <div class="min-h-0 overflow-auto border-t border-border lg:border-l lg:border-t-0">
                <div class="border-b border-border bg-surface px-3 py-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                    🏆 Top OI · จัดอันดับ
                </div>
                <div class="flex flex-col gap-1.5 p-2.5">
                    {#each topRows as r, i (r.strike)}
                        <div class="flex items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-1.5">
                            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-warn/15 font-mono text-[10px] font-bold text-warn">{i + 1}</span>
                            <div class="min-w-0 flex-1">
                                <div class="font-mono text-sm font-bold tabular-nums text-foreground">{fmtStrike(r.strike)}</div>
                                <div class="font-mono text-[9px] tabular-nums">
                                    <span class="text-call">C {fmtNumber(r.call)}</span>
                                    <span class="text-muted-foreground"> / </span>
                                    <span class="text-put">P {fmtNumber(r.put)}</span>
                                </div>
                            </div>
                            <span class="shrink-0 font-mono text-sm font-bold tabular-nums text-foreground">{fmtNumber(r.total)}</span>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    {/if}
</Card>
