<script>
    import { cn } from '$lib/utils.js';

    let { tabs = [], active = $bindable('current'), onChange = () => {} } = $props();

    function pick(tab) {
        active = tab.key;
        onChange(tab.key);
    }

    const toneText = {
        primary: 'text-primary',
        mag:     'text-mag',
        warn:    'text-warn'
    };
    const toneBar = {
        primary: 'bg-primary',
        mag:     'bg-mag',
        warn:    'bg-warn'
    };
</script>

<nav class="flex items-stretch gap-0 border-b border-border bg-surface px-6">
    {#each tabs as tab}
        {@const isActive = active === tab.key}
        {@const Icon = tab.icon}
        <button
            type="button"
            onclick={() => pick(tab)}
            class={cn(
                'group relative flex items-center gap-2 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors',
                isActive
                    ? `${toneText[tab.tone || 'primary']}`
                    : 'text-muted-foreground hover:text-foreground',
                tab.alignRight ? 'ml-auto' : ''
            )}
        >
            {#if Icon}
                <Icon class="h-3.5 w-3.5" strokeWidth={2.4} />
            {/if}
            <span>{tab.label}</span>
            {#if tab.meta}
                <span class="font-mono text-[10px] normal-case tracking-normal text-muted-foreground">
                    {tab.meta}
                </span>
            {/if}

            <!-- crisp 2px indicator -->
            {#if isActive}
                <span
                    class={cn(
                        'pointer-events-none absolute inset-x-0 -bottom-px h-[2px]',
                        toneBar[tab.tone || 'primary']
                    )}
                ></span>
            {/if}
        </button>
    {/each}
</nav>
