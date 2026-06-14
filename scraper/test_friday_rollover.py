# Repro/falsification harness for the Friday-rollover staleness bug.
# Simulates the exact saved state from Thursday 2026-06-11 and asserts:
#   1. _saved_slot_symbol parses the real OIData headers
#   2. _promote_slots on Friday promotes the FRIDAY slot (OG2M6, exp 6/12)
#      into current — not Thursday's "tomorrow" slot (G3MM6, exp 6/15 Monday)
#   3. the intraday OI-repair condition fires for current/friday and not for
#      slots whose saved symbol already matches
import os
import sys
import tempfile
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quikstrike_scraper import _saved_slot_symbol, _promote_slots

# Real headers as saved by Thursday's last full run
HEADERS = {
    'current':  'Option Contract:\t\tJun 2026 Option Expiration:\t6/11/2026 (0.33 DTE) Option Symbol:\t\tG2RM6 Underlying Future:\tAug 2026',
    'tomorrow': 'Option Contract:\t\tJun 2026 Option Expiration:\t6/15/2026 (4.33 DTE) Option Symbol:\t\tG3MM6 Underlying Future:\tAug 2026',
    'friday':   'Option Contract:\t\tJun 2026 Option Expiration:\t6/12/2026 (1.33 DTE) Option Symbol:\t\tOG2M6 Underlying Future:\tAug 2026',
    'monthly':  'Option Contract:\t\tJul 2026 Option Expiration:\t6/25/2026 (14.33 DTE) Option Symbol:\t\tOGN6 Underlying Future:\tAug 2026',
}

failures = []

def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    print(f'[{status}] {name} {detail}')
    if not cond:
        failures.append(name)

def write_position_bias(path, slot, symbol):
    with open(os.path.join(path, f'{slot}_PositionBias.json'), 'w', encoding='utf-8') as fh:
        json.dump({'contract_key': slot, 'contract': symbol}, fh)
        fh.write('\n')

def read_position_bias_slot(path, slot):
    with open(os.path.join(path, f'{slot}_PositionBias.json'), encoding='utf-8') as fh:
        return json.load(fh).get('contract_key')

with tempfile.TemporaryDirectory() as d:
    for slot, hdr in HEADERS.items():
        with open(os.path.join(d, f'{slot}_OIData.txt'), 'w', encoding='utf-8') as fh:
            fh.write(hdr + '\nStrike,Call,Put,Vol Settle\n3865,0,0,0.73\n')
        write_position_bias(d, slot, _saved_slot_symbol(d, slot))

    # 1. header symbol parsing
    check('parse current symbol', _saved_slot_symbol(d, 'current') == 'G2RM6',
          f'-> {_saved_slot_symbol(d, "current")}')
    check('parse friday symbol', _saved_slot_symbol(d, 'friday') == 'OG2M6',
          f'-> {_saved_slot_symbol(d, "friday")}')
    check('missing file -> None', _saved_slot_symbol(d, 'nope') is None)

    # 2. Thursday->Friday promote: friday slot must win (earliest expiry)
    _promote_slots(d)
    promoted = _saved_slot_symbol(d, 'current')
    check('promote picks friday slot', promoted == 'OG2M6', f'-> current now {promoted}')
    check('promote restamps current PositionBias key',
          read_position_bias_slot(d, 'current') == 'current',
          f'-> {read_position_bias_slot(d, "current")}')
    tom_after = _saved_slot_symbol(d, 'tomorrow')
    check('tomorrow slot untouched', tom_after == 'G3MM6', f'-> {tom_after}')
    check('tomorrow PositionBias key stays tomorrow',
          read_position_bias_slot(d, 'tomorrow') == 'tomorrow',
          f'-> {read_position_bias_slot(d, "tomorrow")}')

    # idempotency: second promote is a no-op
    _promote_slots(d)
    check('promote idempotent', _saved_slot_symbol(d, 'current') == 'OG2M6')

# 3. OI-repair trigger logic (same comparison as the scrape_asset loop)
with tempfile.TemporaryDirectory() as d:
    for slot, hdr in HEADERS.items():
        with open(os.path.join(d, f'{slot}_OIData.txt'), 'w', encoding='utf-8') as fh:
            fh.write(hdr + '\n')
    # Friday's actual classification (from today's intraday run)
    classified = {'current': 'OG2M6', 'tomorrow': 'G3MM6', 'friday': 'OG4M6', 'monthly': 'OGN6'}
    expected_repair = {'current': True, 'tomorrow': False, 'friday': True, 'monthly': False}
    for slot, sym in classified.items():
        fires = _saved_slot_symbol(d, slot) != sym
        check(f'repair[{slot}]', fires == expected_repair[slot],
              f'saved={_saved_slot_symbol(d, slot)} classified={sym} -> force_oi={fires}')

# Mon-Thu regression: tomorrow slot expires before friday slot -> default path
with tempfile.TemporaryDirectory() as d:
    weekday = {
        'current':  'Option Expiration:\t6/9/2026 (0.3 DTE) Option Symbol:\t\tG1TM6',
        'tomorrow': 'Option Expiration:\t6/10/2026 (1.3 DTE) Option Symbol:\t\tG2WM6',
        'friday':   'Option Expiration:\t6/12/2026 (3.3 DTE) Option Symbol:\t\tOG2M6',
    }
    for slot, hdr in weekday.items():
        with open(os.path.join(d, f'{slot}_OIData.txt'), 'w', encoding='utf-8') as fh:
            fh.write(hdr + '\n')
        write_position_bias(d, slot, _saved_slot_symbol(d, slot))
    _promote_slots(d)
    check('weekday promote: tomorrow->current', _saved_slot_symbol(d, 'current') == 'G2WM6',
          f'-> {_saved_slot_symbol(d, "current")}')
    check('weekday restamps current PositionBias key',
          read_position_bias_slot(d, 'current') == 'current',
          f'-> {read_position_bias_slot(d, "current")}')
    check('weekday promote: friday->tomorrow', _saved_slot_symbol(d, 'tomorrow') == 'OG2M6',
          f'-> {_saved_slot_symbol(d, "tomorrow")}')
    check('weekday restamps tomorrow PositionBias key',
          read_position_bias_slot(d, 'tomorrow') == 'tomorrow',
          f'-> {read_position_bias_slot(d, "tomorrow")}')

print()
if failures:
    print(f'{len(failures)} FAILURE(S): {failures}')
    sys.exit(1)
print('ALL CHECKS PASSED')
