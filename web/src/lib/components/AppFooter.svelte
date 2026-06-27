<script>
    import { Database } from 'lucide-svelte';
    let { contract = '-', dataType = '-', source = 'pageth/Vol2VolData' } = $props();
</script>

<footer class="flex flex-wrap items-center gap-6 border-t border-border bg-surface px-6 py-2 text-[10px] text-muted-foreground">
    <div class="flex items-center gap-1.5">
        <Database class="h-3 w-3 opacity-70" strokeWidth={2.2} />
        <span>Source</span>
        <span class="font-mono text-foreground/80">{source}</span>
    </div>
    <div class="flex items-center gap-1.5">
        <span>Contract</span>
        <span class="font-mono text-foreground/80">{contract}</span>
    </div>
    <div class="flex items-center gap-1.5">
        <span>Data Type</span>
        <span class="font-mono text-foreground/80">{dataType}</span>
    </div>
    <div class="ml-auto flex items-center gap-3 opacity-70">
        <div class="hidden items-center gap-1.5 md:flex">
            <kbd class="rounded-sm border border-border bg-background px-1 font-mono text-[9px] text-foreground/80">R</kbd>
            <span>refresh</span>
            <span class="opacity-50">.</span>
            <kbd class="rounded-sm border border-border bg-background px-1 font-mono text-[9px] text-foreground/80">1</kbd>
            <span class="opacity-50">-</span>
            <kbd class="rounded-sm border border-border bg-background px-1 font-mono text-[9px] text-foreground/80">4</kbd>
            <span>tabs</span>
        </div>
        <span class="font-mono">v2</span>
    </div>
</footer>
