<script>
    import { cn } from '$lib/utils.js';

    let {
        class: className = '',
        variant = 'default',
        size = 'default',
        type = 'button',
        children,
        ...rest
    } = $props();

    const variants = {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-border',
        ghost: 'hover:bg-surface-elevated text-muted-foreground hover:text-foreground border border-border',
        outline: 'border border-border bg-transparent hover:bg-surface-elevated hover:text-foreground'
    };

    const sizes = {
        default: 'h-9 px-3.5 text-sm',
        sm: 'h-8 px-3 text-xs',
        icon: 'h-9 w-9'
    };
</script>

<button
    {type}
    class={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant] || variants.default,
        sizes[size] || sizes.default,
        className
    )}
    {...rest}
>
    {@render children?.()}
</button>
