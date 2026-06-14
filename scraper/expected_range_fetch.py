#!/usr/bin/env python3
"""Expected Range / SD bands / ATM IV from the Vol2Vol smile (Phase 1).

No scraping here: the per-strike `Vol Settle` column in the already-committed
{current,tomorrow,friday,monthly}_OIData.txt files IS the implied-vol smile,
and the header carries FutPrc + DTE. Everything QuikStrike's Expected Range
view shows can be recomputed from those:

    expected_move(nSD, horizon) = F * IV_atm * sqrt(DTE/365) * n

Multi-asset: runs for every asset whose OIData files exist (GC at data/,
NQ at data/nq/).

Skew interpretation differs by asset class:
  - GC  : absolute read (gold put/call skew is roughly symmetric at baseline,
          so put-dominant skew genuinely means downside fear)
  - NQ  : RELATIVE read. Index options carry a permanent structural put skew
          (portfolio hedging), so the absolute read would scream fear every
          day. Each run appends today's skew to <dir>/iv_baseline.json and the
          read becomes a z-score vs the asset's own rolling history; until
          BASELINE_MIN_N sessions accumulate the read is 'baseline_building'.

Outputs <dir>/expected_range.json per asset. Dependencies: stdlib only.
  python scraper/expected_range_fetch.py
"""

import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
CONTRACT_KEYS = ('current', 'tomorrow', 'friday', 'monthly')
SKEW_PCT = 0.02            # measure smile slope at +/-2% from the future price
BASELINE_MIN_N = 20        # sessions needed before relative skew reads activate
BASELINE_KEEP = 60         # rolling sessions kept in iv_baseline.json

ASSETS = {
    'gc': {'subdir': '', 'skew_mode': 'absolute'},
    'nq': {'subdir': 'nq', 'skew_mode': 'relative'},
}


def _num(text):
    try:
        return float(str(text).replace(',', ''))
    except (TypeError, ValueError):
        return None


def parse_oidata(path):
    """Parse one Vol2Vol text file -> {header fields, smile [(strike, iv)]}."""
    try:
        with open(path, encoding='utf-8') as f:
            lines = [ln.strip() for ln in f if ln.strip()]
    except OSError:
        return None
    if not lines:
        return None

    header = lines[0]
    fut = _num((re.search(r'FutPrc:\s*([\d.,]+)', header) or [None, None])[1])
    dte = _num((re.search(r'\(([\d.]+)\s*DTE\)', header) or [None, None])[1])
    vol = _num((re.search(r'\bVol:\s*([\d.]+)', header) or [None, None])[1])
    sym = (re.search(r'Option Symbol:\s*(\S+)', header) or [None, None])[1]
    exp = (re.search(r'Option Expiration:\s*([\d/]+)', header) or [None, None])[1]
    underlying = (re.search(r'Underlying Symbol:\s*([A-Z0-9=]+)', header) or [None, None])[1]

    smile = []
    for ln in lines[1:]:
        parts = ln.split(',')
        if len(parts) < 4 or parts[0].lower() == 'strike':
            continue
        strike, iv = _num(parts[0]), _num(parts[3])
        if strike and iv and 0.01 < iv < 5.0:
            smile.append((strike, iv))
    smile.sort()

    if not fut or not smile:
        return None
    return {'symbol': sym, 'expiration': exp, 'dte': dte,
            'underlying_symbol': underlying,
            'future_price': fut, 'raw_future_price': fut,
            'header_vol': vol, 'smile': smile}


def _median(values):
    vals = sorted(values)
    n = len(vals)
    if n == 0:
        return None
    mid = n // 2
    if n % 2:
        return vals[mid]
    return (vals[mid - 1] + vals[mid]) / 2


def _canonical_future_price(items):
    """Pick one futures anchor for option tenors sharing the same underlying."""
    prices = [p.get('future_price') for p in items if p.get('future_price') and p.get('future_price') > 0]
    if len(prices) < 2:
        return None

    rounded = [round(p, 1) for p in prices]
    counts = Counter(rounded)
    most_common = counts.most_common()
    top_count = most_common[0][1]
    top_prices = [price for price, count in most_common if count == top_count]
    if top_count > 1 and len(top_prices) == 1:
        return top_prices[0]
    return round(_median(rounded), 1)


def normalize_future_prices(parsed_by_key, asset_id, reference_by_key=None):
    """Normalize stale per-file FutPrc values for tenors on the same underlying.

    QuikStrike files for multiple option expiries can be written at different
    times, but the tenors often point to the same underlying future. The expected
    range overlay must use one futures anchor per underlying; otherwise the
    bands are centered on stale file-local prices while the chart price line is
    live/recent.
    """
    groups = defaultdict(list)
    for key, parsed in parsed_by_key.items():
        group_key = parsed.get('underlying_symbol') or f'{asset_id}:unknown'
        groups[group_key].append((key, parsed, True))
    for key, parsed in (reference_by_key or {}).items():
        group_key = parsed.get('underlying_symbol') or f'{asset_id}:unknown'
        groups[group_key].append((key, parsed, False))

    notes = []
    for group_key, pairs in groups.items():
        items = [p for _, p, _ in pairs]
        canonical = _canonical_future_price(items)
        if canonical is None:
            continue
        raw_prices = [round(p['future_price'], 1) for p in items if p.get('future_price')]
        if not raw_prices or max(raw_prices) == min(raw_prices):
            continue
        for _, parsed, mutable in pairs:
            if not mutable:
                continue
            parsed['raw_future_price'] = parsed.get('future_price')
            parsed['future_price'] = canonical
        notes.append({
            'underlying_symbol': group_key,
            'canonical_future_price': canonical,
            'raw_future_prices': sorted(set(raw_prices)),
        })
    return notes


def interp_iv(smile, strike):
    """Linear interpolation of the smile at `strike` (clamped to smile range)."""
    if strike <= smile[0][0]:
        return smile[0][1]
    if strike >= smile[-1][0]:
        return smile[-1][1]
    for (s0, v0), (s1, v1) in zip(smile, smile[1:]):
        if s0 <= strike <= s1:
            t = (strike - s0) / (s1 - s0) if s1 > s0 else 0
            return v0 + t * (v1 - v0)
    return None


def _is_expired(expiration):
    """True if the contract's expiry has passed. Daily/weekly options stop
    trading ~12:30 CT (~17:30 UTC); scraped data can outlive the contract when
    the morning pipeline runs before the day's new scrape."""
    try:
        m, d, y = (int(x) for x in str(expiration).split('/'))
        expiry = datetime(y, m, d, 17, 30, tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    return datetime.now(timezone.utc) > expiry


def build_tenor(key, parsed):
    f, dte = parsed['future_price'], parsed['dte']
    atm_iv = interp_iv(parsed['smile'], f)
    if atm_iv is None or dte is None or dte <= 0:
        return None
    if _is_expired(parsed.get('expiration')):
        return None
    move_1sd = f * atm_iv * math.sqrt(dte / 365.0)
    bands = {}
    for n in (1, 2, 3):
        bands[f'plus{n}'] = round(f + n * move_1sd, 1)
        bands[f'minus{n}'] = round(f - n * move_1sd, 1)
    return {
        'contract_key': key,
        'symbol': parsed['symbol'],
        'expiration': parsed['expiration'],
        'underlying_symbol': parsed.get('underlying_symbol'),
        'dte': dte,
        'future_price': f,
        'raw_future_price': parsed.get('raw_future_price'),
        'atm_iv': round(atm_iv, 4),
        'atm_iv_pct': round(atm_iv * 100, 2),
        'header_vol': parsed['header_vol'],
        'expected_move_to_expiry': round(move_1sd, 1),
        'bands_to_expiry': bands,
    }


def build_skew(parsed):
    f = parsed['future_price']
    atm = interp_iv(parsed['smile'], f)
    put_iv = interp_iv(parsed['smile'], f * (1 - SKEW_PCT))
    call_iv = interp_iv(parsed['smile'], f * (1 + SKEW_PCT))
    if None in (atm, put_iv, call_iv):
        return None
    put_skew = round((put_iv - atm) * 100, 2)
    call_skew = round((call_iv - atm) * 100, 2)
    if put_skew - call_skew > 1.0:
        read = 'put_skew_dominant (downside fear priced in)'
    elif call_skew - put_skew > 1.0:
        read = 'call_skew_dominant (upside chase priced in)'
    else:
        read = 'balanced'
    return {'measured_at_pct': SKEW_PCT * 100, 'put_skew_volpts': put_skew,
            'call_skew_volpts': call_skew, 'read': read}


# ---- per-asset rolling baseline (for relative skew reads) -------------------

def update_baseline(dir_, entry):
    """Append today's IV metrics to <dir>/iv_baseline.json (one per date)."""
    path = os.path.join(dir_, 'iv_baseline.json')
    try:
        with open(path, encoding='utf-8') as f:
            hist = json.load(f)
    except (OSError, json.JSONDecodeError):
        hist = []
    hist = [h for h in hist if h.get('date') != entry['date']]
    hist.append(entry)
    hist = sorted(hist, key=lambda h: h['date'])[-BASELINE_KEEP:]
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(hist, f, indent=1)
        f.write('\n')
    return hist


def relative_skew_read(skew, hist):
    """Replace the absolute skew read with a z-score vs the asset's own
    history — the only honest read for assets with structural skew."""
    vals = [h['skew_spread'] for h in hist if h.get('skew_spread') is not None]
    n = len(vals)
    spread = skew['put_skew_volpts'] - skew['call_skew_volpts']
    skew['skew_spread_volpts'] = round(spread, 2)
    skew['baseline_n'] = n
    if n < BASELINE_MIN_N:
        skew['read'] = (f'baseline_building ({n}/{BASELINE_MIN_N} sessions) — '
                        'structural put skew; absolute read suppressed')
        return skew
    mean = sum(vals) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / n) or 1e-9
    z = (spread - mean) / sd
    skew['skew_z_vs_baseline'] = round(z, 2)
    if z >= 1.0:
        skew['read'] = f'put_skew_stretched_vs_norm (z={z:+.1f} — fear ABOVE its usual hedge level)'
    elif z <= -1.0:
        skew['read'] = f'put_skew_compressed_vs_norm (z={z:+.1f} — less fear than usual)'
    else:
        skew['read'] = f'normal_for_asset (z={z:+.1f} — typical hedging skew)'
    return skew


def run_asset(asset_id, cfg):
    dir_ = os.path.join(BASE_DIR, cfg['subdir']) if cfg['subdir'] else BASE_DIR
    parsed_by_key = {}
    reference_by_key = {}
    for key in CONTRACT_KEYS:
        parsed = parse_oidata(os.path.join(dir_, f'{key}_OIData.txt'))
        if parsed:
            parsed_by_key[key] = parsed
        ref = parse_oidata(os.path.join(dir_, f'{key}_IntradayData.txt'))
        if ref:
            reference_by_key[key] = ref

    price_normalization = normalize_future_prices(parsed_by_key, asset_id, reference_by_key)
    for note in price_normalization:
        print(f"[ER:{asset_id}] normalized FutPrc for {note['underlying_symbol']}: "
              f"{note['raw_future_prices']} -> {note['canonical_future_price']}")

    tenors = []
    for key in CONTRACT_KEYS:
        parsed = parsed_by_key.get(key)
        if not parsed:
            continue
        t = build_tenor(key, parsed)
        if t:
            t['_smile'] = parsed['smile']
            tenors.append(t)
            print(f"[ER:{asset_id}] {key} {t['symbol']}: DTE {t['dte']} | ATM IV {t['atm_iv_pct']}% "
                  f"| 1SD to expiry ±{t['expected_move_to_expiry']}")
        elif _is_expired(parsed.get('expiration')):
            print(f"[ER:{asset_id}] {key} {parsed.get('symbol')}: expired {parsed.get('expiration')} — skipped")

    if not tenors:
        print(f'[ER:{asset_id}] no tenors parsed — skipped')
        return False

    short = min(tenors, key=lambda t: t['dte'])
    long_ = max(tenors, key=lambda t: t['dte'])
    f = short['future_price']
    horizon_days = min(1.0, short['dte'])
    move_1d = f * short['atm_iv'] * math.sqrt(horizon_days / 365.0)
    bands_1d = {}
    for n in (1, 2, 3):
        bands_1d[f'plus{n}'] = round(f + n * move_1d, 1)
        bands_1d[f'minus{n}'] = round(f - n * move_1d, 1)

    slope = round((short['atm_iv'] - long_['atm_iv']) * 100, 2)
    if slope > 2.0:
        shape = 'inverted (event/stress premium in front)'
    elif slope < -2.0:
        shape = 'contango (calm front, risk priced later)'
    else:
        shape = 'flat'

    skew = build_skew({'future_price': f, 'smile': short.pop('_smile')})
    for t in tenors:
        t.pop('_smile', None)

    # Rolling baseline (kept for BOTH assets so reads can become relative
    # later); NQ's displayed read is relative from day one.
    if skew:
        hist = update_baseline(dir_, {
            'date': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
            'atm_iv_pct': short['atm_iv_pct'],
            'put_skew': skew['put_skew_volpts'],
            'call_skew': skew['call_skew_volpts'],
            'skew_spread': round(skew['put_skew_volpts'] - skew['call_skew_volpts'], 2),
            'term_slope': slope,
        })
        if cfg['skew_mode'] == 'relative':
            skew = relative_skew_read(skew, hist[:-1])  # today excluded from its own baseline

    pb = {}
    try:
        with open(os.path.join(dir_, 'current_PositionBias.json'), encoding='utf-8') as fh:
            pb = json.load(fh)
    except (OSError, json.JSONDecodeError):
        pass

    out = {
        'asset': asset_id.upper(),
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source_generated_at': pb.get('generated_at'),
        'method': 'ATM IV interpolated from Vol2Vol per-strike Vol Settle smile; '
                  'move = F x IV x sqrt(DTE/365)',
        'skew_mode': cfg['skew_mode'],
        'price_normalization': price_normalization,
        'future_price': f,
        'atm_iv_pct_1d_basis': short['atm_iv_pct'],
        'basis_tenor': {'contract_key': short['contract_key'], 'symbol': short['symbol'],
                        'dte': short['dte']},
        'horizon_days': horizon_days,
        'expected_move_1d': round(move_1d, 1),
        'day_high_est': round(f + move_1d, 1),
        'day_low_est': round(f - move_1d, 1),
        'bands_1d': bands_1d,
        'term_structure': {'slope_volpts_short_minus_monthly': slope, 'shape': shape,
                           'short_tenor': short['symbol'], 'long_tenor': long_['symbol']},
        'skew': skew,
        'tenors': tenors,
    }

    path = os.path.join(dir_, 'expected_range.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=2)
        fh.write('\n')
    print(f"[ER:{asset_id}] wrote {path} | 1d move ±{out['expected_move_1d']} "
          f"({out['atm_iv_pct_1d_basis']}% IV) | term {shape} | skew {skew and skew['read']}")
    return True


def main():
    any_ok = False
    for asset_id, cfg in ASSETS.items():
        try:
            any_ok = run_asset(asset_id, cfg) or any_ok
        except Exception as e:
            print(f'[ER:{asset_id}] failed: {e}')
    return 0 if any_ok else 1


if __name__ == '__main__':
    sys.exit(main())
