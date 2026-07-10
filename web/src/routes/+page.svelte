<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasDashboard from '$lib/components/PositionBiasDashboard.svelte';
    import { fetchGammaHeatmap, fetchHeatmap, fetchLivePrice, fetchPositionBias } from '$lib/data.js';
    import { ASSET_PROFILES, CONTRACT_OPTIONS, DEFAULT_CONTRACT_KEY } from '$lib/config.js';
    import { LineChart, Grid3X3, Activity, LayoutDashboard, History } from 'lucide-svelte';

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
    let dashboardLiveLoading = $state(false);
    /** @type {Date | null} */
    let dashboardLiveLoadedAt = $state(null);
    const dashboardAssetIds = Object.keys(ASSET_PROFILES);

    let historyPayload = $state(null);
    let historyLoading = $state(false);
    let historyContract = $state(DEFAULT_CONTRACT_KEY);
    /** @type {Record<string, any>} */
    let historyCache = $state({});
    /** @type {Record<string, any>} */
    let historyLastGood = $state({});
    let historyRequestKey = '';
    let payloadRequestId = 0;
    let dashboardRequestId = 0;

    /** @type {Record<string, any>} */
    let lazyComponents = $state({});
    /** @type {Record<string, boolean>} */
    let lazyLoading = $state({});
    /** @type {Record<string, boolean>} */
    let lazyErrors = $state({});
    const lazyPromises = new Map();
    const lazyTabsLoading = $derived(Object.values(lazyLoading).some(Boolean));
    const lazyTabLoaders = {
        history: () => import('$lib/components/BiasHistoryView.svelte'),
        analysis: () => import('$lib/components/PositionBiasView.svelte'),
        heatmap: () => import('$lib/components/HeatmapView.svelte')
    };

    // Live futures price (same-origin /api/price proxy) — ONE source of truth
    // shared by the Header and position-bias cards so they never disagree. Polled
    // every 20s; falls back to the scrape-time contract price if the proxy is down.
    let livePrice = $state(null);
    /** @type {Date | null} */
    let liveAt = $state(null);
    const isLive = $derived(Number.isFinite(livePrice) && livePrice > 0);
    $effect(() => {
        const activeAsset = asset;
        const tab = activeTab;
        if (tab === 'dashboard') return;
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
        { key: 'history',   label: 'History',        tone: 'primary', icon: History },
        { key: 'analysis',  label: 'Position Bias',  tone: 'primary', icon: LineChart },
        { key: 'heatmap',   label: 'OI Heatmap',     tone: 'mag',     icon: Grid3X3 },
        { key: 'gamma',     label: 'Gamma Heatmap',  tone: 'mag',     icon: Activity }
    ];

    const singleContractKey = $derived(
        activeTab === 'heatmap' ? heatmapContract
            : activeTab === 'gamma' ? gammaContract
            : activeTab === 'dashboard' ? dashboardContract
            : activeTab === 'history' ? historyContract
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
    const HistoryComponent = $derived(lazyComponent('history'));
    const AnalysisComponent = $derived(lazyComponent('analysis'));
    const HeatmapComponent = $derived(lazyComponent('heatmap'));
    const GammaHeatmapComponent = $derived(lazyComponent('gamma'));

    function resolveContractKey(contractKeys, preferredKey = heatmapContract) {
        if (!contractKeys.length) return null;
        if (contractKeys.includes(preferredKey)) return preferredKey;
        if (contractKeys.includes(DEFAULT_CONTRACT_KEY)) return DEFAULT_CONTRACT_KEY;
        return contractKeys[0];
    }

    function lazyKeyForTab(key) {
        return key === 'gamma' ? 'heatmap' : key;
    }

    function lazyComponent(key) {
        return lazyComponents[lazyKeyForTab(key)] ?? null;
    }

    async function ensureTabComponent(key) {
        const lazyKey = lazyKeyForTab(key);
        const existing = untrack(() => lazyComponents[lazyKey]);
        if (existing || !lazyTabLoaders[lazyKey]) return existing ?? null;
        const pending = lazyPromises.get(lazyKey);
        if (pending) return pending;

        lazyLoading = { ...untrack(() => lazyLoading), [lazyKey]: true };
        lazyErrors = { ...untrack(() => lazyErrors), [lazyKey]: false };
        const promise = (async () => {
            const module = await lazyTabLoaders[lazyKey]();
            const component = module?.default ?? null;
            if (component) {
                lazyComponents = { ...untrack(() => lazyComponents), [lazyKey]: component };
            }
            return component;
        })().catch((error) => {
            console.warn(`tab component failed to load: ${lazyKey}`, error);
            lazyErrors = { ...untrack(() => lazyErrors), [lazyKey]: true };
            return null;
        }).finally(() => {
            if (lazyPromises.get(lazyKey) === promise) lazyPromises.delete(lazyKey);
            lazyLoading = { ...untrack(() => lazyLoading), [lazyKey]: false };
        });
        lazyPromises.set(lazyKey, promise);
        return promise;
    }

    function historyKey(assetId = asset, contractKey = historyContract) {
        return `${assetId}:${contractKey}`;
    }

    async function load({ silent = false, force = false, assetId: targetAsset = asset } = {}) {
        const requestId = ++payloadRequestId;
        if (!silent) loading = true;
        try {
            const nextPayload = await fetchPositionBias(targetAsset, { force });
            if (requestId !== payloadRequestId || targetAsset !== asset) return null;
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
            if (!silent && requestId === payloadRequestId) loading = false;
        }
    }

    async function refreshDashboardLivePrices() {
        if (dashboardLiveLoading) return;
        dashboardLiveLoading = true;
        try {
            const entries = await Promise.all(
                dashboardAssetIds.map(async (assetId) => {
                    const assetProfile = ASSET_PROFILES[assetId];
                    const data = await fetchLivePrice(assetProfile.liveSymbol, assetId);
                    return [assetId, data && Number.isFinite(data.price) ? data : null];
                })
            );
            dashboardLivePrices = Object.fromEntries(entries);
            const cryptoEntries = await Promise.all(
                dashboardAssetIds
                    .filter((assetId) => ASSET_PROFILES[assetId]?.source === 'crypto')
                    .map(async (assetId) => [assetId, await fetchPositionBias(assetId)])
            );
            dashboardPayloads = { ...dashboardPayloads, ...Object.fromEntries(cryptoEntries) };
            dashboardLiveLoadedAt = new Date();
        } finally {
            dashboardLiveLoading = false;
        }
    }

    async function loadDashboard({ silent = false, force = false } = {}) {
        const requestId = ++dashboardRequestId;
        if (!silent) dashboardLoading = true;
        try {
            const previous = untrack(() => dashboardPayloads);
            const entries = await Promise.all(
                dashboardAssetIds.map(async (assetId) => {
                    try {
                        return [assetId, await fetchPositionBias(assetId, { force })];
                    } catch (error) {
                        console.warn(`dashboard load failed: ${assetId}`, error);
                        return [assetId, previous[assetId] || null];
                    }
                })
            );
            if (requestId !== dashboardRequestId) return;
            dashboardPayloads = Object.fromEntries(entries);
            const selectedPayload = dashboardPayloads[asset];
            if (selectedPayload) payload = selectedPayload;
            void refreshDashboardLivePrices();
            const stamp = new Date();
            lastUpdate = stamp.toLocaleTimeString();
            lastUpdateAt = stamp;
        } finally {
            if (!silent && requestId === dashboardRequestId) dashboardLoading = false;
        }
    }

    async function loadHistory({
        silent = false,
        force = false,
        assetId: targetAsset = asset,
        contractKey: targetContract = historyContract
    } = {}) {
        const key = historyKey(targetAsset, targetContract);
        const cached = untrack(() => historyCache[key]);
        if (cached && !force) {
            historyPayload = cached;
            return;
        }

        if (!silent) historyLoading = true;
        historyRequestKey = key;
        try {
            const { fetchBiasHistory } = await import('$lib/history-data.js');
            const nextHistory = await fetchBiasHistory({ assetId: targetAsset, contractKey: targetContract });
            if (historyRequestKey !== key) return;

            const lastGood = untrack(() => historyLastGood[key]);
            if (nextHistory?.load_error && lastGood) {
                historyPayload = { ...lastGood, load_error: true };
            } else {
                historyPayload = nextHistory;
                if (!nextHistory?.load_error) {
                    historyCache = { ...untrack(() => historyCache), [key]: nextHistory };
                    historyLastGood = { ...untrack(() => historyLastGood), [key]: nextHistory };
                }
            }
            const stamp = new Date();
            lastUpdate = stamp.toLocaleTimeString();
            lastUpdateAt = stamp;
        } finally {
            if (!silent) historyLoading = false;
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
            const forceLive = silent && ASSET_PROFILES[asset]?.source === 'crypto';
            if (activeTab === 'dashboard') {
                await loadDashboard({ silent, force: !silent });
            } else if (activeTab === 'history') {
                await ensureTabComponent('history');
                await loadHistory({ silent, force: !silent });
            } else {
                const nextKey = await load({ silent, force: !silent || forceLive });
                if (activeTab === 'analysis') {
                    await ensureTabComponent('analysis');
                } else if (activeTab === 'heatmap' && nextKey) {
                    await ensureTabComponent('heatmap');
                    await ensureHeatmap(nextKey, { force: forceLive, silent });
                } else if (activeTab === 'gamma' && nextKey) {
                    await ensureTabComponent('gamma');
                    await ensureGamma(nextKey, { force: forceLive, silent });
                }
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
        } else if (key === 'history') {
            if (ASSET_PROFILES[asset]?.source === 'crypto') {
                asset = 'gc';
                return;
            }
            void ensureTabComponent('history');
        } else if (key === 'analysis') {
            void ensureTabComponent('analysis');
            void load();
        } else if (key === 'heatmap') {
            void ensureTabComponent('heatmap');
            void load().then((nextKey) => {
                if (activeTab !== 'heatmap' || !nextKey) return;
                if (nextKey !== heatmapContract) heatmapContract = nextKey;
                void ensureHeatmap(nextKey);
            });
        } else if (key === 'gamma') {
            void ensureTabComponent('gamma');
            void load().then((nextKey) => {
                if (activeTab !== 'gamma' || !nextKey) return;
                if (nextKey !== gammaContract) gammaContract = nextKey;
                void ensureGamma(nextKey);
            });
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
        const selectedAsset = asset;
        untrack(() => {
            heatmapCache = {};
            gammaCache = {};
            if (activeTab === 'dashboard') {
                void loadDashboard();
            } else if (activeTab === 'history') {
                if (ASSET_PROFILES[selectedAsset]?.source === 'crypto') asset = 'gc';
            } else {
                void load({ assetId: selectedAsset }).then((nextKey) => {
                    if (asset !== selectedAsset) return;
                    if (activeTab === 'analysis') {
                        void ensureTabComponent('analysis');
                    } else if (activeTab === 'heatmap' && nextKey) {
                        void ensureTabComponent('heatmap');
                        void ensureHeatmap(nextKey);
                    } else if (activeTab === 'gamma' && nextKey) {
                        void ensureTabComponent('gamma');
                        void ensureGamma(nextKey);
                    }
                });
            }
        });
    });

    $effect(() => {
        const selectedAsset = asset;
        const selectedContract = historyContract;
        if (activeTab !== 'history') return;
        if (ASSET_PROFILES[selectedAsset]?.source === 'crypto') {
            asset = 'gc';
            return;
        }
        untrack(() => {
            void ensureTabComponent('history');
            void loadHistory({ assetId: selectedAsset, contractKey: selectedContract });
        });
    });

    $effect(() => {
        if (activeTab !== 'dashboard') return;
        let stopped = false;
        async function tick() {
            if (stopped) return;
            await refreshDashboardLivePrices();
        }
        const stale = !dashboardLiveLoadedAt || Date.now() - dashboardLiveLoadedAt.getTime() > 5000;
        if (stale) tick();
        const id = setInterval(tick, 5000);
        return () => { stopped = true; clearInterval(id); };
    });

    $effect(() => {
        const activeAsset = asset;
        const tab = activeTab;
        if (ASSET_PROFILES[activeAsset]?.source !== 'crypto' || tab === 'dashboard' || tab === 'history') return;
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
            : activeTab === 'history'
                ? `Bias History - ${historyContract.toUpperCase()}`
            : activeTab === 'dashboard'
                ? `${dashboardContractLabel} - ${dashboardAssetIds.length} assets`
                : visibleContract?.contract || ''}
        price={activeTab === 'dashboard' || activeTab === 'history' ? null : (isLive ? livePrice : visibleContract?.future_price)}
        live={activeTab === 'dashboard' || activeTab === 'history' ? false : isLive}
        dte={activeTab === 'dashboard' || activeTab === 'history' ? null : visibleContract?.dte}
        {lastUpdate}
        {lastUpdateAt}
        refreshing={refreshing || loading || dashboardLoading || historyLoading || lazyTabsLoading}
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
                {:else if activeTab === 'history'}
                    <div class="flex flex-col gap-4 overflow-y-auto">
                        {#if HistoryComponent}
                            <HistoryComponent
                                history={historyPayload}
                                loading={historyLoading}
                                bind:assetId={asset}
                                bind:contractKey={historyContract}
                                {livePrice}
                                {liveAt}
                            />
                        {:else}
                            <div class="flex h-64 items-center justify-center text-muted-foreground">
                                {#if lazyErrors.history}
                                    <button type="button" class="rounded border border-border px-3 py-1.5 text-sm text-foreground" onclick={() => ensureTabComponent('history')}>Retry history view</button>
                                {:else}
                                    <div class="flex items-center gap-3">
                                        <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                                        <span class="text-sm">Loading history view...</span>
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {:else if activeTab === 'analysis'}
                    <div class="flex flex-col gap-4 overflow-y-auto">
                        {#if AnalysisComponent}
                            <AnalysisComponent {payload} {loading} {livePrice} assetId={asset} />
                        {:else}
                            <div class="flex h-64 items-center justify-center text-muted-foreground">
                                {#if lazyErrors.analysis}
                                    <button type="button" class="rounded border border-border px-3 py-1.5 text-sm text-foreground" onclick={() => ensureTabComponent('analysis')}>Retry position bias</button>
                                {:else}
                                    <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {:else if activeTab === 'heatmap'}
                    {#if HeatmapComponent}
                        <HeatmapComponent
                            assetId={asset}
                            bind:contractKey={heatmapContract}
                            availableContracts={availableContractKeys}
                            data={currentHeatmap}
                            loading={heatmapLoading}
                            onChangeContract={onHeatmapContract}
                            showChangeToggle={true}
                        />
                    {:else}
                        <div class="flex h-64 items-center justify-center text-muted-foreground">
                            {#if lazyErrors.heatmap}
                                <button type="button" class="rounded border border-border px-3 py-1.5 text-sm text-foreground" onclick={() => ensureTabComponent('heatmap')}>Retry heatmap</button>
                            {:else}
                                <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                            {/if}
                        </div>
                    {/if}
                {:else if activeTab === 'gamma'}
                    {#if GammaHeatmapComponent}
                        <GammaHeatmapComponent
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
                    {:else}
                        <div class="flex h-64 items-center justify-center text-muted-foreground">
                            {#if lazyErrors.heatmap}
                                <button type="button" class="rounded border border-border px-3 py-1.5 text-sm text-foreground" onclick={() => ensureTabComponent('gamma')}>Retry gamma heatmap</button>
                            {:else}
                                <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
                            {/if}
                        </div>
                    {/if}
                {/if}
            </div>
        {/key}
    </main>

    <AppFooter
        source={activeTab === 'dashboard' ? 'Cross-asset position bias'
            : activeTab === 'history' ? 'Bias snapshots'
            : sourceLabel}
        contract={activeTab === 'dashboard'
            ? `${dashboardContractLabel} - ${dashboardAssetIds.length} assets`
            : activeTab === 'history'
            ? `${profile.shortLabel} - ${historyContract.toUpperCase()}`
            : activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || '—'
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || '—'
                : visibleContract?.contract || '—'}
        dataType={activeTab === 'dashboard' ? 'Position Bias Dashboard'
            : activeTab === 'history' ? 'Bias History'
            : activeTab === 'analysis' ? 'Position Bias'
            : activeTab === 'heatmap' ? 'OI Heatmap'
            : activeTab === 'gamma' ? 'Gamma Heatmap'
            : 'Position Bias'}
    />
</div>
