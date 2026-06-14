<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasView from '$lib/components/PositionBiasView.svelte';
    import HeatmapView from '$lib/components/HeatmapView.svelte';
    import TargetView from '$lib/components/TargetView.svelte';
    import { fetchGammaHeatmap, fetchHeatmap, fetchLivePrice, fetchPositionBias, fetchStrategy } from '$lib/data.js';
    import { ASSET_PROFILES, DEFAULT_CONTRACT_KEY } from '$lib/config.js';
    import { LineChart, Grid3X3, Activity, Target } from 'lucide-svelte';

    let asset = $state('gc');
    let activeTab = $state('target');
    let payload = $state(null);
    let loading = $state(true);
    let refreshing = $state(false);
    let lastUpdate = $state('—');
    /** @type {Date | null} */
    let lastUpdateAt = $state(null);

    // Per-contract OI heatmap state.
    let heatmapContract = $state(DEFAULT_CONTRACT_KEY);
    /** @type {Record<string, any>} */
    let heatmapCache = $state({});
    let heatmapLoading = $state(false);

    // Per-contract Gamma heatmap — same shape as OI, separate cache + pill.
    let gammaContract = $state(DEFAULT_CONTRACT_KEY);
    /** @type {Record<string, any>} */
    let gammaCache = $state({});
    let gammaLoading = $state(false);

    // Daily strategy JSON — the Target tab's only data source (bias + regime +
    // expected move + gamma/confluence walls). The strategy *tab* was removed;
    // the fetch stays because TargetView synthesizes its read from this file.
    let strategy = $state(null);
    let strategyLoading = $state(false);

    // Live futures price (same-origin /api/price proxy) — ONE source of truth
    // shared by the Header and the Target card so they never disagree. Polled
    // every 20s; falls back to the scrape-time contract price if the proxy is down.
    let livePrice = $state(null);
    /** @type {Date | null} */
    let liveAt = $state(null);
    const isLive = $derived(Number.isFinite(livePrice) && livePrice > 0);
    $effect(() => {
        const sym = asset === 'nq' ? 'NQ=F' : 'GC=F';
        let stopped = false;
        async function tick() {
            const d = await fetchLivePrice(sym);
            if (stopped) return;
            if (d && Number.isFinite(d.price)) {
                livePrice = d.price;
                liveAt = d.time ? new Date(d.time * 1000) : new Date();
            }
        }
        livePrice = null;
        liveAt = null;
        tick();
        const id = setInterval(tick, 20000);
        return () => { stopped = true; clearInterval(id); };
    });

    const profile = $derived(ASSET_PROFILES[asset]);
    const availableContractKeys = $derived(
        (payload?.contracts || []).map((contract) => contract.contract_key)
    );

    const tabs = [
        { key: 'target',   label: 'เป้าวันนี้',     tone: 'warn',    icon: Target },
        { key: 'analysis', label: 'Position Bias', tone: 'primary', icon: LineChart },
        { key: 'heatmap',  label: 'OI Heatmap',    tone: 'mag',     icon: Grid3X3 },
        { key: 'gamma',    label: 'Gamma Heatmap', tone: 'mag',     icon: Activity }
    ];

    const singleContractKey = $derived(
        activeTab === 'heatmap' ? heatmapContract
            : activeTab === 'gamma' ? gammaContract
            : 'current'
    );

    const visibleContract = $derived(
        payload?.contracts?.find((c) => c.contract_key === singleContractKey)
        || payload?.contracts?.[0]
    );

    const currentHeatmap = $derived(heatmapCache[heatmapContract] ?? null);
    const currentGamma = $derived(gammaCache[gammaContract] ?? null);

    function resolveContractKey(contractKeys, preferredKey = heatmapContract) {
        if (!contractKeys.length) return null;
        if (contractKeys.includes(preferredKey)) return preferredKey;
        if (contractKeys.includes(DEFAULT_CONTRACT_KEY)) return DEFAULT_CONTRACT_KEY;
        return contractKeys[0];
    }

    async function load() {
        loading = true;
        try {
            const nextPayload = await fetchPositionBias(asset);
            const nextContractKeys = (nextPayload?.contracts || []).map((contract) => contract.contract_key);
            const nextKey = resolveContractKey(nextContractKeys);

            payload = nextPayload;
            if (nextKey && nextKey !== heatmapContract) heatmapContract = nextKey;
            if (nextKey && nextKey !== gammaContract) gammaContract = nextKey;
            const stamp = new Date();
            lastUpdate = stamp.toLocaleTimeString();
            lastUpdateAt = stamp;
            return nextKey;
        } finally {
            loading = false;
        }
    }

    async function ensureHeatmap(contractKey) {
        const cached = untrack(() => heatmapCache[contractKey]);
        if (cached) return;
        heatmapLoading = true;
        try {
            const data = await fetchHeatmap(asset, contractKey);
            heatmapCache = { ...untrack(() => heatmapCache), [contractKey]: data };
        } finally {
            heatmapLoading = false;
        }
    }

    async function ensureGamma(contractKey) {
        const cached = untrack(() => gammaCache[contractKey]);
        if (cached) return;
        gammaLoading = true;
        try {
            const data = await fetchGammaHeatmap(asset, contractKey);
            gammaCache = { ...untrack(() => gammaCache), [contractKey]: data };
        } finally {
            gammaLoading = false;
        }
    }

    async function ensureStrategy() {
        strategyLoading = true;
        try {
            strategy = await fetchStrategy(asset);
        } finally {
            strategyLoading = false;
        }
    }

    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        try {
            heatmapCache = {};
            gammaCache = {};
            const nextKey = await load();
            if (activeTab === 'heatmap' && nextKey) {
                await ensureHeatmap(nextKey);
            } else if (activeTab === 'gamma' && nextKey) {
                await ensureGamma(nextKey);
            } else if (activeTab === 'target') {
                await ensureStrategy();
            }
        } finally {
            refreshing = false;
        }
    }

    function onKeydown(event) {
        // Ignore when user is typing in a form field
        const t = event.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
            return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'r') {
            event.preventDefault();
            void refresh();
            return;
        }
        // Number keys switch tabs
        const idx = Number(event.key);
        if (Number.isInteger(idx) && idx >= 1 && idx <= tabs.length) {
            event.preventDefault();
            const t = tabs[idx - 1];
            if (t && t.key !== activeTab) {
                activeTab = t.key;
                onTabChange(t.key);
            }
        }
    }

    function onTabChange(key) {
        if (key === 'heatmap') {
            const nextKey = resolveContractKey(availableContractKeys);
            if (!nextKey) return;
            if (nextKey !== heatmapContract) heatmapContract = nextKey;
            void ensureHeatmap(nextKey);
        } else if (key === 'gamma') {
            const nextKey = resolveContractKey(availableContractKeys, gammaContract);
            if (!nextKey) return;
            if (nextKey !== gammaContract) gammaContract = nextKey;
            void ensureGamma(nextKey);
        } else if (key === 'target') {
            void ensureStrategy();
        }
    }

    function onHeatmapContract(key) {
        heatmapContract = key;
        void ensureHeatmap(key);
    }

    function onGammaContract(key) {
        gammaContract = key;
        void ensureGamma(key);
    }

    $effect(() => {
        asset; // dep
        untrack(() => {
            heatmapCache = {};
            gammaCache = {};
            void load().then((nextKey) => {
                if (activeTab === 'heatmap' && nextKey) {
                    void ensureHeatmap(nextKey);
                } else if (activeTab === 'gamma' && nextKey) {
                    void ensureGamma(nextKey);
                } else if (activeTab === 'target') {
                    void ensureStrategy();
                }
            });
        });
    });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-screen flex-col overflow-hidden">
    <Header
        bind:asset
        contract={profile.label}
        contractCode={activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || ''
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || ''
            : activeTab === 'target'
                ? 'เป้าวันนี้'
                : visibleContract?.contract || ''}
        price={isLive ? livePrice : visibleContract?.future_price}
        live={isLive}
        dte={visibleContract?.dte}
        {lastUpdate}
        {lastUpdateAt}
        refreshing={refreshing || loading}
        onRefresh={refresh}
    />

    <TabNav {tabs} bind:active={activeTab} onChange={onTabChange} />

    <main class="flex flex-1 min-h-0 flex-col overflow-hidden px-6 py-5">
        {#key activeTab}
            <div class="flex flex-1 min-h-0 flex-col overflow-hidden animate-fade-in">
                {#if activeTab === 'target'}
                    <div class="flex flex-col gap-4 overflow-y-auto">
                        <TargetView {strategy} assetId={asset} loading={strategyLoading} {livePrice} {liveAt} />
                    </div>
                {:else if activeTab === 'analysis'}
                    <div class="flex flex-col gap-4 overflow-y-auto">
                        <PositionBiasView {payload} {loading} />
                    </div>
                {:else if activeTab === 'heatmap'}
                    <HeatmapView
                        assetId={asset}
                        bind:contractKey={heatmapContract}
                        availableContracts={availableContractKeys}
                        data={currentHeatmap}
                        loading={heatmapLoading}
                        onChangeContract={onHeatmapContract}
                    />
                {:else if activeTab === 'gamma'}
                    <HeatmapView
                        assetId={asset}
                        bind:contractKey={gammaContract}
                        availableContracts={availableContractKeys}
                        data={currentGamma}
                        loading={gammaLoading}
                        onChangeContract={onGammaContract}
                        title="Gamma Heatmap (1 Pct, Call+Put)"
                        valueDecimals={0}
                        heatScale="log"
                        emptyFile="_GammaHeatmap.json"
                    />
                {/if}
            </div>
        {/key}
    </main>

    <AppFooter
        contract={activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || '—'
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || '—'
                : visibleContract?.contract || '—'}
        dataType={activeTab === 'target' ? 'เป้าวันนี้'
            : activeTab === 'analysis' ? 'Position Bias'
            : activeTab === 'heatmap' ? 'OI Heatmap'
            : activeTab === 'gamma' ? 'Gamma Heatmap'
            : 'Position Bias'}
    />
</div>
