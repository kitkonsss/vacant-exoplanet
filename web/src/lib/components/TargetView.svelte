<script>
    import Card from './ui/Card.svelte';
    import Badge from './ui/Badge.svelte';
    import { buildTarget, touchProb } from '$lib/target.js';
    import { fetchLivePrice } from '$lib/data.js';
    import { fmtNumber, fmtBangkok } from '$lib/utils.js';
    import { Target, TrendingUp, TrendingDown, Crosshair, Gauge, ShieldAlert } from 'lucide-svelte';

    let { strategy = null, assetId = 'gc', loading = false } = $props();

    // Live futures price (same-origin /api/price proxy), polled every 20s and used
    // to re-center the bands. Falls back to the scrape-time price if unavailable.
    let livePrice = $state(null);
    let liveAt = $state(null);
    $effect(() => {
        const sym = assetId === 'nq' ? 'NQ=F' : 'GC=F';
        let stopped = false;
        async function tick() {
            const d = await fetchLivePrice(sym);
            if (stopped) return;
            if (d && Number.isFinite(d.price)) {
                livePrice = d.price;
                liveAt = d.time ? new Date(d.time * 1000) : new Date();
            }
        }
        livePrice = null;
        liveAt = null;
        tick();
        const id = setInterval(tick, 20000);
        return () => { stopped = true; clearInterval(id); };
    });

    const t = $derived(strategy ? buildTarget(strategy, assetId, livePrice) : null);

    function liveClock(d) {
        if (!d) return '';
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    const up = $derived(t?.targets.find((x) => x.side === 'above') || null);
    const down = $derived(t?.targets.find((x) => x.side === 'below') || null);

    function fmtMove(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        return fmtNumber(n, Math.abs(n) < 10 ? 1 : 0);
    }
    // value in the asset's native unit ("$63" for gold, "485 จุด" for NQ)
    function uv(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        const s = fmtMove(n);
        return t?.unit === '$' ? `$${s}` : `${s} ${t?.unit || ''}`.trim();
    }
    function usd(points) {
        if (points == null || !t?.pointValueUsd) return null;
        return `$${fmtNumber(points * t.pointValueUsd, 0)}/สัญญา`;
    }
    function pct(p) {
        return p == null ? '—' : `${Math.round(p * 100)}%`;
    }
    function probTone(p) {
        return p == null ? 'muted' : p >= 0.5 ? 'up' : p >= 0.25 ? 'warn' : 'down';
    }
    function regimeLabel(r) {
        return r === 'trending'
            ? 'เทรนด์ → ปล่อยวิ่ง + trail'
            : r === 'range' || r === 'ranging'
              ? 'ออกข้าง → เก็บสั้น'
              : 'กลางๆ';
    }
    function dirLabel(d) {
        return d === 'long' ? 'เอนขึ้น (Long)' : d === 'short' ? 'เอนลง (Short)' : 'ยังไม่ชัด — ดู 2 ทาง';
    }
    function wallProb(wall) {
        if (!wall || !t) return null;
        return touchProb(Math.abs(wall.price - t.price) / t.em);
    }
</script>

{#if loading}
    <div class="flex h-64 items-center justify-center text-muted-foreground">
        <div class="flex items-center gap-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"></div>
            <span class="text-sm">กำลังคำนวณเป้าวันนี้…</span>
        </div>
    </div>
{:else if !t}
    <Card class="p-8 text-center">
        <div class="font-semibold text-foreground">ยังคำนวณเป้าไม่ได้</div>
        <p class="mt-1 text-sm text-muted-foreground">
            ต้องมี daily_strategy.json + expected_range (ค่า expected_move จาก IV).
            รัน pipeline ให้อัปเดตก่อน
        </p>
    </Card>
{:else}
    <div class="flex flex-col gap-4">
        <!-- ============ CARD A · เป้าวันนี้ (the big answer) ============ -->
        <Card class="border-warn/30 bg-warn/5 p-5">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">
                    <Target class="h-4 w-4" /> เป้าวันนี้
                </div>
                <div class="flex flex-wrap items-center gap-1.5">
                    <span class="font-mono text-base font-semibold text-foreground">{fmtNumber(t.price, 0)}</span>
                    {#if t.isLive}
                        <span class="inline-flex items-center gap-1 text-[10px] font-semibold text-up" title="ราคา realtime">
                            <span class="h-1.5 w-1.5 rounded-full bg-up"></span>live{#if liveAt}&nbsp;{liveClock(liveAt)}{/if}
                        </span>
                    {:else}
                        <span class="text-[10px] text-muted-foreground" title="ราคาจาก scrape ล่าสุด — live ดึงไม่ได้">· scrape</span>
                    {/if}
                    <Badge variant={t.direction === 'long' ? 'up' : t.direction === 'short' ? 'down' : 'muted'}>{dirLabel(t.direction)}</Badge>
                    <Badge variant={t.regime === 'trending' ? 'warn' : t.regime === 'range' ? 'up' : 'muted'}>{regimeLabel(t.regime)}</Badge>
                </div>
            </div>

            <!-- headline: expected move -->
            <div class="mt-4 flex flex-wrap items-end gap-x-4 gap-y-1">
                <div>
                    <div class="text-[10px] uppercase tracking-wider text-muted-foreground">วันนี้คาดวิ่ง (±1SD จาก IV)</div>
                    <div class="font-mono text-3xl font-bold text-foreground">±{uv(t.em)}</div>
                </div>
                <div class="pb-1 text-[11px] leading-relaxed text-muted-foreground">
                    {#if usd(t.em)}<div>= {usd(t.em)}{#if t.microPointValueUsd} · ไมโคร ${fmtNumber(t.em * t.microPointValueUsd, 0)}{/if}</div>{/if}
                    <div>กรอบวัน {fmtNumber(t.dayLow, 0)} – {fmtNumber(t.dayHigh, 0)}{#if t.atmIvPct} · IV {fmtNumber(t.atmIvPct, 1)}%{/if}{#if t.atr} · ATR {fmtMove(t.atr)}{/if}</div>
                </div>
            </div>

            <!-- suggested TP boxes -->
            <div class="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {#if up}
                    <div class="rounded-md border border-up/30 bg-up/5 p-3">
                        <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-up">
                            <TrendingUp class="h-3.5 w-3.5" /> เป้า Long
                        </div>
                        <div class="mt-1 font-mono text-lg font-semibold text-foreground">
                            +{uv(up.dist)} → {fmtNumber(up.tpPrice, 0)}
                        </div>
                        <div class="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <Badge variant={probTone(up.prob)}>โอกาสแตะ {pct(up.prob)}</Badge>
                            {#if usd(up.dist)}<span>{usd(up.dist)}</span>{/if}
                        </div>
                        {#if up.cappedBy}<div class="mt-1 text-[10px] text-warn">⛓ ตัดที่กำแพง {up.cappedBy.label} @ {fmtNumber(up.cappedBy.price, 0)}</div>{/if}
                    </div>
                {/if}
                {#if down}
                    <div class="rounded-md border border-down/30 bg-down/5 p-3">
                        <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-down">
                            <TrendingDown class="h-3.5 w-3.5" /> เป้า Short
                        </div>
                        <div class="mt-1 font-mono text-lg font-semibold text-foreground">
                            −{uv(down.dist)} → {fmtNumber(down.tpPrice, 0)}
                        </div>
                        <div class="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <Badge variant={probTone(down.prob)}>โอกาสแตะ {pct(down.prob)}</Badge>
                            {#if usd(down.dist)}<span>{usd(down.dist)}</span>{/if}
                        </div>
                        {#if down.cappedBy}<div class="mt-1 text-[10px] text-warn">⛓ ตัดที่กำแพง {down.cappedBy.label} @ {fmtNumber(down.cappedBy.price, 0)}</div>{/if}
                    </div>
                {/if}
            </div>

            <p class="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                เป้า = <b>{fmtNumber(t.k, 2)}× expected move</b> (ปรับตาม regime) แล้วตัดไม่ให้เลยกำแพงแรก ·
                regime <b>{regimeLabel(t.regime)}</b>
            </p>
        </Card>

        <!-- ============ CARD B · ราคามีโอกาสไปถึงแค่ไหน (ladder) ============ -->
        <Card class="p-5">
            <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <Crosshair class="h-3.5 w-3.5" /> ราคามีโอกาสไปถึงแค่ไหน (ภายในวันนี้)
            </div>

            <div class="mt-3 flex flex-col">
                {#each t.ladder.filter((r) => r.side === 'above') as r}
                    <div class="flex items-center gap-2 py-1">
                        <span class="w-16 shrink-0 font-mono text-sm font-semibold tabular-nums text-down">{fmtNumber(r.price, 0)}</span>
                        <span class="w-10 shrink-0 text-[10px] text-muted-foreground">+{r.k}σ</span>
                        <div class="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div class="h-full rounded-full bg-down/70" style="width:{Math.round(r.prob * 100)}%"></div>
                        </div>
                        <span class="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums {r.prob >= 0.5 ? 'text-up' : r.prob >= 0.25 ? 'text-warn' : 'text-down'}">{pct(r.prob)}</span>
                    </div>
                {/each}

                <div class="my-1.5 flex items-center gap-2">
                    <div class="h-px flex-1 bg-primary/40"></div>
                    <span class="rounded bg-primary/15 px-2 py-0.5 font-mono text-sm font-bold text-primary">{fmtNumber(t.price, 0)}</span>
                    <span class="text-[10px] text-muted-foreground">ราคาปัจจุบัน</span>
                    <div class="h-px flex-1 bg-primary/40"></div>
                </div>

                {#each t.ladder.filter((r) => r.side === 'below') as r}
                    <div class="flex items-center gap-2 py-1">
                        <span class="w-16 shrink-0 font-mono text-sm font-semibold tabular-nums text-up">{fmtNumber(r.price, 0)}</span>
                        <span class="w-10 shrink-0 text-[10px] text-muted-foreground">−{r.k}σ</span>
                        <div class="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div class="h-full rounded-full bg-up/70" style="width:{Math.round(r.prob * 100)}%"></div>
                        </div>
                        <span class="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums {r.prob >= 0.5 ? 'text-up' : r.prob >= 0.25 ? 'text-warn' : 'text-down'}">{pct(r.prob)}</span>
                    </div>
                {/each}
            </div>

            <!-- nearest walls = realistic caps -->
            {#if t.wallUp || t.wallDown}
                <div class="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div class="rounded-md border border-border/60 p-2">
                        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">🧱 กำแพงบน (ต้าน)</div>
                        {#if t.wallUp}
                            <div class="font-mono text-down">{fmtNumber(t.wallUp.price, 0)} <span class="text-muted-foreground text-[10px]">{t.wallUp.label}</span></div>
                            <div class="text-[10px] text-muted-foreground">โอกาสไปถึง {pct(wallProb(t.wallUp))}</div>
                        {:else}<div class="text-muted-foreground">—</div>{/if}
                    </div>
                    <div class="rounded-md border border-border/60 p-2">
                        <div class="text-[10px] uppercase tracking-wider text-muted-foreground">🧱 กำแพงล่าง (รับ)</div>
                        {#if t.wallDown}
                            <div class="font-mono text-up">{fmtNumber(t.wallDown.price, 0)} <span class="text-muted-foreground text-[10px]">{t.wallDown.label}</span></div>
                            <div class="text-[10px] text-muted-foreground">โอกาสไปถึง {pct(wallProb(t.wallDown))}</div>
                        {:else}<div class="text-muted-foreground">—</div>{/if}
                    </div>
                </div>
            {/if}
            <p class="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                % = โอกาสที่ราคาจะ "แตะ" ระดับนั้นอย่างน้อย 1 ครั้งก่อนปิดตลาด (จาก normal distribution) · 🔴 เหนือ=ต้าน 🟢 ใต้=รับ
            </p>
        </Card>

        <!-- ============ CARD C · สรุป + เทียบ TP เดิม ============ -->
        <Card class="p-4">
            <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <Gauge class="h-3.5 w-3.5" /> สรุปสั้นๆ
            </div>
            <p class="mt-2 text-sm leading-relaxed text-foreground">
                วันนี้ตลาด <b>{regimeLabel(t.regime)}</b>, bias <b>{dirLabel(t.direction)}</b> ·
                คาดวิ่ง <b>±{uv(t.em)}</b> ·
                {#if up && down}
                    เป้าเหมาะ ขึ้น <b>+{uv(up.dist)}</b> ({pct(up.prob)}) / ลง <b>−{uv(down.dist)}</b> ({pct(down.prob)})
                {:else if up}
                    เป้าเหมาะ <b>+{uv(up.dist)}</b> → {fmtNumber(up.tpPrice, 0)} (โอกาสแตะ {pct(up.prob)})
                {:else if down}
                    เป้าเหมาะ <b>−{uv(down.dist)}</b> → {fmtNumber(down.tpPrice, 0)} (โอกาสแตะ {pct(down.prob)})
                {/if}
            </p>

            {#if t.fixedRef}
                <div class="mt-3 rounded-md border p-3 {t.fixedRef.prob < 0.25 ? 'border-down/40 bg-down/5' : t.fixedRef.prob < 0.4 ? 'border-warn/40 bg-warn/5' : 'border-up/40 bg-up/5'}">
                    <div class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider {t.fixedRef.prob < 0.25 ? 'text-down' : t.fixedRef.prob < 0.4 ? 'text-warn' : 'text-up'}">
                        <ShieldAlert class="h-3.5 w-3.5" /> ถ้าตั้ง TP {uv(t.fixedRef.dist)} แบบเดิม
                    </div>
                    <div class="mt-1 text-sm text-foreground">
                        = <b>{fmtNumber(t.fixedRef.k, 1)}σ</b> วันนี้ → โอกาสแตะแค่ <b class="{t.fixedRef.prob < 0.25 ? 'text-down' : t.fixedRef.prob < 0.4 ? 'text-warn' : 'text-up'}">{pct(t.fixedRef.prob)}</b>
                        {#if t.fixedRef.prob < 0.3}<span class="text-[11px] text-muted-foreground">— ไกลเกินไปวันนี้ ราคาเด้งกลับก่อน ลองลดเป้าตามด้านบน</span>{/if}
                    </div>
                </div>
            {/if}

            <p class="mt-3 text-[10px] leading-relaxed text-muted-foreground">
                คำนวณจาก expected move (IV) × regime + กำแพง gamma/OI/confluence ที่ระบบมีอยู่ · ความน่าจะเป็นอิง normal distribution (ตลาดจริงมี fat tails — วัน event วิ่งเกินได้) · เพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน
                {#if strategy?.generated_at}· ข้อมูล {fmtBangkok(strategy.generated_at)}{/if}
            </p>
        </Card>
    </div>
{/if}
