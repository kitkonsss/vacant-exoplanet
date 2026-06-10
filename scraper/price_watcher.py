#!/usr/bin/env python3
"""Price watcher: compare live GC price against data/daily_strategy.json setups
and push entry-signal alerts to Telegram.

Signal kinds (all levels come from strategy_fetch.py output — no new analysis here):
  1. breakout   — price crosses the momentum/scenario trigger level
  2. zone_touch — price reaches a mean_reversion fade zone (has target + invalidation)
  3. approach   — price gets near a confluence level with >= 3 sources (heads-up)

Anti-spam: each (kind, level) alerts at most once per UTC day, tracked in
data/watcher_state.json (committed back by the workflow). If the strategy file
is older than STALE_HOURS the watcher sends one stale-data warning per day
instead of signals.

Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Without them (or with --dry-run)
alerts are printed instead of sent, so the script is safe to run locally.

Dependencies: stdlib + yfinance (same as macro_fetch.py).
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Windows consoles default to a legacy codepage that can't print emoji/Thai.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO_ROOT = Path(__file__).resolve().parent.parent
STRATEGY_PATH = REPO_ROOT / 'data' / 'daily_strategy.json'
STATE_PATH = REPO_ROOT / 'data' / 'watcher_state.json'

YAHOO_SYMBOL = 'GC=F'
STALE_HOURS = 36          # strategy older than this -> warn, don't signal
STATE_KEEP_DAYS = 3       # prune alert dedupe keys older than this
MAX_BREAKOUT_LAG_ATR = 0.5   # don't call "breakout" if price is already this far past the level
ZONE_TOUCH_ATR = 0.08        # zone counts as touched within this fraction of ATR
APPROACH_ATR = 0.25          # "approaching" window for confluence levels
DEFAULT_ATR = 60.0           # fallback if expected_range is missing


def utcnow():
    return datetime.now(timezone.utc)


def fetch_price():
    """Live GC front-month price from yfinance (same source as quikstrike_scraper)."""
    import yfinance as yf
    ticker = yf.Ticker(YAHOO_SYMBOL)
    price = None
    try:
        info = ticker.fast_info
        price = info.get('lastPrice') or info.get('last_price')
    except Exception as e:
        print(f'[WATCH] fast_info error: {e}')
    if not price:
        hist = ticker.history(period='1d', interval='5m')
        if hist is not None and len(hist):
            price = float(hist['Close'].iloc[-1])
    return float(price) if price else None


def parse_level(text):
    """Extract the first price-like number from trigger text like
    'break above 4400 (confluence x4)'. Returns float or None."""
    if not text:
        return None
    m = re.search(r'(\d{3,6}(?:\.\d+)?)', str(text))
    return float(m.group(1)) if m else None


def parse_direction(text):
    t = str(text or '').lower()
    if 'above' in t:
        return 'above'
    if 'below' in t:
        return 'below'
    return None


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def load_state():
    state = load_json(STATE_PATH) or {}
    state.setdefault('alerts', {})
    return state


def save_state(state):
    cutoff = (utcnow() - timedelta(days=STATE_KEEP_DAYS)).isoformat()
    state['alerts'] = {k: v for k, v in state['alerts'].items() if v >= cutoff}
    state['last_check'] = utcnow().isoformat(timespec='seconds')
    STATE_PATH.write_text(json.dumps(state, indent=2) + '\n', encoding='utf-8')


def already_alerted(state, key):
    return key in state['alerts']

def mark_alerted(state, key):
    state['alerts'][key] = utcnow().isoformat(timespec='seconds')


def send_telegram(text, dry_run=False):
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
    chat_id = os.environ.get('TELEGRAM_CHAT_ID', '').strip()
    if dry_run or not token or not chat_id:
        print('[ALERT/dry-run]\n' + text + '\n')
        return True
    url = f'https://api.telegram.org/bot{token}/sendMessage'
    data = urllib.parse.urlencode({
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'HTML',
        'disable_web_page_preview': 'true',
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=15) as resp:
            ok = json.loads(resp.read().decode()).get('ok', False)
        print(f'[ALERT] sent ok={ok}')
        return ok
    except Exception as e:
        print(f'[ALERT] telegram error: {e}')
        return False


def fmt(n):
    return f'{n:,.1f}'.rstrip('0').rstrip('.')


def build_watch_items(strategy):
    """Flatten the strategy into watchable items. Every item:
    {kind, side, level, label, target, invalidation, extra}"""
    items = []
    atr = (strategy.get('expected_range') or {}).get('atr') or DEFAULT_ATR

    # 1. breakout triggers — momentum block first, scenarios as the source of
    # the opposite side (momentum only describes the leading direction).
    momentum = strategy.get('momentum') or {}
    level = parse_level(momentum.get('trigger'))
    side = parse_direction(momentum.get('trigger'))
    if level and side:
        targets = [parse_level(t) for t in momentum.get('targets') or []]
        items.append({
            'kind': 'breakout', 'side': side, 'level': level,
            'label': momentum.get('trigger'),
            'target': next((t for t in targets if t), None),
            'invalidation': parse_level(momentum.get('invalidation')),
            'extra': momentum.get('rationale') or '',
        })
    for sc in strategy.get('scenarios') or []:
        lv = parse_level(sc.get('trigger'))
        sd = parse_direction(sc.get('trigger'))
        if not lv or not sd:
            continue
        if any(i['kind'] == 'breakout' and i['level'] == lv and i['side'] == sd for i in items):
            continue
        items.append({
            'kind': 'breakout', 'side': sd, 'level': lv,
            'label': sc.get('trigger'),
            'target': parse_level(sc.get('then')),
            'invalidation': parse_level(sc.get('invalidation')),
            'extra': sc.get('then') or '',
        })

    # 2. mean-reversion fade zones (numeric at/target/invalidation already provided)
    mr = strategy.get('mean_reversion') or {}
    for z in mr.get('zones') or []:
        if not z.get('at'):
            continue
        items.append({
            'kind': 'zone_touch', 'side': None, 'level': float(z['at']),
            'label': f"{z.get('action', 'fade')} @ {fmt(z['at'])} ({z.get('band', '')})",
            'target': z.get('target'),
            'invalidation': z.get('invalidation'),
            'extra': ', '.join(z.get('confluence_with') or []),
            'aligned': mr.get('aligned_with_regime', True),
            'action': z.get('action', 'fade'),
        })

    # 3. high-confluence levels (heads-up only)
    for c in strategy.get('confluence_levels') or []:
        if (c.get('confluence') or 0) < 3 or not c.get('level'):
            continue
        items.append({
            'kind': 'approach', 'side': None, 'level': float(c['level']),
            'label': f"confluence x{c['confluence']}",
            'target': None, 'invalidation': None,
            'extra': ', '.join(c.get('sources') or []),
        })

    return items, atr


def bias_line(strategy):
    bias = strategy.get('directional_bias') or {}
    agree = strategy.get('agreement') or {}
    regime = strategy.get('regime') or {}
    return (f"Bias: {bias.get('label', '?')} ({bias.get('confidence', '?')}) | "
            f"layers ตรงกัน {agree.get('aligned', '?')}/{agree.get('total', '?')} | "
            f"regime: {regime.get('regime', '?')} → {regime.get('lead_playbook', '?')}")


def check_items(price, items, atr, strategy, state):
    """Evaluate all watch items against the current price; return alert messages."""
    msgs = []
    day = utcnow().strftime('%Y-%m-%d')
    foot = f"\n{bias_line(strategy)}\n<i>สัญญาณจากระบบ ไม่ใช่คำแนะนำการลงทุน</i>"

    for it in items:
        level = it['level']
        key = f"{day}:{it['kind']}:{level:g}"
        if already_alerted(state, key):
            continue

        if it['kind'] == 'breakout':
            crossed = price >= level if it['side'] == 'above' else price <= level
            lag = abs(price - level)
            if crossed and lag <= MAX_BREAKOUT_LAG_ATR * atr:
                emoji = '🟢' if it['side'] == 'above' else '🔴'
                lines = [f"{emoji} <b>GC Breakout</b> — {it['label']}",
                         f"ราคา {fmt(price)} ({'ทะลุขึ้น' if it['side'] == 'above' else 'หลุดลง'} {fmt(level)})"]
                tp, sl = it.get('target'), it.get('invalidation')
                if tp or sl:
                    lines.append(f"เป้า: {fmt(tp) if tp else '-'} | Invalidation: {fmt(sl) if sl else '-'}")
                if it['extra']:
                    lines.append(it['extra'])
                msgs.append((key, '\n'.join(lines) + foot))

        elif it['kind'] == 'zone_touch':
            if abs(price - level) <= max(3.0, ZONE_TOUCH_ATR * atr):
                emoji = '🔵' if 'long' in it.get('action', '') else '🟠'
                lines = [f"{emoji} <b>GC แตะโซน {it.get('action', 'fade')}</b> ที่ {fmt(level)}",
                         f"ราคา {fmt(price)}",
                         f"เป้า: {fmt(it['target']) if it.get('target') else '-'} | SL: {fmt(it['invalidation']) if it.get('invalidation') else '-'}"]
                if it['extra']:
                    lines.append(f"Confluence: {it['extra']}")
                if not it.get('aligned', True):
                    lines.append('⚠️ โซน MR สวน regime วันนี้ — ลดขนาด/รอ confirm')
                msgs.append((key, '\n'.join(lines) + foot))

        elif it['kind'] == 'approach':
            dist = abs(price - level)
            if max(3.0, ZONE_TOUCH_ATR * atr) < dist <= APPROACH_ATR * atr:
                side_txt = 'เหนือราคา' if level > price else 'ใต้ราคา'
                msgs.append((key,
                             f"⚠️ <b>GC เข้าใกล้ level {fmt(level)}</b> ({it['label']}, {side_txt} {fmt(dist)} pts)\n"
                             f"ราคา {fmt(price)}\nSources: {it['extra']}" + foot))

    return msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='print alerts instead of sending')
    ap.add_argument('--price', type=float, default=None, help='override live price (testing)')
    args = ap.parse_args()

    # GC closes Fri 21:00 UTC, reopens Sun 22:00 UTC — Saturday is always dead.
    if utcnow().weekday() == 5:
        print('[WATCH] Saturday — market closed, skipping.')
        return 0

    strategy = load_json(STRATEGY_PATH)
    if not strategy:
        print(f'[WATCH] cannot read {STRATEGY_PATH}')
        return 1

    state = load_state()
    day = utcnow().strftime('%Y-%m-%d')

    gen = strategy.get('generated_at')
    try:
        age_h = (utcnow() - datetime.fromisoformat(gen)).total_seconds() / 3600
    except (TypeError, ValueError):
        age_h = None
    if age_h is None or age_h > STALE_HOURS:
        key = f'{day}:stale'
        print(f'[WATCH] strategy stale (age={age_h and round(age_h, 1)}h) — no signals.')
        if not already_alerted(state, key):
            send_telegram(f'⚠️ <b>GC watcher</b>: daily_strategy.json เก่า {round(age_h or 0)} ชม. '
                          f'— งดส่งสัญญาณจนกว่า pipeline จะอัปเดต', dry_run=args.dry_run)
            mark_alerted(state, key)
        save_state(state)
        return 0

    price = args.price or fetch_price()
    if not price:
        print('[WATCH] no live price available — skipping.')
        save_state(state)
        return 0
    print(f'[WATCH] GC price {price} | strategy age {round(age_h, 1)}h')

    items, atr = build_watch_items(strategy)
    print(f'[WATCH] watching {len(items)} items (ATR {atr})')
    msgs = check_items(price, items, atr, strategy, state)

    for key, text in msgs:
        if send_telegram(text, dry_run=args.dry_run):
            mark_alerted(state, key)

    state['last_price'] = price
    save_state(state)
    print(f'[WATCH] done — {len(msgs)} alert(s).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
