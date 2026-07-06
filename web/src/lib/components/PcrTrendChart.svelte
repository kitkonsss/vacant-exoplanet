<script>
    import { onMount } from 'svelte';

    let {
        rows = []
    } = $props();

    const LATEST_WINDOW = 24;
    const slotLabels = {
        morning: 'Morning',
        afternoon: 'Afternoon',
        evening: 'Evening',
        night: 'Night'
    };

    let chartHost;
    let chart = null;
    let oiSeries = null;
    let volumeSeries = null;
    let referenceLine = null;
    let resizeObserver = null;
    let chartModule = null;
    let lastDataKey = '';
    let tooltip = $state(null);
    let viewMode = $state('latest');

    const chartData = $derived.by(() => normalizeRows(rows));
    const valueRange = $derived.by(() => {
        const values = chartData
            .flatMap((point) => [point.oi, point.volume])
            .filter(Number.isFinite);
        return {
            min: Math.min(0.5, ...values),
            max: Math.max(2.5, ...values)
        };
    });
    const firstStamp = $derived(chartData[0] ? stamp(chartData[0].row) : '-');
    const lastStamp = $derived(chartData[chartData.length - 1] ? stamp(chartData[chartData.length - 1].row) : '-');

    function cssColor(name, fallback) {
        if (typeof window === 'undefined') return fallback;
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value ? `hsl(${value})` : fallback;
    }

    function toTimestamp(row, index, previousTime) {
        const raw = Date.parse(row.captured_at_utc || row.source_generated_at || '');
        const fallbackDate = Date.parse(`${row.date_bangkok || '1970-01-01'}T00:00:00Z`);
        const slotOffset = Number(row.slot_order || 0) * 3600;
        const ms = Number.isFinite(raw)
            ? raw
            : (Number.isFinite(fallbackDate) ? fallbackDate + slotOffset * 1000 : Date.UTC(1970, 0, 1) + index * 1000);
        let seconds = Math.floor(ms / 1000);
        if (seconds <= previousTime) seconds = previousTime + 1;
        return seconds;
    }

    function normalizeRows(inputRows) {
        const ordered = [...(inputRows || [])].sort((a, b) => {
            const ad = `${a.date_bangkok || ''}-${String(a.slot_order || 0).padStart(2, '0')}-${a.captured_at_utc || ''}`;
            const bd = `${b.date_bangkok || ''}-${String(b.slot_order || 0).padStart(2, '0')}-${b.captured_at_utc || ''}`;
            return ad.localeCompare(bd);
        });
        let previousTime = 0;
        return ordered
            .map((row, index) => {
                const oi = Number(row.totals?.oi_put_call_ratio);
                const volume = Number(row.totals?.volume_put_call_ratio);
                const time = toTimestamp(row, index, previousTime);
                previousTime = time;
                return { time, row, oi, volume };
            })
            .filter((point) => Number.isFinite(point.oi) || Number.isFinite(point.volume));
    }

    function lineData(points, field) {
        return points.map((point) => (
            Number.isFinite(point[field])
                ? { time: point.time, value: point[field] }
                : { time: point.time }
        ));
    }

    function fmt(value, digits = 2) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toFixed(digits) : '-';
    }

    function fmtInteger(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toLocaleString() : '-';
    }

    function fmtScore(value) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}` : '-';
    }

    function stamp(row) {
        if (!row) return '-';
        return `${row.date_bangkok || '-'} ${slotLabels[row.slot] || row.slot || ''}`;
    }

    function capturedTime(row) {
        const raw = row?.captured_at_bangkok || row?.captured_at_utc;
        if (!raw) return '-';
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    }

    function biasLabel(row) {
        return String(row?.bias?.label || 'neutral').replaceAll('_', ' ');
    }

    function currentPointByTime(points, time) {
        return points.find((point) => Number(point.time) === Number(time)) || null;
    }

    function showLatest() {
        if (!chart || !chartData.length) return;
        viewMode = 'latest';
        const count = chartData.length;
        if (count <= LATEST_WINDOW) {
            chart.timeScale().fitContent();
            return;
        }
        chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, count - LATEST_WINDOW),
            to: count - 1
        });
    }

    function showAll() {
        if (!chart || !chartData.length) return;
        viewMode = 'all';
        chart.timeScale().fitContent();
    }

    function syncChart(points = chartData) {
        if (!chart || !oiSeries || !volumeSeries) return;

        oiSeries.setData(lineData(points, 'oi'));
        volumeSeries.setData(lineData(points, 'volume'));

        const nextKey = points.map((point) => point.time).join('|');
        if (nextKey !== lastDataKey) {
            lastDataKey = nextKey;
            tooltip = null;
            showLatest();
        }
    }

    function initChart() {
        if (!chartHost || !chartModule || chart) return;
        const { ColorType, CrosshairMode, LineSeries, LineStyle, createChart } = chartModule;
        const background = cssColor('--background', '#0a0a0a');
        const surface = cssColor('--surface', '#121212');
        const text = cssColor('--muted-foreground', '#999999');
        const border = cssColor('--border', '#242424');
        const put = cssColor('--put', '#fb923c');
        const call = cssColor('--call', '#06b6d4');

        chart = createChart(chartHost, {
            width: Math.max(chartHost.clientWidth, 320),
            height: Math.max(chartHost.clientHeight, 224),
            layout: {
                background: { type: ColorType.Solid, color: background },
                textColor: text,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
            },
            grid: {
                vertLines: { color: 'transparent' },
                horzLines: { color: border }
            },
            crosshair: {
                mode: CrosshairMode.Magnet,
                vertLine: { color: text, labelBackgroundColor: surface },
                horzLine: { color: text, labelBackgroundColor: surface }
            },
            rightPriceScale: {
                borderColor: border,
                scaleMargins: { top: 0.16, bottom: 0.14 }
            },
            timeScale: {
                borderColor: border,
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 2,
                barSpacing: 16,
                minBarSpacing: 4,
                lockVisibleTimeRangeOnResize: true
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: false
            },
            handleScale: {
                axisPressedMouseMove: true,
                mouseWheel: true,
                pinch: true
            },
            localization: {
                priceFormatter: (price) => fmt(price)
            }
        });

        oiSeries = chart.addSeries(LineSeries, {
            color: put,
            lineWidth: 2,
            pointMarkersVisible: true,
            pointMarkersRadius: 3,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'OI P/C'
        });
        volumeSeries = chart.addSeries(LineSeries, {
            color: call,
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            pointMarkersVisible: true,
            pointMarkersRadius: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            title: 'Vol P/C'
        });
        referenceLine = oiSeries.createPriceLine({
            price: 1,
            color: border,
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: '1.00'
        });

        chart.subscribeCrosshairMove((param) => {
            if (!param?.point || param.time == null || !chartHost) {
                tooltip = null;
                return;
            }
            const point = currentPointByTime(chartData, param.time);
            if (!point) {
                tooltip = null;
                return;
            }
            const width = chartHost.clientWidth || 320;
            const x = param.point.x > width - 280 ? param.point.x - 268 : param.point.x + 12;
            const y = param.point.y > 132 ? param.point.y - 124 : param.point.y + 12;
            tooltip = {
                x: Math.max(8, Math.min(width - 260, x)),
                y: Math.max(8, y),
                point
            };
        });

        resizeObserver = new ResizeObserver(([entry]) => {
            if (!chart || !entry) return;
            chart.applyOptions({
                width: Math.max(Math.floor(entry.contentRect.width), 320),
                height: Math.max(Math.floor(entry.contentRect.height), 224)
            });
        });
        resizeObserver.observe(chartHost);
        syncChart(chartData);
    }

    onMount(() => {
        let cancelled = false;
        import('lightweight-charts').then((module) => {
            if (cancelled) return;
            chartModule = module;
            initChart();
        });
        return () => {
            cancelled = true;
            resizeObserver?.disconnect();
            resizeObserver = null;
            if (referenceLine && oiSeries) oiSeries.removePriceLine(referenceLine);
            referenceLine = null;
            chart?.remove();
            chart = null;
            oiSeries = null;
            volumeSeries = null;
        };
    });

    $effect(() => {
        syncChart(chartData);
    });
</script>

<div class="relative">
    <div class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
        <button
            type="button"
            onclick={showAll}
            class={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${viewMode === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
            All
        </button>
        <button
            type="button"
            onclick={showLatest}
            class={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${viewMode === 'latest' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
            Latest 24
        </button>
    </div>

    <div
        bind:this={chartHost}
        class="h-64 w-full overflow-hidden rounded-md border border-border bg-background"
        role="img"
        aria-label="Interactive put call ratio trend"
        onpointerleave={() => (tooltip = null)}
    >
        {#if !chartData.length}
            <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
                No ratio points for this contract yet.
            </div>
        {/if}
    </div>

    {#if tooltip}
        {@const point = tooltip.point}
        {@const row = point.row}
        <div
            class="pointer-events-none absolute z-20 w-64 rounded-md border border-border bg-surface px-3 py-2 text-[11px] shadow-xl"
            style={`left:${tooltip.x}px; top:${tooltip.y}px;`}
        >
            <div class="flex items-center justify-between gap-2">
                <div class="font-mono font-semibold text-foreground">{stamp(row)}</div>
                <div class="font-mono text-muted-foreground">{capturedTime(row)}</div>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-muted-foreground">
                <span>{row.contract || row.contract_key}</span>
                <span class="font-mono text-foreground">{fmt(row.future_price, 1)}</span>
            </div>
            <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono tabular-nums">
                <span class="text-muted-foreground">OI P/C</span>
                <span class="text-right text-put">{fmt(point.oi)}</span>
                <span class="text-muted-foreground">Vol P/C</span>
                <span class="text-right text-call">{fmt(point.volume)}</span>
                <span class="text-muted-foreground">Score</span>
                <span class="text-right text-foreground">{fmtScore(row.bias?.score)}</span>
                <span class="text-muted-foreground">Bias</span>
                <span class="text-right text-foreground capitalize">{biasLabel(row)}</span>
                <span class="text-muted-foreground">Call Vol</span>
                <span class="text-right text-call">{fmtInteger(row.totals?.call_volume)}</span>
                <span class="text-muted-foreground">Put Vol</span>
                <span class="text-right text-put">{fmtInteger(row.totals?.put_volume)}</span>
            </div>
        </div>
    {/if}
</div>

<div class="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
    <span>{firstStamp}</span>
    <span>{chartData.length} points | range {fmt(valueRange.min)}-{fmt(valueRange.max)}</span>
    <span>{lastStamp}</span>
</div>
