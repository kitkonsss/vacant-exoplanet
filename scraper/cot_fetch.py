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
import sys
import json
import argparse
import statistics
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

WEEKS = 156       # weekly rows to pull (≈3y) so pct_rank / z-scores are meaningful
HISTORY_OUT = 26  # rows kept in the JSON output (stats computed over the full window)


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


def _pct_rank_label(rank):
    """Crowding band for a net-position percentile (1.0 = most long in window)."""
    if rank is None:
        return None
    if rank >= 0.85:
        return 'near-extreme long'
    if rank >= 0.65:
        return 'elevated'
    if rank <= 0.15:
        return 'near-extreme short'
    if rank <= 0.35:
        return 'subdued'
    return 'mid'


def _mm_signals(mm):
    """Managed Money produces TWO independent signals: trend-following momentum and
    a crowding-extreme contrarian flag (crowded long = top caution; crowded short = bottom)."""
    if not mm:
        return 'neutral', 'none'
    net, trend, rank = mm['net'], mm['trend'], mm['pct_rank']
    momentum = 'bullish' if trend == 'rising' else ('bearish' if trend == 'falling' else 'neutral')
    contrarian = 'none'
    if rank is not None:
        if rank >= 0.85 and net > 0:
            contrarian = 'caution_top'       # crowded long → fade-down risk
        elif rank <= 0.15 and net < 0:
            contrarian = 'caution_bottom'     # crowded short → squeeze-up risk
    return momentum, contrarian


def _smart_money(prod, swap):
    """Commercials (producer + swap) = smart money, read from the *change* in net,
    not the raw level (producers hedge short structurally). Commercials covering
    short abnormally fast (net rising, high z) = bullish; the reverse = bearish."""
    if not prod or not swap:
        return None
    pmap = {p['date']: p['net'] for p in prod['history']}
    smap = {s['date']: s['net'] for s in swap['history']}
    dates = sorted(set(pmap) & set(smap))
    if len(dates) < 5:
        return None
    comm = [pmap[d] + smap[d] for d in dates]                  # commercial net, oldest→newest
    chgs = [comm[i] - comm[i - 1] for i in range(1, len(comm))]
    latest_net, latest_chg = comm[-1], chgs[-1]
    mean = statistics.fmean(chgs)
    sd = statistics.pstdev(chgs) or 1.0
    z = (latest_chg - mean) / sd
    if z >= 1.0 and latest_chg > 0:
        signal = 'bullish'
        note = f'commercials covering short fast (net {latest_chg:+,}/wk, z={z:.1f}) → smart-money bullish'
    elif z <= -1.0 and latest_chg < 0:
        signal = 'bearish'
        note = f'commercials adding short fast (net {latest_chg:+,}/wk, z={z:.1f}) → smart-money bearish'
    else:
        signal = 'neutral'
        note = f'commercial net change in-line (net {latest_chg:+,}/wk, z={z:.1f}) → no smart-money edge'
    return {
        'commercial_net': latest_net,
        'commercial_net_chg_1w': latest_chg,
        'commercial_zscore': round(z, 2),
        'signal': signal,
        'note': note,
    }


def _interpret_gold_v2(mm, sm, momentum, contrarian):
    """Blend MM momentum + commercial smart-money + crowding into a net lean.
    Smart money carries the most weight; a crowding extreme dampens / flips the lean."""
    if not mm:
        return {'label': 'unknown', 'note': 'Managed Money fields not found.'}
    score = 0
    score += {'bullish': 1, 'bearish': -1}.get(momentum, 0)
    if sm:
        score += {'bullish': 2, 'bearish': -2}.get(sm['signal'], 0)
    score += {'caution_top': -1, 'caution_bottom': 1}.get(contrarian, 0)
    if score >= 3:
        net_label = 'bullish'
    elif score >= 1:
        net_label = 'lean_bullish'
    elif score <= -3:
        net_label = 'bearish'
    elif score <= -1:
        net_label = 'lean_bearish'
    else:
        net_label = 'neutral'
    side = 'net long' if mm['net'] > 0 else 'net short'
    bits = [f"MM {side} ({mm['net']:+,}, {mm.get('pct_rank_label') or 'mid'}) → momentum {momentum}"]
    if sm:
        bits.append(sm['note'])
    if contrarian == 'caution_top':
        bits.append('MM crowded long → contrarian top caution (favours mean-reversion down)')
    elif contrarian == 'caution_bottom':
        bits.append('MM crowded short → squeeze-up risk (favours mean-reversion up)')
    return {
        'label': net_label,            # kept so older readers keep working
        'net_label': net_label,
        'momentum': momentum,
        'contrarian': contrarian,
        'smart_money': sm['signal'] if sm else 'neutral',
        'note': '; '.join(bits) + '.',
    }


def _group(rows, long_subs, short_subs):
    series = _net_series(rows, long_subs, short_subs)
    if not series:
        return None
    latest = series[-1]
    prev_net = series[-2]['net'] if len(series) >= 2 else None
    rank = _pct_rank(series)
    return {
        'long': latest['long'],
        'short': latest['short'],
        'net': latest['net'],
        'net_chg_1w': (latest['net'] - prev_net) if prev_net is not None else None,
        'trend': _trend(series),
        'pct_rank': rank,
        'pct_rank_label': _pct_rank_label(rank),
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

    # v2 reads — compute BEFORE trimming history (smart-money needs the full window).
    smart_money = _smart_money(prod, swap)
    momentum, contrarian = _mm_signals(mm)
    if mm:
        mm['momentum_signal'] = momentum
        mm['contrarian_signal'] = contrarian
    if prod:
        prod['note'] = 'producer hedge is structurally short — treat net as mechanical, not directional'

    payload['version'] = 2
    payload['source'] = 'CFTC Disaggregated Futures-Only (publicreporting.cftc.gov)'
    payload['managed_money'] = mm
    payload['producer_merchant'] = prod
    payload['swap_dealer'] = swap
    payload['smart_money'] = smart_money
    payload['interpretation'] = _interpret_gold_v2(mm, smart_money, momentum, contrarian)

    # Trim per-group history for a lean output (stats already computed over full window).
    for grp in (mm, prod, swap):
        if grp and grp.get('history'):
            grp['history'] = grp['history'][-HISTORY_OUT:]

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
    try:
        sys.stdout.reconfigure(encoding='utf-8')   # keep non-ASCII notes printable on any console
    except (AttributeError, ValueError):
        pass
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
