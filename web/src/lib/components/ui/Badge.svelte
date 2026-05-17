<script>
    import { cn } from '$lib/utils.js';

    let { class: className = '', variant = 'default', children, ...rest } = $props();

    // Solid outline / fill — no opacity tricks.
    const variants = {
        default:   'bg-primary text-primary-foreground border-primary',
        secondary: 'bg-secondary text-secondary-foreground border-border',
        outline:   'bg-background text-muted-foreground border-border',
        up:        'bg-background text-up border-up',
        down:      'bg-background text-down border-down',
        call:      'bg-background text-call border-call',
        put:       'bg-background text-put border-put',
        warn:      'bg-background text-warn border-warn',
        mag:       'bg-background text-mag border-mag',
        muted:     'bg-muted text-muted-foreground border-border'
    };
</script>

<span
    class={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider tabular-nums',
        variants[variant] || variants.default,
        className
    )}
    {...rest}
>
    {@render children?.()}
</span>
