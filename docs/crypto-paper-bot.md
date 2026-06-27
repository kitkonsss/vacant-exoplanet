# Crypto Paper Bot

Forward-test execution layer for BTC/ETH perpetual futures.

The bot reads the existing crypto snapshot payload, blends options-wall context
with an independent standard-deviation probability model, and records paper
positions under `data/paper/`. It does not send live broker orders.

## Why Paper First

The TradingView indicator shared in the thread is published as closed-source.
This bot does not copy or bypass that source. It implements an independent model
from the public description:

- standard-deviation move probabilities
- overextension/reversal confirmation
- momentum/bias alignment
- options wall confluence from the existing crypto snapshot

## Run Once

```bash
python scraper/crypto_paper_bot.py --assets btc,eth
```

Default snapshot URL, intended for local Wrangler development:

```text
http://127.0.0.1:8787/api/crypto/snapshot?asset={asset}
```

Override it for production:

```bash
set CRYPTO_SNAPSHOT_URL_TEMPLATE=https://your-worker.example/api/crypto/snapshot?asset={asset}
python scraper/crypto_paper_bot.py --assets btc,eth
```

## Run Loop

```bash
python scraper/crypto_paper_bot.py --assets btc,eth --loop --interval-sec 30
```

## Outputs

- `data/paper/crypto_bot_state.json` - open positions, realized P&L, guards
- `data/paper/crypto_bot_events.jsonl` - append-only audit log
- `data/paper/crypto_bot_summary.json` - compact dashboard-ready summary

## Risk Controls

- stale snapshot guard
- kill switch file: `data/paper/KILL_SWITCH`
- max daily loss
- max trades per day
- one open position per symbol by default
- cooldown per signal/wall
- mandatory target and stop
- fee and slippage assumptions
- notional cap

## Common Settings

```bash
python scraper/crypto_paper_bot.py ^
  --risk-usd 50 ^
  --max-daily-loss-usd 150 ^
  --max-trades-per-day 6 ^
  --max-notional-usd 5000 ^
  --min-score 72
```

## Live Trading

`--live` intentionally refuses execution in this file. The next stage should add
a separate broker adapter after the paper log proves that the model survives
fees, slippage, funding, and live data outages.
