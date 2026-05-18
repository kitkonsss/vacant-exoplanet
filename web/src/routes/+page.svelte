<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasView from '$lib/components/PositionBiasView.svelte';
    import HeatmapView from '$lib/components/HeatmapView.svelte';
    import ConvictionView from '$lib/components/ConvictionView.svelte';
    import { fetchHeatmap, fetchPositionBias } from '$lib/data.js';
    import { ASSET_PROFILES, DEFAULT_CONTRACT_KEY } from '$lib/config.js';
    import { LineChart, Grid3X3, Target } from 'lucide-svelte';

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

    const profile = $derived(ASSET_PROFILES[asset]);
    const availableContractKeys = $derived(
        (payload?.contracts || []).map((contract) => contract.contract_key)
    );

    const tabs = [
        { key: 'analysis',   label: 'Position Bias', tone: 'primary', icon: LineChart },
        { key: 'heatmap',    label: 'OI Heatmap',    tone: 'mag',     icon: Grid3X3 },
        { key: 'conviction', label: 'Conviction',    tone: 'warn',    icon: Target }
    ];

    const tabUsesContract = $derived(activeTab === 'heatmap' || activeTab === 'conviction');

    const visibleContract = $derived(
        payload?.contracts?.find(
            (c) => c.contract_key === (tabUsesContract ? heatmapContract : 'current')
        ) || payload?.contracts?.[0]
    );

    const currentHeatmap = $derived(heatmapCache[heatmapContract] ?? null);
    const currentBias = $derived(
        payload?.contracts?.find((c) => c.contract_key === heatmapContract) || null
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

    async function refresh() {
        heatmapCache = {};
        const nextKey = await load();
        if ((activeTab === 'heatmap' || activeTab === 'conviction') && nextKey) {
            await ensureHeatmap(nextKey);
        }
    }

    function onTabChange(key) {
        if (key !== 'heatmap' && key !== 'conviction') return;

        const nextKey = resolveContractKey(availableContractKeys);
        if (!nextKey) return;

        if (nextKey !== heatmapContract) {
            heatmapContract = nextKey;
        }
        void ensureHeatmap(nextKey);
    }

    function onHeatmapContract(key) {
        heatmapContract = key;
        void ensureHeatmap(key);
    }

    // React only to asset changes. Wrap side effects in untrack so writes
    // to heatmapCache / reads of activeTab don't subscribe this effect.
    $effect(() => {
        asset; // dep
        untrack(() => {
            heatmapCache = {};
            void load().then((nextKey) => {
                if ((activeTab === 'heatmap' || activeTab === 'conviction') && nextKey) {
                    void ensureHeatmap(nextKey);
                }
            });
        });
    });
</script>

<div class="flex h-screen flex-col overflow-hidden">
    <Header
        bind:asset
        contract={profile.label}
        contractCode={tabUsesContract
            ? currentHeatmap?.contract || visibleContract?.contract || ''
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
        {:else if activeTab === 'conviction'}
            <ConvictionView
                assetId={asset}
                bind:contractKey={heatmapContract}
                availableContracts={availableContractKeys}
                bias={currentBias}
                heatmap={currentHeatmap}
                loading={heatmapLoading || loading}
                onChangeContract={onHeatmapContract}
            />
        {/if}
    </main>

    <AppFooter
        contract={tabUsesContract
            ? currentHeatmap?.contract || visibleContract?.contract || '—'
            : visibleContract?.contract || '—'}
        dataType={activeTab === 'analysis' ? 'Position Bias' : activeTab === 'heatmap' ? 'OI Heatmap' : 'Conviction'}
    />
</div>
