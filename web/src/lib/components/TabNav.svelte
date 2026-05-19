<script>
    import { cn } from '$lib/utils.js';

    let { tabs = [], active = $bindable('current'), onChange = () => {} } = $props();

    function pick(tab) {
        if (active === tab.key) return;
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
    const toneGlow = {
        primary: 'shadow-[0_0_8px_hsl(var(--primary)/0.6)]',
        mag:     'shadow-[0_0_8px_hsl(var(--mag)/0.6)]',
        warn:    'shadow-[0_0_8px_hsl(var(--warn)/0.6)]'
    };
</script>

<nav class="flex items-stretch gap-0 border-b border-border bg-surface px-6">
    {#each tabs as tab}
        {@const isActive = active === tab.key}
        {@const Icon = tab.icon}
        {@const tone = tab.tone || 'primary'}
        <button
            type="button"
            onclick={() => pick(tab)}
            class={cn(
                'group relative flex items-center gap-2 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] transition-all duration-150',
                isActive
                    ? toneText[tone]
                    : 'text-muted-foreground hover:text-foreground hover:bg-surface-elevated/60',
                tab.alignRight ? 'ml-auto' : ''
            )}
            aria-current={isActive ? 'page' : undefined}
        >
            {#if Icon}
                <Icon
                    class={cn(
                        'h-3.5 w-3.5 transition-transform duration-150',
                        isActive ? 'scale-110' : 'group-hover:scale-105'
                    )}
                    strokeWidth={2.4}
                />
            {/if}
            <span>{tab.label}</span>
            {#if tab.meta}
                <span class="font-mono text-[10px] normal-case tracking-normal text-muted-foreground">
                    {tab.meta}
                </span>
            {/if}

            <!-- crisp 2px indicator with subtle glow when active -->
            {#if isActive}
                <span
                    class={cn(
                        'pointer-events-none absolute inset-x-0 -bottom-px h-[2px] rounded-t-sm',
                        toneBar[tone],
                        toneGlow[tone]
                    )}
                ></span>
            {/if}
        </button>
    {/each}
</nav>
