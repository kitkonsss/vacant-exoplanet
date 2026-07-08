<script>
    import Card from './ui/Card.svelte';
    import ContractCard from './ContractCard.svelte';
    import { ASSET_PROFILES, CONTRACT_OPTIONS } from '$lib/config.js';
    import { fetchOIData } from '$lib/data.js';
    import { cn } from '$lib/utils.js';

    let {
        payloads = {},
        loading = false,
        contractKey = $bindable('current'),
        onChangeContract = () => {},
        livePrices = {}
    } = $props();

    let mode = $state('total');
    let showIv = $state(true);
    let showDaySd = $state(true);
    let showExpSd = $state(true);
    let ivMaps = $state({});

    const assetIds = Object.keys(ASSET_PROFILES);
    const selectedContract = $derived(
        CONTRACT_OPTIONS.find((option) => option.key === contractKey) || CONTRACT_OPTIONS[0]
    );

    const rows = $derived(
        assetIds.map((assetId) => {
            const profile = ASSET_PROFILES[assetId];
            const contracts = payloads?.[assetId]?.contracts || [];
            const contract = contracts.find((item) => item.contract_key === contractKey) || null;
            return { assetId, profile, contract };
        })
    );

    const loadedCount = $derived(rows.filter((row) => row.contract).length);
    const biasMix = $derived.by(() => {
        const mix = { bullish: 0, neutral: 0, bearish: 0 };
        for (const row of rows) {
            const label = String(row.contract?.position_bias?.label || '').toLowerCase();
            const score = Number(row.contract?.position_bias?.score);
            if (label.includes('bull') || score > 5) mix.bullish += 1;
            else if (label.includes('bear') || score < -5) mix.bearish += 1;
            else if (row.contract) mix.neutral += 1;
        }
        return mix;
    });

    function pickContract(key) {
        if (contractKey === key) return;
        contractKey = key;
        onChangeContract(key);
    }

    $effect(() => {
        const key = contractKey;
        const activeRows = rows.filter((row) => row.contract);
        let stopped = false;
        (async () => {
            const entries = await Promise.all(
                activeRows.map(async (row) => {
                    const oi = await fetchOIData(row.assetId, key);
                    if (!oi?.strikes) return [row.assetId, ivMaps[row.assetId] || null];
                    const map = {};
                    for (const strike of oi.strikes) {
                        if (Number.isFinite(strike.strike) && strike.volSettle > 0) {
                            map[strike.strike] = strike.volSettle * 100;
                        }
                    }
                    return [row.assetId, Object.keys(map).length ? map : null];
                })
            );
            if (!stopped) ivMaps = { ...ivMaps, ...Object.fromEntries(entries) };
        })();
        return () => { stopped = true; };
    });

    function tenorFor(assetId, contract) {
        const tenors = payloads?.[assetId]?.expectedRange?.tenors || [];
        return tenors.find((tenor) => tenor.contract_key === contract?.contract_key)
            || tenors.find((tenor) => tenor.symbol === contract?.contract)
            || null;
    }

    function pushBands(out, bands, group, color, labelPrefix) {
        if (!bands) return;
        for (const k of [1, 2, 3]) {
            for (const side of ['minus', 'plus']) {
                const level = Number(bands[`${side}${k}`]);
                if (Number.isFinite(level)) {
                    out.push({
                        k,
                        side,
                        group,
                        color,
                        level,
                        label: `${side === 'plus' ? '+' : '-'}${k}${labelPrefix}`
                    });
                }
            }
        }
    }

    function dayBandsFor(tenor) {
        const f = Number(tenor?.future_price);
        const iv = Number(tenor?.atm_iv);
        const dte = Number(tenor?.dte);
        if (!Number.isFinite(f) || !Number.isFinite(iv) || !Number.isFinite(dte) || dte <= 0) return null;

        const horizonDays = Math.min(1, dte);
        const move = f * iv * Math.sqrt(horizonDays / 365);
        const bands = {};
        for (const k of [1, 2, 3]) {
            bands[`plus${k}`] = f + k * move;
            bands[`minus${k}`] = f - k * move;
        }
        return bands;
    }

    function sdBandsFor(assetId, contract) {
        const tenor = tenorFor(assetId, contract);
        const out = [];
        if (showDaySd) pushBands(out, dayBandsFor(tenor), 'day', '#38bdf8', 'D');
        if (showExpSd) pushBands(out, tenor?.bands_to_expiry, 'expiry', '#f59e0b', 'E');
        return out;
    }
</script>

{#if loading && loadedCount === 0}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">Loading position bias...</span>
        </div>
    </div>
{:else}
    <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex min-w-0 flex-wrap items-center gap-2.5">
                <span class="h-3 w-1 rounded-sm bg-warn"></span>
                <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Position Bias Dashboard</span>
                <span class="font-mono text-[10px] text-muted-foreground">{selectedContract.label} - {loadedCount}/{assetIds.length} assets</span>
                <span class="hidden h-3 w-px bg-border sm:inline-block"></span>
                <span class="text-[10px] font-semibold uppercase tracking-wider text-up">Bullish {biasMix.bullish}</span>
                <span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Neutral {biasMix.neutral}</span>
                <span class="text-[10px] font-semibold uppercase tracking-wider text-down">Bearish {biasMix.bearish}</span>
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onclick={() => (showIv = !showIv)}
                    title="Overlay IV smile on every asset wall chart"
                    class={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        showIv ? 'border-[#c084fc] text-[#c084fc]' : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                >
                    <span class="inline-block h-[2px] w-3 rounded-sm bg-[#c084fc]"></span> IV smile
                </button>
                <button
                    type="button"
                    onclick={() => (showDaySd = !showDaySd)}
                    title="Overlay 1-day standard-deviation bands for each asset"
                    class={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        showDaySd ? 'border-[#38bdf8] text-[#38bdf8]' : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                >
                    <span class="inline-block h-3 w-[2px] rounded-sm bg-[#38bdf8]"></span> 1D SD
                </button>
                <button
                    type="button"
                    onclick={() => (showExpSd = !showExpSd)}
                    title="Overlay to-expiry standard-deviation bands for each asset"
                    class={cn(
                        'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                        showExpSd ? 'border-[#f59e0b] text-[#f59e0b]' : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                >
                    <span class="inline-block h-3 w-[2px] rounded-sm bg-[#f59e0b]"></span> Exp SD
                </button>

                <div class="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
                    {#each CONTRACT_OPTIONS as option}
                        <button
                            type="button"
                            onclick={() => pickContract(option.key)}
                            class={cn(
                                'rounded px-3 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors',
                                contractKey === option.key ? 'bg-warn text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {option.label}
                        </button>
                    {/each}
                </div>

                <div class="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
                    {#each [['split', 'Call / Put'], ['total', 'Total']] as [key, label]}
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
        </div>

        <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {#each rows as row (row.assetId)}
                {#if row.contract}
                    <ContractCard
                        contract={row.contract}
                        compact={true}
                        assetLabel={row.profile.shortLabel}
                        {mode}
                        livePrice={livePrices?.[row.assetId]?.price ?? null}
                        ivByStrike={ivMaps[row.assetId] || null}
                        {showIv}
                        sdBands={sdBandsFor(row.assetId, row.contract)}
                    />
                {:else}
                    <Card class="flex min-h-[320px] flex-col justify-between p-5">
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{row.profile.shortLabel}</div>
                                <div class="mt-1 truncate text-lg font-semibold text-foreground">{row.profile.label}</div>
                            </div>
                            <span class="rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {selectedContract.label}
                            </span>
                        </div>
                        <div class="rounded-md border border-border bg-background px-4 py-8 text-center text-sm text-muted-foreground">
                            No position-bias data
                        </div>
                    </Card>
                {/if}
            {/each}
        </div>
    </div>
{/if}
