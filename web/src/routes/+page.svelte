<script>
    import { untrack } from 'svelte';
    import Header from '$lib/components/Header.svelte';
    import TabNav from '$lib/components/TabNav.svelte';
    import AppFooter from '$lib/components/AppFooter.svelte';
    import PositionBiasView from '$lib/components/PositionBiasView.svelte';
    import HeatmapView from '$lib/components/HeatmapView.svelte';
    import ConvictionView from '$lib/components/ConvictionView.svelte';
    import { fetchGammaMatrix, fetchHeatmap, fetchPositionBias } from '$lib/data.js';
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

    // Gamma matrix is one file per asset (no contract pivot).
    let gammaMatrix = $state(null);
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

    // Heatmap tab pivots on its own contract pill; Gamma matrix doesn't.
    const visibleContract = $derived(
        payload?.contracts?.find(
            (c) => c.contract_key === (activeTab === 'heatmap' ? heatmapContract : 'current')
        ) || payload?.contracts?.[0]
    );

    const currentHeatmap = $derived(heatmapCache[heatmapContract] ?? null);

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

    async function ensureGamma() {
        if (untrack(() => gammaMatrix)) return;
        gammaLoading = true;
        try {
            gammaMatrix = await fetchGammaMatrix(asset);
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
        gammaMatrix = null;
        const nextKey = await load();
        if (activeTab === 'heatmap' && nextKey) {
            await ensureHeatmap(nextKey);
        } else if (activeTab === 'gamma') {
            await ensureGamma();
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
            void ensureGamma();
        } else if (key === 'conviction') {
            void ensureAllHeatmaps(availableContractKeys);
        }
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
            gammaMatrix = null;
            void load().then((nextKey) => {
                if (activeTab === 'heatmap' && nextKey) {
                    void ensureHeatmap(nextKey);
                } else if (activeTab === 'gamma') {
                    void ensureGamma();
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
                ? `${gammaMatrix?.dates?.length ?? 0}× expirations`
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
                availableContracts={[]}
                data={gammaMatrix}
                loading={gammaLoading}
                title="Gamma Matrix (1 Pct, Call+Put)"
                valueDecimals={0}
                heatScale="log"
                emptyFile="GammaMatrix.json"
                columnLabel="Expiration"
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
                ? 'All Expirations'
            : activeTab === 'conviction'
                ? 'All Contracts'
                : visibleContract?.contract || '—'}
        dataType={activeTab === 'analysis' ? 'Position Bias'
            : activeTab === 'heatmap' ? 'OI Heatmap'
            : activeTab === 'gamma' ? 'Gamma Matrix'
            : 'Conviction'}
    />
</div>
