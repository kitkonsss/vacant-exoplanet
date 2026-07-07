import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from scraper import strategy_fetch


class ExpectedRangeAnchorTests(unittest.TestCase):
    def test_iv_expected_range_stays_anchored_when_price_moves(self):
        old_base = strategy_fetch.BASE_OUTPUT_DIR
        try:
            with tempfile.TemporaryDirectory() as tmp:
                strategy_fetch.BASE_OUTPUT_DIR = tmp
                Path(tmp, "expected_range.json").write_text(
                    json.dumps({
                        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "future_price": 4400,
                        "anchor_price": 4400,
                        "expected_move_1d": 50,
                        "atm_iv_pct_1d_basis": 20,
                        "basis_tenor": {"contract_key": "current", "symbol": "TEST", "dte": 1},
                        "bands_1d": {
                            "plus1": 4450,
                            "minus1": 4350,
                            "plus2": 4500,
                            "minus2": 4300,
                            "plus3": 4550,
                            "minus3": 4250,
                        },
                    }),
                    encoding="utf-8",
                )

                out = strategy_fetch.analyze_expected_range("gc", 4425, {"candles": []})

                self.assertEqual(out["anchor_price"], 4400)
                self.assertEqual(out["current_price"], 4425)
                self.assertEqual(out["expected_move"], 50)
                self.assertEqual(out["day_high_est"], 4450)
                self.assertEqual(out["day_low_est"], 4350)
                self.assertEqual(out["bands_1d"]["plus1"], 4450)
                self.assertEqual(out["price_sd_from_anchor"], 0.5)
        finally:
            strategy_fetch.BASE_OUTPUT_DIR = old_base


if __name__ == "__main__":
    unittest.main()
