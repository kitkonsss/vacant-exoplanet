#!/usr/bin/env python3
"""Morning brief: condense data/daily_strategy.json + expected_range.json into
one Thai-language Telegram message, sent before the European session.

Designed to run AFTER the light pipeline (macro -> vwap -> expected_range ->
strategy) so levels are recomputed on the latest price. OI itself only
publishes once per CME day (~midday Thai), so the brief is explicit about the
data vintage instead of pretending overnight OI exists.

Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (same as price_watcher).
  python scraper/morning_brief.py [--dry-run]
"""

import argparse
import sys
from datetime import datetime, timezone, timedelta

# Reuse the watcher's Telegram + helpers (same directory).
from price_watcher import (STRATEGY_PATH, REPO_ROOT, fetch_price, fmt,
                           load_json, send_telegram, utcnow)

EXPECTED_RANGE_PATH = REPO_ROOT / 'data' / 'expected_range.json'
TH_TZ = timezone(timedelta(hours=7))

BIAS_TH = {
    'bullish': 'ขาขึ้น 🟢', 'lean_bullish': 'เอียงขึ้น 🟢',
    'bearish': 'ขาลง 🔴', 'lean_bearish': 'เอียงลง 🔴',
    'neutral': 'กลางๆ ⚪',
}
REGIME_TH = {'trending': 'Trending (เล่นตามแรง)', 'range': 'Range (เล่นเด้งกลับ)',
             'mixed': 'Mixed (ก้ำกึ่ง)'}


def age_hours(stamp):
    try:
        return (utcnow() - datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))).total_seconds() / 3600
    except (TypeError, ValueError):
        return None


def fmt_local(stamp):
    try:
        return datetime.fromisoformat(str(stamp).replace('Z', '+00:00')) \
            .astimezone(TH_TZ).strftime('%d/%m %H:%M')
    except (TypeError, ValueError):
        return '—'


def build_message(strategy, er, price):
    bias = strategy.get('directional_bias') or {}
    regime = strategy.get('regime') or {}
    momentum = strategy.get('momentum') or {}
    scenarios = strategy.get('scenarios') or []
    agree = strategy.get('agreement') or {}
    freshness = strategy.get('data_freshness') or {}

    now_th = utcnow().astimezone(TH_TZ)
    lines = [f"🌅 <b>GC Morning Brief</b> — {now_th.strftime('%a %d/%m/%Y %H:%M')} น."]

    if price:
        ref = strategy.get('future_price')
        chg = f" ({price - ref:+.1f} จากรอบคำนวณ)" if ref else ''
        lines.append(f"ราคา GC ตอนนี้ <b>{fmt(price)}</b>{chg}")

    lines.append(f"Bias วันนี้: <b>{BIAS_TH.get(bias.get('label'), bias.get('label', '?'))}</b> "
                 f"(score {bias.get('score', '?')}, {bias.get('confidence', '?')}) | "
                 f"layers ตรงกัน {agree.get('aligned', '?')}/{agree.get('total', '?')}")
    lines.append(f"Regime: {REGIME_TH.get(regime.get('regime'), regime.get('regime', '?'))}")

    if er and er.get('expected_move_1d'):
        b = er.get('bands_1d') or {}
        lines.append(f"\n📐 <b>Expected Range วันนี้: ±{fmt(er['expected_move_1d'])}</b> "
                     f"(IV {fmt(er.get('atm_iv_pct_1d_basis'))}%)"
                     + (f" → {fmt(b.get('minus1'))} – {fmt(b.get('plus1'))}" if b else ''))
        ts = er.get('term_structure') or {}
        skew = er.get('skew') or {}
        vol_notes = []
        if str(ts.get('shape', '')).startswith('inverted'):
            vol_notes.append('IV หน้าสั้นพุ่ง (ตลาดตึง ระวังเหวี่ยงแรง)')
        elif str(ts.get('shape', '')).startswith('contango'):
            vol_notes.append('IV หน้าสั้นสงบ')
        if str(skew.get('read', '')).startswith('put'):
            vol_notes.append('put skew หนา (ตลาดกลัวขาลง)')
        elif str(skew.get('read', '')).startswith('call'):
            vol_notes.append('call skew หนา (ไล่ขาขึ้น)')
        if vol_notes:
            lines.append('⚡ ' + ' | '.join(vol_notes))

    if momentum.get('trigger'):
        lines.append(f"\n🎯 <b>Momentum:</b> {momentum['trigger']}")
        tgt = ', '.join(momentum.get('targets') or []) or '-'
        lines.append(f"   เป้า {tgt} | invalidation {momentum.get('invalidation', '-')}")
        risk = strategy.get('risk') or {}
        mom_size = next((s for s in risk.get('setups') or [] if s.get('setup') == 'momentum'), None)
        if mom_size:
            budget = risk.get('budget_usd_per_trade', 500)
            if mom_size['mgc_contracts'] < 1:
                lines.append(f"   📏 SL ห่าง {mom_size['risk_points']} pts — เกิน budget ${budget:.0f} "
                             'แม้ 1 MGC → ข้าม setup นี้ หรือรอจุดเข้าที่แคบกว่า')
            else:
                lines.append(f"   📏 ขนาด (เสี่ยง ${budget:.0f}): {mom_size['mgc_contracts']} MGC "
                             f"| SL ห่าง {mom_size['risk_points']} pts"
                             + (f" | RR {mom_size['rr']}" if mom_size.get('rr') else ''))
    for sc in scenarios:
        if sc.get('trigger') and sc.get('trigger') != momentum.get('trigger'):
            lines.append(f"🔄 {sc.get('bias', '')}: {sc['trigger']} → {sc.get('then', '')}")

    kl = strategy.get('key_levels') or {}
    res = ', '.join(fmt(x) for x in (kl.get('resistances') or [])[:3])
    sup = ', '.join(fmt(x) for x in (kl.get('supports') or [])[:3])
    if res or sup:
        lines.append(f"\n🧱 แนวต้าน: {res or '-'} | แนวรับ: {sup or '-'}")

    # Data vintage — OI publishes once per CME day, so be explicit.
    pos_age = age_hours(freshness.get('positioning'))
    note = f"\n📊 OI as-of {fmt_local(freshness.get('positioning'))} น."
    if pos_age is not None and pos_age > 8:
        note += ' (ของเมื่อคืน — สัญญา/OI ชุดใหม่จะเข้าหลัง scrape รอบบ่าย)'
    lines.append(note)
    lines.append('<i>สรุปจากระบบ ไม่ใช่คำแนะนำการลงทุน — สัญญาณ entry จะแจ้งแยกเมื่อราคาแตะ trigger</i>')
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    strategy = load_json(STRATEGY_PATH)
    if not strategy:
        print('[BRIEF] no daily_strategy.json — abort')
        return 1
    st_age = age_hours(strategy.get('generated_at'))
    if st_age is not None and st_age > 24:
        print(f'[BRIEF] strategy is {round(st_age)}h old — sending stale warning only')
        send_telegram('⚠️ <b>GC Morning Brief</b>: ข้อมูล strategy เก่าเกิน 24 ชม. '
                      '— เช็ค pipeline (macro.yml / scrape.yml)', dry_run=args.dry_run)
        return 0

    er = load_json(EXPECTED_RANGE_PATH)
    price = fetch_price()
    msg = build_message(strategy, er, price)
    ok = send_telegram(msg, dry_run=args.dry_run)
    print(f'[BRIEF] sent ok={ok}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
