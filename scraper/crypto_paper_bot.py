#!/usr/bin/env python3
"""Crypto paper execution bot.

This is the forward-test layer before any live broker adapter is enabled. It
reads the existing crypto snapshot/strategy payload, blends options-wall context
with an independent standard-deviation probability model, and records paper
orders with realistic fee/slippage assumptions.

No live order is sent from this file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
PAPER_DIR = REPO_ROOT / "data" / "paper"
DEFAULT_STATE_PATH = PAPER_DIR / "crypto_bot_state.json"
DEFAULT_EVENTS_PATH = PAPER_DIR / "crypto_bot_events.jsonl"
DEFAULT_SUMMARY_PATH = PAPER_DIR / "crypto_bot_summary.json"
DEFAULT_KILL_SWITCH_PATH = PAPER_DIR / "KILL_SWITCH"
DEFAULT_URL_TEMPLATE = os.environ.get(
    "CRYPTO_SNAPSHOT_URL_TEMPLATE",
    "http://127.0.0.1:8787/api/crypto/snapshot?asset={asset}",
)


ASSETS = {
    "btc": {
        "symbol": "BTCUSDT",
        "qty_step": 0.001,
        "min_qty": 0.001,
        "min_notional_usd": 5.0,
    },
    "eth": {
        "symbol": "ETHUSDT",
        "qty_step": 0.01,
        "min_qty": 0.01,
        "min_notional_usd": 5.0,
    },
}


@dataclass(frozen=True)
class BotConfig:
    assets: tuple[str, ...] = ("btc", "eth")
    modes: tuple[str, ...] = ("wall_fade", "bias_follow")
    risk_usd: float = 50.0
    max_daily_loss_usd: float = 150.0
    max_trades_per_day: int = 6
    max_open_positions_per_symbol: int = 1
    max_notional_usd: float = 5000.0
    leverage: float = 2.0
    min_score: float = 72.0
    min_rr: float = 1.15
    min_target_touch_prob: float = 0.25
    wall_entry_sigma: float = 0.22
    wall_stop_sigma: float = 0.35
    wall_target_sigma: float = 0.65
    trend_target_sigma: float = 0.95
    trend_stop_sigma: float = 0.45
    trend_min_abs_bias_score: float = 18.0
    stale_seconds: int = 45
    cooldown_minutes: int = 60
    fee_bps: float = 5.0
    slippage_bps: float = 1.0
    enforce_staleness: bool = True


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def normal_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def touch_prob(k_sigma: float) -> float:
    """Probability a driftless path touches a level k sigma away in horizon."""
    if not math.isfinite(k_sigma):
        return 0.0
    p = 2 * (1 - normal_cdf(abs(k_sigma)))
    return max(0.0, min(1.0, p))


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def round_down_step(value: float, step: float) -> float:
    if step <= 0:
        return value
    return math.floor(value / step) * step


def side_sign(side: str) -> int:
    return 1 if side == "long" else -1


def dir_from_bias(label: str | None) -> str:
    text = (label or "").lower()
    if "bull" in text:
        return "long"
    if "bear" in text:
        return "short"
    return "neutral"


def live_price(snapshot: dict[str, Any]) -> float | None:
    price = snapshot.get("live_price", {}).get("price")
    if isinstance(price, (int, float)) and math.isfinite(price) and price > 0:
        return float(price)
    price = snapshot.get("future_price")
    if isinstance(price, (int, float)) and math.isfinite(price) and price > 0:
        return float(price)
    return None


def expected_move(strategy: dict[str, Any]) -> float | None:
    er = strategy.get("expected_range") or {}
    em = er.get("expected_move_1d") or er.get("expected_move")
    if isinstance(em, (int, float)) and math.isfinite(em) and em > 0:
        return float(em)
    return None


def stale_reason(snapshot: dict[str, Any], cfg: BotConfig) -> str | None:
    if not cfg.enforce_staleness:
        return None
    ts = parse_ts(snapshot.get("generated_at") or snapshot.get("strategy", {}).get("generated_at"))
    if not ts:
        return "snapshot has no generated_at"
    age = (utcnow() - ts).total_seconds()
    if age > cfg.stale_seconds:
        return f"snapshot stale: {age:.0f}s > {cfg.stale_seconds}s"
    return None


def wall_key(price: float) -> str:
    return f"{price:.2f}"


def collect_walls(strategy: dict[str, Any], price: float) -> list[dict[str, Any]]:
    """Collect de-duplicated wall levels from confluence and gamma summaries."""
    by_key: dict[str, dict[str, Any]] = {}

    def add(level: Any, strength: float, source: str, meta: dict[str, Any] | None = None) -> None:
        if not isinstance(level, (int, float)) or not math.isfinite(level) or level <= 0:
            return
        key = wall_key(float(level))
        row = by_key.setdefault(
            key,
            {
                "price": float(level),
                "strength": 0.0,
                "sources": [],
                "side": "above" if float(level) > price else "below",
            },
        )
        row["strength"] = max(float(strength), row["strength"])
        if source not in row["sources"]:
            row["sources"].append(source)
        if meta:
            row.update(meta)

    for c in strategy.get("confluence_levels") or []:
        add(
            c.get("level"),
            float(c.get("confluence") or 1),
            "confluence",
            {"distance_points": c.get("distance_points")},
        )

    gamma = strategy.get("gamma_1pct") or {}
    for name in (
        "nearest_upside_wall",
        "major_upside_wall",
        "nearest_downside_wall",
        "major_downside_wall",
    ):
        w = gamma.get(name) or {}
        gamma_strength = 2.0
        if isinstance(w.get("gamma_1pct"), (int, float)) and w["gamma_1pct"] > 0:
            gamma_strength = min(4.0, 2.0 + math.log10(w["gamma_1pct"] + 1) / 3)
        add(
            w.get("strike"),
            gamma_strength,
            name,
            {"gamma_1pct": w.get("gamma_1pct"), "contract_key": w.get("contract_key")},
        )

    return sorted(by_key.values(), key=lambda x: abs(x["price"] - price))


def nearest_wall(walls: list[dict[str, Any]], price: float, side: str, min_dist: float = 0.0) -> dict[str, Any] | None:
    candidates = [
        w
        for w in walls
        if (w["price"] - price >= min_dist if side == "above" else price - w["price"] >= min_dist)
    ]
    return sorted(candidates, key=lambda w: abs(w["price"] - price))[0] if candidates else None


def target_for_side(price: float, side: str, em: float, walls: list[dict[str, Any]], sigma: float) -> tuple[float, dict[str, Any] | None]:
    dist = sigma * em
    wall = nearest_wall(walls, price, "above" if side == "long" else "below", min_dist=0.25 * em)
    capped_by = None
    if wall:
        wall_dist = abs(wall["price"] - price)
        if 0 < wall_dist < dist:
            dist = wall_dist
            capped_by = wall
    target = price + dist if side == "long" else price - dist
    return target, capped_by


def build_wall_fade_signals(snapshot: dict[str, Any], cfg: BotConfig) -> list[dict[str, Any]]:
    strategy = snapshot.get("strategy") or {}
    price = live_price(snapshot)
    em = expected_move(strategy)
    asset = str(snapshot.get("asset") or strategy.get("asset") or "").lower()
    if not price or not em or asset not in ASSETS:
        return []

    walls = collect_walls(strategy, price)
    bias = strategy.get("directional_bias") or {}
    bias_dir = dir_from_bias(bias.get("label"))
    regime = (strategy.get("regime") or {}).get("regime") or "neutral"
    signals = []
    entry_dist = cfg.wall_entry_sigma * em

    for wall in walls:
        dist = abs(price - wall["price"])
        if dist > entry_dist:
            continue
        side = "long" if wall["price"] <= price else "short"
        target, capped_by = target_for_side(price, side, em, walls, cfg.wall_target_sigma)
        stop = wall["price"] - cfg.wall_stop_sigma * em if side == "long" else wall["price"] + cfg.wall_stop_sigma * em
        risk = abs(price - stop)
        reward = abs(target - price)
        if risk <= 0 or reward <= 0:
            continue
        rr = reward / risk
        p_target = touch_prob(reward / em)
        p_stop = touch_prob(risk / em)

        wall_power = clamp(float(wall.get("strength") or 1) / 4)
        touch_score = clamp(1 - dist / max(entry_dist, 1e-9))
        if bias_dir == side:
            alignment = 1.0
        elif bias_dir == "neutral":
            alignment = 0.68
        else:
            alignment = 0.32
        regime_score = 1.0 if regime in ("range", "ranging", "neutral") else 0.58
        rr_score = clamp(rr / 1.8)
        probability_score = clamp((p_target / max(p_target + p_stop, 1e-9)) / 0.65)
        score = 100 * (
            0.24 * wall_power
            + 0.18 * touch_score
            + 0.20 * probability_score
            + 0.18 * alignment
            + 0.10 * regime_score
            + 0.10 * rr_score
        )

        signals.append(
            {
                "mode": "wall_fade",
                "asset": asset,
                "symbol": ASSETS[asset]["symbol"],
                "side": side,
                "entry": round(price, 2),
                "target": round(target, 2),
                "stop": round(stop, 2),
                "score": round(score, 1),
                "rr": round(rr, 2),
                "target_touch_prob": round(p_target, 3),
                "stop_touch_prob": round(p_stop, 3),
                "wall": wall,
                "capped_by": capped_by,
                "reason": (
                    f"near {wall['side']} options wall {wall['price']:.2f}; "
                    f"sigma_dist={dist / em:.2f}; bias={bias.get('label', 'neutral')}; regime={regime}"
                ),
            }
        )
    return signals


def build_bias_follow_signals(snapshot: dict[str, Any], cfg: BotConfig) -> list[dict[str, Any]]:
    strategy = snapshot.get("strategy") or {}
    price = live_price(snapshot)
    em = expected_move(strategy)
    asset = str(snapshot.get("asset") or strategy.get("asset") or "").lower()
    if not price or not em or asset not in ASSETS:
        return []

    bias = strategy.get("directional_bias") or {}
    bias_score = float(bias.get("score") or 0)
    side = dir_from_bias(bias.get("label"))
    if side == "neutral" or abs(bias_score) < cfg.trend_min_abs_bias_score:
        return []

    regime = (strategy.get("regime") or {}).get("regime") or "neutral"
    if regime not in ("trending", "trend"):
        return []

    walls = collect_walls(strategy, price)
    target, capped_by = target_for_side(price, side, em, walls, cfg.trend_target_sigma)
    stop = price - cfg.trend_stop_sigma * em if side == "long" else price + cfg.trend_stop_sigma * em
    risk = abs(price - stop)
    reward = abs(target - price)
    if risk <= 0 or reward <= 0:
        return []

    rr = reward / risk
    p_target = touch_prob(reward / em)
    p_stop = touch_prob(risk / em)
    bias_component = clamp(abs(bias_score) / 50)
    probability_score = clamp((p_target / max(p_target + p_stop, 1e-9)) / 0.65)
    rr_score = clamp(rr / 2.0)
    wall_score = 0.8 if capped_by else 0.55
    score = 100 * (0.38 * bias_component + 0.22 * probability_score + 0.20 * rr_score + 0.20 * wall_score)

    return [
        {
            "mode": "bias_follow",
            "asset": asset,
            "symbol": ASSETS[asset]["symbol"],
            "side": side,
            "entry": round(price, 2),
            "target": round(target, 2),
            "stop": round(stop, 2),
            "score": round(score, 1),
            "rr": round(rr, 2),
            "target_touch_prob": round(p_target, 3),
            "stop_touch_prob": round(p_stop, 3),
            "wall": capped_by,
            "capped_by": capped_by,
            "reason": f"trend bias {bias.get('label')} score={bias_score:.1f}; regime={regime}",
        }
    ]


def build_signals(snapshot: dict[str, Any], cfg: BotConfig) -> list[dict[str, Any]]:
    if stale_reason(snapshot, cfg):
        return []
    signals: list[dict[str, Any]] = []
    if "wall_fade" in cfg.modes:
        signals.extend(build_wall_fade_signals(snapshot, cfg))
    if "bias_follow" in cfg.modes:
        signals.extend(build_bias_follow_signals(snapshot, cfg))
    return sorted(
        [
            s
            for s in signals
            if s["score"] >= cfg.min_score
            and s["rr"] >= cfg.min_rr
            and s["target_touch_prob"] >= cfg.min_target_touch_prob
        ],
        key=lambda s: s["score"],
        reverse=True,
    )


def default_state() -> dict[str, Any]:
    return {
        "version": 1,
        "created_at": utcnow().isoformat(timespec="seconds"),
        "updated_at": None,
        "realized_pnl_usd": 0.0,
        "open_positions": {},
        "daily": {},
        "recent_signals": {},
    }


def load_state(path: Path) -> dict[str, Any]:
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        state = default_state()
    state.setdefault("open_positions", {})
    state.setdefault("daily", {})
    state.setdefault("recent_signals", {})
    return state


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = utcnow().isoformat(timespec="seconds")
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append_event(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {"ts": utcnow().isoformat(timespec="seconds"), **event}
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def today_bucket(state: dict[str, Any]) -> dict[str, Any]:
    key = utcnow().strftime("%Y-%m-%d")
    return state.setdefault("daily", {}).setdefault(key, {"trades": 0, "realized_pnl_usd": 0.0})


def signal_key(signal: dict[str, Any]) -> str:
    wall = signal.get("wall") or {}
    raw = "|".join(
        [
            signal["asset"],
            signal["symbol"],
            signal["side"],
            signal["mode"],
            wall_key(float(wall.get("price") or signal["entry"])),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def is_on_cooldown(state: dict[str, Any], signal: dict[str, Any], cfg: BotConfig) -> bool:
    item = state.get("recent_signals", {}).get(signal_key(signal))
    ts = parse_ts(item) if item else None
    if not ts:
        return False
    return (utcnow() - ts).total_seconds() < cfg.cooldown_minutes * 60


def mark_signal(state: dict[str, Any], signal: dict[str, Any]) -> None:
    state.setdefault("recent_signals", {})[signal_key(signal)] = utcnow().isoformat(timespec="seconds")


def daily_guards(state: dict[str, Any], cfg: BotConfig) -> str | None:
    day = today_bucket(state)
    if day.get("realized_pnl_usd", 0.0) <= -abs(cfg.max_daily_loss_usd):
        return "daily loss limit reached"
    if day.get("trades", 0) >= cfg.max_trades_per_day:
        return "max trades per day reached"
    return None


def position_id(signal: dict[str, Any]) -> str:
    return f"{signal['symbol']}:{signal['side']}"


def has_open_position(state: dict[str, Any], signal: dict[str, Any], cfg: BotConfig) -> bool:
    symbol = signal["symbol"]
    count = sum(1 for p in state.get("open_positions", {}).values() if p.get("symbol") == symbol)
    return count >= cfg.max_open_positions_per_symbol


def fee_usd(notional: float, cfg: BotConfig) -> float:
    return abs(notional) * cfg.fee_bps / 10000


def fill_price(price: float, side: str, action: str, cfg: BotConfig) -> float:
    slip = cfg.slippage_bps / 10000
    if action == "entry":
        return price * (1 + slip) if side == "long" else price * (1 - slip)
    return price * (1 - slip) if side == "long" else price * (1 + slip)


def size_for_signal(signal: dict[str, Any], cfg: BotConfig) -> tuple[float, str | None]:
    asset_cfg = ASSETS[signal["asset"]]
    entry = float(signal["entry"])
    stop = float(signal["stop"])
    risk_dist = abs(entry - stop)
    if risk_dist <= 0:
        return 0.0, "invalid risk distance"
    qty = cfg.risk_usd / risk_dist
    qty = round_down_step(qty, asset_cfg["qty_step"])
    notional = qty * entry
    if qty < asset_cfg["min_qty"]:
        return 0.0, "quantity below exchange-style minimum"
    if notional < asset_cfg["min_notional_usd"]:
        return 0.0, "notional below minimum"
    if notional > cfg.max_notional_usd:
        qty = round_down_step(cfg.max_notional_usd / entry, asset_cfg["qty_step"])
        notional = qty * entry
    if qty < asset_cfg["min_qty"] or notional < asset_cfg["min_notional_usd"]:
        return 0.0, "quantity below minimum after notional cap"
    return qty, None


def open_position(state: dict[str, Any], signal: dict[str, Any], cfg: BotConfig, events_path: Path) -> dict[str, Any] | None:
    guard = daily_guards(state, cfg)
    if guard:
        append_event(events_path, {"type": "guard_block", "reason": guard, "signal": signal})
        return None
    if has_open_position(state, signal, cfg):
        append_event(events_path, {"type": "guard_block", "reason": "open position exists", "signal": signal})
        return None
    if is_on_cooldown(state, signal, cfg):
        append_event(events_path, {"type": "guard_block", "reason": "signal cooldown", "signal": signal})
        return None

    qty, err = size_for_signal(signal, cfg)
    if err:
        append_event(events_path, {"type": "guard_block", "reason": err, "signal": signal})
        return None

    entry_fill = fill_price(float(signal["entry"]), signal["side"], "entry", cfg)
    notional = qty * entry_fill
    entry_fee = fee_usd(notional, cfg)
    pos = {
        "id": position_id(signal),
        "asset": signal["asset"],
        "symbol": signal["symbol"],
        "side": signal["side"],
        "mode": signal["mode"],
        "qty": qty,
        "entry": round(entry_fill, 6),
        "target": signal["target"],
        "stop": signal["stop"],
        "score": signal["score"],
        "rr": signal["rr"],
        "target_touch_prob": signal["target_touch_prob"],
        "entry_fee_usd": round(entry_fee, 6),
        "notional_usd": round(notional, 2),
        "margin_estimate_usd": round(notional / max(cfg.leverage, 1e-9), 2),
        "opened_at": utcnow().isoformat(timespec="seconds"),
        "reason": signal["reason"],
    }
    state.setdefault("open_positions", {})[pos["id"]] = pos
    today_bucket(state)["trades"] += 1
    mark_signal(state, signal)
    append_event(events_path, {"type": "paper_open", "position": pos, "signal": signal})
    return pos


def close_position(
    state: dict[str, Any],
    pos_id: str,
    pos: dict[str, Any],
    exit_price: float,
    reason: str,
    cfg: BotConfig,
    events_path: Path,
) -> dict[str, Any]:
    side = pos["side"]
    exit_fill = fill_price(exit_price, side, "exit", cfg)
    qty = float(pos["qty"])
    gross = side_sign(side) * (exit_fill - float(pos["entry"])) * qty
    exit_fee = fee_usd(qty * exit_fill, cfg)
    net = gross - float(pos.get("entry_fee_usd") or 0) - exit_fee
    event = {
        "type": "paper_close",
        "reason": reason,
        "position": pos,
        "exit": round(exit_fill, 6),
        "gross_pnl_usd": round(gross, 6),
        "exit_fee_usd": round(exit_fee, 6),
        "net_pnl_usd": round(net, 6),
    }
    state["realized_pnl_usd"] = round(float(state.get("realized_pnl_usd") or 0) + net, 6)
    day = today_bucket(state)
    day["realized_pnl_usd"] = round(float(day.get("realized_pnl_usd") or 0) + net, 6)
    del state["open_positions"][pos_id]
    append_event(events_path, event)
    return event


def update_open_positions(
    state: dict[str, Any],
    snapshots: dict[str, dict[str, Any]],
    cfg: BotConfig,
    events_path: Path,
) -> list[dict[str, Any]]:
    events = []
    for pos_id, pos in list(state.get("open_positions", {}).items()):
        snap = snapshots.get(pos["asset"])
        price = live_price(snap or {})
        if not price:
            continue
        side = pos["side"]
        target = float(pos["target"])
        stop = float(pos["stop"])
        if side == "long" and price <= stop:
            events.append(close_position(state, pos_id, pos, stop, "stop", cfg, events_path))
        elif side == "long" and price >= target:
            events.append(close_position(state, pos_id, pos, target, "target", cfg, events_path))
        elif side == "short" and price >= stop:
            events.append(close_position(state, pos_id, pos, stop, "stop", cfg, events_path))
        elif side == "short" and price <= target:
            events.append(close_position(state, pos_id, pos, target, "target", cfg, events_path))
        else:
            unrealized = side_sign(side) * (price - float(pos["entry"])) * float(pos["qty"])
            pos["last_price"] = price
            pos["unrealized_pnl_usd"] = round(unrealized, 6)
            pos["updated_at"] = utcnow().isoformat(timespec="seconds")
    return events


def fetch_snapshot(asset: str, url_template: str, timeout: int = 20) -> dict[str, Any]:
    url = url_template.format(asset=asset)
    req = urllib.request.Request(url, headers={"User-Agent": "vacant-crypto-paper-bot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"{url} returned HTTP {resp.status}")
        return json.loads(resp.read().decode("utf-8"))


def load_snapshot_file(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and data.get("asset"):
        return {str(data["asset"]).lower(): data}
    if isinstance(data, dict):
        out = {}
        for key, value in data.items():
            if isinstance(value, dict):
                out[str(key).lower()] = value
        return out
    raise ValueError("snapshot file must contain one snapshot or an object keyed by asset")


def load_snapshots(args: argparse.Namespace, cfg: BotConfig) -> dict[str, dict[str, Any]]:
    if args.snapshot_file:
        loaded = load_snapshot_file(Path(args.snapshot_file))
        return {asset: loaded[asset] for asset in cfg.assets if asset in loaded}
    snapshots = {}
    for asset in cfg.assets:
        snapshots[asset] = fetch_snapshot(asset, args.url_template)
    return snapshots


def write_summary(path: Path, state: dict[str, Any], snapshots: dict[str, dict[str, Any]], signals: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    summary = {
        "updated_at": utcnow().isoformat(timespec="seconds"),
        "assets": list(snapshots),
        "realized_pnl_usd": state.get("realized_pnl_usd", 0.0),
        "open_positions": list(state.get("open_positions", {}).values()),
        "candidate_signals": signals[:10],
        "daily": state.get("daily", {}),
        "note": "Paper forward test only. No live broker order is sent.",
    }
    path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run_cycle(args: argparse.Namespace, cfg: BotConfig) -> int:
    state_path = Path(args.state_path)
    events_path = Path(args.events_path)
    summary_path = Path(args.summary_path)
    state = load_state(state_path)
    snapshots = load_snapshots(args, cfg)

    closed = update_open_positions(state, snapshots, cfg, events_path)
    all_signals: list[dict[str, Any]] = []
    kill_switch = Path(args.kill_switch_path)
    paused = kill_switch.exists() or os.environ.get("CRYPTO_BOT_KILL_SWITCH") == "1"

    for asset, snapshot in snapshots.items():
        reason = stale_reason(snapshot, cfg)
        if reason:
            append_event(events_path, {"type": "guard_block", "asset": asset, "reason": reason})
            continue
        signals = build_signals(snapshot, cfg)
        all_signals.extend(signals)
        if paused:
            continue
        if signals:
            open_position(state, signals[0], cfg, events_path)

    save_state(state_path, state)
    write_summary(summary_path, state, snapshots, sorted(all_signals, key=lambda s: s["score"], reverse=True))

    print(
        f"[PAPER] assets={','.join(snapshots)} candidates={len(all_signals)} "
        f"closed={len(closed)} open={len(state.get('open_positions', {}))} "
        f"realized={state.get('realized_pnl_usd', 0):.2f}"
        + (" paused=kill_switch" if paused else "")
    )
    return 0


def parse_config(args: argparse.Namespace) -> BotConfig:
    assets = tuple(a.strip().lower() for a in args.assets.split(",") if a.strip())
    bad = [a for a in assets if a not in ASSETS]
    if bad:
        raise SystemExit(f"Unsupported asset(s): {', '.join(bad)}")
    modes = tuple(m.strip() for m in args.modes.split(",") if m.strip())
    return BotConfig(
        assets=assets or ("btc", "eth"),
        modes=modes or ("wall_fade", "bias_follow"),
        risk_usd=args.risk_usd,
        max_daily_loss_usd=args.max_daily_loss_usd,
        max_trades_per_day=args.max_trades_per_day,
        max_notional_usd=args.max_notional_usd,
        leverage=args.leverage,
        min_score=args.min_score,
        enforce_staleness=not args.allow_stale,
    )


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Crypto paper execution bot")
    ap.add_argument("--assets", default="btc,eth", help="comma-separated: btc,eth")
    ap.add_argument("--modes", default="wall_fade,bias_follow", help="comma-separated modes")
    ap.add_argument("--url-template", default=DEFAULT_URL_TEMPLATE, help="snapshot URL with {asset}")
    ap.add_argument("--snapshot-file", default=None, help="load snapshot JSON instead of fetching")
    ap.add_argument("--state-path", default=str(DEFAULT_STATE_PATH))
    ap.add_argument("--events-path", default=str(DEFAULT_EVENTS_PATH))
    ap.add_argument("--summary-path", default=str(DEFAULT_SUMMARY_PATH))
    ap.add_argument("--kill-switch-path", default=str(DEFAULT_KILL_SWITCH_PATH))
    ap.add_argument("--risk-usd", type=float, default=float(os.environ.get("CRYPTO_BOT_RISK_USD", "50")))
    ap.add_argument("--max-daily-loss-usd", type=float, default=float(os.environ.get("CRYPTO_BOT_MAX_DAILY_LOSS_USD", "150")))
    ap.add_argument("--max-trades-per-day", type=int, default=int(os.environ.get("CRYPTO_BOT_MAX_TRADES_PER_DAY", "6")))
    ap.add_argument("--max-notional-usd", type=float, default=float(os.environ.get("CRYPTO_BOT_MAX_NOTIONAL_USD", "5000")))
    ap.add_argument("--leverage", type=float, default=float(os.environ.get("CRYPTO_BOT_LEVERAGE", "2")))
    ap.add_argument("--min-score", type=float, default=float(os.environ.get("CRYPTO_BOT_MIN_SCORE", "72")))
    ap.add_argument("--allow-stale", action="store_true", help="allow old snapshot files for offline tests")
    ap.add_argument("--loop", action="store_true", help="run forever")
    ap.add_argument("--interval-sec", type=int, default=30)
    ap.add_argument(
        "--live",
        action="store_true",
        help="reserved for future broker adapter; this script refuses live trading",
    )
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    if args.live:
        print("[REFUSE] live trading is not implemented in crypto_paper_bot.py", file=sys.stderr)
        return 2
    cfg = parse_config(args)
    if args.loop:
        while True:
            try:
                run_cycle(args, cfg)
            except Exception as e:
                append_event(Path(args.events_path), {"type": "bot_error", "error": str(e)})
                print(f"[PAPER] error: {e}", file=sys.stderr)
            time.sleep(max(5, args.interval_sec))
    return run_cycle(args, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
