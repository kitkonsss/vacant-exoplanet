#!/usr/bin/env python3
"""Signal self-eval (Phase 4): score fired entry signals against what price
actually did next.

Reads data/signal_log.json (written by price_watcher.py when an alert is sent)
and, for every signal still 'open', walks the subsequent GC=F 15-minute candles:

  - win     : price reached `target` before `invalidation`
  - loss    : price reached `invalidation` first (or both in one candle —
              counted as loss, conservative)
  - expired : neither hit within EVAL_HORIZON_H market hours -> records the
              max favorable excursion (mfe_points) so near-misses are visible

Aggregates per signal kind into data/signal_scorecard.json (win rate, average
hours to resolution). 'approach' alerts are informational and never scored.

Dependencies: stdlib + yfinance.
  python scraper/signal_eval.py
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_PATH = REPO_ROOT / 'data' / 'signal_log.json'
SCORECARD_PATH = REPO_ROOT / 'data' / 'signal_scorecard.json'

YAHOO_SYMBOL = 'GC=F'
EVAL_HORIZON_H = 48          # signal expires if unresolved after this many hours
MIN_AGE_MIN = 30             # let at least a few candles print before judging


def utcnow():
    return datetime.now(timezone.utc)


def fetch_candles(since):
    """15m GC=F candles since `since` (UTC) as [(ts, high, low)], oldest first.

    yfinance keeps ~60 days of 15m history — far beyond the 48h horizon."""
    import yfinance as yf
    span_days = max(1, min(59, (utcnow() - since).days + 2))
    hist = yf.Ticker(YAHOO_SYMBOL).history(period=f'{span_days}d', interval='15m')
    if hist is None or not len(hist):
        return []
    out = []
    for ts, row in hist.iterrows():
        ts_utc = ts.tz_convert('UTC').to_pydatetime()
        if ts_utc >= since:
            out.append((ts_utc, float(row['High']), float(row['Low'])))
    return out


def resolve(sig, candles):
    """Walk candles after the alert; return updated signal or None if untouched."""
    target, stop = sig.get('target'), sig.get('invalidation')
    direction = sig.get('direction')
    if not target or not stop or direction not in ('long', 'short'):
        sig['status'] = 'unscorable'
        return sig

    alert_ts = datetime.fromisoformat(sig['ts'])
    deadline = alert_ts + timedelta(hours=EVAL_HORIZON_H)
    entry = sig.get('price_at_alert') or sig.get('level')
    mfe = 0.0

    for ts, high, low in candles:
        if ts < alert_ts:
            continue
        if direction == 'long':
            hit_tp, hit_sl = high >= target, low <= stop
            mfe = max(mfe, high - entry)
        else:
            hit_tp, hit_sl = low <= target, high >= stop
            mfe = max(mfe, entry - low)
        if hit_tp or hit_sl:
            # both in one 15m candle -> can't know the order -> conservative loss
            sig['status'] = 'win' if (hit_tp and not hit_sl) else 'loss'
            sig['resolved_ts'] = ts.isoformat(timespec='seconds')
            sig['hours_to_resolution'] = round((ts - alert_ts).total_seconds() / 3600, 1)
            sig['mfe_points'] = round(mfe, 1)
            return sig
        if ts >= deadline:
            break

    if utcnow() >= deadline:
        sig['status'] = 'expired'
        sig['mfe_points'] = round(mfe, 1)
        return sig
    return None  # still open


def build_scorecard(log):
    scored = [s for s in log if s.get('status') in ('win', 'loss', 'expired')]
    by_kind = {}
    for s in scored:
        k = s['kind']
        b = by_kind.setdefault(k, {'n': 0, 'win': 0, 'loss': 0, 'expired': 0, 'hours': []})
        b['n'] += 1
        b[s['status']] = b.get(s['status'], 0) + 1
        if s.get('hours_to_resolution') is not None:
            b['hours'].append(s['hours_to_resolution'])
    for k, b in by_kind.items():
        decided = b['win'] + b['loss']
        b['win_rate'] = round(b['win'] / decided, 3) if decided else None
        b['avg_hours_to_resolution'] = round(sum(b['hours']) / len(b['hours']), 1) if b['hours'] else None
        del b['hours']
    open_n = sum(1 for s in log if s.get('status') == 'open')
    decided = sum(b['win'] for b in by_kind.values()), sum(b['loss'] for b in by_kind.values())
    return {
        'updated_at': utcnow().isoformat(timespec='seconds'),
        'horizon_hours': EVAL_HORIZON_H,
        'total_signals': len(log),
        'open': open_n,
        'overall_win_rate': round(decided[0] / sum(decided), 3) if sum(decided) else None,
        'by_kind': by_kind,
        'note': 'win = target before invalidation on 15m candles; both-in-one-candle counts '
                'as loss (conservative); expired = neither within horizon (see mfe_points).',
    }


def main():
    try:
        log = json.loads(LOG_PATH.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        print('[EVAL] no signal log yet — nothing to score')
        return 0

    open_sigs = [s for s in log
                 if s.get('status') == 'open'
                 and (utcnow() - datetime.fromisoformat(s['ts'])).total_seconds() / 60 >= MIN_AGE_MIN]
    if open_sigs:
        oldest = min(datetime.fromisoformat(s['ts']) for s in open_sigs)
        candles = fetch_candles(oldest)
        print(f'[EVAL] {len(open_sigs)} open signal(s), {len(candles)} candles since {oldest:%Y-%m-%d %H:%M}')
        if candles:
            resolved = 0
            for sig in open_sigs:
                if resolve(sig, candles) is not None:
                    resolved += 1
                    print(f"[EVAL] {sig['ts']} {sig['kind']} {sig.get('direction')} @{sig['level']} "
                          f"-> {sig['status']} (mfe {sig.get('mfe_points')})")
            print(f'[EVAL] resolved {resolved}/{len(open_sigs)}')
    else:
        print('[EVAL] no open signals to score')

    LOG_PATH.write_text(json.dumps(log, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    card = build_scorecard(log)
    SCORECARD_PATH.write_text(json.dumps(card, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    wr = card['overall_win_rate']
    print(f"[EVAL] scorecard: {card['total_signals']} signals | open {card['open']} | "
          f"win rate {wr if wr is not None else 'n/a'}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
