<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasView from '$lib/components/PositionBiasView.svelte';
    import HeatmapView from '$lib/components/HeatmapView.svelte';
    import { fetchHeatmap, fetchPositionBias } from '$lib/data.js';
    import { ASSET_PROFILES } from '$lib/config.js';
    import { LineChart, Grid3X3 } from 'lucide-svelte';

    let asset = $state('gc');
    let activeTab = $state('analysis');
    let payload = $state(null);
    let loading = $state(true);
    let lastUpdate = $state('—');

    // Heatmap state
    let heatmapContract = $state('current');
    /** @type {Record<string, any>} */
    let heatmapCache = $state({});
    let heatmapLoading = $state(false);

    const profile = $derived(ASSET_PROFILES[asset]);

    const tabs = [
        { key: 'analysis', label: 'Position Bias', tone: 'primary', icon: LineChart },
        { key: 'heatmap',  label: 'OI Heatmap',    tone: 'mag',     icon: Grid3X3 }
    ];

    const headerContract = $derived(
        payload?.contracts?.find((c) => c.contract_key === 'current') || payload?.contracts?.[0]
    );

    const currentHeatmap = $derived(heatmapCache[heatmapContract] ?? null);

    async function load() {
        loading = true;
        try {
            payload = await fetchPositionBias(asset);
            lastUpdate = new Date().toLocaleTimeString();
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
        await load();
        if (activeTab === 'heatmap') await ensureHeatmap(heatmapContract);
    }

    function onTabChange(key) {
        if (key === 'heatmap') void ensureHeatmap(heatmapContract);
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
            void load();
            if (activeTab === 'heatmap') void ensureHeatmap(heatmapContract);
        });
    });
</script>

<div class="flex h-screen flex-col overflow-hidden">
    <Header
        bind:asset
        contract={profile.label}
        contractCode={activeTab === 'heatmap'
            ? currentHeatmap?.contract || headerContract?.contract || ''
            : headerContract?.contract || ''}
        price={headerContract?.future_price}
        dte={headerContract?.dte}
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
                data={currentHeatmap}
                loading={heatmapLoading}
                onChangeContract={onHeatmapContract}
            />
        {/if}
    </main>

    <AppFooter
        contract={activeTab === 'heatmap'
            ? currentHeatmap?.contract || '—'
            : headerContract?.contract || '—'}
        dataType={activeTab === 'analysis' ? 'Position Bias' : 'OI Heatmap'}
    />
</div>
