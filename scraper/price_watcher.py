#!/usr/bin/env python3
"""Price watcher: compare live GC price against data/daily_strategy.json setups
and push entry-signal alerts to Telegram.

Signal kinds (all levels come from strategy_fetch.py output — no new analysis here):
  1. breakout    — price crosses the momentum/scenario trigger level
  2. zone_touch  — price reaches a mean_reversion fade zone (has target + invalidation)
  3. band_touch  — price reaches the IV ±2sigma daily band (fade toward ±1sigma)
  4. round_wall  — price touches a round number carrying top-quartile OI
                   (the trader's round-to-round fade: GC $50 grid, NQ $100 grid)
  5. approach    — price gets near a confluence level with >= 3 sources (heads-up)

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
STATE_PATH = REPO_ROOT / 'data' / 'watcher_state.json'

# Multi-asset: each asset watches its own strategy/signal-log files; the
# dedupe state file is shared with asset-prefixed keys.
ASSETS = {
    'gc': {'subdir': '', 'label': 'GC', 'yahoo': 'GC=F', 'stooq': 'gc.f',
           'micro': 'MGC', 'micro_point': 10.0, 'full': 'GC', 'micro_per_full': 10},
    'nq': {'subdir': 'nq', 'label': 'NQ', 'yahoo': 'NQ=F', 'stooq': 'nq.f',
           'micro': 'MNQ', 'micro_point': 2.0, 'full': 'NQ', 'micro_per_full': 10},
}
# Back-compat for morning_brief.py imports (GC paths).
STRATEGY_PATH = REPO_ROOT / 'data' / 'daily_strategy.json'

STALE_HOURS = 36          # strategy older than this -> warn, don't signal
STATE_KEEP_DAYS = 3       # prune alert dedupe keys older than this
MAX_BREAKOUT_LAG_ATR = 0.5   # don't call "breakout" if price is already this far past the level
ZONE_TOUCH_ATR = 0.08        # zone counts as touched within this fraction of ATR
APPROACH_ATR = 0.25          # "approaching" window for confluence levels
DEFAULT_ATR = 60.0           # fallback if expected_range is missing
RISK_BUDGET_USD = float(os.environ.get('RISK_BUDGET_USD', '500'))


def sizing_line(price, invalidation, cfg):
    """Suggested size so a stop-out costs at most RISK_BUDGET_USD."""
    if not invalidation:
        return None
    rp = abs(price - float(invalidation))
    if rp <= 0:
        return None
    micro = int(RISK_BUDGET_USD // (rp * cfg['micro_point']))
    if micro < 1:
        return (f"ขนาด: SL ห่าง {rp:.0f} pts — เกิน budget ${RISK_BUDGET_USD:.0f} "
                f"แม้ 1 {cfg['micro']}, ข้ามหรือรอจุดที่แคบกว่า")
    full = micro // cfg['micro_per_full']
    return (f"ขนาด (เสี่ยง ${RISK_BUDGET_USD:.0f}): {micro} {cfg['micro']}"
            + (f" / {full} {cfg['full']}" if full else '')
            + f' — SL ห่าง {rp:.0f} pts')


def utcnow():
    return datetime.now(timezone.utc)


def fetch_price(cfg=None):
    """Live front-month price from yfinance (same source as quikstrike_scraper)."""
    import yfinance as yf
    cfg = cfg or ASSETS['gc']
    ticker = yf.Ticker(cfg['yahoo'])
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
    if not price:
        price = _stooq_price(cfg['stooq'])
    return float(price) if price else None


def _stooq_price(symbol):
    """Backup quote from Stooq (free CSV endpoint) when yfinance fails."""
    url = f'https://stooq.com/q/l/?s={symbol}&f=sd2t2ohlcv&h&e=csv'
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            lines = resp.read().decode().strip().splitlines()
        if len(lines) >= 2:
            close = lines[1].split(',')[6]
            price = float(close)
            print(f'[WATCH] price from Stooq fallback: {price}')
            return price
    except Exception as e:
        print(f'[WATCH] stooq fallback error: {e}')
    return None


def fetch_last_closed_15m(yahoo_symbol):
    """Close of the most recent COMPLETED 15m candle, or None.

    Breakouts confirm against this instead of the live tick so a wick
    poking through a level doesn't fire the alert."""
    import yfinance as yf
    try:
        hist = yf.Ticker(yahoo_symbol).history(period='1d', interval='15m')
    except Exception as e:
        print(f'[WATCH] 15m history error: {e}')
        return None
    if hist is None or len(hist) < 2:
        return None
    last_ts = hist.index[-1].tz_convert('UTC').to_pydatetime()
    # yfinance includes the in-progress candle as the last row — drop it.
    row = hist.iloc[-2] if last_ts + timedelta(minutes=15) > utcnow() else hist.iloc[-1]
    return float(row['Close'])


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
    er = strategy.get('expected_range') or {}
    # expected_move is IV-based when Phase 1 data is fresh — prefer it over raw ATR.
    atr = er.get('expected_move') or er.get('atr') or DEFAULT_ATR

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

    # 3. IV ±2σ band fades (Phase 1 bands) — target ±1σ, invalidation ±3σ.
    # Logged as their own kind so the scorecard can judge them separately;
    # fading ±2σ in a trending regime gets a warning, not a suppression.
    bands = er.get('bands_1d') or {}
    trending = (strategy.get('regime') or {}).get('regime') == 'trending'
    if all(bands.get(k) for k in ('minus1', 'minus2', 'minus3')):
        items.append({
            'kind': 'band_touch', 'side': None, 'level': float(bands['minus2']),
            'label': 'IV −2σ', 'action': 'fade long',
            'target': float(bands['minus1']), 'invalidation': float(bands['minus3']),
            'extra': 'แบนด์ IV รายวัน (−2σ)', 'aligned': not trending,
        })
    if all(bands.get(k) for k in ('plus1', 'plus2', 'plus3')):
        items.append({
            'kind': 'band_touch', 'side': None, 'level': float(bands['plus2']),
            'label': 'IV +2σ', 'action': 'fade short',
            'target': float(bands['plus1']), 'invalidation': float(bands['plus3']),
            'extra': 'แบนด์ IV รายวัน (+2σ)', 'aligned': not trending,
        })

    # 4. round numbers with top-quartile OI — the trader's own playbook
    # (fade at touch, target the next round, SL in the per-asset stop band).
    rw = strategy.get('round_walls') or {}
    for r in rw.get('levels') or []:
        if not r.get('thick') or not r.get('level'):
            continue
        oi_txt = (f"OI {r.get('oi', 0):,.0f} (p{round((r.get('oi_pctile') or 0) * 100)}), "
                  f"{r.get('oi_type') or 'mixed'} → {r.get('role') or 'magnet'}")
        items.append({
            'kind': 'round_wall', 'side': None, 'level': float(r['level']),
            'label': f"Round {fmt(r['level'])}" + (' (major)' if r.get('is_major') else ''),
            'action': r.get('action', 'fade'),
            'target': r.get('target'),
            'invalidation': r.get('invalidation'),
            'extra': oi_txt,
            'aligned': r.get('aligned', True),
            'rr': r.get('rr'),
        })

    # 5. high-confluence levels (heads-up only)
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


def _signal_record(it, price, strategy, direction, asset_id='gc'):
    """Structured record of a fired signal, for Phase 4 self-eval."""
    return {
        'ts': utcnow().isoformat(timespec='seconds'),
        'asset': asset_id,
        'kind': it['kind'],
        'level': it['level'],
        'direction': direction,                 # long / short / None (approach)
        'price_at_alert': price,
        'target': it.get('target'),
        'invalidation': it.get('invalidation'),
        'label': it.get('label'),
        'context': it.get('extra') or None,
        'bias': (strategy.get('directional_bias') or {}).get('label'),
        'regime': (strategy.get('regime') or {}).get('regime'),
        'strategy_ts': strategy.get('generated_at'),
        'status': 'open' if it['kind'] != 'approach' else 'info',
    }


def log_signal(record, log_path):
    log = load_json(log_path) or []
    log.append(record)
    log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8')


def check_items(asset_id, cfg, price, items, atr, strategy, state, candle_close=None):
    """Evaluate all watch items against the current price; return alerts as
    (dedupe_key, message_text, signal_record) tuples.

    Breakouts confirm against `candle_close` (last completed 15m close) when
    available, so intrabar wicks through a level don't fire."""
    msgs = []
    day = utcnow().strftime('%Y-%m-%d')
    name = cfg['label']
    foot = f"\n{bias_line(strategy)}\n<i>สัญญาณจากระบบ ไม่ใช่คำแนะนำการลงทุน</i>"

    for it in items:
        level = it['level']
        key = f"{asset_id}:{day}:{it['kind']}:{level:g}"
        if already_alerted(state, key):
            continue

        if it['kind'] == 'breakout':
            ref = candle_close if candle_close is not None else price
            crossed = ref >= level if it['side'] == 'above' else ref <= level
            lag = abs(ref - level)
            if crossed and lag <= MAX_BREAKOUT_LAG_ATR * atr:
                emoji = '🟢' if it['side'] == 'above' else '🔴'
                lines = [f"{emoji} <b>{name} Breakout</b> — {it['label']}",
                         f"ราคา {fmt(price)} ({'ทะลุขึ้น' if it['side'] == 'above' else 'หลุดลง'} {fmt(level)})"]
                if candle_close is not None:
                    lines.append(f"ยืนยันแล้ว: แท่ง 15 นาทีปิด {fmt(candle_close)} เลย level")
                tp, sl = it.get('target'), it.get('invalidation')
                if tp or sl:
                    lines.append(f"เป้า: {fmt(tp) if tp else '-'} | Invalidation: {fmt(sl) if sl else '-'}")
                size = sizing_line(price, sl, cfg)
                if size:
                    lines.append(size)
                if it['extra']:
                    lines.append(it['extra'])
                direction = 'long' if it['side'] == 'above' else 'short'
                msgs.append((key, '\n'.join(lines) + foot,
                             _signal_record(it, price, strategy, direction, asset_id)))

        elif it['kind'] in ('zone_touch', 'band_touch', 'round_wall'):
            if abs(price - level) <= max(3.0, ZONE_TOUCH_ATR * atr):
                emoji = '🧱' if it['kind'] == 'round_wall' else \
                    ('🔵' if 'long' in it.get('action', '') else '🟠')
                if it['kind'] == 'round_wall':
                    what = f"แตะ {it.get('label', 'Round')} + OI หนา"
                elif it['kind'] == 'band_touch':
                    what = f"แตะแบนด์ {it.get('label', '')}"
                else:
                    what = f"แตะโซน {it.get('action', 'fade')}"
                lines = [f"{emoji} <b>{name} {what}</b> ที่ {fmt(level)} → {it.get('action', 'fade')}",
                         f"ราคา {fmt(price)}",
                         f"เป้า: {fmt(it['target']) if it.get('target') else '-'} | SL: {fmt(it['invalidation']) if it.get('invalidation') else '-'}"
                         + (f" | RR {it['rr']:g}" if it.get('rr') else '')]
                size = sizing_line(price, it.get('invalidation'), cfg)
                if size:
                    lines.append(size)
                if it['extra']:
                    prefix = '' if it['kind'] == 'round_wall' else 'Confluence: '
                    lines.append(f"{prefix}{it['extra']}")
                if not it.get('aligned', True):
                    lines.append('⚠️ fade สวน regime trending วันนี้ — ลดขนาด/รอ confirm')
                direction = 'long' if 'long' in it.get('action', '') else 'short'
                msgs.append((key, '\n'.join(lines) + foot,
                             _signal_record(it, price, strategy, direction, asset_id)))

        elif it['kind'] == 'approach':
            dist = abs(price - level)
            if max(3.0, ZONE_TOUCH_ATR * atr) < dist <= APPROACH_ATR * atr:
                side_txt = 'เหนือราคา' if level > price else 'ใต้ราคา'
                msgs.append((key,
                             f"⚠️ <b>{name} เข้าใกล้ level {fmt(level)}</b> ({it['label']}, {side_txt} {fmt(dist)} pts)\n"
                             f"ราคา {fmt(price)}\nSources: {it['extra']}" + foot,
                             _signal_record(it, price, strategy, None, asset_id)))

    return msgs


def run_asset(asset_id, cfg, state, args):
    """Watch one asset; returns number of alerts sent."""
    dir_ = REPO_ROOT / 'data' / cfg['subdir'] if cfg['subdir'] else REPO_ROOT / 'data'
    strategy = load_json(dir_ / 'daily_strategy.json')
    if not strategy:
        print(f'[WATCH:{asset_id}] no daily_strategy.json — skipped')
        return 0

    day = utcnow().strftime('%Y-%m-%d')
    gen = strategy.get('generated_at')
    try:
        age_h = (utcnow() - datetime.fromisoformat(gen)).total_seconds() / 3600
    except (TypeError, ValueError):
        age_h = None
    if age_h is None or age_h > STALE_HOURS:
        key = f'{asset_id}:{day}:stale'
        print(f'[WATCH:{asset_id}] strategy stale (age={age_h and round(age_h, 1)}h) — no signals.')
        if not already_alerted(state, key):
            send_telegram(f"⚠️ <b>{cfg['label']} watcher</b>: daily_strategy.json เก่า "
                          f'{round(age_h or 0)} ชม. — งดส่งสัญญาณจนกว่า pipeline จะอัปเดต',
                          dry_run=args.dry_run)
            mark_alerted(state, key)
        return 0

    price = args.price or fetch_price(cfg)
    if not price:
        print(f'[WATCH:{asset_id}] no live price available — skipped')
        return 0
    # Confirm breakouts on the last completed 15m close (price override in
    # tests doubles as the close so simulations behave like before).
    candle_close = args.price or fetch_last_closed_15m(cfg['yahoo'])
    print(f"[WATCH:{asset_id}] price {price} | 15m close {candle_close} "
          f"| strategy age {round(age_h, 1)}h")

    items, atr = build_watch_items(strategy)
    print(f'[WATCH:{asset_id}] watching {len(items)} items (move basis {atr})')
    msgs = check_items(asset_id, cfg, price, items, atr, strategy, state,
                       candle_close=candle_close)

    sent = 0
    for key, text, record in msgs:
        if send_telegram(text, dry_run=args.dry_run):
            mark_alerted(state, key)
            sent += 1
            if not args.dry_run:
                log_signal(record, dir_ / 'signal_log.json')

    state.setdefault('last_price', {})
    if isinstance(state['last_price'], dict):
        state['last_price'][asset_id] = price
    else:
        state['last_price'] = {asset_id: price}
    return sent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='print alerts instead of sending')
    ap.add_argument('--price', type=float, default=None, help='override live price (testing)')
    ap.add_argument('--asset', choices=[*ASSETS, 'all'], default='all',
                    help='watch one asset only (mainly for --price tests)')
    ap.add_argument('--test-message', action='store_true',
                    help='send a Telegram connectivity test message and exit')
    args = ap.parse_args()

    if args.test_message:
        parts = []
        for aid, cfg in ASSETS.items():
            p = fetch_price(cfg)
            parts.append(f"{cfg['label']} {fmt(p) if p else 'n/a'}")
        ok = send_telegram(
            '✅ <b>Price Watcher — ทดสอบการเชื่อมต่อ</b>\n'
            f"ระบบส่งสัญญาณทำงานปกติ | {' | '.join(parts)}\n"
            '<i>ข้อความนี้มาจากปุ่ม Run workflow (test_message)</i>',
            dry_run=args.dry_run)
        print(f'[WATCH] test message sent ok={ok}')
        return 0 if ok else 1

    # CME closes Fri 21:00 UTC, reopens Sun 22:00 UTC — Saturday is always dead.
    if utcnow().weekday() == 5:
        print('[WATCH] Saturday — market closed, skipping.')
        return 0

    state = load_state()
    total = 0
    assets = ASSETS if args.asset == 'all' else {args.asset: ASSETS[args.asset]}
    for asset_id, cfg in assets.items():
        try:
            total += run_asset(asset_id, cfg, state, args)
        except Exception as e:
            print(f'[WATCH:{asset_id}] failed: {e}')
    save_state(state)
    print(f'[WATCH] done — {total} alert(s).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
