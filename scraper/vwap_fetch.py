# VWAP + SD bands — mean-reversion reference levels for Vol2Vol (GC)
#
# Computes anchored VWAP and ±1/2/3 volume-weighted SD bands from data/OHLC_1h.json
# for two anchors:
#   - daily/session : candles sharing the latest candle's UTC date (resets daily)
#   - weekly        : candles in the latest candle's ISO week (resets weekly)
# -> writes data/vwap.json (GC).
#
# These bands are the mean-reversion fade zones the owner trades (VWAP ±2SD/±3SD)
# and feed the confluence layer in strategy_fetch.py.
#
# NOTE: yfinance 1h OHLC on the back-adjusted continuous future is a PROXY — good
# enough for a daily reference but not the broker's exact session VWAP. The real
# intraday SD/Expected Range from QuikStrike Vol2Vol is the future upgrade (spec §7).
#
# Dependencies: Python stdlib only.
#   python scraper/vwap_fetch.py

import os
import sys
import json
import math
from datetime import datetime, timezone

BASE_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')


def _load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _candle_dt(ts):
    """1h candle 'time' is a unix epoch (seconds). Return a UTC datetime."""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _vwap_bands(candles):
    """Volume-weighted VWAP + SD over a set of candles.

    typical = (H+L+C)/3 ; VWAP = Σ(typ·vol)/Σvol ;
    variance = Σ(vol·(typ−VWAP)²)/Σvol ; SD = √variance."""
    num = den = 0.0
    pts = []
    for c in candles:
        h, l, cl, v = c.get('high'), c.get('low'), c.get('close'), c.get('volume')
        if None in (h, l, cl) or not v or v <= 0:
            continue
        typ = (float(h) + float(l) + float(cl)) / 3.0
        num += typ * v
        den += v
        pts.append((typ, v))
    if den <= 0 or len(pts) < 2:
        return None
    vwap = num / den
    var = sum(v * (typ - vwap) ** 2 for typ, v in pts) / den
    sd = math.sqrt(var)
    bands = {f'{sign}{k}': round(vwap + s * k * sd, 2)
             for k in (1, 2, 3) for sign, s in (('plus', 1), ('minus', -1))}
    return {
        'vwap': round(vwap, 2),
        'sd': round(sd, 2),
        'n_candles': len(pts),
        'bands': bands,
    }


def _price_vs_band(price, b):
    """Where price sits relative to the band ladder, e.g. 'between +1sd and +2sd'."""
    if price is None or not b:
        return None
    vwap, sd = b['vwap'], b['sd']
    if sd <= 0:
        return 'at vwap'
    z = (price - vwap) / sd
    if z >= 3:
        return 'above +3sd (stretched)'
    if z >= 2:
        return 'between +2sd and +3sd'
    if z >= 1:
        return 'between +1sd and +2sd'
    if z >= 0:
        return 'between vwap and +1sd'
    if z > -1:
        return 'between vwap and -1sd'
    if z > -2:
        return 'between -1sd and -2sd'
    if z > -3:
        return 'between -2sd and -3sd'
    return 'below -3sd (stretched)'


def build_vwap():
    ohlc = _load_json(os.path.join(BASE_OUTPUT_DIR, 'OHLC_1h.json'))
    if not ohlc or not ohlc.get('candles'):
        print('[VWAP] OHLC_1h.json missing or empty — skipping')
        return None
    candles = [c for c in ohlc['candles'] if _candle_dt(c.get('time'))]
    if not candles:
        print('[VWAP] no timestamped candles — skipping')
        return None
    candles.sort(key=lambda c: int(c['time']))
    latest = candles[-1]
    price = latest.get('close')
    ldt = _candle_dt(latest['time'])

    day_candles = [c for c in candles if _candle_dt(c['time']).date() == ldt.date()]
    iso_year, iso_week, _ = ldt.isocalendar()
    week_candles = [c for c in candles if _candle_dt(c['time']).isocalendar()[:2] == (iso_year, iso_week)]
    # Sessions can be thin near the open; fall back to last 24 / 120 candles.
    if len(day_candles) < 3:
        day_candles = candles[-24:]
    if len(week_candles) < 5:
        week_candles = candles[-120:]

    daily = _vwap_bands(day_candles)
    weekly = _vwap_bands(week_candles)
    if daily:
        daily['price_vs_band'] = _price_vs_band(price, daily)
    if weekly:
        weekly['price_vs_band'] = _price_vs_band(price, weekly)

    return {
        'version': 1,
        'asset': 'GC',
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'price': price,
        'source': 'yfinance 1h back-adjusted continuous future (proxy)',
        'daily': daily,
        'weekly': weekly,
        'note': 'Anchored VWAP ±1/2/3 SD (volume-weighted). Proxy from 1h OHLC; '
                'real intraday SD/Expected Range from QuikStrike is the future upgrade.',
    }


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    print('=' * 60)
    print('  Vol2Vol VWAP + SD bands')
    print('=' * 60)
    payload = build_vwap()
    if not payload:
        raise SystemExit(1)
    out_path = os.path.join(BASE_OUTPUT_DIR, 'vwap.json')
    os.makedirs(BASE_OUTPUT_DIR, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    d = payload.get('daily') or {}
    print(f"[VWAP] price {payload['price']} | daily VWAP {d.get('vwap')} ±SD {d.get('sd')} "
          f"({d.get('price_vs_band')})")
    print(f'[VWAP] wrote {out_path}')
    raise SystemExit(0)


if __name__ == '__main__':
    main()
