// "อารมณ์ตลาดวันนี้" — a one-glance read of whether today is a day to FADE
// (mean-revert against a move) or NOT. Built from data the pipeline already
// produces: the options expected_range (ATM IV, put/call skew, term structure)
// embedded in daily_strategy.json, the regime classifier, the rolling IV history
// (iv_baseline.json) for a "vs its own normal" comparison, the gamma magnet, and
// the scheduled high-impact macro calendar (econ_calendar.json). Pure, no I/O.
//
// Why it exists: the trader's account-killer is fading a 1-SD move on a CPI/FOMC
// day that then trends 2-3 SD. Two complementary defenses:
//   • REACTIVE — once the market starts pricing an event, IV expands, the term
//     structure inverts (front-month event premium), skew leans to the feared
//     side, and the regime flips to trending.
//   • PROACTIVE — the economic calendar knows the exact schedule days ahead
//     (FOMC/CPI/NFP), regardless of whether IV has moved yet.
// This collapses all of that into one red / yellow / green "fade or don't" verdict.

function median(xs) {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const CODE_LABEL = { FOMC: 'FOMC', CPI: 'CPI', NFP: 'จ้างงาน (NFP)' };

/**
 * @param strategy parsed daily_strategy.json (needs `.expected_range` + `.regime`)
 * @param opts {
 *   ivHistory: iv_baseline rows (array) | null   — for IV-vs-normal,
 *   events:    econ_calendar events (array) | null,
 *   nowMs:     Date.now() from the caller (browser) | null  — for event proximity,
 *   price:     live futures price | null          — for gamma-magnet distance
 * }
 * @returns mood object or null if there's no expected_range
 */
export function buildMood(strategy, opts = {}) {
    const er = strategy?.expected_range;
    if (!er) return null;

    // Tolerate the old call shape buildMood(strategy, ivHistoryArray).
    if (Array.isArray(opts)) opts = { ivHistory: opts };
    const { ivHistory = null, events = null, nowMs = null, price = null } = opts;

    const atmIvPct = Number.isFinite(er.atm_iv_pct) ? er.atm_iv_pct : null;

    // --- IV vs its own recent baseline (is vol bid up = a big move priced in?) ---
    const hist = Array.isArray(ivHistory) ? ivHistory.map((r) => r?.atm_iv_pct).filter(Number.isFinite) : [];
    const ivCount = hist.length;
    const ivBaseline = ivCount ? median(hist) : null;
    const ivSampleThin = ivCount < 6;
    const ivRatio = atmIvPct != null && ivBaseline ? atmIvPct / ivBaseline : null;
    let ivLevel = null; // 'calm' | 'normal' | 'elevated' | 'high'
    if (ivRatio != null) {
        ivLevel = ivRatio > 1.35 ? 'high' : ivRatio > 1.12 ? 'elevated' : ivRatio < 0.85 ? 'calm' : 'normal';
    }
    const ivLabel =
        ivLevel === 'high' ? 'สูงมาก (ตลาดอัดเบี้ยรอมูฟใหญ่)'
        : ivLevel === 'elevated' ? 'สูงกว่าปกติ'
        : ivLevel === 'calm' ? 'ต่ำ/นิ่งกว่าปกติ'
        : ivLevel === 'normal' ? 'ปกติ'
        : 'ยังไม่มีฐานเทียบ';

    // --- skew = which side the market is paying to hedge (= direction of fear) ---
    const putSkew = Number.isFinite(er?.skew?.put_skew_volpts) ? er.skew.put_skew_volpts : null;
    const callSkew = Number.isFinite(er?.skew?.call_skew_volpts) ? er.skew.call_skew_volpts : null;
    const read = er?.skew?.read || '';
    const spread = putSkew != null && callSkew != null ? putSkew - callSkew : null;
    let fearDir = 'balanced'; // 'down' | 'up' | 'balanced'
    if (read.includes('put_skew_dominant') || (spread != null && spread > 1.5)) fearDir = 'down';
    else if (read.includes('call_skew_dominant') || (spread != null && spread < -1.5)) fearDir = 'up';
    const fearLabel =
        fearDir === 'down' ? '🔻 ตลาดกลัวฝั่งลง (แห่ซื้อประกันขาลง)'
        : fearDir === 'up' ? '🔺 ตลาดกลัว/ไล่ฝั่งขึ้น (แห่ซื้อ call)'
        : '⚖️ สองฝั่งพอๆ กัน';

    // --- term structure = scheduled-event premium in the front contract ---
    const termSlope = Number.isFinite(er?.term_structure?.slope_volpts_short_minus_monthly)
        ? er.term_structure.slope_volpts_short_minus_monthly
        : null;
    const termShape = er?.term_structure?.shape || '';
    const termInverted = termShape.includes('inverted') || (termSlope != null && termSlope > 3);
    const termStrong = termSlope != null && termSlope > 10;
    const termLabel = termInverted
        ? termStrong
            ? '⚠️ เบี้ยข่าวแรงในสัญญาสั้น (กลัวข่าวมาก)'
            : 'มีเบี้ยข่าวฝั่งสั้นเล็กน้อย'
        : 'ปกติ (ไม่มีเบี้ยข่าวพิเศษ)';

    // --- regime = the proven circuit-breaker ---
    const regime = strategy?.regime?.regime || 'neutral';
    const regimeTrending = regime === 'trending';
    const regimeRange = regime === 'range' || regime === 'ranging';
    const leadPlaybook = strategy?.regime?.lead_playbook || null;

    // --- gamma magnet = pin (mean-revert, fade ok) vs escaped (trend, don't fade) ---
    // NOTE: this is a PIN-PROXIMITY proxy from the COMBINED gamma magnet, not a
    // signed dealer long/short-gamma (that needs call/put-split gamma the scrape
    // doesn't capture yet). Honest heuristic: price hugging the biggest gamma pile
    // tends to pin; once it breaks away, moves run.
    const magnet = strategy?.gamma_1pct?.gamma_magnet || null;
    const gammaPrice = Number.isFinite(price) ? price : strategy?.future_price ?? er?.future_price ?? null;
    const emScale = Number.isFinite(er.expected_move) && er.expected_move > 0 ? er.expected_move : null;
    let gammaPin = null;
    if (magnet?.strike != null && gammaPrice != null && emScale) {
        const dist = Math.abs(gammaPrice - magnet.strike);
        const ratio = dist / emScale;
        const state = ratio <= 0.5 ? 'pinned' : ratio >= 1.1 || regimeTrending ? 'escaped' : 'neutral';
        gammaPin = { strike: magnet.strike, dist, ratio, state };
    }

    // --- scheduled high-impact event proximity (proactive layer) ---
    let event = null; // soonest upcoming high-impact event + status
    if (Array.isArray(events) && Number.isFinite(nowMs)) {
        const upcoming = events
            .map((e) => ({ ...e, ms: Date.parse(e.at) }))
            .filter((e) => Number.isFinite(e.ms))
            .map((e) => ({ ...e, hoursUntil: (e.ms - nowMs) / 3600000 }))
            .filter((e) => e.hoursUntil > -3) // keep through ~3h after the print (still volatile)
            .sort((a, b) => a.hoursUntil - b.hoursUntil);
        const next = upcoming[0];
        if (next) {
            const status = next.hoursUntil <= 20 ? 'today' : next.hoursUntil <= 44 ? 'tomorrow' : 'far';
            event = { code: next.code, name: next.name, at: next.at, hoursUntil: next.hoursUntil, status };
        }
    }

    // --- verdict: red (don't fade) / yellow (fade carefully) / green (fade ok) ---
    const reasons = [];

    // base verdict from the vol structure
    let verdict;
    if (regimeTrending || termStrong || ivLevel === 'high') verdict = 'red';
    else if (termInverted || ivLevel === 'elevated' || regime === 'mixed') verdict = 'yellow';
    else verdict = 'green';

    // gamma nudge: a clean breakaway argues for trend
    if (gammaPin?.state === 'escaped' && verdict === 'green') verdict = 'yellow';

    // scheduled-event override (strongest, proactive)
    if (event?.status === 'today') verdict = 'red';
    else if (event?.status === 'tomorrow' && verdict === 'green') verdict = 'yellow';

    // reasons, most important first
    if (event?.status === 'today') {
        const hrs = Math.max(0, Math.round(event.hoursUntil));
        reasons.push(`📅 วันนี้มีข่าว ${CODE_LABEL[event.code] || event.code} (อีก ${hrs} ชม.) — ห้าม fade`);
    } else if (event?.status === 'tomorrow') {
        reasons.push(`📅 พรุ่งนี้มีข่าว ${CODE_LABEL[event.code] || event.code} — ระวังก่อนข่าว`);
    }
    if (regimeTrending) reasons.push('regime = เทรนด์ → ห้ามสวนทาง');
    if (termStrong) reasons.push(`term inverted แรง (slope ${termSlope.toFixed(1)}) = ตลาดกลัวข่าว`);
    else if (termInverted) reasons.push('term inverted เล็กน้อย = มีเบี้ยข่าวฝั่งสั้น');
    if (ivLevel === 'high') reasons.push('IV สูงกว่าปกติมาก = ตลาดรอมูฟใหญ่');
    else if (ivLevel === 'elevated') reasons.push('IV สูงกว่าปกติ');
    if (gammaPin?.state === 'escaped') reasons.push('หลุด gamma magnet → มูฟมีโอกาสเร่ง');
    if (fearDir !== 'balanced' && (regimeTrending || ivLevel === 'high' || ivLevel === 'elevated' || event?.status === 'today')) {
        reasons.push(fearDir === 'down' ? 'skew เอียงกลัวลง — ระวังไหลลง' : 'skew เอียงกลัวขึ้น — ระวังพุ่งขึ้น');
    }

    const headline =
        verdict === 'red' ? 'ห้าม FADE วันนี้'
        : verdict === 'yellow' ? 'ระวัง — สวนได้แต่เสี่ยง'
        : 'FADE ได้ — ตลาดค่อนข้างนิ่ง';
    const sub =
        verdict === 'red' ? 'วันแบบนี้สวนเทรนด์/สวนข่าวพอร์ตแตกง่าย → เทรดตามทางหรือยืนดู'
        : verdict === 'yellow' ? 'มีสัญญาณผันผวนบางส่วน ถ้าจะสวนกรอบ ลดไม้ + ตั้ง SL แคบ'
        : 'ไม่มีสัญญาณเทรนด์/ข่าวเด่น สวนกรอบ (mean reversion) พอมีลุ้น';

    return {
        verdict,
        fadeOk: verdict === 'green',
        headline,
        sub,
        reasons,
        // IV
        atmIvPct, ivBaseline, ivRatio, ivLevel, ivLabel, ivCount, ivSampleThin,
        // skew / fear
        putSkew, callSkew, spread, fearDir, fearLabel,
        // term structure
        termSlope, termInverted, termStrong, termLabel, termShape,
        // regime
        regime, regimeTrending, regimeRange, leadPlaybook,
        // gamma pin proxy
        gammaPin,
        // scheduled event
        event,
    };
}
