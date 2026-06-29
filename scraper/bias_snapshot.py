#!/usr/bin/env python3
"""Archive Position Bias dashboard snapshots by Bangkok day/session slot.

Why this exists:
  *_PositionBias.json and position_bias_summary.json are overwritten on every
  scrape. That is fine for the live dashboard, but it makes it impossible to
  test questions like "has P/C stayed put-heavy for several sessions while
  price kept falling?"

What it produces:
  data/bias_snapshots/<YYYY-MM-DD>/<slot>/<asset>_position_bias_summary.json
  data/bias_snapshots/<YYYY-MM-DD>/<slot>/<asset>_<contract>_PositionBias.json
  data/bias_snapshots/bias_history.json

Slots are Bangkok time: morning / afternoon / evening / night. Re-running
within the same slot overwrites the raw files and replaces that slot's compact
records, so high-frequency intraday scrapes do not create noisy duplicates.
"""

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone, timedelta

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, 'data')
SNAPSHOT_DIR = os.path.join(DATA_DIR, 'bias_snapshots')
HISTORY_PATH = os.path.join(SNAPSHOT_DIR, 'bias_history.json')

ASSETS = {
    'gc': {'short': 'GC', 'subdir': ''},
    'nq': {'short': 'NQ', 'subdir': 'nq'},
}

CONTRACT_RE = re.compile(r'^(?P<key>.+)_PositionBias\.json$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
BANGKOK_TZ = timezone(timedelta(hours=7))
KEEP_DAYS = max(10, int(os.environ.get('BIAS_SNAPSHOT_KEEP_DAYS', '60') or '60'))


def _load_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f'[BIAS-SNAPSHOT] WARN: could not read {path}: {e}')
        return None


def _write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
        f.write('\n')


def _parse_now(value):
    if not value:
        return datetime.now(timezone.utc)
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def slot_for(dt_utc):
    """Return (date_bangkok, slot, captured_at_bangkok_iso)."""
    local = dt_utc.astimezone(BANGKOK_TZ)
    hour = local.hour
    if 5 <= hour < 11:
        slot = 'morning'
    elif 11 <= hour < 16:
        slot = 'afternoon'
    elif 16 <= hour < 19:
        slot = 'evening'
    else:
        slot = 'night'
    return local.strftime('%Y-%m-%d'), slot, local.isoformat(timespec='seconds')


def _asset_dir(data_dir, asset_id):
    subdir = ASSETS[asset_id]['subdir']
    return os.path.join(data_dir, subdir) if subdir else data_dir


def _discover_contracts(asset_dir):
    out = []
    try:
        names = sorted(os.listdir(asset_dir))
    except OSError:
        return out
    for name in names:
        if name == 'position_bias_summary.json':
            continue
        m = CONTRACT_RE.match(name)
        if m:
            out.append((m.group('key'), os.path.join(asset_dir, name)))
    return out


def _compact_wall(wall):
    if not isinstance(wall, dict):
        return None
    distance = wall.get('distance') or {}
    return {
        'strike': wall.get('strike'),
        'side': wall.get('side'),
        'total_oi': wall.get('total_oi'),
        'call_oi': wall.get('call_oi'),
        'put_oi': wall.get('put_oi'),
        'intraday_volume': wall.get('intraday_volume'),
        'call_volume': wall.get('call_volume'),
        'put_volume': wall.get('put_volume'),
        'activity_vs_oi': wall.get('activity_vs_oi'),
        'distance_points': distance.get('points'),
        'distance_side': distance.get('side'),
    }


def _compact_contract(asset_id, slot_meta, payload):
    totals = payload.get('totals') or {}
    bias = payload.get('position_bias') or {}
    walls = payload.get('walls') or {}
    return {
        **slot_meta,
        'asset': asset_id,
        'asset_label': payload.get('asset') or ASSETS[asset_id]['short'],
        'contract_key': payload.get('contract_key'),
        'contract': payload.get('contract'),
        'dte': payload.get('dte'),
        'future_price': payload.get('future_price'),
        'source_generated_at': payload.get('generated_at'),
        'bias': {
            'score': bias.get('score'),
            'label': bias.get('label'),
            'drivers': bias.get('drivers') or [],
        },
        'totals': {
            'open_interest': totals.get('open_interest'),
            'call_oi': totals.get('call_oi'),
            'put_oi': totals.get('put_oi'),
            'oi_put_call_ratio': totals.get('oi_put_call_ratio'),
            'intraday_volume': totals.get('intraday_volume'),
            'call_volume': totals.get('call_volume'),
            'put_volume': totals.get('put_volume'),
            'volume_put_call_ratio': totals.get('volume_put_call_ratio'),
            'volume_vs_oi': totals.get('volume_vs_oi'),
        },
        'structure': payload.get('structure') or {},
        'walls': {
            'dominant_call': _compact_wall(walls.get('dominant_call')),
            'dominant_put': _compact_wall(walls.get('dominant_put')),
            'largest_combined_position': _compact_wall(walls.get('largest_combined_position')),
        },
    }


def _compact_summary(asset_id, slot_meta, summary):
    bias = summary.get('position_bias') or {}
    return {
        **slot_meta,
        'asset': asset_id,
        'asset_label': summary.get('asset') or ASSETS[asset_id]['short'],
        'contract_key': 'summary',
        'source_generated_at': summary.get('generated_at'),
        'bias': {
            'score': bias.get('score'),
            'label': bias.get('label'),
            'method': bias.get('method'),
        },
        'contracts': summary.get('contracts') or [],
    }


def _update_history(records, history_path):
    existing = _load_json(history_path)
    rows = existing.get('records') if isinstance(existing, dict) else []
    rows = rows if isinstance(rows, list) else []

    def key(r):
        return (
            r.get('date_bangkok'),
            r.get('slot'),
            r.get('asset'),
            r.get('contract_key'),
        )

    new_keys = {key(r) for r in records}
    rows = [r for r in rows if key(r) not in new_keys]
    rows.extend(records)
    rows.sort(key=lambda r: (
        r.get('date_bangkok') or '',
        r.get('slot_order', 0),
        r.get('asset') or '',
        r.get('contract_key') or '',
    ), reverse=True)

    payload = {
        'schema': 1,
        'description': ('Position Bias dashboard snapshots by Bangkok day/slot. '
                        'Use this to measure persistence: e.g. put-heavy P/C '
                        'across multiple slots while price trends lower.'),
        'updated_utc': records[0]['captured_at_utc'] if records else None,
        'records': rows,
    }
    _write_json(history_path, payload)
    return len(rows)


def _slot_order(slot):
    return {'morning': 1, 'afternoon': 2, 'evening': 3, 'night': 4}.get(slot, 0)


def _prune(snapshot_dir, keep_days):
    if not os.path.isdir(snapshot_dir):
        return
    folders = [d for d in os.listdir(snapshot_dir)
               if DATE_RE.match(d) and os.path.isdir(os.path.join(snapshot_dir, d))]
    folders.sort(reverse=True)
    for d in folders[keep_days:]:
        shutil.rmtree(os.path.join(snapshot_dir, d), ignore_errors=True)
        print(f'[BIAS-SNAPSHOT] Pruned old bias snapshot {d}')


def run(data_dir=DATA_DIR, snapshot_dir=SNAPSHOT_DIR, now=None, keep_days=KEEP_DAYS):
    now_utc = _parse_now(now) if isinstance(now, str) or now is None else now.astimezone(timezone.utc)
    date_bkk, slot, captured_bkk = slot_for(now_utc)
    captured_utc = now_utc.isoformat(timespec='seconds').replace('+00:00', 'Z')
    slot_meta = {
        'date_bangkok': date_bkk,
        'slot': slot,
        'slot_order': _slot_order(slot),
        'captured_at_utc': captured_utc,
        'captured_at_bangkok': captured_bkk,
    }

    day_dir = os.path.join(snapshot_dir, date_bkk, slot)
    os.makedirs(day_dir, exist_ok=True)

    records = []
    copied = 0
    for asset_id in ASSETS:
        asset_dir = _asset_dir(data_dir, asset_id)
        summary_path = os.path.join(asset_dir, 'position_bias_summary.json')
        summary = _load_json(summary_path)
        if summary:
            dst = os.path.join(day_dir, f'{asset_id}_position_bias_summary.json')
            shutil.copy2(summary_path, dst)
            copied += 1
            records.append(_compact_summary(asset_id, slot_meta, summary))

        for contract_key, path in _discover_contracts(asset_dir):
            payload = _load_json(path)
            if not payload:
                continue
            dst = os.path.join(day_dir, f'{asset_id}_{contract_key}_PositionBias.json')
            shutil.copy2(path, dst)
            copied += 1
            records.append(_compact_contract(asset_id, slot_meta, payload))

    if not records:
        print('[BIAS-SNAPSHOT] No PositionBias JSON found - nothing to snapshot.')
        return 0

    history_path = os.path.join(snapshot_dir, 'bias_history.json')
    total = _update_history(records, history_path)
    _prune(snapshot_dir, keep_days)

    assets = ', '.join(sorted({r['asset'] for r in records}))
    print(f'[BIAS-SNAPSHOT] {date_bkk} {slot}: archived {copied} file(s) for {assets}')
    print(f'[BIAS-SNAPSHOT] bias_history.json now holds {total} record(s)')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description='Snapshot Position Bias dashboard files by Bangkok time slot.')
    parser.add_argument('--data-dir', default=DATA_DIR)
    parser.add_argument('--snapshot-dir', default=SNAPSHOT_DIR)
    parser.add_argument('--now', default=None, help='Override current time, ISO-8601. Useful for tests/backfills.')
    parser.add_argument('--keep-days', type=int, default=KEEP_DAYS)
    args = parser.parse_args(argv)
    return run(data_dir=args.data_dir, snapshot_dir=args.snapshot_dir,
               now=args.now, keep_days=max(10, args.keep_days))


if __name__ == '__main__':
    sys.exit(main())
