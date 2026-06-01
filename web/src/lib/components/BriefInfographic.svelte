<script>
    import { marked } from 'marked';
    import { fmtBangkok } from '$lib/utils.js';
    import Badge from './ui/Badge.svelte';
    import {
        Sparkles, Clock, TrendingUp, TrendingDown, Minus,
        Crosshair, Target, ArrowUpRight, ArrowDownRight,
        ShieldAlert, Lightbulb, AlertTriangle, FileText
    } from 'lucide-svelte';

    // brief = raw markdown string; bias/generatedAt come from the structured strategy
    // (robust, not parsed) so the header chip + time don't depend on LLM formatting.
    let { brief = null, bias = null, generatedAt = null } = $props();

    // ---- tiny markdown helpers (trusted: our own repo content) ----------------
    function inline(md) {
        return marked.parseInline((md || '').trim());
    }
    function stripBold(s) {
        return (s || '').replace(/\*\*/g, '').trim();
    }
    function toneForText(t) {
        const s = (t || '').toLowerCase();
        if (/bull|tailwind|หนุน|รับ|support|ขึ้น|long/.test(s)) return 'up';
        if (/bear|headwind|กด|ต้าน|resist|ลง|short/.test(s)) return 'down';
        return 'muted';
    }
    function scoreOf(text) {
        const m = (text || '').match(/[+-]?\d+(?:\.\d+)?/);
        return m ? m[0] : null;
    }
    function labelWordOf(text) {
        const m = (text || '').match(/neutral|lean[_ ]?bullish|lean[_ ]?bearish|bullish|bearish|tailwind|headwind/i);
        return m ? m[0] : '';
    }

    // ---- section classifier ---------------------------------------------------
    function classify(heading) {
        const h = (heading || '').toLowerCase();
        if (/สรุป/.test(h) && !/เหตุผล|ชั้น/.test(h)) return 'summary';
        if (/เหตุผล|ชั้น|layer|reason/.test(h)) return 'layers';
        if (/execution|read|แผนเทรด|การเทรด/.test(h)) return 'exec';
        if (/key level|ระดับ|levels|แนวรับ|แนวต้าน/.test(h)) return 'levels';
        if (/scenario|สถานการณ์/.test(h)) return 'scenarios';
        if (/เปลี่ยนมุมมอง|change my mind|flip|มุมมอง/.test(h)) return 'flip';
        if (/ระวัง|caveat|risk|disclaim/.test(h)) return 'caveat';
        return 'generic';
    }

    const DISCLAIMER_RE = /ไม่ใช่คำแนะนำลงทุน|เชิงการศึกษา|educational|entry\/stop\/target/i;

    function isTableRow(line) {
        return line.trim().startsWith('|');
    }
    function isSeparatorRow(cells) {
        return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
    }
    function splitCells(line) {
        return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    }

    // ---- main parser ----------------------------------------------------------
    function parseBrief(md) {
        if (!md) return null;
        const lines = md.replace(/\r\n/g, '\n').split('\n');

        let title = null;
        let generatedIso = null;
        let subtitle = null;
        const sections = [];
        let cur = null; // { heading, kind, body[] }

        const pushSection = () => {
            if (cur && (cur.heading || cur.body.some((l) => l.trim()))) sections.push(cur);
        };

        for (const raw of lines) {
            const line = raw.replace(/\s+$/, '');
            const t = line.trim();

            const h1 = t.match(/^#\s+(.*)$/);
            if (h1 && !cur) { title = h1[1].trim(); continue; }

            const h2 = t.match(/^##\s+(.*)$/);
            if (h2) {
                pushSection();
                const heading = h2[1].trim();
                cur = { heading, kind: classify(heading), body: [] };
                continue;
            }

            if (!cur) {
                // preamble: capture generated + blockquote subtitle
                const gen = t.match(/^Generated:\s*(.+)$/i) || t.match(/^Generated\b.*?([0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s]+)/i);
                if (gen) { generatedIso = gen[1].trim(); continue; }
                const bq = t.match(/^>\s*(.+)$/);
                if (bq) { subtitle = (subtitle ? subtitle + ' ' : '') + bq[1].trim(); continue; }
                continue;
            }
            cur.body.push(line);
        }
        pushSection();

        // Lift a trailing disclaimer paragraph out of whatever section swallowed it.
        let disclaimer = null;
        for (const sec of sections) {
            const keep = [];
            for (const l of sec.body) {
                if (DISCLAIMER_RE.test(l) && l.trim()) disclaimer = (disclaimer ? disclaimer + ' ' : '') + stripBold(l);
                else keep.push(l);
            }
            sec.body = keep;
        }

        return {
            title,
            generatedIso,
            subtitle,
            sections: sections.map(buildSection),
            disclaimer
        };
    }

    // ---- per-kind shaping -----------------------------------------------------
    function buildSection(sec) {
        const body = sec.body;
        if (sec.kind === 'layers') {
            const tableLines = body.filter(isTableRow);
            const rows = tableLines.map(splitCells).filter((c) => !isSeparatorRow(c));
            const dataRows = rows.slice(1); // drop header row
            const layers = dataRows
                .filter((c) => c.length >= 2 && c[0])
                .map((c) => {
                    const read = c[1] || '';
                    return {
                        name: stripBold(c[0]),
                        score: scoreOf(read),
                        label: labelWordOf(read) || stripBold(read),
                        summary: c[2] || '',
                        tone: toneForText(read)
                    };
                });
            const prose = body.filter((l) => !isTableRow(l) && l.trim());
            return { ...sec, layers, prose };
        }
        if (sec.kind === 'levels') {
            const groups = [];
            for (const l of body) {
                const m = l.match(/^\s*[-*]?\s*\**\s*(Resistance|Magnet|Support|แนวต้าน|แม่เหล็ก|แนวรับ)\s*\**\s*:\s*(.+)$/i);
                if (!m) continue;
                const label = m[1];
                const tone = /resist|ต้าน/i.test(label) ? 'down' : /magnet|แม่เหล็ก/i.test(label) ? 'warn' : 'up';
                // split on "/" or "、" or a list-comma, but NOT a thousands-separator comma (",550")
                const values = stripBold(m[2]).split(/\s*[\/、]\s*|\s*,(?!\d)\s*/).map((v) => v.trim()).filter(Boolean);
                groups.push({ label, tone, values });
            }
            const prose = groups.length ? [] : body.filter((l) => l.trim());
            return { ...sec, groups, prose };
        }
        if (sec.kind === 'scenarios') {
            const scenarios = [];
            for (const l of body) {
                const m = l.match(/^\s*[-*]?\s*\*\*(.+?)\*\*\s*:?\s*(.*)$/);
                if (m && m[2].trim()) {
                    const head = m[1].trim().replace(/:$/, '');
                    const dir = /up|ขึ้น|bull/i.test(head) ? 'up' : /down|ลง|bear/i.test(head) ? 'down' : 'muted';
                    scenarios.push({ head, dir, text: m[2].trim() });
                }
            }
            const prose = scenarios.length ? [] : body.filter((l) => l.trim());
            return { ...sec, scenarios, prose };
        }
        if (sec.kind === 'exec') {
            const items = body
                .filter((l) => /^\s*[-*]\s+/.test(l))
                .map((l) => {
                    const txt = l.replace(/^\s*[-*]\s+/, '');
                    const m = txt.match(/^\*\*(.+?):?\*\*\s*:?\s*(.*)$/);
                    return m ? { label: m[1].trim(), text: m[2].trim() } : { label: null, text: txt };
                });
            const prose = items.length ? [] : body.filter((l) => l.trim());
            return { ...sec, items, prose };
        }
        // summary / flip / caveat / generic → just prose paragraphs
        const prose = body.filter((l) => l.trim());
        return { ...sec, prose };
    }

    const parsed = $derived(parseBrief(brief));

    const genIso = $derived(parsed?.generatedIso || generatedAt || null);

    function biasText(label) {
        return (label || 'neutral').replace('lean_', 'lean ').replace('_', ' ');
    }
    function biasVariant(label) {
        if (label === 'bullish' || label === 'lean_bullish') return 'up';
        if (label === 'bearish' || label === 'lean_bearish') return 'down';
        return 'muted';
    }

    // join consecutive prose lines into paragraphs (blank line separates)
    function paragraphs(lines) {
        const out = [];
        let buf = [];
        for (const l of lines || []) {
            if (l.trim()) buf.push(l.trim());
            else if (buf.length) { out.push(buf.join(' ')); buf = []; }
        }
        if (buf.length) out.push(buf.join(' '));
        return out;
    }

    const kindMeta = {
        flip: { icon: Lightbulb, tone: 'up', label: 'อะไรจะเปลี่ยนมุมมอง' },
        caveat: { icon: AlertTriangle, tone: 'warn', label: 'ข้อควรระวัง' },
        generic: { icon: FileText, tone: 'muted', label: '' }
    };
</script>

{#if parsed}
    <div class="overflow-hidden rounded-xl border border-warn/30 bg-card">
        <!-- ===== Hero header ===== -->
        <div class="relative border-b border-border/70 bg-gradient-to-br from-warn/12 via-card to-card px-5 py-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-warn">
                        <Sparkles class="h-3.5 w-3.5" /> บทวิเคราะห์ประจำวัน (AI)
                    </div>
                    {#if parsed.title}
                        <h2 class="mt-1 text-lg font-bold leading-tight text-foreground">{parsed.title}</h2>
                    {/if}
                </div>
                <div class="flex flex-col items-end gap-1.5">
                    {#if bias}
                        <span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide
                            {biasVariant(bias.label) === 'up' ? 'border-up/40 bg-up/10 text-up'
                             : biasVariant(bias.label) === 'down' ? 'border-down/40 bg-down/10 text-down'
                             : 'border-border bg-muted text-muted-foreground'}">
                            {#if biasVariant(bias.label) === 'up'}<TrendingUp class="h-3.5 w-3.5" />
                            {:else if biasVariant(bias.label) === 'down'}<TrendingDown class="h-3.5 w-3.5" />
                            {:else}<Minus class="h-3.5 w-3.5" />{/if}
                            {biasText(bias.label)}
                            {#if bias.score != null}<span class="font-mono opacity-80">{bias.score > 0 ? '+' : ''}{bias.score}</span>{/if}
                        </span>
                        {#if bias.confidence}
                            <span class="text-[10px] uppercase tracking-wider text-muted-foreground">{bias.confidence} confidence</span>
                        {/if}
                    {/if}
                </div>
            </div>
            {#if genIso}
                <div class="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock class="h-3 w-3" /> <span class="font-mono">{fmtBangkok(genIso)}</span>
                </div>
            {/if}
            {#if parsed.subtitle}
                <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">{parsed.subtitle}</p>
            {/if}
        </div>

        <!-- ===== Body sections ===== -->
        <div class="flex flex-col gap-4 px-5 py-4">
            {#each parsed.sections as sec (sec.heading)}
                {#if sec.kind === 'summary'}
                    <div class="rounded-lg border-l-[3px] p-3.5 {biasVariant(bias?.label) === 'up' ? 'border-up bg-up/[0.06]' : biasVariant(bias?.label) === 'down' ? 'border-down bg-down/[0.06]' : 'border-warn bg-warn/[0.06]'}">
                        {#each paragraphs(sec.prose) as p}
                            <p class="brief-rt text-[15px] font-medium leading-relaxed text-foreground">{@html inline(p)}</p>
                        {/each}
                    </div>

                {:else if sec.kind === 'layers'}
                    <section>
                        <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Crosshair class="h-3.5 w-3.5" /> {sec.heading}
                        </div>
                        {#if sec.layers?.length}
                            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                {#each sec.layers as L}
                                    <div class="rounded-lg border border-border/70 bg-muted/20 p-3">
                                        <div class="flex items-center justify-between">
                                            <span class="text-xs font-semibold text-foreground">{L.name}</span>
                                            {#if L.score != null}
                                                <span class="font-mono text-xs tabular-nums {L.tone === 'up' ? 'text-up' : L.tone === 'down' ? 'text-down' : 'text-muted-foreground'}">{L.score}</span>
                                            {/if}
                                        </div>
                                        <div class="mt-1.5">
                                            <Badge variant={L.tone}>{L.label}</Badge>
                                        </div>
                                        {#if L.summary}
                                            <p class="brief-rt mt-2 text-[11px] leading-snug text-muted-foreground">{@html inline(L.summary)}</p>
                                        {/if}
                                    </div>
                                {/each}
                            </div>
                        {/if}
                        {#each paragraphs(sec.prose) as p}
                            <div class="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/[0.05] p-2.5">
                                <ShieldAlert class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                                <p class="brief-rt text-[11px] leading-relaxed text-foreground/90">{@html inline(p)}</p>
                            </div>
                        {/each}
                    </section>

                {:else if sec.kind === 'exec' && sec.items?.length}
                    <section>
                        <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Target class="h-3.5 w-3.5" /> {sec.heading}
                        </div>
                        <div class="flex flex-col gap-1.5">
                            {#each sec.items as it}
                                <div class="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5">
                                    <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn"></span>
                                    <div class="text-[12px] leading-relaxed">
                                        {#if it.label}<span class="font-semibold text-foreground">{it.label}: </span>{/if}
                                        <span class="brief-rt text-muted-foreground">{@html inline(it.text)}</span>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    </section>

                {:else if sec.kind === 'levels' && sec.groups?.length}
                    <section>
                        <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Target class="h-3.5 w-3.5" /> {sec.heading}
                        </div>
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            {#each sec.groups as g}
                                <div class="rounded-lg border border-border/70 p-3">
                                    <div class="text-[10px] font-semibold uppercase tracking-wider {g.tone === 'down' ? 'text-down' : g.tone === 'warn' ? 'text-warn' : 'text-up'}">{g.label}</div>
                                    <div class="mt-1.5 flex flex-wrap gap-1.5">
                                        {#each g.values as v}<Badge variant={g.tone}>{v}</Badge>{/each}
                                    </div>
                                </div>
                            {/each}
                        </div>
                    </section>

                {:else if sec.kind === 'scenarios' && sec.scenarios?.length}
                    <section>
                        <div class="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                            <Crosshair class="h-3.5 w-3.5" /> {sec.heading}
                        </div>
                        <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
                            {#each sec.scenarios as sc}
                                <div class="rounded-lg border p-3 {sc.dir === 'up' ? 'border-up/40 bg-up/[0.05]' : sc.dir === 'down' ? 'border-down/40 bg-down/[0.05]' : 'border-border'}">
                                    <div class="flex items-center gap-1.5 text-xs font-bold {sc.dir === 'up' ? 'text-up' : sc.dir === 'down' ? 'text-down' : 'text-foreground'}">
                                        {#if sc.dir === 'up'}<ArrowUpRight class="h-3.5 w-3.5" />{:else if sc.dir === 'down'}<ArrowDownRight class="h-3.5 w-3.5" />{/if}
                                        {sc.head}
                                    </div>
                                    <p class="brief-rt mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{@html inline(sc.text)}</p>
                                </div>
                            {/each}
                        </div>
                    </section>

                {:else if paragraphs(sec.prose).length}
                    {@const meta = kindMeta[sec.kind] || kindMeta.generic}
                    {@const Icon = meta.icon}
                    <section class="rounded-lg border p-3 {sec.kind === 'caveat' ? 'border-warn/30 bg-warn/[0.04]' : sec.kind === 'flip' ? 'border-up/30 bg-up/[0.04]' : 'border-border/70'}">
                        <div class="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] {sec.kind === 'caveat' ? 'text-warn' : sec.kind === 'flip' ? 'text-up' : 'text-muted-foreground'}">
                            <Icon class="h-3.5 w-3.5" /> {sec.heading}
                        </div>
                        {#each paragraphs(sec.prose) as p}
                            <p class="brief-rt text-[12px] leading-relaxed text-muted-foreground">{@html inline(p)}</p>
                        {/each}
                    </section>
                {/if}
            {/each}

            {#if parsed.disclaimer}
                <p class="border-t border-border/50 pt-3 text-[10px] leading-relaxed text-muted-foreground/70">{parsed.disclaimer}</p>
            {/if}
        </div>
    </div>
{/if}

<style>
    /* inline-markdown emphasis inside the infographic text fragments */
    .brief-rt :global(strong) { font-weight: 700; color: var(--rt-strong, inherit); }
    .brief-rt :global(code) { font-family: ui-monospace, monospace; font-size: 0.9em; }
    .brief-rt :global(a) { text-decoration: underline; }
</style>
