<script>
    import { cn } from '$lib/utils.js';

    let { class: className = '', value = $bindable(), children, ...rest } = $props();
</script>

<div class="relative inline-block">
    <select
        bind:value
        class={cn(
            'appearance-none rounded-md border border-border bg-surface px-3 pr-8 py-1.5 text-sm font-medium text-foreground',
            'hover:bg-surface-elevated hover:border-border focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-primary/60',
            'transition-colors cursor-pointer',
            className
        )}
        {...rest}
    >
        {@render children?.()}
    </select>
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
    >
        <path d="m6 9 6 6 6-6" />
    </svg>
</div>
