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


def _sign(s):
    return 1 if s > 8 else (-1 if s < -8 else 0)


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
    label = interp.get('label', 'neutral')
    base = {'bullish': 30, 'bearish': -30, 'neutral': 0}.get(label, 0)
    # nudge by the primary group's trend (rising net -> reinforce direction)
    primary = cot.get('managed_money') or cot.get('leveraged_funds') or cot.get('asset_manager') or {}
    trend = primary.get('trend')
    if trend == 'rising':
        base += 10
    elif trend == 'falling':
        base -= 10
    return {
        'score': float(_clamp(base, -50, 50)),
        'label': label,
        'note': interp.get('note', ''),
        'report_date': cot.get('report_date'),
    }


# ---- Synthesis --------------------------------------------------------------

def build_strategy(asset_id):
    cfg = ASSETS[asset_id]
    pos_score, pos_label, contracts = load_positioning(asset_id)
    macro = load_macro(cfg['macro_key'])
    cot = load_cot(asset_id)

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
    wsum = sum(w for _, w in parts) or 1.0
    blended = round(sum(s * w for s, w in parts) / wsum, 1)
    label = _label_from_score(blended)

    # Layer agreement -> confidence
    signs = [_sign(s) for s, _ in parts if s is not None]
    nz = [x for x in signs if x != 0]
    bull = sum(1 for x in nz if x > 0)
    bear = sum(1 for x in nz if x < 0)
    overall_sign = _sign(blended)
    agree = sum(1 for x in nz if x == overall_sign)
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

    price = nearest.get('future_price') if nearest else None
    key_levels, price = build_key_levels(contracts, price)

    # Narrative context strings
    macro_context = None
    if macro:
        macro_context = f"Macro {macro['label']} ({macro['score']:+.0f}): " + '; '.join(macro['drivers'])
    cot_context = cot['note'] if cot else None

    # Deterministic scenarios from the nearest levels
    scenarios = []
    r0 = key_levels['resistances'][0] if key_levels['resistances'] else None
    r1 = key_levels['resistances'][1] if len(key_levels['resistances']) > 1 else None
    s0 = key_levels['supports'][0] if key_levels['supports'] else None
    s1 = key_levels['supports'][1] if len(key_levels['supports']) > 1 else None
    if r0:
        scenarios.append({
            'bias': 'upside',
            'trigger': f'sustained move above {r0}',
            'then': f'opens path toward {r1}' if r1 else 'momentum extension higher',
            'invalidation': f'back below {s0}' if s0 else 'loss of the breakout level',
        })
    if s0:
        scenarios.append({
            'bias': 'downside',
            'trigger': f'break below {s0}',
            'then': f'toward {s1}' if s1 else 'lower support void',
            'invalidation': f'reclaim {r0}' if r0 else 'recovery of broken support',
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
    if not flip:
        flip.append('a clean break of the key levels above with the macro backdrop confirming')

    return {
        'version': 1,
        'asset': cfg['short'],
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'future_price': price,
        'directional_bias': {'label': label, 'score': blended, 'confidence': confidence},
        'components': {
            'positioning': None if pos_score is None else {'score': round(pos_score, 1), 'label': pos_label, 'weight': W_POSITIONING},
            'macro': None if macro is None else {'score': round(macro['score'], 1), 'label': macro['label'], 'weight': W_MACRO, 'drivers': macro['drivers']},
            'cot': None if cot is None else {'score': round(cot['score'], 1), 'label': cot['label'], 'weight': W_COT, 'note': cot['note'], 'report_date': cot.get('report_date')},
        },
        'agreement': {'bullish_layers': bull, 'bearish_layers': bear, 'aligned': agree, 'total': total},
        'key_levels': key_levels,
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
