import json
import tempfile
import unittest
from pathlib import Path

from scraper import bias_snapshot


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def contract_payload(score=7, generated_at="2026-06-29T10:00:00Z"):
    return {
        "asset": "GC",
        "contract_key": "current",
        "contract": "G5MM6",
        "dte": 0.3,
        "generated_at": generated_at,
        "future_price": 4050.0,
        "position_bias": {
            "score": score,
            "label": "neutral",
            "drivers": [{"name": "oi_put_call_ratio", "score": -8, "detail": "OI P/C 1.40"}],
        },
        "totals": {
            "open_interest": 100,
            "call_oi": 40,
            "put_oi": 60,
            "oi_put_call_ratio": 1.5,
            "intraday_volume": 25,
            "call_volume": 10,
            "put_volume": 15,
            "volume_put_call_ratio": 1.5,
            "volume_vs_oi": 0.25,
        },
        "structure": {"support_oi_below_price": 30, "resistance_oi_above_price": 20},
        "walls": {
            "dominant_put": {
                "strike": 4000,
                "side": "put_wall",
                "total_oi": 60,
                "call_oi": 5,
                "put_oi": 55,
                "distance": {"points": -50, "side": "below"},
            }
        },
    }


class BiasSnapshotTests(unittest.TestCase):
    def test_slot_for_uses_bangkok_time(self):
        dt = bias_snapshot._parse_now("2026-06-29T10:30:00Z")
        date_bkk, slot, _ = bias_snapshot.slot_for(dt)
        self.assertEqual(date_bkk, "2026-06-29")
        self.assertEqual(slot, "evening")

    def test_snapshot_replaces_same_slot_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            snap_dir = data_dir / "bias_snapshots"
            write_json(data_dir / "position_bias_summary.json", {
                "asset": "GC",
                "generated_at": "2026-06-29T10:00:00Z",
                "position_bias": {"score": 1, "label": "neutral", "method": "test"},
                "contracts": [],
            })
            write_json(data_dir / "current_PositionBias.json", contract_payload(score=7))

            bias_snapshot.run(str(data_dir), str(snap_dir), now="2026-06-29T10:30:00Z")
            write_json(data_dir / "current_PositionBias.json", contract_payload(score=9))
            bias_snapshot.run(str(data_dir), str(snap_dir), now="2026-06-29T10:45:00Z")

            history = json.loads((snap_dir / "bias_history.json").read_text(encoding="utf-8"))
            gc_current = [
                r for r in history["records"]
                if r["asset"] == "gc" and r["contract_key"] == "current"
            ]
            self.assertEqual(len(gc_current), 1)
            self.assertEqual(gc_current[0]["slot"], "evening")
            self.assertEqual(gc_current[0]["bias"]["score"], 9)
            self.assertTrue((snap_dir / "2026-06-29" / "evening" / "gc_current_PositionBias.json").exists())


if __name__ == "__main__":
    unittest.main()
