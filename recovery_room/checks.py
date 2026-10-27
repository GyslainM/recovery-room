"""Operational checks do not use the private fixture evaluator."""

from __future__ import annotations

import json
from contextlib import closing
from pathlib import Path

from .db import readonly, snapshot
from .fixtures import evidence_index


def check_state(incident: Path, candidate: Path, before: dict, targeted_ids: set[str]) -> list[dict]:
    state = snapshot(candidate)
    orders = {row["id"]: row for row in state["orders"]}
    original = {row["id"]: row for row in before["orders"]}
    movements = state["inventory_movements"]
    opening = json.loads((incident / "evidence" / "opening_stock.json").read_text(encoding="utf-8"))
    source_ids = {
        row["event_id"]
        for row in json.loads((incident / "evidence" / "source_orders.json").read_text(encoding="utf-8"))
    }
    groups, _ = evidence_index(incident)
    with closing(readonly(candidate)) as conn:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        foreign_keys = not list(conn.execute("PRAGMA foreign_key_check"))
    checks: list[dict] = []

    def add(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    add("database_integrity", integrity and foreign_keys, "SQLite integrity and foreign-key checks.")
    unchanged = (
        set(orders) == set(original)
        and all(orders[key] == row for key, row in original.items() if key not in targeted_ids)
    )
    add("unaffected_orders_preserved", unchanged, "Every untargeted order matches its original record exactly.")
    add(
        "order_history_preserved",
        all(
            all(orders[key][field] == row[field] for field in row if field != "status")
            for key, row in original.items() if key in orders
        ),
        "Corrections retain original order identities, quantities and customer fields.",
    )
    original_movements = {row["id"]: row for row in before["inventory_movements"]}
    current_movements = {row["id"]: row for row in movements}
    add(
        "original_movements_preserved",
        all(current_movements.get(key) == row for key, row in original_movements.items()),
        "Original stock movements remain intact; corrections are compensating entries.",
    )
    balanced = all(
        product["on_hand"] == opening[product["sku"]] + sum(
            row["delta"] for row in movements if row["sku"] == product["sku"]
        )
        for product in state["products"]
    )
    add("stock_matches_movement_ledger", balanced, "Opening stock plus all recorded movements equals current stock.")
    active_balance = all(
        product["on_hand"] == opening[product["sku"]] - sum(
            row["quantity"] for row in orders.values()
            if row["sku"] == product["sku"] and row["status"] == "active"
        )
        for product in state["products"]
    )
    add("stock_matches_active_orders", active_balance, "Stock reconciles with all active purchases, including later purchases.")
    covered = source_ids.issubset(groups)
    add("source_evidence_complete", covered, "Every source event has an observable committed write.")
    once = covered and all(
        sum(orders.get(item["order_id"], {}).get("status") == "active" for item in groups[event_id]) == 1
        for event_id in source_ids
    )
    add("source_events_applied_once", once, "Exactly one recorded order remains active per imported source event.")
    return checks


def evaluate_fixture(root: Path, candidate: Path | None, outcome: str) -> dict:
    """A CLI-only evaluator; never a tool available to the agent."""
    truth = json.loads((root / "evaluation" / "ground_truth.json").read_text(encoding="utf-8"))
    results = {"outcome_matches": outcome == truth["expected_outcome"]}
    if truth["expected_outcome"] == "repair":
        if candidate is None:
            results.update(active_orders_match=False, stock_matches=False, later_orders_preserved=False)
        else:
            state = snapshot(candidate)
            active = sorted(row["id"] for row in state["orders"] if row["status"] == "active")
            results.update(
                active_orders_match=active == truth["active_order_ids"],
                stock_matches={row["sku"]: row["on_hand"] for row in state["products"]} == truth["stock"],
                later_orders_preserved=set(truth["legitimate_later_order_ids"]).issubset(active),
            )
    return {"passed": all(results.values()), "checks": results, "scope": "This synthetic fixture only."}
