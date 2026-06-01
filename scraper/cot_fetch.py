# COT Fetch — Phase 0 institutional-positioning layer for Vol2Vol
#
# Pulls the CFTC Commitments of Traders report for GC (gold) and writes
# data/cot.json. This adds the "what are the big funds actually doing" signal
# that OI walls alone can't see:
#   - Gold  -> Disaggregated report -> Managed Money net long/short (classic gold tell)
#
# ZERO credentials required: CFTC publishes COT via the public Socrata API at
# publicreporting.cftc.gov — no API key needed for our small weekly queries.
#
# Dependencies: Python stdlib only (urllib, json).
#
# Run standalone (no Selenium / no CME login):
#   python scraper/cot_fetch.py --asset all
#
# Cadence: COT is released weekly (Fri ~15:30 ET for the prior Tuesday). Schedule
# this in its own cheap GitHub Actions job ~once a day (cheap; data only moves 1x/wk).

import os
import json
import argparse
import urllib.request
import urllib.error
from datetime import datetime, timezone

BASE_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
HTTP_TIMEOUT = 30
UA = 'Mozilla/5.0 (Vol2Vol cot_fetch)'

# Socrata dataset ids on publicreporting.cftc.gov (public, no key).
# If CFTC ever renames these, swap the id here — raw_latest in the output dumps
# the full record so field names can be re-verified from a CI run's artifact.
SOCRATA = {
    'disaggregated': '72hh-3qpy',   # Disaggregated Futures-Only (commodities, e.g. gold)
}

# CFTC contract market codes (stable identifiers).
COT_CONFIG = {
    'gc': {'short': 'GC', 'code': '088691', 'report': 'disaggregated', 'subfolder': ''},
}

WEEKS = 12  # how many weekly rows to pull for trend / change


def http_get_json(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8', errors='replace'))


def socrata_rows(report, contract_code, limit=WEEKS):
    dataset = SOCRATA[report]
    base = f'https://publicreporting.cftc.gov/resource/{dataset}.json'
    order = 'report_date_as_yyyy_mm_dd'
    url = (f'{base}?cftc_contract_market_code={contract_code}'
           f'&$order={order}%20DESC&$limit={limit}')
    return http_get_json(url)


def _to_num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def find_num(record, *required_substrings):
    """Find the first numeric field whose key contains ALL given substrings.
    Resilient to minor CFTC field-name variations across report types."""
    for key, val in record.items():
        k = key.lower()
        if all(s in k for s in required_substrings):
            n = _to_num(val)
            if n is not None:
                return n
    return None


def _net_series(rows, long_subs, short_subs):
    """Build oldest->newest list of {date, long, short, net} for one trader group."""
    series = []
    for r in reversed(rows):  # rows come newest-first -> reverse to oldest-first
        lng = find_num(r, *long_subs)
        sht = find_num(r, *short_subs)
        d = r.get('report_date_as_yyyy_mm_dd') or r.get('report_date') or ''
        if lng is None or sht is None:
            continue
        series.append({'date': d[:10], 'long': int(lng), 'short': int(sht), 'net': int(lng - sht)})
    return series


def _trend(series):
    if len(series) < 2:
        return 'flat'
    nets = [p['net'] for p in series]
    last, prev = nets[-1], nets[-2]
    chg = last - prev
    # 4-week direction
    four = nets[-5] if len(nets) >= 5 else nets[0]
    if last - four > abs(four) * 0.05:
        return 'rising'
    if last - four < -abs(four) * 0.05:
        return 'falling'
    return 'flat' if abs(chg) < abs(prev) * 0.02 else ('rising' if chg > 0 else 'falling')


def _pct_rank(series):
    """Percentile of the latest net within the fetched window (0..1). Crowding gauge."""
    if not series:
        return None
    nets = sorted(p['net'] for p in series)
    last = series[-1]['net']
    below = sum(1 for n in nets if n <= last)
    return round(below / len(nets), 2)


def _interpret_gold(mm, oi):
    if not mm:
        return {'label': 'unknown', 'note': 'Managed Money fields not found.'}
    net, trend, rank = mm['net'], mm['trend'], mm['pct_rank']
    side = 'net long' if net > 0 else 'net short'
    if trend == 'rising':
        label, verb = 'bullish', 'funds adding longs'
    elif trend == 'falling':
        label, verb = 'bearish', 'funds cutting longs / adding shorts'
    else:
        label, verb = 'neutral', 'positioning flat'
    crowd = ''
    if rank is not None and rank >= 0.9 and net > 0:
        crowd = ' — crowded long (contrarian caution)'
    elif rank is not None and rank <= 0.1 and net < 0:
        crowd = ' — crowded short (squeeze risk)'
    return {'label': label, 'note': f'Managed Money {side} ({net:+,}), {trend} — {verb}{crowd}.'}


def _group(rows, long_subs, short_subs):
    series = _net_series(rows, long_subs, short_subs)
    if not series:
        return None
    latest = series[-1]
    prev_net = series[-2]['net'] if len(series) >= 2 else None
    return {
        'long': latest['long'],
        'short': latest['short'],
        'net': latest['net'],
        'net_chg_1w': (latest['net'] - prev_net) if prev_net is not None else None,
        'trend': _trend(series),
        'pct_rank': _pct_rank(series),
        'history': series,
    }


def fetch_asset_cot(asset_id):
    cfg = COT_CONFIG[asset_id]
    print(f'\n[COT] {cfg["short"]} — fetching {cfg["report"]} (code {cfg["code"]})...')
    try:
        rows = socrata_rows(cfg['report'], cfg['code'])
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        print(f'[COT] {cfg["short"]}: fetch error — {e}')
        return False
    except Exception as e:
        print(f'[COT] {cfg["short"]}: unexpected error — {e}')
        return False

    if not rows:
        print(f'[COT] {cfg["short"]}: no data returned.')
        return False

    latest = rows[0]
    report_date = (latest.get('report_date_as_yyyy_mm_dd') or latest.get('report_date') or '')[:10]
    oi = find_num(latest, 'open_interest', 'all') or find_num(latest, 'open_interest')

    payload = {
        'version': 1,
        'asset': cfg['short'],
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'report_date': report_date,
        'contract_code': cfg['code'],
        'open_interest': int(oi) if oi is not None else None,
    }

    mm = _group(rows, ('m_money', 'long'), ('m_money', 'short'))
    prod = _group(rows, ('prod_merc', 'long'), ('prod_merc', 'short'))
    swap = _group(rows, ('swap', 'long'), ('swap', 'short'))
    payload['source'] = 'CFTC Disaggregated Futures-Only (publicreporting.cftc.gov)'
    payload['managed_money'] = mm
    payload['producer_merchant'] = prod
    payload['swap_dealer'] = swap
    payload['interpretation'] = _interpret_gold(mm, oi)

    # Keep the raw latest record so field names can always be re-verified.
    payload['raw_latest'] = latest

    out_dir = os.path.join(BASE_OUTPUT_DIR, cfg['subfolder']) if cfg['subfolder'] else BASE_OUTPUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'cot.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    interp = payload.get('interpretation', {})
    print(f"[COT] {cfg['short']}: {interp.get('label', '?')} — {interp.get('note', '')}")
    print(f'[COT] wrote {out_path} (report {report_date})')
    return True


def main():
    parser = argparse.ArgumentParser(description='Vol2Vol COT fetch (Phase 0)')
    parser.add_argument('--asset', choices=['gc', 'all'], default='all')
    args = parser.parse_args()
    assets = ['gc'] if args.asset == 'all' else [args.asset]

    print('=' * 60)
    print('  Vol2Vol COT Fetch (Phase 0)')
    print('=' * 60)
    ok_any = False
    for a in assets:
        try:
            ok_any = fetch_asset_cot(a) or ok_any
        except Exception as e:
            print(f'[COT] {a}: failed — {e}')
    raise SystemExit(0 if ok_any else 1)


if __name__ == '__main__':
    main()
