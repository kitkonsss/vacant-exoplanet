# Macro Fetch — Phase 0 macro-context layer for Vol2Vol
#
# Pulls the macro drivers that actually move GC (gold) and writes data/macro.json
# — a small, frontend-friendly snapshot plus a ready-made interpretation
# ("tailwind / headwind") that the daily-strategy engine (Phase 3) and a Macro
# tab can consume directly.
#
# ZERO credentials required:
#   - Yields / real yields / breakevens / broad USD / VIX come from the FRED
#     public CSV endpoint (https://fred.stlouisfed.org/graph/fredgraph.csv?id=...)
#     which needs NO API key.
#   - If yfinance is installed (it already is, for OHLC), DXY (DX=F) and VIX (^VIX)
#     are overridden with fresher intraday values. Pure-stdlib fallback otherwise.
#
# Dependencies: Python stdlib only (urllib, csv, json). yfinance is optional.
#
# Run standalone (no Selenium / no CME login needed):
#   python scraper/macro_fetch.py
#
# Designed to run in a SEPARATE, cheap GitHub Actions job on a fast cadence
# (e.g. every 30 min) so it never waits on the heavy QuikStrike Selenium scrape.

import os
import io
import csv
import json
import urllib.request
import urllib.error
from datetime import datetime, date, timedelta, timezone

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False

BASE_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
HTTP_TIMEOUT = 25
UA = 'Mozilla/5.0 (Vol2Vol macro_fetch)'

# FRED series we pull (all free, no key). label -> (series_id, human_name, unit)
FRED_SERIES = {
    'nominal_10y':   ('DGS10',    '10Y Treasury yield',          'pct'),
    'nominal_2y':    ('DGS2',     '2Y Treasury yield',           'pct'),
    'real_yield_10y':('DFII10',   '10Y real yield (TIPS)',       'pct'),   # #1 gold driver
    'breakeven_10y': ('T10YIE',   '10Y breakeven inflation',     'pct'),
    'dxy_broad':     ('DTWEXBGS', 'Broad USD index',             'index'),
    'vix':           ('VIXCLS',   'VIX',                         'index'),
}


def http_get(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode('utf-8', errors='replace')


def fred_series(series_id, days=160):
    """Fetch a FRED daily series via the public CSV endpoint (no API key).
    Returns a list of (date_str, float_value) for valid observations, oldest->newest.
    """
    start = (date.today() - timedelta(days=days)).isoformat()
    url = f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start}'
    text = http_get(url)
    out = []
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)  # DATE,<series_id>
    for row in reader:
        if len(row) < 2:
            continue
        d, v = row[0].strip(), row[1].strip()
        if v in ('', '.'):       # FRED marks missing as '.'
            continue
        try:
            out.append((d, float(v)))
        except ValueError:
            continue
    return out


def _changes(values):
    """Given oldest->newest list of floats, return (last, prev, five_ago)."""
    if not values:
        return (None, None, None)
    last = values[-1]
    prev = values[-2] if len(values) >= 2 else None
    five = values[-6] if len(values) >= 6 else (values[0] if values else None)
    return (last, prev, five)


def _trend(chg5, flat_eps):
    if chg5 is None:
        return 'flat'
    if chg5 > flat_eps:
        return 'up'
    if chg5 < -flat_eps:
        return 'down'
    return 'flat'


def build_series_snapshot():
    """Pull every FRED series and build a normalized per-series snapshot dict."""
    series = {}
    for label, (sid, name, unit) in FRED_SERIES.items():
        try:
            obs = fred_series(sid)
            vals = [v for _, v in obs]
            last, prev, five = _changes(vals)
            if last is None:
                print(f'[MACRO] {sid}: no data')
                continue
            chg_1d = round(last - prev, 4) if prev is not None else None
            chg_5d = round(last - five, 4) if five is not None else None
            # basis-point change for rate-type series (pct unit)
            flat_eps = 0.02 if unit == 'pct' else (last * 0.001 if last else 0.01)
            series[label] = {
                'value': round(last, 4),
                'date': obs[-1][0],
                'chg_1d': chg_1d,
                'chg_5d': chg_5d,
                'chg_5d_bp': round(chg_5d * 100, 1) if (chg_5d is not None and unit == 'pct') else None,
                'trend': _trend(chg_5d, flat_eps),
                'unit': unit,
                'name': name,
                'source': f'FRED:{sid}',
            }
            print(f'[MACRO] {sid}: {last} ({series[label]["trend"]}, 5d {chg_5d})')
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f'[MACRO] {sid}: fetch error — {e}')
        except Exception as e:
            print(f'[MACRO] {sid}: unexpected error — {e}')

    # 2s10s curve (compute if both legs present)
    if 'nominal_10y' in series and 'nominal_2y' in series:
        spread = round(series['nominal_10y']['value'] - series['nominal_2y']['value'], 4)
        series['curve_2s10s'] = {
            'value': spread,
            'unit': 'pct',
            'name': '2s10s curve',
            'source': 'computed (DGS10-DGS2)',
        }

    # Optional fresher DXY + VIX from yfinance (intraday, vs FRED's ~1d lag).
    if HAS_YFINANCE:
        # DX-Y.NYB = ICE US Dollar Index (the familiar ~99 DXY); DX=F is not on Yahoo.
        for label, symbols, name in (('dxy', ('DX-Y.NYB', 'DX=F'), 'US Dollar Index (DXY)'),
                                    ('vix_live', ('^VIX',), 'VIX (live)')):
            for symbol in symbols:
                ov = _yf_snapshot(symbol, name)
                if ov:
                    series[label] = ov
                    break
    return series


def _yf_snapshot(symbol, name):
    try:
        df = yf.Ticker(symbol).history(period='15d', interval='1d', auto_adjust=False)
        closes = [float(c) for c in df['Close'].tolist() if c == c]  # drop NaN
        if not closes:
            return None
        last, prev, five = _changes(closes)
        chg_5d = round(last - five, 4) if five else None
        return {
            'value': round(last, 3),
            'chg_1d': round(last - prev, 4) if prev else None,
            'chg_5d': chg_5d,
            'pct_5d': round((last - five) / five * 100, 3) if five else None,
            'trend': _trend(chg_5d, abs(last) * 0.002),
            'unit': 'index',
            'name': name,
            'source': f'yfinance:{symbol}',
        }
    except Exception as e:
        print(f'[MACRO] yfinance {symbol}: {e}')
        return None


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def interpret(series):
    """Turn raw macro series into a gold tailwind/headwind read.

    Gold: inversely driven by 10Y REAL yield (DFII10) and the US dollar.
    Scores are clamped to [-100, +100]; positive = tailwind (bullish for gold).
    """
    ry = series.get('real_yield_10y')
    dxy = series.get('dxy') or series.get('dxy_broad')

    # ---- Gold ----
    gold_drivers, gold_score = [], 0
    if ry and ry.get('chg_5d_bp') is not None:
        ry_sig = _clamp(-ry['chg_5d_bp'] * 3, -50, 50)   # ~17bp/5d move => +-50
        gold_score += ry_sig
        gold_drivers.append(
            f"real yield {ry['chg_5d_bp']:+.0f}bp/5d → {'tailwind' if ry_sig >= 0 else 'headwind'}")
    if dxy:
        pct5 = dxy.get('pct_5d')
        if pct5 is None and dxy.get('chg_5d') is not None and dxy.get('value'):
            pct5 = dxy['chg_5d'] / dxy['value'] * 100
        if pct5 is not None:
            dxy_sig = _clamp(-pct5 * 30, -50, 50)        # ~1.7%/5d move => +-50
            gold_score += dxy_sig
            gold_drivers.append(
                f"DXY {pct5:+.2f}%/5d → {'tailwind' if dxy_sig >= 0 else 'headwind'}")
    gold_score = round(_clamp(gold_score, -100, 100))

    def label(s):
        if s >= 25:
            return 'tailwind'
        if s <= -25:
            return 'headwind'
        return 'neutral'

    return {
        'gold': {'score': gold_score, 'label': label(gold_score), 'drivers': gold_drivers},
    }


def fetch_macro():
    print('=' * 60)
    print('  Vol2Vol Macro Fetch (Phase 0)')
    print('=' * 60)
    series = build_series_snapshot()
    if not series:
        print('[MACRO] No series fetched — writing nothing.')
        return False
    interpretation = interpret(series)
    payload = {
        'version': 1,
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'series': series,
        'interpretation': interpretation,
        'note': 'Macro context only. Gold ~ inverse 10Y real yield + USD.',
    }
    os.makedirs(BASE_OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(BASE_OUTPUT_DIR, 'macro.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    g = interpretation['gold']
    print(f"[MACRO] gold: {g['label']} ({g['score']:+d})")
    print(f'[MACRO] wrote {out_path} ({len(series)} series)')
    return True


if __name__ == '__main__':
    ok = fetch_macro()
    raise SystemExit(0 if ok else 1)
