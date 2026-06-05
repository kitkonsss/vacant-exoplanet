# Snapshot vol2vol (gamma) + OI heatmap data with DATE STAMPS for backtesting.
#
# Problem this solves:
#   quikstrike_scraper.py OVERWRITES data/{prefix}_OIHeatmap.json /
#   data/{prefix}_GammaHeatmap.json / data/GammaMatrix.json on every run, so the
#   only history is scattered through git. That makes it painful to answer the one
#   question that matters: "did price actually travel to the OI / vol2vol wall that
#   was standing on day X?"
#
# What it produces (all under data/snapshots/):
#   <YYYY-MM-DD>/<prefix>_OIHeatmap.json     raw OI heatmap copy (the walls)
#   <YYYY-MM-DD>/<prefix>_GammaHeatmap.json  raw vol2vol / gamma heatmap copy
#   <YYYY-MM-DD>/GammaMatrix.json            raw cross-DTE gamma matrix copy
#   oi_levels_history.json                   compact, append/update — ONE record per
#                                            (settlement_date, asset, prefix) holding
#                                            underlying price + the top OI/gamma walls.
#                                            This flat list IS the backtest dataset.
#
# Keying:
#   The snapshot is keyed by the latest SETTLEMENT date in the heatmap (dates[0]),
#   NOT the wall-clock run time. So re-running the scraper several times the same
#   trading day just refreshes that day's record instead of piling up duplicates,
#   and weekends/holidays (no new settlement) add nothing.
#
# Retention:
#   Dated raw folders older than QS_SNAPSHOT_KEEP_DAYS (default 30, floor 5) are
#   pruned. The compact oi_levels_history.json is NEVER pruned — it is tiny
#   (~1 KB/record) and is the whole point.
#
# Runs standalone, no deps beyond stdlib. Cross-platform (resolves data/ from this
# file's location, so cwd doesn't matter). Wired into .github/workflows/scrape.yml
# right after the scraper step.

import os
import re
import sys
import json
import shutil
from datetime import datetime, timezone

# data/ lives next to scraper/ — resolve from this file so cwd is irrelevant.
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
SNAP_DIR = os.path.join(DATA_DIR, 'snapshots')
HISTORY_PATH = os.path.join(SNAP_DIR, 'oi_levels_history.json')

# How many dated RAW folders to keep. The user asked for "at least 5 days"; keep a
# month by default so there is headroom for backtests. Floor at 5 so a bad env var
# can't shrink it below the requirement.
KEEP_DAYS = max(5, int(os.environ.get('QS_SNAPSHOT_KEEP_DAYS', '30') or '30'))

# How many walls to record per side in the compact summary.
TOP_N = 8

DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _num(v):
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def _iso_from_us_date(s):
    """'6/4/2026' -> '2026-06-04'. Returns None if it can't be parsed."""
    if not s or not isinstance(s, str):
        return None
    try:
        dt = datetime.strptime(s.strip(), '%m/%d/%Y')
        return dt.strftime('%Y-%m-%d')
    except ValueError:
        return None


def _latest_value(values):
    """First non-null in a newest-first heatmap row (= latest settlement value)."""
    for v in values or []:
        n = _num(v)
        if n is not None:
            return n
    return None


def _top_walls(heatmap, value_label):
    """Top strikes by latest value, split above/below the underlying.

    Returns a dict with: top (overall, desc by value), nearest_above, nearest_below,
    max_above, max_below — everything you need to ask 'did price reach the wall?'.
    """
    price = _num(heatmap.get('underlying'))
    rows = []
    for row in heatmap.get('strikes') or []:
        strike = _num(row.get('strike'))
        latest = _latest_value(row.get('values') or [])
        if strike is None or latest is None or latest <= 0:
            continue
        if price is None:
            side = 'unknown'
            dist_pts = None
            dist_pct = None
        elif strike > price:
            side = 'above'
            dist_pts = round(strike - price, 4)
            dist_pct = round((strike - price) / price * 100, 4)
        elif strike < price:
            side = 'below'
            dist_pts = round(strike - price, 4)
            dist_pct = round((strike - price) / price * 100, 4)
        else:
            side = 'at_price'
            dist_pts = 0.0
            dist_pct = 0.0
        rows.append({
            'strike': strike,
            value_label: round(latest, 4),
            'side': side,
            'distance_points': dist_pts,
            'distance_pct': dist_pct,
        })

    by_value = sorted(rows, key=lambda r: r[value_label], reverse=True)
    above = [r for r in rows if r['side'] == 'above']
    below = [r for r in rows if r['side'] == 'below']

    def _nearest(side_rows):
        # smallest absolute distance from price
        cand = [r for r in side_rows if r['distance_points'] is not None]
        return min(cand, key=lambda r: abs(r['distance_points'])) if cand else None

    def _max(side_rows):
        return max(side_rows, key=lambda r: r[value_label]) if side_rows else None

    return {
        'top': by_value[:TOP_N],
        'nearest_above': _nearest(above),
        'nearest_below': _nearest(below),
        'max_above': _max(above),
        'max_below': _max(below),
    }


def _discover_prefixes(data_dir):
    """Prefixes that have an OI heatmap, e.g. ['current','tomorrow','friday','monthly']."""
    out = []
    for fn in sorted(os.listdir(data_dir)):
        if fn.endswith('_OIHeatmap.json'):
            out.append(fn[:-len('_OIHeatmap.json')])
    return out


def _load_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f'[SNAPSHOT] WARN: could not read {os.path.basename(path)}: {e}')
        return None


def _build_record(prefix, oi_hm, gamma_hm, run_utc):
    """Compact backtest record for one (settlement_date, asset, prefix)."""
    settlement = None
    dates = oi_hm.get('dates') or []
    if dates:
        settlement = _iso_from_us_date(dates[0])

    rec = {
        'snapshot_date': settlement,                 # latest settlement date (ISO)
        'captured_run_utc': run_utc,                 # when this snapshot ran
        'asset': oi_hm.get('asset'),
        'prefix': prefix,
        'contract': oi_hm.get('contract'),
        'underlying': _num(oi_hm.get('underlying')),
        'latest_settlement_date_raw': dates[0] if dates else None,
        'oi_walls': _top_walls(oi_hm, 'oi'),
    }
    if gamma_hm:
        rec['gamma_walls'] = _top_walls(gamma_hm, 'gamma')
    return rec


def _update_history(records):
    """Append/replace records in the flat history, deduped on (date, asset, prefix)."""
    existing = _load_json(HISTORY_PATH)
    if isinstance(existing, dict) and isinstance(existing.get('records'), list):
        rows = existing['records']
    else:
        rows = []

    def key(r):
        return (r.get('snapshot_date'), r.get('asset'), r.get('prefix'))

    new_keys = {key(r) for r in records}
    rows = [r for r in rows if key(r) not in new_keys]
    rows.extend(records)
    # Sort newest settlement first, then asset/prefix for stable diffs.
    rows.sort(key=lambda r: (r.get('snapshot_date') or '', r.get('asset') or '',
                             r.get('prefix') or ''), reverse=True)

    payload = {
        'schema': 1,
        'description': ('Daily backtest record of where the OI / vol2vol (gamma) '
                        'walls stood vs the underlying price, so you can later check '
                        'whether price actually reached them. One record per '
                        '(snapshot_date, asset, prefix).'),
        'updated_utc': records[0]['captured_run_utc'] if records else None,
        'records': rows,
    }
    with open(HISTORY_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return len(rows)


def _prune(keep_days):
    """Delete dated raw folders beyond the newest keep_days."""
    folders = [d for d in os.listdir(SNAP_DIR)
               if DATE_RE.match(d) and os.path.isdir(os.path.join(SNAP_DIR, d))]
    folders.sort(reverse=True)               # newest first
    for d in folders[keep_days:]:
        shutil.rmtree(os.path.join(SNAP_DIR, d), ignore_errors=True)
        print(f'[SNAPSHOT] Pruned old snapshot {d}')


def main():
    if not os.path.isdir(DATA_DIR):
        print(f'[SNAPSHOT] data dir not found: {DATA_DIR}')
        return 1

    prefixes = _discover_prefixes(DATA_DIR)
    if not prefixes:
        print('[SNAPSHOT] No *_OIHeatmap.json found — nothing to snapshot.')
        return 0

    os.makedirs(SNAP_DIR, exist_ok=True)
    run_utc = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    records = []
    # Determine ONE folder date = most recent settlement across all OI heatmaps,
    # falling back to today's UTC date if none parse.
    folder_date = None

    per_prefix = []
    for prefix in prefixes:
        oi_path = os.path.join(DATA_DIR, f'{prefix}_OIHeatmap.json')
        gamma_path = os.path.join(DATA_DIR, f'{prefix}_GammaHeatmap.json')
        oi_hm = _load_json(oi_path)
        if not oi_hm:
            continue
        gamma_hm = _load_json(gamma_path)
        rec = _build_record(prefix, oi_hm, gamma_hm, run_utc)
        records.append(rec)
        per_prefix.append((prefix, oi_path, gamma_path, rec.get('snapshot_date')))
        if rec.get('snapshot_date'):
            folder_date = max(folder_date, rec['snapshot_date']) if folder_date else rec['snapshot_date']

    if not records:
        print('[SNAPSHOT] OI heatmaps present but unreadable — nothing to snapshot.')
        return 0

    folder_date = folder_date or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    day_dir = os.path.join(SNAP_DIR, folder_date)
    os.makedirs(day_dir, exist_ok=True)

    # Copy raw heatmaps for the day (overwrite same-day on re-run).
    copied = 0
    for prefix, oi_path, gamma_path, _ in per_prefix:
        shutil.copy2(oi_path, os.path.join(day_dir, f'{prefix}_OIHeatmap.json'))
        copied += 1
        if os.path.isfile(gamma_path):
            shutil.copy2(gamma_path, os.path.join(day_dir, f'{prefix}_GammaHeatmap.json'))
            copied += 1
    matrix_path = os.path.join(DATA_DIR, 'GammaMatrix.json')
    if os.path.isfile(matrix_path):
        shutil.copy2(matrix_path, os.path.join(day_dir, 'GammaMatrix.json'))
        copied += 1

    total = _update_history(records)
    _prune(KEEP_DAYS)

    print(f'[SNAPSHOT] {folder_date}: archived {copied} raw files for '
          f'{len(records)} contract(s) [{", ".join(p for p, *_ in per_prefix)}]')
    print(f'[SNAPSHOT] oi_levels_history.json now holds {total} record(s), '
          f'keeping {KEEP_DAYS} days of raw folders')
    return 0


if __name__ == '__main__':
    sys.exit(main())
