import json
import tempfile
import unittest
from pathlib import Path

from scraper import bias_snapshot


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def contract_payload(score=7, generated_at="2026-06-29T10:00:00Z", intraday_volume=25):
    call_volume = 10 if intraday_volume else 0
    put_volume = max(0, intraday_volume - call_volume)
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
            "intraday_volume": intraday_volume,
            "call_volume": call_volume,
            "put_volume": put_volume,
            "volume_put_call_ratio": round(put_volume / call_volume, 3) if call_volume else None,
            "volume_vs_oi": round(intraday_volume / 100, 3),
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


def expected_range_payload():
    return {
        "generated_at": "2026-06-29T10:15:00Z",
        "source_generated_at": "2026-06-29T10:00:00Z",
        "expected_move_1d": 25.5,
        "bands_1d": {
            "plus1": 4075.5,
            "minus1": 4024.5,
            "plus2": 4101.0,
            "minus2": 3999.0,
        },
        "tenors": [
            {
                "contract_key": "current",
                "symbol": "G5MM6",
                "dte": 0.3,
                "atm_iv_pct": 18.25,
                "expected_move_to_expiry": 14.2,
                "bands_to_expiry": {
                    "plus1": 4064.2,
                    "minus1": 4035.8,
                    "plus2": 4078.4,
                    "minus2": 4021.6,
                },
            }
        ],
    }


class BiasSnapshotTests(unittest.TestCase):
    def test_slot_for_uses_bangkok_time(self):
        dt = bias_snapshot._parse_now("2026-06-29T10:30:00Z")
        date_bkk, slot, _ = bias_snapshot.slot_for(dt)
        self.assertEqual(date_bkk, "2026-06-29")
        self.assertEqual(slot, "evening")

    def test_snapshot_keeps_each_capture_in_same_slot_history(self):
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
            self.assertEqual(len(gc_current), 2)
            self.assertEqual({r["slot"] for r in gc_current}, {"evening"})
            self.assertEqual([r["bias"]["score"] for r in gc_current], [9, 7])
            self.assertEqual(gc_current[0]["capture_id"], "2026-06-29T174500+0700")
            self.assertEqual(gc_current[1]["capture_id"], "2026-06-29T173000+0700")
            self.assertTrue((snap_dir / "2026-06-29" / "evening" / "174500" / "gc_current_PositionBias.json").exists())
            self.assertTrue((snap_dir / "2026-06-29" / "evening" / "173000" / "gc_current_PositionBias.json").exists())
            sliced = json.loads((snap_dir / "history_gc_current.json").read_text(encoding="utf-8"))
            self.assertEqual(len(sliced["records"]), 2)
            self.assertEqual(sliced["asset"], "gc")
            self.assertEqual(sliced["contract_key"], "current")

    def test_snapshot_marks_missing_intraday_volume(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            snap_dir = data_dir / "bias_snapshots"
            write_json(data_dir / "current_PositionBias.json", contract_payload(intraday_volume=0))

            bias_snapshot.run(str(data_dir), str(snap_dir), now="2026-06-29T10:30:00Z")

            history = json.loads((snap_dir / "bias_history.json").read_text(encoding="utf-8"))
            gc_current = [
                r for r in history["records"]
                if r["asset"] == "gc" and r["contract_key"] == "current"
            ][0]
            self.assertFalse(gc_current["flow_ready"])
            self.assertEqual(gc_current["flow_status"], "missing_intraday_volume")
            self.assertEqual(gc_current["totals"]["intraday_volume"], 0)
            self.assertIsNone(gc_current["totals"]["volume_put_call_ratio"])

    def test_snapshot_compacts_expected_range_for_contract_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            snap_dir = data_dir / "bias_snapshots"
            write_json(data_dir / "current_PositionBias.json", contract_payload())
            write_json(data_dir / "expected_range.json", expected_range_payload())

            bias_snapshot.run(str(data_dir), str(snap_dir), now="2026-06-29T10:30:00Z")

            history = json.loads((snap_dir / "bias_history.json").read_text(encoding="utf-8"))
            gc_current = [
                r for r in history["records"]
                if r["asset"] == "gc" and r["contract_key"] == "current"
            ][0]
            er = gc_current["expected_range"]
            self.assertEqual(er["expected_move_1d"], 25.5)
            self.assertEqual(er["bands_1d"]["plus1"], 4075.5)
            self.assertEqual(er["expected_move_to_expiry"], 14.2)
            self.assertEqual(er["bands_to_expiry"]["minus2"], 4021.6)
            self.assertEqual(er["atm_iv_pct"], 18.25)
            self.assertEqual(er["source_generated_at"], "2026-06-29T10:00:00Z")

    def test_history_retention_prunes_full_and_slice_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "data"
            snap_dir = data_dir / "bias_snapshots"
            write_json(data_dir / "current_PositionBias.json", contract_payload(score=1))

            for day, score in [
                ("2026-06-27", 1),
                ("2026-06-28", 2),
                ("2026-06-29", 3),
            ]:
                write_json(data_dir / "current_PositionBias.json", contract_payload(score=score))
                bias_snapshot.run(
                    str(data_dir),
                    str(snap_dir),
                    now=f"{day}T10:30:00Z",
                    history_keep_days=2,
                )

            history = json.loads((snap_dir / "bias_history.json").read_text(encoding="utf-8"))
            dates = {r["date_bangkok"] for r in history["records"]}
            self.assertEqual(dates, {"2026-06-28", "2026-06-29"})

            sliced = json.loads((snap_dir / "history_gc_current.json").read_text(encoding="utf-8"))
            self.assertEqual({r["date_bangkok"] for r in sliced["records"]}, dates)
            self.assertEqual([r["bias"]["score"] for r in sliced["records"]], [3, 2])


if __name__ == "__main__":
    unittest.main()
