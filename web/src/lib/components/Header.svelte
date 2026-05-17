<script>
    import Select from './ui/Select.svelte';
    import Button from './ui/Button.svelte';
    import { ASSET_PROFILES } from '$lib/config.js';
    import { fmtNumber } from '$lib/utils.js';
    import { TrendingUp, RefreshCw } from 'lucide-svelte';

    let {
        asset = $bindable('gc'),
        contract = '—',
        contractCode = '',
        price = null,
        dte = null,
        lastUpdate = '—',
        onRefresh = () => {}
    } = $props();
</script>

<header class="relative border-b border-border bg-surface">
    <div class="flex items-center justify-between gap-4 px-6 py-3">
        <div class="flex items-center gap-5 min-w-0">
            <!-- Logo -->
            <div class="flex items-center gap-2.5 shrink-0">
                <div class="flex h-8 w-8 items-center justify-center rounded-md bg-primary">
                    <TrendingUp class="h-4 w-4 text-primary-foreground" strokeWidth={2.8} />
                </div>
                <div class="flex flex-col leading-none">
                    <span class="font-mono text-[15px] font-bold tracking-tight text-foreground">
                        Vol2Vol<span class="text-primary">.</span>
                    </span>
                    <span class="mt-0.5 text-[9px] font-semibold uppercase tracking-widest-2 text-muted-foreground">
                        Options Flow
                    </span>
                </div>
            </div>

            <!-- Asset selector -->
            <Select bind:value={asset}>
                {#each Object.values(ASSET_PROFILES) as profile}
                    <option value={profile.id}>{profile.label}</option>
                {/each}
            </Select>

            <!-- Contract + price -->
            <div class="hidden items-center gap-4 md:flex min-w-0">
                <div class="flex flex-col leading-tight min-w-0">
                    <span class="text-[9px] font-semibold uppercase tracking-widest-2 text-muted-foreground">
                        Contract
                    </span>
                    <div class="flex items-baseline gap-2 min-w-0">
                        <span class="truncate font-semibold text-foreground">{contract}</span>
                        <span class="truncate font-mono text-xs text-muted-foreground">{contractCode || '—'}</span>
                    </div>
                </div>
                <div class="h-9 w-px bg-border"></div>
                <div class="flex items-baseline gap-2.5">
                    <span class="font-mono text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                        {price != null ? fmtNumber(price, 1) : '—'}
                    </span>
                </div>
            </div>
        </div>

        <div class="flex items-center gap-3 shrink-0">
            {#if dte != null}
                <span class="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-2.5 py-1 font-mono text-xs font-semibold tabular-nums text-primary-foreground">
                    DTE {fmtNumber(dte, 2)}
                </span>
            {/if}

            <Button variant="ghost" size="sm" onclick={onRefresh}>
                <RefreshCw class="h-3.5 w-3.5" strokeWidth={2.2} />
                Refresh
            </Button>

            <div class="hidden items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[10px] text-muted-foreground sm:flex">
                <span class="h-1.5 w-1.5 rounded-full bg-primary"></span>
                <span>{lastUpdate}</span>
            </div>
        </div>
    </div>
</header>
