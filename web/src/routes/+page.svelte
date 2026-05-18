<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasView from '$lib/components/PositionBiasView.svelte';
    import HeatmapView from '$lib/components/HeatmapView.svelte';
    import ConvictionView from '$lib/components/ConvictionView.svelte';
    import { fetchGammaHeatmap, fetchHeatmap, fetchPositionBias } from '$lib/data.js';
    import { ASSET_PROFILES, DEFAULT_CONTRACT_KEY } from '$lib/config.js';
    import { LineChart, Grid3X3, Activity, Target } from 'lucide-svelte';

    let asset = $state('gc');
    let activeTab = $state('analysis');
    let payload = $state(null);
    let loading = $state(true);
    let lastUpdate = $state('—');

    // Heatmap state (shared by Heatmap + Conviction tabs — both pivot on the same contract)
    let heatmapContract = $state(DEFAULT_CONTRACT_KEY);
    /** @type {Record<string, any>} */
    let heatmapCache = $state({});
    let heatmapLoading = $state(false);

    // Gamma heatmap has its own per-contract cache and active contract.
    let gammaContract = $state(DEFAULT_CONTRACT_KEY);
    /** @type {Record<string, any>} */
    let gammaCache = $state({});
    let gammaLoading = $state(false);

    const profile = $derived(ASSET_PROFILES[asset]);
    const availableContractKeys = $derived(
        (payload?.contracts || []).map((contract) => contract.contract_key)
    );

    const tabs = [
        { key: 'analysis',   label: 'Position Bias', tone: 'primary', icon: LineChart },
        { key: 'heatmap',    label: 'OI Heatmap',    tone: 'mag',     icon: Grid3X3 },
        { key: 'gamma',      label: 'Gamma Heatmap', tone: 'mag',     icon: Activity },
        { key: 'conviction', label: 'Conviction',    tone: 'warn',    icon: Target }
    ];

    // Single-contract tabs each pivot on their own contract pill.
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

    // Conviction tab aggregates all 4 tenors at once — assemble side-by-side
    // bias + heatmap pairs for every contract we've loaded.
    const convictionContracts = $derived(
        (payload?.contracts || [])
            .map((c) => ({
                key: c.contract_key,
                dte: c.dte,
                bias: c,
                heatmap: heatmapCache[c.contract_key] || null
            }))
            .filter((c) => c.heatmap)
    );
    const convictionLoading = $derived(
        loading || (activeTab === 'conviction' && convictionContracts.length === 0)
    );

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
            if (nextKey && nextKey !== heatmapContract) {
                heatmapContract = nextKey;
            }
            if (nextKey && nextKey !== gammaContract) {
                gammaContract = nextKey;
            }
            lastUpdate = new Date().toLocaleTimeString();
            return nextKey;
        } finally {
            loading = false;
        }
    }

    async function ensureHeatmap(contractKey) {
        // Read cache without tracking — caller may be inside an $effect
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

    async function ensureAllHeatmaps(keys) {
        const missing = keys.filter((k) => !untrack(() => heatmapCache[k]));
        if (missing.length === 0) return;
        heatmapLoading = true;
        try {
            const results = await Promise.all(
                missing.map((k) => fetchHeatmap(asset, k).then((data) => [k, data]))
            );
            const next = { ...untrack(() => heatmapCache) };
            for (const [k, data] of results) next[k] = data;
            heatmapCache = next;
        } finally {
            heatmapLoading = false;
        }
    }

    async function refresh() {
        heatmapCache = {};
        gammaCache = {};
        const nextKey = await load();
        if (activeTab === 'heatmap' && nextKey) {
            await ensureHeatmap(nextKey);
        } else if (activeTab === 'gamma' && nextKey) {
            await ensureGamma(nextKey);
        } else if (activeTab === 'conviction') {
            await ensureAllHeatmaps(availableContractKeys);
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
        } else if (key === 'conviction') {
            void ensureAllHeatmaps(availableContractKeys);
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

    // React only to asset changes. Wrap side effects in untrack so writes
    // to heatmapCache / reads of activeTab don't subscribe this effect.
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
                } else if (activeTab === 'conviction') {
                    void ensureAllHeatmaps(availableContractKeys);
                }
            });
        });
    });
</script>

<div class="flex h-screen flex-col overflow-hidden">
    <Header
        bind:asset
        contract={profile.label}
        contractCode={activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || ''
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || ''
            : activeTab === 'conviction'
                ? `${convictionContracts.length}× tenors`
                : visibleContract?.contract || ''}
        price={visibleContract?.future_price}
        dte={visibleContract?.dte}
        {lastUpdate}
        onRefresh={refresh}
    />

    <TabNav {tabs} bind:active={activeTab} onChange={onTabChange} />

    <main class="flex flex-1 min-h-0 flex-col overflow-hidden px-6 py-5">
        {#if activeTab === 'analysis'}
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
                title="Gamma Heatmap (1 Pct)"
                valueDecimals={2}
                heatScale="linear"
                emptyFile="_GammaHeatmap.json"
            />
        {:else if activeTab === 'conviction'}
            <ConvictionView
                contracts={convictionContracts}
                loading={convictionLoading}
            />
        {/if}
    </main>

    <AppFooter
        contract={activeTab === 'heatmap'
            ? currentHeatmap?.contract || visibleContract?.contract || '—'
            : activeTab === 'gamma'
                ? currentGamma?.contract || visibleContract?.contract || '—'
            : activeTab === 'conviction'
                ? 'All Contracts'
                : visibleContract?.contract || '—'}
        dataType={activeTab === 'analysis' ? 'Position Bias'
            : activeTab === 'heatmap' ? 'OI Heatmap'
            : activeTab === 'gamma' ? 'Gamma Heatmap'
            : 'Conviction'}
    />
</div>
