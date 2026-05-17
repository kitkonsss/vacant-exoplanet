<script>
    import { cn } from '$lib/utils.js';
    let { class: className = '', children, ...rest } = $props();
</script>

<div
    class={cn(
        'rounded-md border border-border bg-card text-card-foreground',
        className
    )}
    {...rest}
>
    {@render children?.()}
</div>
