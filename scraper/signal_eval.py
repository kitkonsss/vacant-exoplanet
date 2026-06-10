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
import math
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
COST_POINTS = 0.5            # round-trip spread + slippage estimate, GC points
MIN_N_DECIDED = 30           # below this the verdict is always insufficient_n


def wilson_ci(wins, n, z=1.96):
    """95% Wilson score interval for a win rate — honest about small n."""
    if n <= 0:
        return None
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3)]


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
            won = hit_tp and not hit_sl
            risk = abs(entry - stop)
            reward = abs(target - entry)
            sig['status'] = 'win' if won else 'loss'
            sig['resolved_ts'] = ts.isoformat(timespec='seconds')
            sig['hours_to_resolution'] = round((ts - alert_ts).total_seconds() / 3600, 1)
            sig['mfe_points'] = round(mfe, 1)
            sig['risk_points'] = round(risk, 1)
            sig['reward_points'] = round(reward, 1)
            # net P&L in points after round-trip cost — what a fill would have paid
            sig['net_points'] = round((reward if won else -risk) - COST_POINTS, 1)
            return sig
        if ts >= deadline:
            break

    if utcnow() >= deadline:
        sig['status'] = 'expired'
        sig['mfe_points'] = round(mfe, 1)
        return sig
    return None  # still open


def _verdict(decided_n, ci, breakeven):
    """Institutional honesty: only claim edge when the WHOLE confidence
    interval clears the cost-adjusted breakeven."""
    if decided_n < MIN_N_DECIDED:
        return 'insufficient_n'
    if ci and breakeven is not None:
        if ci[0] > breakeven:
            return 'edge_confirmed'
        if ci[1] < breakeven:
            return 'no_edge'
    return 'inconclusive'


def build_scorecard(log):
    scored = [s for s in log if s.get('status') in ('win', 'loss', 'expired')]
    by_kind = {}
    for s in scored:
        k = s['kind']
        b = by_kind.setdefault(k, {'n': 0, 'win': 0, 'loss': 0, 'expired': 0,
                                   'hours': [], 'risks': [], 'rewards': [], 'nets': []})
        b['n'] += 1
        b[s['status']] = b.get(s['status'], 0) + 1
        if s.get('hours_to_resolution') is not None:
            b['hours'].append(s['hours_to_resolution'])
        if s['status'] in ('win', 'loss'):
            if s.get('risk_points'):
                b['risks'].append(s['risk_points'])
            if s.get('reward_points'):
                b['rewards'].append(s['reward_points'])
            if s.get('net_points') is not None:
                b['nets'].append(s['net_points'])

    for k, b in by_kind.items():
        decided = b['win'] + b['loss']
        wr = b['win'] / decided if decided else None
        b['win_rate'] = round(wr, 3) if wr is not None else None
        b['win_rate_ci95'] = wilson_ci(b['win'], decided)
        b['avg_hours_to_resolution'] = round(sum(b['hours']) / len(b['hours']), 1) if b['hours'] else None
        avg_risk = sum(b['risks']) / len(b['risks']) if b['risks'] else None
        avg_reward = sum(b['rewards']) / len(b['rewards']) if b['rewards'] else None
        if avg_risk and avg_reward and (avg_risk + avg_reward) > 0:
            b['avg_risk_points'] = round(avg_risk, 1)
            b['avg_reward_points'] = round(avg_reward, 1)
            # p* such that p*reward - (1-p)*risk - cost = 0
            b['breakeven_win_rate'] = round((avg_risk + COST_POINTS) / (avg_risk + avg_reward), 3)
            if wr is not None:
                b['expectancy_points'] = round(wr * avg_reward - (1 - wr) * avg_risk - COST_POINTS, 1)
        else:
            b['breakeven_win_rate'] = None
        b['total_net_points'] = round(sum(b['nets']), 1) if b['nets'] else 0
        b['verdict'] = _verdict(decided, b['win_rate_ci95'], b.get('breakeven_win_rate'))
        for tmp in ('hours', 'risks', 'rewards', 'nets'):
            del b[tmp]

    open_n = sum(1 for s in log if s.get('status') == 'open')
    wins = sum(b['win'] for b in by_kind.values())
    losses = sum(b['loss'] for b in by_kind.values())
    total_net = round(sum(b['total_net_points'] for b in by_kind.values()), 1)
    return {
        'updated_at': utcnow().isoformat(timespec='seconds'),
        'horizon_hours': EVAL_HORIZON_H,
        'cost_points_per_trade': COST_POINTS,
        'min_n_for_verdict': MIN_N_DECIDED,
        'total_signals': len(log),
        'open': open_n,
        'overall_win_rate': round(wins / (wins + losses), 3) if (wins + losses) else None,
        'overall_win_rate_ci95': wilson_ci(wins, wins + losses),
        'total_net_points': total_net,
        'total_net_usd_mgc': round(total_net * 10, 0),
        'by_kind': by_kind,
        'note': 'win = target before invalidation on 15m candles; both-in-one-candle counts '
                'as loss (conservative); expired = neither within horizon (see mfe_points). '
                f'All P&L net of {COST_POINTS} pt round-trip cost. Verdicts require the full '
                'Wilson 95% CI to clear the cost-adjusted breakeven win rate — '
                f'and at least {MIN_N_DECIDED} decided signals.',
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
