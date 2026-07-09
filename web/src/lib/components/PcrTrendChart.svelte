<script>
    import { onMount } from 'svelte';

    let {
        rows = [],
        livePrice = null,
        liveAt = null
    } = $props();

    const LATEST_WINDOW = 24;
    const PRICE_PANEL_HEIGHT = 164;
    const PRICE_PAD_TOP = 18;
    const PRICE_PAD_BOTTOM = 24;
    const VISIBLE_RIGHT_OFFSET = 2;
    const MIN_LOGICAL_SPAN = 2;
    const TOOLTIP_WIDTH = 304;
    const TOOLTIP_MIN_WIDTH = 180;
    const slotLabels = {
        morning: 'Morning',
        afternoon: 'Afternoon',
        evening: 'Evening',
        night: 'Night'
    };
    const wallTypes = [
        { key: 'dominant_call', label: 'Call Wall', color: 'hsl(var(--put))', short: 'Call' },
        { key: 'dominant_put', label: 'Put Wall', color: 'hsl(var(--call))', short: 'Put' },
        { key: 'largest_combined_position', label: 'Largest Wall', color: 'hsl(var(--warn))', short: 'Largest' }
    ];
    const sdBandDefs = [
        { key: 'plus2', label: '+2SD', color: 'hsl(var(--primary))', opacity: 0.34 },
        { key: 'plus1', label: '+1SD', color: 'hsl(var(--primary))', opacity: 0.52 },
        { key: 'minus1', label: '-1SD', color: 'hsl(var(--primary))', opacity: 0.52 },
        { key: 'minus2', label: '-2SD', color: 'hsl(var(--primary))', opacity: 0.34 }
    ];

    let rootHost;
    let chartHost;
    let priceHost;
    let chart = null;
    let oiSeries = null;
    let volumeSeries = null;
    let referenceLine = null;
    let resizeObserver = null;
    let chartModule = null;
    let visibleRangeHandler = null;
    let lastDataKey = '';
    let priceDrag = null;
    let tooltip = $state(null);
    let viewMode = $state('latest');
    let visibleRange = $state(null);
    let activeIndex = $state(null);
    let overlaySize = $state({ width: 0, height: PRICE_PANEL_HEIGHT });

    const livePriceValue = $derived.by(() => {
        const n = Number(livePrice);
        return Number.isFinite(n) && n > 0 ? n : null;
    });
    const chartData = $derived.by(() => normalizeRows(rows, livePriceValue));
    const visiblePoints = $derived.by(() => pointsInRange(chartData, visibleRange));
    const valueRange = $derived.by(() => {
        const values = chartData
            .flatMap((point) => [point.oi, point.volume])
            .filter(Number.isFinite);
        return {
            min: Math.min(0.5, ...values),
            max: Math.max(2.5, ...values)
        };
    });
    const priceRange = $derived.by(() => buildPriceRange(visiblePoints));
    const priceOverlay = $derived.by(() => buildPriceOverlay(chartData, visibleRange, overlaySize, priceRange));
    const hasAnySd = $derived(chartData.some((point) => Boolean(sdBands(point.row))));
    const hasLivePrice = $derived(chartData.some((point) => point.isLivePrice));
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

    function normalizeRows(inputRows, liveValue = null) {
        const ordered = [...(inputRows || [])].sort((a, b) => {
            const ad = `${a.date_bangkok || ''}-${String(a.slot_order || 0).padStart(2, '0')}-${a.captured_at_utc || ''}`;
            const bd = `${b.date_bangkok || ''}-${String(b.slot_order || 0).padStart(2, '0')}-${b.captured_at_utc || ''}`;
            return ad.localeCompare(bd);
        });
        let previousTime = 0;
        const points = ordered
            .map((row, sortIndex) => {
                const oi = Number(row.totals?.oi_put_call_ratio);
                const volume = isFlowReady(row) ? Number(row.totals?.volume_put_call_ratio) : NaN;
                const time = toTimestamp(row, sortIndex, previousTime);
                previousTime = time;
                return { time, row, oi, volume };
            })
            .filter((point) => Number.isFinite(point.oi) || Number.isFinite(point.volume))
            .map((point, index) => ({ ...point, index }));
        if (liveValue != null && points.length) {
            const lastIndex = points.length - 1;
            points[lastIndex] = {
                ...points[lastIndex],
                livePrice: liveValue,
                isLivePrice: true
            };
        }
        return points;
    }

    function lineData(points, field) {
        return points.map((point) => (
            Number.isFinite(point[field])
                ? { time: point.time, value: point[field] }
                : { time: point.time }
        ));
    }

    function fallbackRange(points = chartData) {
        const count = points.length;
        if (!count) return { from: 0, to: 1 };
        return latestLogicalRange(points);
    }

    function currentRange() {
        return visibleRange || fallbackRange();
    }

    function fullLogicalRange(points = chartData) {
        const count = points.length;
        if (!count) return { from: 0, to: 1 };
        return { from: 0, to: Math.max(count - 1 + VISIBLE_RIGHT_OFFSET, 1) };
    }

    function latestLogicalRange(points = chartData) {
        const count = points.length;
        if (!count) return { from: 0, to: 1 };
        const to = Math.max(count - 1 + VISIBLE_RIGHT_OFFSET, 1);
        const visibleBars = Math.min(count, LATEST_WINDOW);
        const span = Math.min(to, Math.max(visibleBars - 1 + VISIBLE_RIGHT_OFFSET, 1));
        return { from: Math.max(0, to - span), to };
    }

    function sanitizeLogicalRange(nextRange, points = chartData) {
        const count = points.length;
        if (!count) return { from: 0, to: 1 };
        const maxTo = Math.max(count - 1 + VISIBLE_RIGHT_OFFSET, 1);
        const maxSpan = Math.max(maxTo, 1);
        const minSpan = Math.min(MIN_LOGICAL_SPAN, maxSpan);
        let from = Number(nextRange?.from);
        let to = Number(nextRange?.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
            return fallbackRange(points);
        }

        const span = clamp(to - from, minSpan, maxSpan);
        const maxFrom = Math.max(maxTo - span, 0);
        from = clamp(from, 0, maxFrom);
        to = from + span;
        if (to > maxTo) {
            to = maxTo;
            from = Math.max(0, to - span);
        }
        return { from, to };
    }

    function rangesClose(a, b) {
        return Math.abs((a?.from ?? 0) - (b?.from ?? 0)) < 0.01
            && Math.abs((a?.to ?? 0) - (b?.to ?? 0)) < 0.01;
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function logicalX(index, range = currentRange(), width = overlaySize.width) {
        const w = Math.max(width || 0, 1);
        const span = Math.max((range?.to ?? 1) - (range?.from ?? 0), 1);
        if (chartData.length <= 1) return w / 2;
        return ((index - (range?.from ?? 0)) / span) * w;
    }

    function indexFromX(x, range = currentRange(), width = overlaySize.width) {
        if (!chartData.length) return null;
        if (chartData.length === 1) return 0;
        const span = Math.max((range?.to ?? 1) - (range?.from ?? 0), 1);
        const logical = (range?.from ?? 0) + (clamp(x, 0, width) / Math.max(width, 1)) * span;
        return clamp(Math.round(logical), 0, chartData.length - 1);
    }

    function pointsInRange(points, range) {
        if (!points.length) return [];
        const activeRange = range || fallbackRange(points);
        const from = Math.floor((activeRange?.from ?? 0) - 1);
        const to = Math.ceil((activeRange?.to ?? points.length - 1) + 1);
        return points.filter((point) => point.index >= from && point.index <= to);
    }

    function numeric(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function pointPrice(point) {
        return numeric(point?.livePrice) ?? numeric(point?.row?.future_price);
    }

    function wallEntries(row) {
        const walls = row?.walls || {};
        return wallTypes
            .map((meta) => {
                const wall = walls[meta.key];
                const strike = numeric(wall?.strike);
                if (strike == null) return null;
                return { ...meta, ...wall, strike };
            })
            .filter(Boolean);
    }

    function sdBands(row) {
        const er = row?.expected_range;
        if (!er) return null;
        return er.bands_to_expiry || er.bands_1d || null;
    }

    function sdBandRows(row) {
        const bands = sdBands(row);
        if (!bands) return [];
        return sdBandDefs
            .map((meta) => {
                const value = numeric(bands[meta.key]);
                return value == null ? null : { ...meta, value };
            })
            .filter(Boolean);
    }

    function priceValues(point) {
        const row = point?.row;
        return [
            pointPrice(point),
            ...wallEntries(row).map((wall) => wall.strike),
            ...sdBandRows(row).map((band) => band.value)
        ].filter(Number.isFinite);
    }

    function buildPriceRange(points) {
        const values = points.flatMap(priceValues).filter(Number.isFinite);
        if (!values.length) return { min: 0, max: 1 };
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = Math.max(max - min, Math.abs(max) * 0.006, 1);
        return {
            min: min - span * 0.14,
            max: max + span * 0.14
        };
    }

    function priceY(value, range = priceRange, height = overlaySize.height) {
        const n = Number(value);
        const h = Math.max(height || PRICE_PANEL_HEIGHT, 1);
        if (!Number.isFinite(n) || range.max <= range.min) return h / 2;
        const plotHeight = Math.max(h - PRICE_PAD_TOP - PRICE_PAD_BOTTOM, 1);
        return PRICE_PAD_TOP + ((range.max - n) / (range.max - range.min)) * plotHeight;
    }

    function pathFrom(points, valueFn, range, size, logicalRange) {
        return points
            .map((point) => {
                const value = valueFn(point);
                const x = logicalX(point.index, logicalRange, size.width);
                const y = priceY(value, range, size.height);
                if (!Number.isFinite(value) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
                return { x, y };
            })
            .filter(Boolean)
            .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
            .join(' ');
    }

    function areaPath(points, upperKey, lowerKey, range, size, logicalRange) {
        const bands = points
            .map((point) => {
                const rowBands = sdBands(point.row);
                const upper = numeric(rowBands?.[upperKey]);
                const lower = numeric(rowBands?.[lowerKey]);
                if (upper == null || lower == null) return null;
                return {
                    x: logicalX(point.index, logicalRange, size.width),
                    upperY: priceY(upper, range, size.height),
                    lowerY: priceY(lower, range, size.height)
                };
            })
            .filter(Boolean);
        if (bands.length < 2) return '';
        const upperPath = bands.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.upperY.toFixed(1)}`);
        const lowerPath = [...bands].reverse().map((point) => `L${point.x.toFixed(1)},${point.lowerY.toFixed(1)}`);
        return `${upperPath.join(' ')} ${lowerPath.join(' ')} Z`;
    }

    function stackLabels(labels, height) {
        let lastY = 8;
        return labels
            .sort((a, b) => a.y - b.y)
            .map((label) => {
                const y = clamp(Math.max(label.y, lastY + 14), 12, Math.max(height - 14, 12));
                lastY = y;
                return { ...label, y };
            });
    }

    function buildPriceOverlay(points, range, sizeInput, rangeInput) {
        const size = {
            width: Math.max(Math.floor(sizeInput.width || 0), 1),
            height: Math.max(Math.floor(sizeInput.height || PRICE_PANEL_HEIGHT), 1)
        };
        const activeRange = sanitizeLogicalRange(range || fallbackRange(points), points);
        const visible = pointsInRange(points, activeRange);
        const latest = visible[visible.length - 1] || null;
        const pricePath = pathFrom(visible, (point) => pointPrice(point), rangeInput, size, activeRange);
        const wallMarkers = visible.flatMap((point) => wallEntries(point.row).map((wall) => ({
            point,
            wall,
            x: logicalX(point.index, activeRange, size.width),
            y: priceY(wall.strike, rangeInput, size.height)
        })));
        const priceDots = visible
            .map((point) => ({
                point,
                x: logicalX(point.index, activeRange, size.width),
                y: priceY(pointPrice(point), rangeInput, size.height),
                isLivePrice: point.isLivePrice
            }))
            .filter((dot) => Number.isFinite(dot.y));
        const labels = latest
            ? stackLabels([
                ...wallEntries(latest.row).map((wall) => ({
                    text: `${wall.short} ${fmtLevel(wall.strike)}`,
                    color: wall.color,
                    x: logicalX(latest.index, activeRange, size.width),
                    y: priceY(wall.strike, rangeInput, size.height)
                })),
                ...sdBandRows(latest.row)
                    .filter((band) => band.key === 'plus1' || band.key === 'minus1')
                    .map((band) => ({
                        text: `${band.label} ${fmtLevel(band.value)}`,
                        color: band.color,
                        x: logicalX(latest.index, activeRange, size.width),
                        y: priceY(band.value, rangeInput, size.height)
                    })),
                ...(latest.isLivePrice ? [{
                    text: `Live ${fmtLevel(pointPrice(latest))}`,
                    color: 'hsl(var(--foreground))',
                    x: logicalX(latest.index, activeRange, size.width),
                    y: priceY(pointPrice(latest), rangeInput, size.height)
                }] : [])
            ], size.height)
            : [];
        const activeX = activeIndex == null ? null : logicalX(activeIndex, activeRange, size.width);

        return {
            ...size,
            pricePath,
            sdArea2: areaPath(visible, 'plus2', 'minus2', rangeInput, size, activeRange),
            sdArea1: areaPath(visible, 'plus1', 'minus1', rangeInput, size, activeRange),
            sdPlus1: pathFrom(visible, (point) => numeric(sdBands(point.row)?.plus1), rangeInput, size, activeRange),
            sdMinus1: pathFrom(visible, (point) => numeric(sdBands(point.row)?.minus1), rangeInput, size, activeRange),
            sdPlus2: pathFrom(visible, (point) => numeric(sdBands(point.row)?.plus2), rangeInput, size, activeRange),
            sdMinus2: pathFrom(visible, (point) => numeric(sdBands(point.row)?.minus2), rangeInput, size, activeRange),
            wallMarkers,
            priceDots,
            labels,
            activeX
        };
    }

    function fmt(value, digits = 2) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toFixed(digits) : '-';
    }

    function fmtLevel(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '-';
        const digits = Math.abs(n) >= 1000 ? 1 : 2;
        return n.toLocaleString(undefined, { maximumFractionDigits: digits });
    }

    function fmtInteger(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toLocaleString() : '-';
    }

    function fmtSigned(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(digits)}` : '-';
    }

    function fmtScore(value) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(1)}` : '-';
    }

    function isFlowReady(row) {
        if (!row || row.flow_ready === false) return false;
        const n = Number(row.totals?.intraday_volume);
        return Number.isFinite(n) && n > 0;
    }

    function fmtFlow(row, key, digits = 2) {
        return isFlowReady(row) ? fmt(row.totals?.[key], digits) : '-';
    }

    function stamp(row) {
        if (!row) return '-';
        const raw = row.captured_at_bangkok || row.captured_at_utc || '';
        const match = String(raw).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
        const dateTime = match ? `${match[1]} ${match[2]}` : (row.date_bangkok || '-');
        const slot = slotLabels[row.slot] || row.slot || '';
        return `${dateTime} ${slot}`.trim();
    }

    function capturedTime(row) {
        const raw = row?.captured_at_bangkok || row?.captured_at_utc;
        if (!raw) return '-';
        const date = new Date(raw);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    }

    function liveTimeLabel(value = liveAt) {
        if (!value) return '';
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Bangkok' });
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
        setVisibleRange(latestLogicalRange());
    }

    function showAll() {
        if (!chart || !chartData.length) return;
        viewMode = 'all';
        setVisibleRange(fullLogicalRange());
    }

    function setVisibleRange(nextRange) {
        if (!chart || !chartData.length) return;
        const range = sanitizeLogicalRange(nextRange);
        visibleRange = range;
        chart.timeScale().setVisibleLogicalRange(range);
    }

    function syncChart(points = chartData) {
        if (!chart || !oiSeries || !volumeSeries) return;

        oiSeries.setData(lineData(points, 'oi'));
        volumeSeries.setData(lineData(points, 'volume'));

        const nextKey = points.map((point) => point.time).join('|');
        if (nextKey !== lastDataKey) {
            lastDataKey = nextKey;
            tooltip = null;
            activeIndex = null;
            visibleRange = fallbackRange(points);
            showLatest();
        }
    }

    function tooltipPosition(clientX, clientY) {
        const rootRect = rootHost?.getBoundingClientRect();
        const width = rootRect?.width || chartHost?.clientWidth || 320;
        const tooltipWidth = Math.max(TOOLTIP_MIN_WIDTH, Math.min(TOOLTIP_WIDTH, width - 16));
        const relX = rootRect ? clientX - rootRect.left : clientX;
        const relY = rootRect ? clientY - rootRect.top : clientY;
        const x = relX > width - tooltipWidth - 16 ? relX - tooltipWidth - 12 : relX + 12;
        const y = relY > 170 ? relY - 150 : relY + 12;
        return {
            x: clamp(x, 8, Math.max(width - tooltipWidth - 8, 8)),
            y: Math.max(8, y),
            width: tooltipWidth
        };
    }

    function setTooltip(point, x, y, width = TOOLTIP_WIDTH) {
        if (!point) {
            tooltip = null;
            activeIndex = null;
            return;
        }
        tooltip = { x, y, width, point };
        activeIndex = point.index;
    }

    function updatePriceTooltip(event) {
        if (!priceHost || !chartData.length) return;
        const rect = priceHost.getBoundingClientRect();
        const index = indexFromX(event.clientX - rect.left, currentRange(), rect.width);
        if (index == null) return;
        const point = chartData[index];
        const pos = tooltipPosition(event.clientX, event.clientY);
        setTooltip(point, pos.x, pos.y, pos.width);
    }

    function onPricePointerDown(event) {
        if (!chartData.length) return;
        const range = currentRange();
        priceDrag = { id: event.pointerId, x: event.clientX, from: range.from, to: range.to, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        updatePriceTooltip(event);
    }

    function onPricePointerMove(event) {
        if (priceDrag?.id === event.pointerId && priceHost) {
            const width = Math.max(priceHost.clientWidth, 1);
            const span = Math.max(priceDrag.to - priceDrag.from, 1);
            const dx = event.clientX - priceDrag.x;
            if (Math.abs(dx) > 2) {
                priceDrag.moved = true;
                const shift = -(dx / width) * span;
                setVisibleRange({ from: priceDrag.from + shift, to: priceDrag.to + shift });
            }
        }
        updatePriceTooltip(event);
    }

    function onPricePointerUp(event) {
        if (priceDrag?.id === event.pointerId) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
            priceDrag = null;
        }
    }

    function onPriceWheel(event) {
        if (!chart || !chartData.length || !priceHost) return;
        event.preventDefault();
        const rect = priceHost.getBoundingClientRect();
        const range = currentRange();
        const span = Math.max(range.to - range.from, 2);
        const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
        const anchor = range.from + ratio * span;
        const factor = event.deltaY > 0 ? 1.18 : 0.84;
        const maxSpan = Math.max(chartData.length - 1 + VISIBLE_RIGHT_OFFSET, MIN_LOGICAL_SPAN);
        const nextSpan = clamp(span * factor, MIN_LOGICAL_SPAN, maxSpan);
        setVisibleRange({
            from: anchor - ratio * nextSpan,
            to: anchor + (1 - ratio) * nextSpan
        });
    }

    function hideTooltip() {
        if (priceDrag) return;
        tooltip = null;
        activeIndex = null;
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
            width: Math.max(chartHost.clientWidth, 1),
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
                activeIndex = null;
                return;
            }
            const point = currentPointByTime(chartData, param.time);
            if (!point) {
                tooltip = null;
                activeIndex = null;
                return;
            }
            const rect = chartHost.getBoundingClientRect();
            const pos = tooltipPosition(rect.left + param.point.x, rect.top + param.point.y);
            setTooltip(point, pos.x, pos.y, pos.width);
        });

        visibleRangeHandler = (range) => {
            const next = sanitizeLogicalRange(range || fallbackRange());
            visibleRange = next;
            if (range && !rangesClose(range, next)) {
                chart.timeScale().setVisibleLogicalRange(next);
            }
        };
        chart.timeScale().subscribeVisibleLogicalRangeChange(visibleRangeHandler);

        resizeObserver = new ResizeObserver(() => {
            tooltip = null;
            activeIndex = null;
            if (chart && chartHost) {
                chart.applyOptions({
                    width: Math.max(Math.floor(chartHost.clientWidth), 1),
                    height: Math.max(Math.floor(chartHost.clientHeight), 224)
                });
            }
            if (priceHost) {
                overlaySize = {
                    width: Math.max(Math.floor(priceHost.clientWidth), 1),
                    height: PRICE_PANEL_HEIGHT
                };
            }
        });
        resizeObserver.observe(chartHost);
        if (priceHost) resizeObserver.observe(priceHost);
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
            if (visibleRangeHandler && chart) chart.timeScale().unsubscribeVisibleLogicalRangeChange(visibleRangeHandler);
            visibleRangeHandler = null;
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

<div bind:this={rootHost} class="relative">
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

    <div class="overflow-hidden rounded-md border border-border bg-background">
        <div
            bind:this={chartHost}
            class="h-64 w-full"
            role="img"
            aria-label="Interactive put call ratio trend"
            onpointerleave={hideTooltip}
        >
            {#if !chartData.length}
                <div class="flex h-full items-center justify-center text-sm text-muted-foreground">
                    No ratio points for this contract yet.
                </div>
            {/if}
        </div>

        <div class="border-t border-border/80 bg-surface/35 px-3 py-2">
            <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Wall + SD Context
                </div>
                <div class="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                    <span><span class="mr-1 inline-block h-[2px] w-4 bg-foreground/80 align-middle"></span> Price</span>
                    <span><span class="mr-1 inline-block h-[2px] w-4 bg-put align-middle"></span> Call Wall</span>
                    <span><span class="mr-1 inline-block h-[2px] w-4 bg-call align-middle"></span> Put Wall</span>
                    <span><span class="mr-1 inline-block h-[6px] w-4 rounded-sm bg-primary/25 align-middle"></span> SD</span>
                    {#if hasLivePrice}
                        <span class="font-mono text-foreground">Live {fmtLevel(livePriceValue)}</span>
                    {/if}
                </div>
            </div>

            <div
                bind:this={priceHost}
                class="relative h-[164px] w-full touch-none overflow-hidden rounded border border-border/70 bg-background"
                role="img"
                aria-label="Synchronized wall and standard deviation price context"
                onpointerdown={onPricePointerDown}
                onpointermove={onPricePointerMove}
                onpointerup={onPricePointerUp}
                onpointercancel={onPricePointerUp}
                onpointerleave={hideTooltip}
                onwheel={onPriceWheel}
            >
                <svg class="h-full w-full" viewBox={`0 0 ${priceOverlay.width} ${priceOverlay.height}`} preserveAspectRatio="none" aria-hidden="true">
                    <rect x="0" y="0" width={priceOverlay.width} height={priceOverlay.height} fill="transparent" />
                    <line x1="0" x2={priceOverlay.width} y1={priceY(priceRange.max)} y2={priceY(priceRange.max)} stroke="hsl(var(--border))" stroke-width="1" opacity="0.35" vector-effect="non-scaling-stroke" />
                    <line x1="0" x2={priceOverlay.width} y1={priceY((priceRange.max + priceRange.min) / 2)} y2={priceY((priceRange.max + priceRange.min) / 2)} stroke="hsl(var(--border))" stroke-width="1" opacity="0.45" vector-effect="non-scaling-stroke" />
                    <line x1="0" x2={priceOverlay.width} y1={priceY(priceRange.min)} y2={priceY(priceRange.min)} stroke="hsl(var(--border))" stroke-width="1" opacity="0.35" vector-effect="non-scaling-stroke" />

                    {#if priceOverlay.sdArea2}
                        <path d={priceOverlay.sdArea2} fill="hsl(var(--primary))" opacity="0.08" />
                    {/if}
                    {#if priceOverlay.sdArea1}
                        <path d={priceOverlay.sdArea1} fill="hsl(var(--primary))" opacity="0.14" />
                    {/if}
                    {#if priceOverlay.sdPlus2}
                        <path d={priceOverlay.sdPlus2} fill="none" stroke="hsl(var(--primary))" stroke-width="1" stroke-dasharray="2 4" opacity="0.34" vector-effect="non-scaling-stroke" />
                    {/if}
                    {#if priceOverlay.sdMinus2}
                        <path d={priceOverlay.sdMinus2} fill="none" stroke="hsl(var(--primary))" stroke-width="1" stroke-dasharray="2 4" opacity="0.34" vector-effect="non-scaling-stroke" />
                    {/if}
                    {#if priceOverlay.sdPlus1}
                        <path d={priceOverlay.sdPlus1} fill="none" stroke="hsl(var(--primary))" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.55" vector-effect="non-scaling-stroke" />
                    {/if}
                    {#if priceOverlay.sdMinus1}
                        <path d={priceOverlay.sdMinus1} fill="none" stroke="hsl(var(--primary))" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.55" vector-effect="non-scaling-stroke" />
                    {/if}

                    {#if priceOverlay.pricePath}
                        <path d={priceOverlay.pricePath} fill="none" stroke="hsl(var(--foreground))" stroke-width="1.8" opacity="0.82" vector-effect="non-scaling-stroke" />
                    {/if}
                    {#each priceOverlay.priceDots as dot}
                        <circle cx={dot.x} cy={dot.y} r={dot.isLivePrice ? 3.5 : 2.4} fill="hsl(var(--foreground))" opacity={dot.isLivePrice || activeIndex === dot.point.index ? 0.95 : 0.42} vector-effect="non-scaling-stroke" />
                    {/each}

                    {#each priceOverlay.wallMarkers as marker}
                        <line x1={marker.x - 9} x2={marker.x + 9} y1={marker.y} y2={marker.y} stroke={marker.wall.color} stroke-width={marker.wall.key === 'largest_combined_position' ? 1.2 : 2.4} opacity={activeIndex === marker.point.index ? 0.95 : 0.55} vector-effect="non-scaling-stroke" />
                        <circle cx={marker.x} cy={marker.y} r={marker.wall.key === 'largest_combined_position' ? 2.4 : 3.2} fill={marker.wall.color} opacity={activeIndex === marker.point.index ? 0.95 : 0.62} vector-effect="non-scaling-stroke" />
                    {/each}

                    {#if priceOverlay.activeX != null}
                        <line x1={priceOverlay.activeX} x2={priceOverlay.activeX} y1="0" y2={priceOverlay.height} stroke="hsl(var(--muted-foreground))" stroke-width="1" opacity="0.5" vector-effect="non-scaling-stroke" />
                    {/if}

                    {#each priceOverlay.labels as label}
                        <g opacity="0.9">
                            <line x1={Math.min(label.x + 10, priceOverlay.width - 92)} x2={Math.min(label.x + 24, priceOverlay.width - 78)} y1={label.y} y2={label.y} stroke={label.color} stroke-width="1" vector-effect="non-scaling-stroke" />
                            <text x={Math.min(label.x + 28, priceOverlay.width - 74)} y={label.y + 3} fill={label.color} font-size="10" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">{label.text}</text>
                        </g>
                    {/each}
                </svg>

                <div class="pointer-events-none absolute left-2 top-2 font-mono text-[10px] text-muted-foreground">
                    {fmtLevel(priceRange.max)}
                </div>
                <div class="pointer-events-none absolute bottom-2 left-2 font-mono text-[10px] text-muted-foreground">
                    {fmtLevel(priceRange.min)}
                </div>
                {#if !hasAnySd}
                    <div class="pointer-events-none absolute bottom-2 right-2 rounded bg-surface/80 px-2 py-1 text-[10px] text-muted-foreground">
                        SD unavailable for old snapshots
                    </div>
                {/if}
            </div>
        </div>
    </div>

    {#if tooltip}
        {@const point = tooltip.point}
        {@const row = point.row}
        {@const bands = sdBandRows(row)}
        {@const walls = wallEntries(row)}
        <div
            class="pointer-events-none absolute z-20 rounded-md border border-border bg-surface px-3 py-2 text-[11px] shadow-xl"
            style={`left:${tooltip.x}px; top:${tooltip.y}px; width:${tooltip.width}px;`}
        >
            <div class="flex items-center justify-between gap-2">
                <div class="font-mono font-semibold text-foreground">{stamp(row)}</div>
                <div class="font-mono text-muted-foreground">{capturedTime(row)}</div>
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-muted-foreground">
                <span>{row.contract || row.contract_key}</span>
                <span class="font-mono text-foreground">
                    {fmtLevel(pointPrice(point))}
                    {#if point.isLivePrice}<span class="ml-1 text-[10px] uppercase tracking-wider text-primary">live</span>{/if}
                </span>
            </div>
            {#if point.isLivePrice}
                <div class="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                    <span>Snapshot {fmtLevel(row.future_price)}</span>
                    {#if liveTimeLabel()}<span>Live at {liveTimeLabel()}</span>{/if}
                </div>
            {/if}
            <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono tabular-nums">
                <span class="text-muted-foreground">OI P/C</span>
                <span class="text-right text-put">{fmt(point.oi)}</span>
                <span class="text-muted-foreground">Vol P/C</span>
                <span class="text-right text-call">{fmtFlow(row, 'volume_put_call_ratio')}</span>
                <span class="text-muted-foreground">Score</span>
                <span class="text-right text-foreground">{fmtScore(row.bias?.score)}</span>
                <span class="text-muted-foreground">Bias</span>
                <span class="text-right text-foreground capitalize">{biasLabel(row)}</span>
                <span class="text-muted-foreground">Call Vol</span>
                <span class="text-right text-call">{fmtFlow(row, 'call_volume', 0)}</span>
                <span class="text-muted-foreground">Put Vol</span>
                <span class="text-right text-put">{fmtFlow(row, 'put_volume', 0)}</span>
            </div>
            {#if !isFlowReady(row)}
                <div class="mt-2 rounded border border-border/70 bg-background px-2 py-1 text-[10px] text-muted-foreground">
                    Intraday volume was not populated for this scrape yet.
                </div>
            {/if}

            <div class="mt-2 border-t border-border/70 pt-2">
                <div class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Walls</div>
                {#if walls.length}
                    <div class="grid grid-cols-2 gap-x-3 gap-y-1 font-mono tabular-nums">
                        {#each walls as wall}
                            <span style={`color:${wall.color}`}>{wall.label}</span>
                            <span class="text-right text-foreground">
                                {fmtLevel(wall.strike)}
                                <span class="text-muted-foreground">({fmtSigned(wall.distance_points, 0)})</span>
                            </span>
                        {/each}
                    </div>
                {:else}
                    <div class="text-muted-foreground">No wall data for this snapshot.</div>
                {/if}
            </div>

            <div class="mt-2 border-t border-border/70 pt-2">
                <div class="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <span>SD Bands</span>
                    {#if row.expected_range?.atm_iv_pct}<span class="font-mono normal-case tracking-normal">{fmt(row.expected_range.atm_iv_pct, 2)}% IV</span>{/if}
                </div>
                {#if bands.length}
                    <div class="grid grid-cols-2 gap-x-3 gap-y-1 font-mono tabular-nums">
                        {#each bands as band}
                            <span style={`color:${band.color}`}>{band.label}</span>
                            <span class="text-right text-foreground">{fmtLevel(band.value)}</span>
                        {/each}
                    </div>
                {:else}
                    <div class="text-muted-foreground">SD unavailable for this snapshot.</div>
                {/if}
            </div>
        </div>
    {/if}
</div>

<div class="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
    <span>{firstStamp}</span>
    <span>{chartData.length} points | P/C range {fmt(valueRange.min)}-{fmt(valueRange.max)}</span>
    <span>{lastStamp}</span>
</div>
