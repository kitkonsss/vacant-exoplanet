# Strategy Synthesizer (v1, rule-based) — the "auto daily strategy" core for Vol2Vol
#
# Replaces the manual daily synthesis with a deterministic blend of the three data
# layers the dashboard now has:
#   - Positioning : data/position_bias_summary.json (CME options OI walls / bias)
#   - Macro       : data/macro.json (yields / real yields / DXY / VIX interpretation)
#   - COT         : data/cot.json   (CFTC institutional net positioning)
# -> writes data/daily_strategy.json (GC).
#
# This is the v1 *mechanical* engine — transparent and fully testable with no
# credentials. Phase 3 swaps/augments build_strategy() with a Claude API call
# (claude-opus-4-8) that reads the same inputs for a richer narrative; this file's
# output schema is the contract a "Daily Strategy" tab and that LLM step consume.
#
# Dependencies: Python stdlib only.
#   python scraper/strategy_fetch.py --asset all

import os
import json
import argparse
from datetime import datetime, timezone

BASE_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

ASSETS = {
    'gc': {'short': 'GC', 'subfolder': '',   'macro_key': 'gold'},
}

# Blend weights — options positioning is the system's core read; macro is a strong
# (esp. for gold) but slower driver; COT is institutional but only weekly.
W_POSITIONING = 0.45
W_MACRO = 0.35
W_COT = 0.20
CONTRACT_KEYS = ('current', 'tomorrow', 'friday', 'monthly')


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _data_dir(asset_id):
    sub = ASSETS[asset_id]['subfolder']
    return os.path.join(BASE_OUTPUT_DIR, sub) if sub else BASE_OUTPUT_DIR


def _label_from_score(s):
    if s >= 30:
        return 'bullish'
    if s >= 10:
        return 'lean_bullish'
    if s <= -30:
        return 'bearish'
    if s <= -10:
        return 'lean_bearish'
    return 'neutral'


def _fmt_level(v):
    if v is None:
        return None
    return f'{float(v):.0f}' if float(v).is_integer() else f'{float(v):.1f}'


def _sign(s):
    return 1 if s > 8 else (-1 if s < -8 else 0)


def _oi_type(call_oi, put_oi):
    """Classify a strike's open interest as call/put/mixed dominant.

    Aligns with the project's existing wall convention (call_wall = resistance,
    put_wall = support) so the heatmap build read is consistent with vol2vol."""
    c, p = float(call_oi or 0), float(put_oi or 0)
    if c == 0 and p == 0:
        return None
    if c >= p * 1.3:
        return 'call'
    if p >= c * 1.3:
        return 'put'
    return 'mixed'


def _wall_role(oi_type):
    """Translate call/put dominance into the role a growing wall plays.

    call build -> resistance/cap; put build -> support/floor; mixed -> pin/magnet."""
    return {'call': 'resistance', 'put': 'support', 'mixed': 'magnet'}.get(oi_type)


# ---- Positioning layer ------------------------------------------------------

def load_positioning(asset_id):
    """Return (score, label, contracts[]). Prefers the aggregate summary;
    falls back to current_PositionBias.json if the summary is absent."""
    d = _data_dir(asset_id)
    summ = _load_json(os.path.join(d, 'position_bias_summary.json'))
    if summ and summ.get('position_bias'):
        return (
            float(summ['position_bias'].get('score', 0)),
            summ['position_bias'].get('label', 'neutral'),
            summ.get('contracts', []),
        )
    cur = _load_json(os.path.join(d, 'current_PositionBias.json'))
    if cur and cur.get('position_bias'):
        pb = cur['position_bias']
        walls = cur.get('walls', {})
        contract = {
            'contract_key': cur.get('contract_key', 'current'),
            'contract': cur.get('contract', ''),
            'dte': cur.get('dte'),
            'future_price': cur.get('future_price'),
            'score': pb.get('score', 0),
            'label': pb.get('label', 'neutral'),
            'confidence': cur.get('confidence', 'low'),
            'dominant_call_wall': (walls.get('dominant_call') or {}).get('strike'),
            'dominant_put_wall': (walls.get('dominant_put') or {}).get('strike'),
            'largest_position': (walls.get('largest_combined_position') or {}).get('strike'),
        }
        return float(pb.get('score', 0)), pb.get('label', 'neutral'), [contract]
    return None, None, []


def load_position_detail(asset_id, contract_key):
    return _load_json(os.path.join(_data_dir(asset_id), f'{contract_key}_PositionBias.json'))


def load_heatmap(asset_id, contract_key, gamma=False):
    suffix = 'GammaHeatmap.json' if gamma else 'OIHeatmap.json'
    return _load_json(os.path.join(_data_dir(asset_id), f'{contract_key}_{suffix}'))


def build_oi_lookup(asset_id):
    """{(contract_key, strike): {call_oi, put_oi, total_oi, side}} from position_map.

    Lets the OI heatmap (call/put combined) be tagged with call/put dominance so a
    build can be read as resistance (call) vs support (put) instead of just location."""
    lookup = {}
    for key in CONTRACT_KEYS:
        detail = load_position_detail(asset_id, key)
        if not detail:
            continue
        for row in detail.get('position_map') or []:
            s = _num(row.get('strike'))
            if s is None:
                continue
            lookup[(key, round(s, 2))] = {
                'call_oi': row.get('call_oi') or 0,
                'put_oi': row.get('put_oi') or 0,
                'total_oi': row.get('total_oi') or 0,
                'side': row.get('side'),
            }
    return lookup


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _latest_change(values):
    """Return latest, previous, and latest-prev from a newest-first heatmap row."""
    latest_idx = next((i for i, v in enumerate(values or []) if _num(v) is not None), None)
    if latest_idx is None:
        return None, None, None
    prev_idx = next((i for i in range(latest_idx + 1, len(values or [])) if _num(values[i]) is not None), None)
    latest = _num(values[latest_idx])
    prev = _num(values[prev_idx]) if prev_idx is not None else None
    change = None if prev is None else latest - prev
    return latest, prev, change


def analyze_heatmap_flow(asset_id, oi_lookup=None):
    """Find where contracts are being added in the OI heatmap and what they mean.

    Each build is tagged call/put (via position_map) so it reads as a growing
    resistance (call build above) vs support (put build below) instead of pure
    location. The biggest growing OI pile is surfaced as the price magnet.
    """
    oi_lookup = oi_lookup or {}
    contracts = []
    all_additions = []
    for key in CONTRACT_KEYS:
        hm = load_heatmap(asset_id, key, gamma=False)
        if not hm:
            continue
        price = hm.get('underlying')
        dates = hm.get('dates') or []
        additions = []
        for row in hm.get('strikes') or []:
            strike = _num(row.get('strike'))
            latest, prev, change = _latest_change(row.get('values') or [])
            if strike is None or latest is None or change is None or change <= 0:
                continue
            side = 'above' if price is not None and strike > float(price) else ('below' if price is not None and strike < float(price) else 'at_price')
            ref = oi_lookup.get((key, round(strike, 2)))
            oi_type = _oi_type(ref['call_oi'], ref['put_oi']) if ref else None
            item = {
                'contract_key': key,
                'contract': hm.get('contract'),
                'strike': strike,
                'latest_oi': round(latest, 2),
                'change_1d': round(change, 2),
                'distance_points': None if price is None else round(strike - float(price), 2),
                'side': side,
                'oi_type': oi_type,                 # call | put | mixed | None
                'wall_role': _wall_role(oi_type),   # resistance | support | magnet | None
            }
            additions.append(item)
            all_additions.append(item)
        additions.sort(key=lambda x: x['change_1d'], reverse=True)
        above = sum(x['change_1d'] for x in additions if x['side'] == 'above')
        below = sum(x['change_1d'] for x in additions if x['side'] == 'below')
        contracts.append({
            'contract_key': key,
            'contract': hm.get('contract'),
            'underlying': price,
            'latest_date': dates[0] if dates else None,
            'prev_date': dates[1] if len(dates) > 1 else None,
            'added_above_price': round(above, 2),
            'added_below_price': round(below, 2),
            'net_added_above_minus_below': round(above - below, 2),
            'top_additions': additions[:5],
        })

    all_additions.sort(key=lambda x: x['change_1d'], reverse=True)
    above_total = sum(x['change_1d'] for x in all_additions if x['side'] == 'above')
    below_total = sum(x['change_1d'] for x in all_additions if x['side'] == 'below')
    # Call/put-aware build: puts piling below = support (bullish floor); calls piling
    # above = resistance (bearish cap). This drives the bias, not raw location.
    support_build = sum(x['change_1d'] for x in all_additions if x['wall_role'] == 'support' and x['side'] == 'below')
    resistance_build = sum(x['change_1d'] for x in all_additions if x['wall_role'] == 'resistance' and x['side'] == 'above')
    if support_build > resistance_build * 1.2:
        bias = 'upside_magnet'        # floor rising under price
    elif resistance_build > support_build * 1.2:
        bias = 'downside_magnet'      # cap building over price
    else:
        bias = 'balanced'
    # Magnet = the largest growing OI pile (where price is being drawn / likely to pin)
    magnet = max(all_additions, key=lambda x: x['latest_oi'], default=None)
    return {
        'method': 'latest OI heatmap build-up: newest non-null date minus previous non-null date',
        'bias': bias,
        'added_above_price': round(above_total, 2),
        'added_below_price': round(below_total, 2),
        'support_build': round(support_build, 2),
        'resistance_build': round(resistance_build, 2),
        'magnet': None if not magnet else {
            'strike': magnet['strike'], 'latest_oi': magnet['latest_oi'],
            'oi_type': magnet['oi_type'], 'side': magnet['side'],
            'distance_points': magnet['distance_points'],
        },
        'top_additions': all_additions[:8],
        'contracts': contracts,
        'note': 'Build tagged via position_map: call build above = growing resistance, put build below = growing support; magnet = largest growing OI pile.',
    }


def analyze_gamma_1pct(asset_id):
    walls = []
    for key in CONTRACT_KEYS:
        hm = load_heatmap(asset_id, key, gamma=True)
        if not hm:
            continue
        price = hm.get('underlying')
        for row in hm.get('strikes') or []:
            strike = _num(row.get('strike'))
            latest, _, _ = _latest_change(row.get('values') or [])
            if strike is None or latest is None or latest <= 0:
                continue
            walls.append({
                'contract_key': key,
                'contract': hm.get('contract'),
                'strike': strike,
                'gamma_1pct': round(latest, 2),
                'distance_points': None if price is None else round(strike - float(price), 2),
                'side': 'above' if price is not None and strike > float(price) else ('below' if price is not None and strike < float(price) else 'at_price'),
            })
    walls.sort(key=lambda x: x['gamma_1pct'], reverse=True)
    top_gamma = walls[0]['gamma_1pct'] if walls else 0
    significant_floor = max(50, top_gamma * 0.25)
    significant = [w for w in walls if w['gamma_1pct'] >= significant_floor]
    # nearest = first speed bump (by distance); major = nearest *big* wall (the real cap)
    above = sorted((w for w in significant if w['side'] == 'above'), key=lambda x: (abs(x['distance_points'] or 0), -x['gamma_1pct']))
    below = sorted((w for w in significant if w['side'] == 'below'), key=lambda x: (abs(x['distance_points'] or 0), -x['gamma_1pct']))

    def _first_major(side_walls):
        """Nearest wall whose gamma is within 60% of the biggest on that side —
        the first wall large enough to actually stall a move, not the farthest-biggest."""
        if not side_walls:
            return None
        smax = max(w['gamma_1pct'] for w in side_walls)
        big = [w for w in side_walls if w['gamma_1pct'] >= 0.6 * smax]
        return min(big, key=lambda w: abs(w['distance_points'] or 0)) if big else None

    major_above = _first_major([w for w in significant if w['side'] == 'above'])
    major_below = _first_major([w for w in significant if w['side'] == 'below'])
    magnet = walls[0] if walls else None   # single largest-gamma strike = dominant pin
    return {
        'method': 'Gamma (1 Pct) heatmap latest non-null value by strike',
        'significant_floor': round(significant_floor, 2),
        'nearest_upside_wall': above[0] if above else None,
        'nearest_downside_wall': below[0] if below else None,
        'major_upside_wall': major_above,
        'major_downside_wall': major_below,
        'gamma_magnet': magnet,
        'top_walls': walls[:10],
        'significant_walls': significant[:12],
        'upside_room_points': (above[0].get('distance_points') if above else None),
        'downside_room_points': (abs(below[0].get('distance_points')) if below else None),
        'upside_room_to_major': (major_above.get('distance_points') if major_above else None),
        'downside_room_to_major': (abs(major_below.get('distance_points')) if major_below and major_below.get('distance_points') is not None else None),
        'note': 'Nearest wall = first speed bump (by distance); major wall = biggest gamma (the real cap); magnet = single largest-gamma strike price gravitates to.',
    }


def analyze_vol2vol_walls(asset_id):
    levels = []
    for key in CONTRACT_KEYS:
        detail = load_position_detail(asset_id, key)
        if not detail:
            continue
        for row in detail.get('position_map') or []:
            strike = _num(row.get('strike'))
            if strike is None:
                continue
            levels.append({
                'contract_key': key,
                'contract': detail.get('contract'),
                'strike': strike,
                'side': row.get('side'),
                'total_oi': row.get('total_oi') or 0,
                'call_oi': row.get('call_oi') or 0,
                'put_oi': row.get('put_oi') or 0,
                'intraday_volume': row.get('intraday_volume') or 0,
                'activity_vs_oi': row.get('activity_vs_oi') or 0,
                'distance_points': (row.get('distance') or {}).get('points'),
                'distance_pct': (row.get('distance') or {}).get('pct'),
                'location': (row.get('distance') or {}).get('side'),
            })
    levels.sort(key=lambda x: (x['total_oi'], x['intraday_volume']), reverse=True)
    above = sorted((x for x in levels if x.get('location') == 'above'), key=lambda x: abs(x.get('distance_points') or 0))
    below = sorted((x for x in levels if x.get('location') == 'below'), key=lambda x: abs(x.get('distance_points') or 0))
    return {
        'method': 'Vol2Vol position_map total OI + intraday activity by strike and tenor',
        'nearest_resistance': above[0] if above else None,
        'nearest_support': below[0] if below else None,
        'top_walls': levels[:10],
        'note': 'Use side + activity_vs_oi to distinguish static wall from active wall.',
    }


VISIBLE_STRIKE_RANGE = 350   # mirrors web/src/lib/config.js gc.visibleStrikeRange


def analyze_round_numbers(price, visible_range=VISIBLE_STRIKE_RANGE):
    """Round-number levels around price: multiples of 100 (primary) and 50 (secondary)."""
    if price is None:
        return {'levels': [], 'note': 'no price'}
    price = float(price)
    lo, hi = price - visible_range, price + visible_range
    levels = []
    n = int(lo // 50) * 50
    while n <= hi:
        if n >= lo and n != 0 and n % 50 == 0:
            tag = 'round_100' if n % 100 == 0 else 'round_50'
            levels.append({
                'level': float(n),
                'tag': tag,
                'distance_points': round(n - price, 2),
                'side': 'above' if n > price else ('below' if n < price else 'at_price'),
            })
        n += 50
    return {
        'levels': levels,
        'visible_range': visible_range,
        'note': 'Round numbers within visible strike range (×100 primary, ×50 secondary).',
    }


def build_confluence(price, gamma, vol2vol, heatmap_flow, round_nums, vwap=None):
    """Cluster levels from OI walls + gamma walls + fresh OI builds + round numbers
    + VWAP SD bands.

    A level confirmed by ≥2 independent source categories is high-conviction — these
    are the strikes worth trading around. Returns levels with sources + confluence count."""
    if not price:
        return []
    price = float(price)
    tol = max(4.0, price * 0.001)   # ~$4.5 for gold: merges same-strike, keeps 5-grid apart
    candidates = []
    for w in (gamma.get('significant_walls') or []):
        candidates.append({'strike': w['strike'], 'source': 'gamma_wall',
                           'detail': f"γ{w['gamma_1pct']:.0f}", 'weight': w['gamma_1pct']})
    for w in (vol2vol.get('top_walls') or []):
        candidates.append({'strike': w['strike'], 'source': 'oi_wall',
                           'detail': f"{w['total_oi']:.0f}OI/{w.get('side', '')}", 'weight': w['total_oi']})
    for a in (heatmap_flow.get('top_additions') or []):
        candidates.append({'strike': a['strike'], 'source': 'oi_build',
                           'detail': f"+{a['change_1d']:.0f}/{a.get('oi_type') or '?'}", 'weight': a['change_1d']})
    for r in (round_nums.get('levels') or []):
        candidates.append({'strike': r['level'], 'source': r['tag'],
                           'detail': r['tag'].replace('round_', '×'), 'weight': 0})
    # VWAP ±2/±3 SD = the mean-reversion fade bands worth confluence-checking
    daily = (vwap or {}).get('daily') or {}
    for bk, lvl in (daily.get('bands') or {}).items():
        if bk in ('plus2', 'minus2', 'plus3', 'minus3') and lvl is not None:
            candidates.append({'strike': float(lvl), 'source': 'vwap_band',
                               'detail': bk.replace('plus', '+').replace('minus', '-') + 'sd', 'weight': 0})

    candidates.sort(key=lambda c: c['strike'])
    clusters = []
    for c in candidates:
        placed = next((cl for cl in clusters if abs(cl['anchor'] - c['strike']) <= tol), None)
        if placed:
            placed['members'].append(c)
        else:
            clusters.append({'anchor': c['strike'], 'members': [c]})

    levels = []
    for cl in clusters:
        members = cl['members']
        srcs = sorted({m['source'] for m in members})
        # distinct categories (round_100/round_50 collapse to one 'round' category)
        cats = {('round' if s.startswith('round') else s) for s in srcs}
        if len(cats) < 2:
            continue
        round_member = next((m for m in members if m['source'].startswith('round')), None)
        level = round_member['strike'] if round_member else max(members, key=lambda m: m['weight'])['strike']
        levels.append({
            'level': round(level, 2),
            'sources': srcs,
            'confluence': len(cats),
            'side': 'above' if level > price else ('below' if level < price else 'at_price'),
            'distance_points': round(level - price, 2),
            'detail': [f"{m['source']}:{m['detail']}" for m in members],
        })
    levels.sort(key=lambda l: (-l['confluence'], abs(l['distance_points'])))
    return levels[:8]


def _score_from_flow(flow):
    if not flow:
        return 0
    sup = flow.get('support_build') or 0       # puts building below = bullish floor
    res = flow.get('resistance_build') or 0    # calls building above = bearish cap
    total = sup + res
    if total <= 0:
        return 0
    return round(_clamp((sup - res) / total * 45, -45, 45), 1)


def build_key_levels(contracts, price):
    """Gather wall strikes from all tenors into nearest supports/resistances + magnet."""
    if not price:
        # fall back to nearest contract's price
        price = next((c.get('future_price') for c in contracts if c.get('future_price')), None)
    res, sup = set(), set()
    for c in contracts:
        for k in ('dominant_call_wall', 'dominant_put_wall', 'largest_position'):
            w = c.get(k)
            if w is None or price is None:
                continue
            if w > price:
                res.add(round(w, 2))
            elif w < price:
                sup.add(round(w, 2))
    resistances = sorted(res)[:4]                       # nearest above, ascending
    supports = sorted(sup, reverse=True)[:4]            # nearest below, descending
    # magnet = largest_position of the nearest-dte contract
    nearest = min(contracts, key=lambda c: (c.get('dte') if c.get('dte') is not None else 1e9), default=None) \
        if contracts else None
    magnet = nearest.get('largest_position') if nearest else None
    return {'supports': supports, 'resistances': resistances, 'magnet': magnet}, price


# ---- Macro layer ------------------------------------------------------------

def load_macro(macro_key):
    m = _load_json(os.path.join(BASE_OUTPUT_DIR, 'macro.json'))
    if not m:
        return None
    interp = (m.get('interpretation') or {}).get(macro_key)
    if not interp:
        return None
    return {
        'score': float(interp.get('score', 0)),
        'label': interp.get('label', 'neutral'),
        'drivers': interp.get('drivers', []),
        'generated_at': m.get('generated_at'),
    }


# ---- COT layer --------------------------------------------------------------

def load_cot(asset_id):
    cot = _load_json(os.path.join(_data_dir(asset_id), 'cot.json'))
    if not cot:
        return None
    interp = cot.get('interpretation') or {}
    # v2: net_label blends MM momentum + commercial smart-money + crowding.
    # Falls back to v1 'label' so an old cot.json still works.
    label = interp.get('net_label') or interp.get('label', 'neutral')
    base = {'bullish': 35, 'lean_bullish': 18, 'neutral': 0,
            'lean_bearish': -18, 'bearish': -35}.get(label, 0)
    smart = (cot.get('smart_money') or {}).get('signal')
    if smart == 'bullish':
        base += 8           # commercials = highest-quality directional tell
    elif smart == 'bearish':
        base -= 8
    if base == 0:           # v1 fallback: no net_label, nudge by MM trend
        primary = cot.get('managed_money') or {}
        base += {'rising': 10, 'falling': -10}.get(primary.get('trend'), 0)
    return {
        'score': float(_clamp(base, -50, 50)),
        'label': label,
        'note': interp.get('note', ''),
        'report_date': cot.get('report_date'),
        'contrarian': interp.get('contrarian', 'none'),
        'smart_money': smart or 'neutral',
    }


# ---- VWAP / volatility layer ------------------------------------------------

def load_vwap(asset_id):
    return _load_json(os.path.join(_data_dir(asset_id), 'vwap.json'))


def load_ohlc_daily(asset_id):
    return _load_json(os.path.join(_data_dir(asset_id), 'OHLC.json'))


def _atr(candles, period=14):
    """Average True Range over the last `period` daily candles."""
    if not candles or len(candles) < 2:
        return None
    trs = []
    for i in range(1, len(candles)):
        h, l = _num(candles[i].get('high')), _num(candles[i].get('low'))
        pc = _num(candles[i - 1].get('close'))
        if None in (h, l, pc):
            continue
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return None
    window = trs[-period:]
    return sum(window) / len(window)


def analyze_expected_range(price, ohlc_daily):
    """Daily expected move from ATR(14) — anchors realistic intraday targets."""
    candles = (ohlc_daily or {}).get('candles') or []
    atr = _atr(candles, 14)
    if atr is None or price is None:
        return None
    return {
        'method': 'ATR(14) daily true-range proxy',
        'atr': round(atr, 2),
        'expected_move': round(atr, 2),
        'day_high_est': round(price + atr, 2),
        'day_low_est': round(price - atr, 2),
        'note': 'Typical 1-day travel; a wall beyond ±ATR from price is unlikely to be reached intraday.',
    }


def detect_regime(price, vwap, expected_range, macro):
    """Trending vs range — picks which playbook (momentum vs mean-reversion) leads.

    Trending when price is stretched from session VWAP (>1.2 SD) AND the daily ATR is
    wide vs the SD band; range when price hugs VWAP and bands are tight."""
    daily = (vwap or {}).get('daily') or {}
    sd = daily.get('sd')
    vw = daily.get('vwap')
    reasons = []
    z = None
    if price is not None and vw is not None and sd:
        z = abs(price - vw) / sd
        reasons.append(f'price {z:.1f} SD from session VWAP')
    atr = (expected_range or {}).get('atr')
    band_width = (sd * 2) if sd else None     # ±1 SD width
    vix = ((macro or {}).get('series') or {}).get('vix_live') or ((macro or {}).get('series') or {}).get('vix') or {}
    vix_val = _num(vix.get('value'))
    score = 0
    if z is not None:
        if z >= 1.2:
            score += 1
        elif z <= 0.6:
            score -= 1
    if atr and band_width and band_width > 0:
        ratio = atr / band_width
        reasons.append(f'ATR/SD-band {ratio:.1f}x')
        if ratio >= 1.5:
            score += 1
        elif ratio <= 0.9:
            score -= 1
    if vix_val is not None:
        reasons.append(f'VIX {vix_val:.1f}')
        if vix_val >= 20:
            score += 1     # high vol → trend/expansion risk
        elif vix_val <= 14:
            score -= 1     # calm → range/mean-reversion
    regime = 'trending' if score >= 1 else ('range' if score <= -1 else 'mixed')
    return {'regime': regime, 'score': score, 'reasons': reasons,
            'lead_playbook': 'momentum' if regime == 'trending' else ('mean_reversion' if regime == 'range' else 'both')}


# ---- Synthesis --------------------------------------------------------------

def build_strategy(asset_id):
    cfg = ASSETS[asset_id]
    pos_score, pos_label, contracts = load_positioning(asset_id)
    macro = load_macro(cfg['macro_key'])
    cot = load_cot(asset_id)
    macro_raw = _load_json(os.path.join(BASE_OUTPUT_DIR, 'macro.json'))
    vwap = load_vwap(asset_id)
    ohlc_daily = load_ohlc_daily(asset_id)
    oi_lookup = build_oi_lookup(asset_id)
    heatmap_flow = analyze_heatmap_flow(asset_id, oi_lookup)
    gamma_1pct = analyze_gamma_1pct(asset_id)
    vol2vol_walls = analyze_vol2vol_walls(asset_id)

    if pos_score is None and macro is None and cot is None:
        print(f'[STRATEGY] {cfg["short"]}: no input layers found — skipping')
        return None

    # Weighted blend over whichever layers are present (renormalize weights).
    parts = []
    if pos_score is not None:
        parts.append((pos_score, W_POSITIONING))
    if macro is not None:
        parts.append((macro['score'], W_MACRO))
    if cot is not None:
        parts.append((cot['score'], W_COT))
    flow_score = _score_from_flow(heatmap_flow)
    if flow_score:
        # Keep the old 3-layer score dominant, but let fresh heatmap build-up nudge
        # the read because this is the fastest options-positioning signal we have.
        parts.append((flow_score, 0.15))
    wsum = sum(w for _, w in parts) or 1.0
    blended = round(sum(s * w for s, w in parts) / wsum, 1)
    label = _label_from_score(blended)

    # Layer agreement -> confidence
    signs = [_sign(s) for s, _ in parts if s is not None]
    nz = [x for x in signs if x != 0]
    bull = sum(1 for x in nz if x > 0)
    bear = sum(1 for x in nz if x < 0)
    overall_sign = _sign(blended)
    # when the blend is neutral (sign 0) no layer "matches" it — show the larger camp instead
    agree = sum(1 for x in nz if x == overall_sign) if overall_sign != 0 else max(bull, bear)
    total = len(nz)
    if total >= 3 and agree == total:
        confidence = 'high'
    elif total >= 2 and agree >= total - (0 if total < 3 else 1) and agree >= 2:
        confidence = 'medium'
    else:
        confidence = 'low'
    # near-dated expiry positioning is noisy -> cap confidence
    nearest = min(contracts, key=lambda c: (c.get('dte') if c.get('dte') is not None else 1e9), default=None) \
        if contracts else None
    if nearest and (nearest.get('dte') or 0) < 0.5 and confidence == 'high':
        confidence = 'medium'
    # COT crowding extreme -> trend read is fragile, cap confidence and flag it
    cot_contrarian = cot.get('contrarian', 'none') if cot else 'none'
    if cot_contrarian in ('caution_top', 'caution_bottom') and confidence == 'high':
        confidence = 'medium'

    price = nearest.get('future_price') if nearest else None
    key_levels, price = build_key_levels(contracts, price)

    # Volatility context: daily expected range (ATR) + trending/range regime
    expected_range = analyze_expected_range(price, ohlc_daily)
    regime = detect_regime(price, vwap, expected_range, macro_raw)

    # Round numbers + confluence across OI walls / gamma walls / fresh builds / round# / VWAP SD
    round_numbers = analyze_round_numbers(price)
    confluence_levels = build_confluence(price, gamma_1pct, vol2vol_walls, heatmap_flow, round_numbers, vwap)
    # split by side, nearest-first, for scenario triggers/targets
    conf_res = sorted((c for c in confluence_levels if c['side'] == 'above'), key=lambda c: abs(c['distance_points']))
    conf_sup = sorted((c for c in confluence_levels if c['side'] == 'below'), key=lambda c: abs(c['distance_points']))

    # Narrative context strings
    macro_context = None
    if macro:
        macro_context = f"Macro {macro['label']} ({macro['score']:+.0f}): " + '; '.join(macro['drivers'])
    cot_context = cot['note'] if cot else None

    nearest_gamma_up = gamma_1pct.get('nearest_upside_wall') if gamma_1pct else None
    nearest_gamma_down = gamma_1pct.get('nearest_downside_wall') if gamma_1pct else None
    major_gamma_up = gamma_1pct.get('major_upside_wall') if gamma_1pct else None
    major_gamma_down = gamma_1pct.get('major_downside_wall') if gamma_1pct else None
    gamma_magnet = gamma_1pct.get('gamma_magnet') if gamma_1pct else None
    nearest_vol_up = vol2vol_walls.get('nearest_resistance') if vol2vol_walls else None
    nearest_vol_down = vol2vol_walls.get('nearest_support') if vol2vol_walls else None
    oi_magnet = heatmap_flow.get('magnet') if heatmap_flow else None
    top_build = (heatmap_flow.get('top_additions') or [None])[0] if heatmap_flow else None

    def _pick_target(trigger, candidates, direction):
        """Nearest distinct level beyond the trigger in the trade direction."""
        vals = sorted({c for c in candidates if c is not None})
        if trigger is not None:
            vals = [c for c in vals if (c > trigger + 0.01 if direction == 'up' else c < trigger - 0.01)]
        if not vals:
            return None
        return min(vals, key=lambda c: abs(c - trigger)) if trigger is not None else vals[0]

    # Confluence-first scenarios; fall back to wall levels. Target is always a
    # distinct level beyond the trigger (no more trigger == target).
    scenarios = []
    r0 = key_levels['resistances'][0] if key_levels['resistances'] else None
    r1 = key_levels['resistances'][1] if len(key_levels['resistances']) > 1 else None
    s0 = key_levels['supports'][0] if key_levels['supports'] else None
    s1 = key_levels['supports'][1] if len(key_levels['supports']) > 1 else None

    up_trigger_c = conf_res[0] if conf_res else None
    up_trigger = up_trigger_c['level'] if up_trigger_c else r0
    up_cands = [c['level'] for c in conf_res[1:]] + [
        (major_gamma_up or {}).get('strike'), (nearest_gamma_up or {}).get('strike'),
        (nearest_vol_up or {}).get('strike'), r1,
    ] + list(key_levels['resistances'])
    up_target = _pick_target(up_trigger, up_cands, 'up')

    dn_trigger_c = conf_sup[0] if conf_sup else None
    dn_trigger = dn_trigger_c['level'] if dn_trigger_c else s0
    dn_cands = [c['level'] for c in conf_sup[1:]] + [
        (major_gamma_down or {}).get('strike'), (nearest_gamma_down or {}).get('strike'),
        (nearest_vol_down or {}).get('strike'), s1,
    ] + list(key_levels['supports'])
    dn_target = _pick_target(dn_trigger, dn_cands, 'down')

    def _trig_txt(level, conf, verb):
        tag = f' (confluence ×{conf["confluence"]})' if conf else ''
        return f'{verb} {_fmt_level(level)}{tag}'

    if up_trigger is not None:
        scenarios.append({
            'bias': 'upside',
            'trigger': _trig_txt(up_trigger, up_trigger_c, 'sustained move above'),
            'then': (f'path toward {_fmt_level(up_target)}'
                     + (f' (major gamma wall γ{major_gamma_up["gamma_1pct"]:.0f})'
                        if major_gamma_up and up_target == major_gamma_up.get('strike') else '')
                     ) if up_target is not None else 'momentum extension higher',
            'invalidation': f'back below {_fmt_level(dn_trigger)}' if dn_trigger is not None else 'loss of the breakout level',
        })
    if dn_trigger is not None:
        scenarios.append({
            'bias': 'downside',
            'trigger': _trig_txt(dn_trigger, dn_trigger_c, 'break below'),
            'then': (f'toward {_fmt_level(dn_target)}'
                     + (f' (major gamma wall γ{major_gamma_down["gamma_1pct"]:.0f})'
                        if major_gamma_down and dn_target == major_gamma_down.get('strike') else '')
                     ) if dn_target is not None else 'lower support void',
            'invalidation': f'reclaim {_fmt_level(up_trigger)}' if up_trigger is not None else 'recovery of broken support',
        })

    # What would flip the view: name the weakest-aligned layer
    flip = []
    if overall_sign >= 0:
        if pos_score is not None and _sign(pos_score) < 0:
            flip.append('call walls keep building above price (options positioning stays heavy)')
        if macro and macro['score'] < 0:
            flip.append('real yields / DXY turn higher')
        if cot and cot['score'] < 0:
            flip.append('funds cut longs (COT rolls over)')
    else:
        if pos_score is not None and _sign(pos_score) > 0:
            flip.append('put support thins out / call walls clear')
        if macro and macro['score'] > 0:
            flip.append('real yields fall / DXY rolls over')
        if cot and cot['score'] > 0:
            flip.append('funds add longs (COT turns up)')
    if cot_contrarian == 'caution_top':
        flip.append('MM is crowded long (COT) — a long flush could flip this into a mean-reversion down')
    elif cot_contrarian == 'caution_bottom':
        flip.append('MM is crowded short (COT) — a squeeze could flip this into a mean-reversion up')
    if not flip:
        flip.append('a clean break of the key levels above with the macro backdrop confirming')

    hbias = heatmap_flow.get('bias') if heatmap_flow else None
    if regime['regime'] == 'trending':
        if overall_sign > 0 or hbias == 'upside_magnet':
            primary_path = 'upside_momentum_to_major_gamma_wall'
        elif overall_sign < 0 or hbias == 'downside_magnet':
            primary_path = 'downside_momentum_to_major_gamma_wall'
        else:
            primary_path = 'breakout_pending_pick_a_side'
    elif regime['regime'] == 'range':
        primary_path = 'mean_revert_at_vwap_sd_and_walls'
    else:  # mixed
        if hbias == 'upside_magnet' and overall_sign >= 0:
            primary_path = 'upside_momentum_to_first_gamma_wall'
        elif hbias == 'downside_magnet' and overall_sign <= 0:
            primary_path = 'downside_momentum_to_first_gamma_wall'
        elif nearest_vol_up and nearest_vol_down:
            primary_path = 'trade_between_nearest_vol2vol_walls'
        else:
            primary_path = 'range_first'

    def _gamma_limit(nearest_w, major_w):
        if not nearest_w and not major_w:
            return None
        parts_l = []
        if nearest_w:
            parts_l.append(f"first {_fmt_level(nearest_w['strike'])} (γ{nearest_w['gamma_1pct']:.0f})")
        if major_w and (not nearest_w or major_w['strike'] != nearest_w['strike']):
            parts_l.append(f"major {_fmt_level(major_w['strike'])} (γ{major_w['gamma_1pct']:.0f})")
        return '; '.join(parts_l)

    top_conf = confluence_levels[0] if confluence_levels else None

    execution_read = {
        'primary_path': primary_path,
        'contract_build_up': None if not top_build else (
            f"largest fresh OI build at {_fmt_level(top_build['strike'])} "
            f"({top_build['contract_key']}, +{top_build['change_1d']:.0f} contracts, {top_build['side']}, "
            f"{top_build.get('oi_type') or '?'} → {top_build.get('wall_role') or 'n/a'})"
        ),
        'oi_magnet': None if not oi_magnet else (
            f"{_fmt_level(oi_magnet['strike'])} ({oi_magnet.get('oi_type') or '?'}, {oi_magnet['latest_oi']:.0f} OI, {oi_magnet['side']})"
        ),
        'gamma_magnet': None if not gamma_magnet else (
            f"{_fmt_level(gamma_magnet['strike'])} (γ{gamma_magnet['gamma_1pct']:.0f})"
        ),
        'upside_limit': _gamma_limit(nearest_gamma_up, major_gamma_up),
        'downside_limit': _gamma_limit(nearest_gamma_down, major_gamma_down),
        'confluence_focus': None if not top_conf else (
            f"{_fmt_level(top_conf['level'])} (×{top_conf['confluence']}: {', '.join(top_conf['sources'])})"
        ),
        'nearest_wall_band': {
            'support': None if not nearest_vol_down else nearest_vol_down['strike'],
            'resistance': None if not nearest_vol_up else nearest_vol_up['strike'],
        },
        'how_to_use': 'Heatmap build/magnet = likely destination; gamma 1pct first wall = speed bump, major wall = real cap; confluence levels (≥2 sources) are the highest-conviction strikes.',
    }

    return {
        'version': 2,
        'asset': cfg['short'],
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'future_price': price,
        'directional_bias': {'label': label, 'score': blended, 'confidence': confidence},
        'components': {
            'positioning': None if pos_score is None else {'score': round(pos_score, 1), 'label': pos_label, 'weight': W_POSITIONING},
            'macro': None if macro is None else {'score': round(macro['score'], 1), 'label': macro['label'], 'weight': W_MACRO, 'drivers': macro['drivers']},
            'cot': None if cot is None else {'score': round(cot['score'], 1), 'label': cot['label'], 'weight': W_COT, 'note': cot['note'], 'report_date': cot.get('report_date'), 'contrarian': cot.get('contrarian', 'none'), 'smart_money': cot.get('smart_money', 'neutral')},
        },
        'agreement': {'bullish_layers': bull, 'bearish_layers': bear, 'aligned': agree, 'total': total},
        'regime': regime,
        'expected_range': expected_range,
        'vwap': None if not vwap else {
            'daily': vwap.get('daily'),
            'weekly_vwap': (vwap.get('weekly') or {}).get('vwap'),
            'price_vs_band': (vwap.get('daily') or {}).get('price_vs_band'),
            'generated_at': vwap.get('generated_at'),
        },
        'contrarian_flag': cot_contrarian,
        'key_levels': key_levels,
        'confluence_levels': confluence_levels,
        'round_numbers': round_numbers,
        'heatmap_contract_flow': heatmap_flow,
        'gamma_1pct': gamma_1pct,
        'vol2vol_walls': vol2vol_walls,
        'execution_read': execution_read,
        'macro_context': macro_context,
        'cot_context': cot_context,
        'scenarios': scenarios,
        'what_would_change_my_mind': '; '.join(flip) + '.',
        'disclaimer': ('Educational/hypothetical synthesis of options positioning + macro + COT. '
                       'Not financial advice; produces a directional read and levels, not live entry/stop/target orders.'),
    }


def write_strategy(asset_id):
    payload = build_strategy(asset_id)
    if not payload:
        return False
    out_dir = _data_dir(asset_id)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'daily_strategy.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)
    db = payload['directional_bias']
    print(f"[STRATEGY] {payload['asset']}: {db['label']} ({db['score']:+}) conf={db['confidence']} "
          f"[{payload['agreement']['aligned']}/{payload['agreement']['total']} aligned]")
    print(f'[STRATEGY] wrote {out_path}')
    return True


def main():
    parser = argparse.ArgumentParser(description='Vol2Vol daily strategy synthesizer (v1, rule-based)')
    parser.add_argument('--asset', choices=['gc', 'all'], default='all')
    args = parser.parse_args()
    assets = ['gc'] if args.asset == 'all' else [args.asset]

    print('=' * 60)
    print('  Vol2Vol Daily Strategy Synthesizer (v1)')
    print('=' * 60)
    ok = False
    for a in assets:
        try:
            ok = write_strategy(a) or ok
        except Exception as e:
            print(f'[STRATEGY] {a}: failed — {e}')
    raise SystemExit(0 if ok else 1)


if __name__ == '__main__':
    main()
