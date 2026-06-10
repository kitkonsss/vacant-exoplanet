#!/usr/bin/env python3
"""Expected Range / SD bands / ATM IV from the Vol2Vol smile (Phase 1).

No scraping here: the per-strike `Vol Settle` column in the already-committed
{current,tomorrow,friday,monthly}_OIData.txt files IS the implied-vol smile,
and the header carries FutPrc + DTE. Everything QuikStrike's Expected Range
view shows can be recomputed from those:

    expected_move(nSD, horizon) = F * IV_atm * sqrt(DTE/365) * n

Outputs data/expected_range.json:
  - per-tenor ATM IV (smile-interpolated at FutPrc) + 1/2/3 SD bands to expiry
  - 1-day expected move from the shortest-dated tenor's ATM IV
  - IV term structure (shape: inverted/flat/contango) and a 2% put/call skew read

strategy_fetch.py picks this up to replace its ATR(14) proxy when fresh.

Dependencies: Python stdlib only.
  python scraper/expected_range_fetch.py
"""

import json
import math
import os
import re
import sys
from datetime import datetime, timezone

# Windows consoles default to a legacy codepage that can't print ± etc.
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
CONTRACT_KEYS = ('current', 'tomorrow', 'friday', 'monthly')
SKEW_PCT = 0.02  # measure smile slope at +/-2% from the future price


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
            'future_price': fut, 'header_vol': vol, 'smile': smile}


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


def build_tenor(key, parsed):
    f, dte = parsed['future_price'], parsed['dte']
    atm_iv = interp_iv(parsed['smile'], f)
    if atm_iv is None or dte is None or dte <= 0:
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
        'dte': dte,
        'future_price': f,
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


def main():
    tenors = []
    for key in CONTRACT_KEYS:
        parsed = parse_oidata(os.path.join(BASE_DIR, f'{key}_OIData.txt'))
        if not parsed:
            print(f'[ER] {key}: no usable OIData — skipped')
            continue
        t = build_tenor(key, parsed)
        if t:
            t['_smile'] = parsed['smile']
            tenors.append(t)
            print(f"[ER] {key} {t['symbol']}: DTE {t['dte']} | ATM IV {t['atm_iv_pct']}% "
                  f"| 1SD to expiry ±{t['expected_move_to_expiry']}")

    if not tenors:
        print('[ER] no tenors parsed — nothing to write')
        return 1

    # 1-day expected move from the shortest-dated tenor (its IV is the best
    # gauge of near-term realized vol). Horizon = min(1 day, its actual DTE).
    short = min(tenors, key=lambda t: t['dte'])
    long_ = max(tenors, key=lambda t: t['dte'])
    f = short['future_price']
    horizon_days = min(1.0, short['dte'])
    move_1d = f * short['atm_iv'] * math.sqrt(horizon_days / 365.0)
    bands_1d = {}
    for n in (1, 2, 3):
        bands_1d[f'plus{n}'] = round(f + n * move_1d, 1)
        bands_1d[f'minus{n}'] = round(f - n * move_1d, 1)

    # Term structure: short-dated IV above monthly IV = stress (inverted).
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

    # Freshness stamp comes from the scrape that produced the OIData files.
    pb = {}
    try:
        with open(os.path.join(BASE_DIR, 'current_PositionBias.json'), encoding='utf-8') as fh:
            pb = json.load(fh)
    except (OSError, json.JSONDecodeError):
        pass

    out = {
        'asset': 'GC',
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source_generated_at': pb.get('generated_at'),
        'method': 'ATM IV interpolated from Vol2Vol per-strike Vol Settle smile; '
                  'move = F x IV x sqrt(DTE/365)',
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

    path = os.path.join(BASE_DIR, 'expected_range.json')
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=2)
        fh.write('\n')
    print(f"[ER] wrote {path} | 1d move ±{out['expected_move_1d']} "
          f"({out['atm_iv_pct_1d_basis']}% IV) | term {shape} | skew {skew and skew['read']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
