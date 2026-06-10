#!/usr/bin/env python3
"""Wall backtest: does the system's core hypothesis hold historically?

The OI heatmap matrices (current files + dated copies under data/snapshots/)
give per-strike, per-day open interest going back as far as the archive
reaches. This script replays them: for each historical day D it rebuilds the
top OI walls around that day's close (exactly how the live system finds
levels) and then checks what price ACTUALLY did on D+1:

  - touch rate    : how often price reached the nearest wall
  - respect rate  : of touches, how often price failed to CLOSE beyond the
                    wall (the tradable fade stat)
  - break rate    : of touches, how often the wall gave way
  - magnet pull   : when the biggest OI pile sat above/below price, how often
                    the next close moved toward it

All rates ship with Wilson 95% CIs and the sample size — small n is reported,
never hidden. Caveats are written into the output: price series is the
yfinance front-month (roll gaps possible), OI is end-of-day.

Dependencies: stdlib + yfinance.
  python scraper/backtest_walls.py
"""

import glob
import json
import math
import os
import sys
from datetime import datetime, timezone

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
CONTRACT_KEYS = ('current', 'tomorrow', 'friday', 'monthly')

# Per-asset: tolerance scales with price (~0.1%); GC ~5 pts, NQ ~25 pts.
ASSETS = {
    'gc': {'subdir': '', 'yahoo': 'GC=F', 'tol_points': 5.0},
    'nq': {'subdir': 'nq', 'yahoo': 'NQ=F', 'tol_points': 25.0},
}

WALL_WINDOW_PCT = 0.06    # consider strikes within +/-6% of that day's close
TOP_N_WALLS = 5


def wilson_ci(wins, n, z=1.96):
    if n <= 0:
        return None
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3)]


def _date_iso(us_date):
    """'6/9/2026' -> '2026-06-09'."""
    try:
        m, d, y = (int(x) for x in str(us_date).split('/'))
        return f'{y:04d}-{m:02d}-{d:02d}'
    except (TypeError, ValueError):
        return None


def load_heatmap_matrix(path, day_oi):
    """Accumulate {date_iso: {strike: oi_sum}} from one heatmap file."""
    try:
        with open(path, encoding='utf-8') as f:
            h = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    dates = [_date_iso(d) for d in h.get('dates') or []]
    for row in h.get('strikes') or []:
        strike = row.get('strike')
        values = row.get('values') or []
        if strike is None:
            continue
        for di, val in zip(dates, values):
            if di and val:
                day_oi.setdefault(di, {})[float(strike)] = \
                    day_oi.get(di, {}).get(float(strike), 0) + float(val)


def collect_day_oi(dir_):
    """Merge current heatmap files + all dated snapshot copies."""
    day_oi = {}
    paths = [os.path.join(dir_, f'{k}_OIHeatmap.json') for k in CONTRACT_KEYS]
    paths += glob.glob(os.path.join(dir_, 'snapshots', '*', '*_OIHeatmap.json'))
    for p in paths:
        load_heatmap_matrix(p, day_oi)
    return day_oi


def fetch_daily_candles(yahoo_symbol):
    """Unadjusted front-month daily candles {date_iso: (o, h, l, c)}."""
    import yfinance as yf
    hist = yf.Ticker(yahoo_symbol).history(period='6mo', interval='1d')
    out = {}
    for ts, row in hist.iterrows():
        out[ts.strftime('%Y-%m-%d')] = (float(row['Open']), float(row['High']),
                                        float(row['Low']), float(row['Close']))
    return out


def run_asset(asset_id, cfg):
    dir_ = os.path.join(BASE_DIR, cfg['subdir']) if cfg['subdir'] else BASE_DIR
    out_path = os.path.join(dir_, 'wall_backtest.json')
    TOL_POINTS = cfg['tol_points']

    day_oi = collect_day_oi(dir_)
    if not day_oi:
        print(f'[BT:{asset_id}] no heatmap data found — skipped')
        return False
    candles = fetch_daily_candles(cfg['yahoo'])
    if not candles:
        print(f'[BT:{asset_id}] no price data from yfinance — skipped')
        return False

    trade_days = sorted(set(day_oi) & set(candles))
    stats = {
        'touch_above': 0, 'respect_above': 0,
        'touch_below': 0, 'respect_below': 0,
        'days_with_wall_above': 0, 'days_with_wall_below': 0,
        'magnet_total': 0, 'magnet_hit': 0,
    }
    evaluated = []

    candle_days = sorted(candles)
    for d in trade_days:
        # next trading day with a candle
        later = [x for x in candle_days if x > d]
        if not later:
            continue
        d1 = later[0]
        close_d = candles[d][3]
        _, high1, low1, close1 = candles[d1]

        strikes = day_oi[d]
        near = {s: oi for s, oi in strikes.items()
                if abs(s - close_d) <= close_d * WALL_WINDOW_PCT}
        if not near:
            continue
        walls = sorted(near.items(), key=lambda kv: -kv[1])[:TOP_N_WALLS]
        above = sorted((s for s, _ in walls if s > close_d))
        below = sorted((s for s, _ in walls if s < close_d), reverse=True)

        rec = {'date': d, 'close': close_d, 'next': d1}
        if above:
            wall = above[0]
            stats['days_with_wall_above'] += 1
            if high1 >= wall - TOL_POINTS:
                stats['touch_above'] += 1
                respected = close1 <= wall + TOL_POINTS
                stats['respect_above'] += 1 if respected else 0
                rec['above'] = {'wall': wall, 'touched': True, 'respected': respected}
        if below:
            wall = below[0]
            stats['days_with_wall_below'] += 1
            if low1 <= wall + TOL_POINTS:
                stats['touch_below'] += 1
                respected = close1 >= wall - TOL_POINTS
                stats['respect_below'] += 1 if respected else 0
                rec['below'] = {'wall': wall, 'touched': True, 'respected': respected}

        biggest = max(walls, key=lambda kv: kv[1])[0]
        if abs(biggest - close_d) > TOL_POINTS:
            stats['magnet_total'] += 1
            pulled = (close1 > close_d) if biggest > close_d else (close1 < close_d)
            stats['magnet_hit'] += 1 if pulled else 0
        evaluated.append(rec)

    touches = stats['touch_above'] + stats['touch_below']
    respects = stats['respect_above'] + stats['respect_below']
    wall_days = stats['days_with_wall_above'] + stats['days_with_wall_below']

    out = {
        'asset': asset_id.upper(),
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'days_evaluated': len(evaluated),
        'date_range': [trade_days[0], trade_days[-1]] if trade_days else None,
        'params': {'tolerance_points': TOL_POINTS, 'wall_window_pct': WALL_WINDOW_PCT,
                   'top_n_walls': TOP_N_WALLS},
        'touch': {
            'n_wall_days': wall_days, 'touched': touches,
            'rate': round(touches / wall_days, 3) if wall_days else None,
            'ci95': wilson_ci(touches, wall_days),
        },
        'respect_given_touch': {
            'n_touches': touches, 'respected': respects,
            'rate': round(respects / touches, 3) if touches else None,
            'ci95': wilson_ci(respects, touches),
            'meaning': 'price reached the nearest top-5 OI wall and failed to close beyond it '
                       '(the fade-at-wall stat)',
        },
        'break_given_touch': {
            'rate': round(1 - respects / touches, 3) if touches else None,
        },
        'magnet_pull': {
            'n': stats['magnet_total'], 'hits': stats['magnet_hit'],
            'rate': round(stats['magnet_hit'] / stats['magnet_total'], 3) if stats['magnet_total'] else None,
            'ci95': wilson_ci(stats['magnet_hit'], stats['magnet_total']),
            'meaning': 'next close moved toward the single biggest OI pile',
        },
        'caveats': [
            'price = yfinance front-month, unadjusted; days around contract rolls can distort',
            'OI is end-of-day; intraday wall migration is invisible at this resolution',
            'sample grows by one day per trading day as snapshots accumulate — '
            'treat small n honestly via the CIs',
        ],
        'daily_records': evaluated[-30:],
    }

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
        f.write('\n')

    print(f"[BT:{asset_id}] {len(evaluated)} days ({out['date_range']})")
    print(f"[BT:{asset_id}] touch rate {out['touch']['rate']} (n={wall_days}, ci {out['touch']['ci95']})")
    print(f"[BT:{asset_id}] respect|touch {out['respect_given_touch']['rate']} "
          f"(n={touches}, ci {out['respect_given_touch']['ci95']})")
    print(f"[BT:{asset_id}] magnet pull {out['magnet_pull']['rate']} "
          f"(n={stats['magnet_total']}, ci {out['magnet_pull']['ci95']})")
    print(f'[BT:{asset_id}] wrote {out_path}')
    return True


def main():
    any_ok = False
    for asset_id, cfg in ASSETS.items():
        try:
            any_ok = run_asset(asset_id, cfg) or any_ok
        except Exception as e:
            print(f'[BT:{asset_id}] failed: {e}')
    return 0 if any_ok else 1


if __name__ == '__main__':
    sys.exit(main())
