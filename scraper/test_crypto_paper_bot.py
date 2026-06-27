import json
import tempfile
import unittest
from pathlib import Path

from scraper import crypto_paper_bot as bot


def snapshot(price=60000.0, wall=59950.0, generated_at=None):
    generated_at = generated_at or bot.utcnow().isoformat(timespec="seconds")
    return {
        "asset": "btc",
        "generated_at": generated_at,
        "live_price": {"price": price},
        "future_price": price,
        "strategy": {
            "generated_at": generated_at,
            "asset": "BTC",
            "future_price": price,
            "source": "test",
            "directional_bias": {"label": "neutral", "score": 0, "confidence": "medium"},
            "regime": {"regime": "range"},
            "expected_range": {
                "expected_move": 1000.0,
                "expected_move_1d": 1000.0,
                "atm_iv_pct": 55,
            },
            "confluence_levels": [
                {"level": wall, "confluence": 4, "sources": ["crypto_options_oi", "gamma_proxy"]},
                {"level": price + 900, "confluence": 3, "sources": ["crypto_options_oi"]},
            ],
            "gamma_1pct": {
                "nearest_downside_wall": {"strike": wall, "gamma_1pct": 1000, "contract_key": "current"},
                "nearest_upside_wall": {"strike": price + 900, "gamma_1pct": 800, "contract_key": "current"},
            },
        },
    }


class CryptoPaperBotTests(unittest.TestCase):
    def test_touch_probability_decreases_with_distance(self):
        self.assertGreater(bot.touch_prob(0.5), bot.touch_prob(1.0))
        self.assertGreater(bot.touch_prob(1.0), bot.touch_prob(2.0))

    def test_wall_fade_signal_builds_long_near_support_wall(self):
        cfg = bot.BotConfig(enforce_staleness=False, min_score=60)
        signals = bot.build_signals(snapshot(), cfg)
        self.assertTrue(signals)
        sig = signals[0]
        self.assertEqual(sig["side"], "long")
        self.assertEqual(sig["mode"], "wall_fade")
        self.assertGreater(sig["target"], sig["entry"])
        self.assertLess(sig["stop"], sig["entry"])
        self.assertGreaterEqual(sig["rr"], cfg.min_rr)

    def test_open_and_close_paper_position(self):
        cfg = bot.BotConfig(enforce_staleness=False, min_score=60, risk_usd=50)
        signals = bot.build_signals(snapshot(), cfg)
        with tempfile.TemporaryDirectory() as tmp:
            events_path = Path(tmp) / "events.jsonl"
            state = bot.default_state()
            pos = bot.open_position(state, signals[0], cfg, events_path)
            self.assertIsNotNone(pos)
            self.assertEqual(len(state["open_positions"]), 1)

            # Price reaches target.
            target_hit = snapshot(price=float(pos["target"]) + 1, wall=59950.0)
            closed = bot.update_open_positions(state, {"btc": target_hit}, cfg, events_path)
            self.assertEqual(len(closed), 1)
            self.assertEqual(len(state["open_positions"]), 0)
            self.assertGreater(state["realized_pnl_usd"], 0)

            events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(events[0]["type"], "paper_open")
            self.assertEqual(events[-1]["type"], "paper_close")

    def test_live_flag_refuses_execution(self):
        self.assertEqual(bot.main(["--live"]), 2)


if __name__ == "__main__":
    unittest.main()
