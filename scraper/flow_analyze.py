#!/usr/bin/env python3
"""Intraday option-flow analyzer (Phase 2a) — flow from snapshot deltas.

The Vol2Vol Intraday Volume view is scraped every ~10 minutes (light mode).
Each run this script appends the per-strike call/put volume snapshot to a
rolling store (data/flow_history.json, pruned to FLOW_KEEP_HOURS) and then
differences snapshots to answer the question OI can't: WHERE IS VOLUME
HITTING RIGHT NOW?

Outputs data/option_flow.json:
  - windows last_10m / last_1h / session (since CME open 22:00 UTC):
    call/put contracts added, above/below-spot split, top active strikes
  - flow_magnet: volume-weighted strike of fresh 1h flow vs spot
  - imbalance: directional read from where flow concentrates
  - wall_activity: fresh volume landing ON the strategy's walls
    (confluence levels) — a wall being traded is a wall being decided

Volume is unsigned (no aggressor side on this view), so reads are about
LOCATION and INTENSITY of flow, not buyer/seller initiative — stated in the
output so the LLM brief doesn't over-claim.

Dependencies: Python stdlib only.
  python scraper/flow_analyze.py
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

ASSETS = {
    'gc': {'subdir': ''},
    'nq': {'subdir': 'nq'},
}

CONTRACT_KEYS = ('current', 'tomorrow', 'friday', 'monthly')
FLOW_KEEP_HOURS = 36        # rolling history horizon
SESSION_OPEN_UTC = 22       # CME Globex daily open 17:00 CT = 22:00 UTC (CDT)
TOP_N = 8


def utcnow():
    return datetime.now(timezone.utc)


def _num(x):
    try:
        return float(str(x).replace(',', ''))
    except (TypeError, ValueError):
        return None


def parse_intraday(path):
    """One *_IntradayData.txt -> {symbol, fut, strikes:{strike:[call,put]}}."""
    try:
        with open(path, encoding='utf-8') as f:
            lines = [ln.strip() for ln in f if ln.strip()]
    except OSError:
        return None
    if len(lines) < 2:
        return None
    header = lines[0]
    fut = _num((re.search(r'FutPrc:\s*([\d.,]+)', header) or [None, None])[1])
    sym = (re.search(r'Option Symbol:\s*(\S+)', header) or [None, None])[1]
    strikes = {}
    for ln in lines[1:]:
        parts = ln.split(',')
        if len(parts) < 3 or parts[0].lower() == 'strike':
            continue
        s, c, p = _num(parts[0]), _num(parts[1]) or 0, _num(parts[2]) or 0
        if s is not None and (c or p):          # keep only strikes with volume
            strikes[f'{s:g}'] = [int(c), int(p)]
    if fut is None:
        return None
    return {'symbol': sym, 'fut': fut, 'strikes': strikes}


def load_history(history_path):
    try:
        with open(history_path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {'snapshots': []}


def save_history(history_path, hist):
    cutoff = (utcnow() - timedelta(hours=FLOW_KEEP_HOURS)).isoformat()
    hist['snapshots'] = [s for s in hist['snapshots'] if s['ts'] >= cutoff]
    with open(history_path, 'w', encoding='utf-8') as f:
        json.dump(hist, f, separators=(',', ':'))
        f.write('\n')


def take_snapshot(dir_):
    contracts = {}
    for key in CONTRACT_KEYS:
        parsed = parse_intraday(os.path.join(dir_, f'{key}_IntradayData.txt'))
        if parsed:
            contracts[key] = parsed
    if not contracts:
        return None
    return {'ts': utcnow().isoformat(timespec='seconds'), 'contracts': contracts}


def snapshot_at(history, target_dt):
    """Most recent snapshot at-or-before target_dt, or None."""
    best = None
    for s in history['snapshots']:
        if datetime.fromisoformat(s['ts']) <= target_dt:
            best = s
    return best


def diff_snapshots(cur, prev):
    """Per-strike volume added between two snapshots (clamped >= 0 so a
    daily volume reset becomes a fresh baseline instead of a negative)."""
    rows = []
    for key, cc in cur['contracts'].items():
        pc = (prev or {}).get('contracts', {}).get(key, {'strikes': {}})
        pstrikes = pc.get('strikes', {})
        for strike, (c, p) in cc['strikes'].items():
            pcall, pput = pstrikes.get(strike, [0, 0])
            dc, dp = max(0, c - pcall), max(0, p - pput)
            if dc or dp:
                rows.append({'contract': key, 'symbol': cc.get('symbol'),
                             'strike': float(strike), 'call_added': dc, 'put_added': dp})
    return rows


def summarize(rows, spot):
    call_add = sum(r['call_added'] for r in rows)
    put_add = sum(r['put_added'] for r in rows)
    above = sum(r['call_added'] + r['put_added'] for r in rows if r['strike'] > spot)
    below = sum(r['call_added'] + r['put_added'] for r in rows if r['strike'] < spot)
    top = sorted(rows, key=lambda r: -(r['call_added'] + r['put_added']))[:TOP_N]
    for t in top:
        t['side'] = 'above' if t['strike'] > spot else 'below'
        t['distance_points'] = round(t['strike'] - spot, 1)
    return {
        'call_added': call_add, 'put_added': put_add, 'total_added': call_add + put_add,
        'added_above_spot': above, 'added_below_spot': below,
        'top_strikes': top,
    }


def flow_magnet(rows, spot):
    total = sum(r['call_added'] + r['put_added'] for r in rows)
    if total < 20:                       # too thin to mean anything
        return None
    vw = sum((r['call_added'] + r['put_added']) * r['strike'] for r in rows) / total
    return {'strike': round(vw, 1), 'side': 'above' if vw > spot else 'below',
            'distance_points': round(vw - spot, 1), 'total_volume': total}


def imbalance(summary):
    total = summary['total_added']
    if total < 20:
        return {'score': 0, 'label': 'thin', 'note': f'only {total} contracts in window'}
    above_share = summary['added_above_spot'] / total
    below_share = summary['added_below_spot'] / total
    score = round(max(-10, min(10, (above_share - below_share) * 20)), 1)
    label = 'upside_flow' if score >= 3 else ('downside_flow' if score <= -3 else 'balanced')
    return {'score': score, 'label': label,
            'above_share': round(above_share, 2), 'below_share': round(below_share, 2)}


def wall_activity(rows, strategy, spot):
    """Fresh volume landing exactly on the strategy's confluence walls."""
    walls = {}
    for c in (strategy or {}).get('confluence_levels') or []:
        if c.get('level'):
            walls[float(c['level'])] = {'sources': c.get('sources') or [],
                                        'confluence': c.get('confluence')}
    if not walls:
        return []
    total = sum(r['call_added'] + r['put_added'] for r in rows) or 1
    out = []
    for level, meta in walls.items():
        vol = sum(r['call_added'] + r['put_added'] for r in rows if r['strike'] == level)
        if vol:
            out.append({'strike': level, 'added': vol,
                        'share_pct': round(100 * vol / total, 1),
                        'side': 'above' if level > spot else 'below',
                        'distance_points': round(level - spot, 1),
                        'confluence': meta['confluence'], 'sources': meta['sources']})
    out.sort(key=lambda w: -w['added'])
    return out[:TOP_N]


def run_asset(asset_id, cfg):
    dir_ = os.path.join(BASE_DIR, cfg['subdir']) if cfg['subdir'] else BASE_DIR
    history_path = os.path.join(dir_, 'flow_history.json')
    out_path = os.path.join(dir_, 'option_flow.json')
    strategy_path = os.path.join(dir_, 'daily_strategy.json')

    snap = take_snapshot(dir_)
    if not snap:
        print(f'[FLOW:{asset_id}] no intraday data files — skipped')
        return False

    history = load_history(history_path)
    now = utcnow()
    spot = (snap['contracts'].get('current') or next(iter(snap['contracts'].values())))['fut']

    prev = history['snapshots'][-1] if history['snapshots'] else None
    prev_1h = snapshot_at(history, now - timedelta(hours=1))
    # session anchor: most recent 22:00 UTC boundary (CME Globex open)
    open_dt = now.replace(hour=SESSION_OPEN_UTC, minute=0, second=0, microsecond=0)
    if open_dt > now:
        open_dt -= timedelta(days=1)
    prev_open = snapshot_at(history, open_dt)

    windows = {}
    for name, base in (('last_10m', prev), ('last_1h', prev_1h), ('session', prev_open)):
        if base is None:
            windows[name] = None
            continue
        rows = diff_snapshots(snap, base)
        s = summarize(rows, spot)
        s['since'] = base['ts']
        windows[name] = s

    rows_1h = diff_snapshots(snap, prev_1h) if prev_1h else []
    strategy = None
    try:
        with open(strategy_path, encoding='utf-8') as f:
            strategy = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass

    out = {
        'asset': asset_id.upper(),
        'generated_at': snap['ts'],
        'future_price': spot,
        'method': 'Successive Vol2Vol intraday-volume snapshot deltas (~10 min cadence). '
                  'Volume is unsigned — reads describe location/intensity of flow, '
                  'not aggressor side.',
        'snapshots_in_history': len(history['snapshots']) + 1,
        'windows': windows,
        'flow_magnet_1h': flow_magnet(rows_1h, spot),
        'imbalance_1h': imbalance(windows['last_1h']) if windows['last_1h'] else None,
        'wall_activity_1h': wall_activity(rows_1h, strategy, spot),
    }

    history['snapshots'].append(snap)
    save_history(history_path, hist=history)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
        f.write('\n')

    w1h = windows['last_1h']
    if w1h:
        print(f"[FLOW:{asset_id}] 1h: +{w1h['call_added']}C/+{w1h['put_added']}P "
              f"(above {w1h['added_above_spot']} / below {w1h['added_below_spot']}) "
              f"| magnet {out['flow_magnet_1h'] and out['flow_magnet_1h']['strike']} "
              f"| {out['imbalance_1h'] and out['imbalance_1h']['label']}")
    else:
        print(f"[FLOW:{asset_id}] warming up — {out['snapshots_in_history']} snapshot(s) stored")
    print(f'[FLOW:{asset_id}] wrote {out_path}')
    return True


def main():
    any_ok = False
    for asset_id, cfg in ASSETS.items():
        try:
            any_ok = run_asset(asset_id, cfg) or any_ok
        except Exception as e:
            print(f'[FLOW:{asset_id}] failed: {e}')
    return 0 if any_ok else 1


if __name__ == '__main__':
    sys.exit(main())
