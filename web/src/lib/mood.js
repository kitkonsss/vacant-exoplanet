// "อารมณ์ตลาดวันนี้" — a one-glance read of whether today is a day to FADE
// (mean-revert against a move) or NOT. Built entirely from data the pipeline
// already produces: the options expected_range (ATM IV, put/call skew, term
// structure) embedded in daily_strategy.json, the regime classifier, and the
// rolling IV history (iv_baseline.json) for a "vs its own normal" comparison.
// Pure functions, no I/O.
//
// Why it exists: the trader's account-killer is fading a 1-SD move on a CPI/FOMC
// day that then trends 2-3 SD. The market prices that risk IN ADVANCE — IV
// expands, the front-month term structure inverts (scheduled-event premium),
// skew leans to the feared side, and the regime flips to trending. This collapses
// those four signals into one red / yellow / green "fade or don't" verdict.

function median(xs) {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * @param strategy  parsed daily_strategy.json (needs `.expected_range` + `.regime`)
 * @param ivHistory array of iv_baseline rows ({ atm_iv_pct, put_skew, ... }) or null
 * @returns mood object (see fields below) or null if there's no expected_range
 */
export function buildMood(strategy, ivHistory = null) {
    const er = strategy?.expected_range;
    if (!er) return null;

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

    // --- verdict: red (don't fade) / yellow (fade carefully) / green (fade ok) ---
    const reasons = [];
    if (regimeTrending) reasons.push('regime = เทรนด์ → ห้ามสวนทาง');
    if (termStrong) reasons.push(`term inverted แรง (slope ${termSlope.toFixed(1)}) = ตลาดกลัวข่าว`);
    else if (termInverted) reasons.push('term inverted เล็กน้อย = มีเบี้ยข่าวฝั่งสั้น');
    if (ivLevel === 'high') reasons.push('IV สูงกว่าปกติมาก = ตลาดรอมูฟใหญ่');
    else if (ivLevel === 'elevated') reasons.push('IV สูงกว่าปกติ');
    if (fearDir !== 'balanced' && (regimeTrending || ivLevel === 'high' || ivLevel === 'elevated')) {
        reasons.push(fearDir === 'down' ? 'skew เอียงกลัวลง — ระวังไหลลง' : 'skew เอียงกลัวขึ้น — ระวังพุ่งขึ้น');
    }

    let verdict;
    if (regimeTrending || termStrong || ivLevel === 'high') verdict = 'red';
    else if (termInverted || ivLevel === 'elevated' || regime === 'mixed') verdict = 'yellow';
    else verdict = 'green';

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
    };
}
