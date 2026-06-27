<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasDashboard from '$lib/components/PositionBiasDashboard.svelte';
    import PositionBiasView from '$lib/components/PositionBiasView.svelte';
    import HeatmapView from '$lib/components/HeatmapView.svelte';
    import { fetchGammaHeatmap, fetchHeatmap, fetchLivePrice, fetchPositionBias, fetchPositionBiasDashboard } from '$lib/data.js';
    import { ASSET_PROFILES, CONTRACT_OPTIONS, DEFAULT_CONTRACT_KEY } from '$lib/config.js';
    import { LineChart, Grid3X3, Activity, LayoutDashboard } from 'lucide-svelte';

    let asset = $state('gc');
    let activeTab = $state('dashboard');
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

    // Cross-asset dashboard: one selected contract slot shown across all assets.
    let dashboardContract = $state(DEFAULT_CONTRACT_KEY);
    /** @type {Record<string, any>} */
    let dashboardPayloads = $state({});
    /** @type {Record<string, any>} */
    let dashboardLivePrices = $state({});
    let dashboardLoading = $state(false);
    const dashboardAssetIds = Object.keys(ASSET_PROFILES);

    // Live futures price (same-origin /api/price proxy) — ONE source of truth
    // shared by the Header and position-bias cards so they never disagree. Polled
    // every 20s; falls back to the scrape-time contract price if the proxy is down.
    let livePrice = $state(null);
    /** @type {Date | null} */
    let liveAt = $state(null);
    const isLive = $derived(Number.isFinite(livePrice) && livePrice > 0);
    $effect(() => {
        const activeAsset = asset;
        const activeProfile = ASSET_PROFILES[activeAsset];
        const sym = activeProfile?.liveSymbol || (activeAsset === 'nq' ? 'NQ=F' : 'GC=F');
        const pollMs = activeProfile?.source === 'crypto' ? 5000 : 20000;
        let stopped = false;
        async function tick() {
            const d = await fetchLivePrice(sym, activeAsset);
            if (stopped) return;
            if (d && Number.isFinite(d.price)) {
                livePrice = d.price;
                liveAt = d.time ? new Date(d.time * 1000) : new Date();
            }
        }
        livePrice = null;
        liveAt = null;
        tick();
        const id = setInterval(tick, pollMs);
        return () => { stopped = true; clearInterval(id); };
    });

    const profile = $derived(ASSET_PROFILES[asset]);
    const dashboardContractLabel = $derived(
        CONTRACT_OPTIONS.find((option) => option.key === dashboardContract)?.label || 'Current'
    );
    const availableContractKeys = $derived(
        (payload?.contracts || []).map((contract) => contract.contract_key)
    );

    const tabs = [
        { key: 'dashboard', label: 'Bias Dashboard', tone: 'warn',    icon: LayoutDashboard },
        { key: 'analysis',  label: 'Position Bias',  tone: 'primary', icon: LineChart },
        { key: 'heatmap',   label: 'OI Heatmap',     tone: 'mag',     icon: Grid3X3 },
        { key: 'gamma',     label: 'Gamma Heatmap',  tone: 'mag',     icon: Activity }
    ];

    const singleContractKey = $derived(
        activeTab === 'heatmap' ? heatmapContract
            : activeTab === 'gamma' ? gammaContract
            : activeTab === 'dashboard' ? dashboardContract
            : 'current'
    );

    const visibleContract = $derived(
        payload?.contracts?.find((c) => c.contract_key === singleContractKey)
        || payload?.contracts?.[0]
    );

    const currentHeatmap = $derived(heatmapCache[heatmapContract] ?? null);
    const currentGamma = $derived(gammaCache[gammaContract] ?? null);
    const sourceLabel = $derived(
        ASSET_PROFILES[asset]?.source === 'crypto'
            ? payload?.provider_label || payload?.provider || 'Crypto aggregate'
            : 'pageth/Vol2VolData'
    );

    function resolveContractKey(contractKeys, preferredKey = heatmapContract) {
        if (!contractKeys.length) return null;
        if (contractKeys.includes(preferredKey)) return preferredKey;
        if (contractKeys.includes(DEFAULT_CONTRACT_KEY)) return DEFAULT_CONTRACT_KEY;
        return contractKeys[0];
    }

    async function load({ silent = false } = {}) {
        if (!silent) loading = true;
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
            if (!silent) loading = false;
        }
    }

    async function refreshDashboardLivePrices() {
        const entries = await Promise.all(
            dashboardAssetIds.map(async (assetId) => {
                const assetProfile = ASSET_PROFILES[assetId];
                const data = await fetchLivePrice(assetProfile.liveSymbol, assetId);
                return [assetId, data && Number.isFinite(data.price) ? data : null];
            })
        );
        dashboardLivePrices = Object.fromEntries(entries);
    }

    async function loadDashboard({ silent = false } = {}) {
        if (!silent) dashboardLoading = true;
        try {
            dashboardPayloads = await fetchPositionBiasDashboard(dashboardAssetIds);
            await refreshDashboardLivePrices();
            const stamp = new Date();
            lastUpdate = stamp.toLocaleTimeString();
            lastUpdateAt = stamp;
        } finally {
            if (!silent) dashboardLoading = false;
        }
    }

    async function ensureHeatmap(contractKey, { force = false, silent = false } = {}) {
        const cached = untrack(() => heatmapCache[contractKey]);
        if (cached && !force) return;
        if (!silent) heatmapLoading = true;
        try {
            const data = await fetchHeatmap(asset, contractKey);
            heatmapCache = { ...untrack(() => heatmapCache), [contractKey]: data };
        } finally {
            if (!silent) heatmapLoading = false;
        }
    }

    async function ensureGamma(contractKey, { force = false, silent = false } = {}) {
        const cached = untrack(() => gammaCache[contractKey]);
        if (cached && !force) return;
        if (!silent) gammaLoading = true;
        try {
            const data = await fetchGammaHeatmap(asset, contractKey);
            gammaCache = { ...untrack(() => gammaCache), [contractKey]: data };
        } finally {
            if (!silent) gammaLoading = false;
        }
    }

    async function refresh({ silent = false } = {}) {
        if (refreshing && !silent) return;
        if (!silent) refreshing = true;
        try {
            if (!silent) {
                heatmapCache = {};
                gammaCache = {};
            }
            const nextKey = await load({ silent });
            const forceLive = silent && ASSET_PROFILES[asset]?.source === 'crypto';
            if (activeTab === 'dashboard') {
                await loadDashboard({ silent });
            } else if (activeTab === 'heatmap' && nextKey) {
                await ensureHeatmap(nextKey, { force: forceLive, silent });
            } else if (activeTab === 'gamma' && nextKey) {
                await ensureGamma(nextKey, { force: forceLive, silent });
            }
        } finally {
            if (!silent) refreshing = false;
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
        if (key === 'dashboard') {
            void loadDashboard();
        } else if (key === 'heatmap') {
            const nextKey = resolveContractKey(availableContractKeys);
            if (!nextKey) return;
            if (nextKey !== heatmapContract) heatmapContract = nextKey;
            void ensureHeatmap(nextKey);
        } else if (key === 'gamma') {
            const nextKey = resolveContractKey(availableContractKeys, gammaContract);
            if (!nextKey) return;
            if (nextKey !== gammaContract) gammaContract = nextKey;
            void ensureGamma(nextKey);
        }
    }

    function onDashboardContract(key) {
        dashboardContract = key;
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
                if (activeTab === 'dashboard') {
                    void loadDashboard();
                } else if (activeTab === 'heatmap' && nextKey) {
                    void ensureHeatmap(nextKey);
                } else if (activeTab === 'gamma' && nextKey) {
                    void ensureGamma(nextKey);
                }
            });
        });
    });

    $effect(() => {
        if (activeTab !== 'dashboard') return;
        let stopped = false;
        async function tick() {
            if (stopped) return;
            await refreshDashboardLivePrices();
        }
        tick();
        const id = setInterval(tick, 5000);
        return () => { stopped = true; clearInterval(id); };
    });

    $effect(() => {
        const activeAsset = asset;
        if (ASSET_PROFILES[activeAsset]?.source !== 'crypto') return;
        let stopped = false;
        async function tick() {
            if (stopped || loading || refreshing) return;
            await refresh({ silent: true });
        }
        const id = setInterval(tick, 5000);
        return () => { stopped = true; clearInterval(id); };
    });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-screen flex-col overflow-hidden">
    <Header
        bind:asset
        contract={activeTab === 'dashboard' ? 'Position Bias Dashboard' : profile.label}
        contractCode={activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || ''
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || ''
            : activeTab === 'dashboard'
                ? `${dashboardContractLabel} - ${dashboardAssetIds.length} assets`
                : visibleContract?.contract || ''}
        price={activeTab === 'dashboard' ? null : (isLive ? livePrice : visibleContract?.future_price)}
        live={activeTab === 'dashboard' ? false : isLive}
        dte={activeTab === 'dashboard' ? null : visibleContract?.dte}
        {lastUpdate}
        {lastUpdateAt}
        refreshing={refreshing || loading || dashboardLoading}
        onRefresh={refresh}
    />

    <TabNav {tabs} bind:active={activeTab} onChange={onTabChange} />

    <main class="flex flex-1 min-h-0 flex-col overflow-hidden px-6 py-5">
        {#key activeTab}
            <div class="flex flex-1 min-h-0 flex-col overflow-hidden animate-fade-in">
                {#if activeTab === 'dashboard'}
                    <div class="flex flex-col gap-4 overflow-y-auto">
                        <PositionBiasDashboard
                            payloads={dashboardPayloads}
                            loading={dashboardLoading}
                            bind:contractKey={dashboardContract}
                            onChangeContract={onDashboardContract}
                            livePrices={dashboardLivePrices}
                        />
                    </div>
                {:else if activeTab === 'analysis'}
                    <div class="flex flex-col gap-4 overflow-y-auto">
                        <PositionBiasView {payload} {loading} {livePrice} assetId={asset} />
                    </div>
                {:else if activeTab === 'heatmap'}
                    <HeatmapView
                        assetId={asset}
                        bind:contractKey={heatmapContract}
                        availableContracts={availableContractKeys}
                        data={currentHeatmap}
                        loading={heatmapLoading}
                        onChangeContract={onHeatmapContract}
                        showChangeToggle={true}
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
        source={activeTab === 'dashboard' ? 'Cross-asset position bias' : sourceLabel}
        contract={activeTab === 'dashboard'
            ? `${dashboardContractLabel} - ${dashboardAssetIds.length} assets`
            : activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || '—'
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || '—'
                : visibleContract?.contract || '—'}
        dataType={activeTab === 'dashboard' ? 'Position Bias Dashboard'
            : activeTab === 'analysis' ? 'Position Bias'
            : activeTab === 'heatmap' ? 'OI Heatmap'
            : activeTab === 'gamma' ? 'Gamma Heatmap'
            : 'Position Bias'}
    />
</div>
