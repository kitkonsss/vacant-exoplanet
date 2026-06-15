#!/usr/bin/env python3
"""Resolve the LEAD (most-active) futures contract for an asset.

Yahoo's continuous `NQ=F` / `GC=F` symbols stay pinned to the *expiring* front
month until its last trade. Near a quarterly expiry the market's liquidity (and
the price a trader actually watches) has already rolled to the next contract, so
`NQ=F` can read ~300 pts below the contract everyone is trading. This module maps
an asset to the Yahoo symbol of the contract liquidity has rolled to, on the
standard calendar.

NQ (CME equity-index futures) roll quarterly — Mar(H) Jun(M) Sep(U) Dec(Z),
expiry = 3rd Friday of the contract month, liquidity rolls ~8 days before expiry.

GC (COMEX gold) has a messier bimonthly delivery calendar AND a tiny
inter-contract spread (~0.1%), and Yahoo's `GC=F` already tracks the liquid
contract — so for GC we keep `GC=F` and rely on the per-ladder underlying fix
(underlying_yahoo_symbol) for internal consistency rather than a hand-rolled
gold calendar that could pick the wrong month.
"""

import re
from datetime import date, timedelta

# CME month codes, 1-indexed (Jan..Dec).
MONTH_CODE = {1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M',
              7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z'}
MONTH_NUM = {'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
             'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12}

# Per-asset roll config.
#   months  : active contract months for explicit calendar rolling
#             (None -> use Yahoo's front-month `=F` symbol as-is)
#   suffix  : Yahoo exchange suffix for the explicit contract symbol
ROLL = {
    'nq': {'front': 'NQ=F', 'root': 'NQ', 'suffix': '.CME',
           'months': [3, 6, 9, 12], 'roll_days_before': 8},
    'gc': {'front': 'GC=F', 'root': 'GC', 'suffix': '.CMX',
           'months': None, 'roll_days_before': 8},
}


def third_friday(year, month):
    """Third Friday of the given month (CME equity-index expiry)."""
    first = date(year, month, 1)
    # weekday(): Mon=0 .. Fri=4 .. Sun=6
    offset = (4 - first.weekday()) % 7          # days to the first Friday
    return first + timedelta(days=offset + 14)  # + two weeks -> third Friday


def lead_contract(asset_id, today=None):
    """(yahoo_symbol, month_letter, year, expiry_date) for the lead contract.

    For non-rolled assets (GC) returns the front `=F` symbol with None metadata.
    """
    cfg = ROLL.get(asset_id)
    today = today or date.today()
    if not cfg:
        return (f'{asset_id.upper()}=F', None, None, None)
    if not cfg.get('months'):
        return (cfg['front'], None, None, None)

    buffer = timedelta(days=cfg['roll_days_before'])
    # Candidate contracts in chronological order: this year's active months,
    # then next year's. Pick the first whose (expiry - roll buffer) is still
    # in the future — i.e. the one liquidity has not yet rolled out of.
    candidates = ([(today.year, m) for m in cfg['months']]
                  + [(today.year + 1, m) for m in cfg['months']])
    for cy, cm in candidates:
        exp = third_friday(cy, cm)
        if today < exp - buffer:
            return (f"{cfg['root']}{MONTH_CODE[cm]}{cy % 100:02d}{cfg['suffix']}",
                    MONTH_CODE[cm], cy, exp)
    return (cfg['front'], None, None, None)


def lead_yahoo_symbol(asset_id, today=None):
    """Yahoo symbol of the asset's lead contract (rolls off the front month)."""
    return lead_contract(asset_id, today)[0]


def underlying_yahoo_symbol(header_line, asset_id):
    """Yahoo symbol of the future an option ladder is written on, parsed from
    QuikStrike's 'Underlying Future: <Mon> <YYYY>' header. Returns None if the
    asset isn't roll-configured or the header can't be parsed.

    This is what keeps deferred-expiry ladders (e.g. an end-of-June NQ option
    series written on the September future) from being anchored to the
    front-month price.
    """
    cfg = ROLL.get(asset_id)
    if not cfg:
        return None
    m = re.search(r'Underlying Future:\s*([A-Za-z]{3,9})\s+(\d{4})', header_line or '')
    if not m:
        return None
    mon = MONTH_NUM.get(m.group(1)[:3].title())
    if not mon:
        return None
    return f"{cfg['root']}{MONTH_CODE[mon]}{int(m.group(2)) % 100:02d}{cfg['suffix']}"
