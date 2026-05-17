<script>
    import { Database } from 'lucide-svelte';
    let { contract = '—', dataType = '—' } = $props();
</script>

<footer class="flex flex-wrap items-center gap-6 border-t border-border bg-surface px-6 py-2 text-[10px] text-muted-foreground">
    <div class="flex items-center gap-1.5">
        <Database class="h-3 w-3 opacity-70" strokeWidth={2.2} />
        <span>Source</span>
        <span class="font-mono text-foreground/80">pageth/Vol2VolData</span>
    </div>
    <div class="flex items-center gap-1.5">
        <span>Contract</span>
        <span class="font-mono text-foreground/80">{contract}</span>
    </div>
    <div class="flex items-center gap-1.5">
        <span>Data Type</span>
        <span class="font-mono text-foreground/80">{dataType}</span>
    </div>
    <div class="ml-auto flex items-center gap-1.5 opacity-70">
        <span class="font-mono">v2</span>
    </div>
</footer>
