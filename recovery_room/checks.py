"""Operational checks do not use the private fixture evaluator."""

from __future__ import annotations

import json
import math
import re
from contextlib import closing
from pathlib import Path

from .db import readonly, snapshot
from .fixtures import evidence_index

# Diagnostics explain a check's decision; they never make it. Every check keeps its original pass/fail
# expression, and its diagnostics are computed beside it from the same state. They are bounded so a
# review stays small: at most MAX_ITEMS items (the total and a truncation flag say how many existed),
# scalar values only, short strings, and short ID lists.
MAX_ITEMS = 20
MAX_IDS = 20
MAX_TEXT = 160
MAX_KEYS = 6
LISTINGS = ("exceptions", "all")


def _scalar(value):
    """A bounded JSON scalar: numbers and booleans as they are, anything else as short plain text."""
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    text = re.sub(r"[\x00-\x1f\x7f]", " ", str(value))
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT - 1] + "…"


def _item(item: dict) -> dict:
    out = {"entity": {str(k)[:40]: _scalar(v) for k, v in list(item["entity"].items())[:MAX_KEYS]},
           "expected": _scalar(item.get("expected")), "observed": _scalar(item.get("observed"))}
    if isinstance(item.get("difference"), (int, float)) and not isinstance(item.get("difference"), bool):
        out["difference"] = _scalar(item["difference"])
    if item.get("parts"):
        out["parts"] = {str(k)[:40]: _scalar(v) for k, v in list(item["parts"].items())[:MAX_KEYS]}
    if item.get("related"):
        related = {str(k)[:40]: [_scalar(x) for x in ids] for k, ids in list(item["related"].items())[:4]}
        out["related"] = {k: ids[:MAX_IDS] for k, ids in related.items()}
        if any(len(ids) > MAX_IDS for ids in related.values()):
            out["related_truncated"] = True
    return out


def safely(build):
    """Run an explanation builder; if it fails, the check keeps its decision and simply has no diagnostics."""
    try:
        return build()
    except Exception:  # noqa: BLE001 - explanations must never turn a computed decision into an error
        return None


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def diagnostics(rule: str, items: list[dict], listing: str = "exceptions") -> dict:
    """listing: "exceptions" lists only what broke the rule; "all" lists every entity the rule covers."""
    return {"rule": _scalar(rule), "listing": listing, "items": [_item(row) for row in items[:MAX_ITEMS]],
            "total": len(items), "truncated": len(items) > MAX_ITEMS}


def public_diagnostics(value) -> dict | None:
    """Re-bound diagnostics read back from a file (a recording). Anything off-shape is dropped, not repaired."""
    if not isinstance(value, dict) or set(value) - {"rule", "listing", "items", "total", "truncated"}:
        return None
    items, total = value.get("items"), value.get("total")
    if (not isinstance(value.get("rule"), str) or value.get("listing") not in LISTINGS or not isinstance(items, list)
            or len(items) > MAX_ITEMS or type(total) is not int or total < len(items)
            or type(value.get("truncated")) is not bool or value["truncated"] != (total > len(items))):
        return None
    scalar = (str, int, float, bool, type(None))
    for row in items:
        if (not isinstance(row, dict) or set(row) - {"entity", "expected", "observed", "difference", "parts",
                                                       "related", "related_truncated"}
                or "expected" not in row or "observed" not in row
                or not isinstance(row.get("entity"), dict) or len(row["entity"]) > MAX_KEYS
                or not all(isinstance(v, scalar) for v in row["entity"].values())
                or not isinstance(row.get("expected"), scalar) or not isinstance(row.get("observed"), scalar)
                or ("difference" in row and (isinstance(row["difference"], bool)
                                             or not isinstance(row["difference"], (int, float))))
                or ("parts" in row and (not isinstance(row["parts"], dict) or len(row["parts"]) > MAX_KEYS
                                        or not all(isinstance(v, scalar) for v in row["parts"].values())))
                or ("related" in row and (not isinstance(row["related"], dict) or len(row["related"]) > 4
                                          or not all(isinstance(ids, list) and len(ids) <= MAX_IDS
                                                     and all(isinstance(x, str) for x in ids)
                                                     for ids in row["related"].values())))
                or ("related_truncated" in row and row["related_truncated"] is not True)):
            return None
    clean = diagnostics(value["rule"], items, value["listing"])
    clean.update(total=total, truncated=value["truncated"])
    for row, original in zip(clean["items"], items):
        if original.get("related_truncated"):
            row["related_truncated"] = True
    return clean


def _mismatches_first(rows: list[dict]) -> list[dict]:
    """Products that break the rule (or cannot be computed) come first, so the 20-item limit never hides them."""
    return sorted(rows, key=lambda row: row.get("difference") == 0)


def _field_changes(table: str, key: str, before: dict, after: dict, skip: tuple[str, ...] = ()) -> list[dict]:
    return [{"entity": {"table": table, "id": key, "field": field}, "expected": before.get(field), "observed": after.get(field)}
            for field in sorted(set(before) | set(after)) if field not in skip and before.get(field) != after.get(field)]


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
        integrity_rows = [row[0] for row in conn.execute("PRAGMA integrity_check")]
        foreign_key_rows = [tuple(row) for row in conn.execute("PRAGMA foreign_key_check")]
    integrity = integrity_rows[0] == "ok"
    foreign_keys = not foreign_key_rows
    checks: list[dict] = []

    def add(name: str, passed: bool, detail: str, explain) -> None:
        check = {"name": name, "passed": bool(passed), "detail": detail}
        explained = safely(explain)
        if explained is not None:
            check["diagnostics"] = explained
        checks.append(check)

    add("database_integrity", integrity and foreign_keys, "SQLite integrity and foreign-key checks.", lambda: diagnostics(
        "PRAGMA integrity_check returns ok and PRAGMA foreign_key_check returns no rows",
        ([] if integrity else [{"entity": {"check": "integrity_check"}, "expected": "ok", "observed": row} for row in integrity_rows])
        + [{"entity": {"table": row[0], "rowid": row[1]}, "expected": f"a parent row in {row[2]}", "observed": "missing"}
           for row in foreign_key_rows]))

    unchanged = (
        set(orders) == set(original)
        and all(orders[key] == row for key, row in original.items() if key not in targeted_ids)
    )
    def untouched_changes():
        found = [{"entity": {"table": "orders", "id": key}, "expected": "present", "observed": "missing"}
                 for key in sorted(set(original) - set(orders))]
        found += [{"entity": {"table": "orders", "id": key}, "expected": "absent", "observed": "added"}
                  for key in sorted(set(orders) - set(original))]
        for key in sorted(original):
            if key not in targeted_ids and key in orders and orders[key] != original[key]:
                found += _field_changes("orders", key, original[key], orders[key])
        return diagnostics("Every order the plan does not target matches its original record exactly", found)
    add("unaffected_orders_preserved", unchanged, "Every untargeted order matches its original record exactly.", untouched_changes)

    history = all(
        all(orders[key][field] == row[field] for field in row if field != "status")
        for key, row in original.items() if key in orders
    )
    def history_changes():
        found = []
        for key in sorted(original):
            if key in orders:
                found += _field_changes("orders", key, original[key], orders[key], skip=("status",))
        return diagnostics("Only an order's status may change; every other field keeps its original value", found)
    add("order_history_preserved", history, "Corrections retain original order identities, quantities and customer fields.", history_changes)

    original_movements = {row["id"]: row for row in before["inventory_movements"]}
    current_movements = {row["id"]: row for row in movements}
    intact = all(current_movements.get(key) == row for key, row in original_movements.items())
    def movement_changes():
        found = []
        for key in sorted(original_movements):
            current = current_movements.get(key)
            if current is None:
                found.append({"entity": {"table": "inventory_movements", "id": key}, "expected": "present", "observed": "missing"})
            elif current != original_movements[key]:
                found += _field_changes("inventory_movements", key, original_movements[key], current)
        return diagnostics("Every original stock movement is still present and unchanged", found)
    add("original_movements_preserved", intact, "Original stock movements remain intact; corrections are compensating entries.", movement_changes)

    balanced = all(
        product["on_hand"] == opening[product["sku"]] + sum(
            row["delta"] for row in movements if row["sku"] == product["sku"]
        )
        for product in state["products"]
    )
    def ledger_rows():
        rows = []
        for product in state["products"]:
            sku, base = product["sku"], opening.get(product["sku"])
            moved = sum(row["delta"] for row in movements if row["sku"] == sku)
            added = [row["id"] for row in movements if row["sku"] == sku and row["id"] not in original_movements]
            row = {"entity": {"table": "products", "sku": sku}, "parts": {"opening": base if _number(base) else None, "movements": moved},
                   "observed": product["on_hand"], "related": {"added_movement_ids": added} if added else None}
            if _number(base) and _number(product["on_hand"]):
                row.update(expected=base + moved, difference=product["on_hand"] - (base + moved))
            else:
                row["expected"] = "unavailable: no opening stock for this product"
            rows.append(row)
        return diagnostics("Stock on hand = opening stock + the sum of recorded movements", _mismatches_first(rows), "all")
    add("stock_matches_movement_ledger", balanced, "Opening stock plus all recorded movements equals current stock.", ledger_rows)

    active_balance = all(
        product["on_hand"] == opening[product["sku"]] - sum(
            row["quantity"] for row in orders.values()
            if row["sku"] == product["sku"] and row["status"] == "active"
        )
        for product in state["products"]
    )
    def reconciled_rows():
        rows = []
        for product in state["products"]:
            sku, base = product["sku"], opening.get(product["sku"])
            active = sum(row["quantity"] for row in orders.values() if row["sku"] == sku and row["status"] == "active")
            row = {"entity": {"table": "products", "sku": sku}, "parts": {"opening": base if _number(base) else None, "active_quantity": active},
                   "observed": product["on_hand"]}
            if _number(base) and _number(product["on_hand"]):
                row.update(expected=base - active, difference=product["on_hand"] - (base - active))
            else:
                row["expected"] = "unavailable: no opening stock for this product"
            rows.append(row)
        return diagnostics("Stock on hand = opening stock − the quantity of every active order", _mismatches_first(rows), "all")
    add("stock_matches_active_orders", active_balance, "Stock reconciles with all active purchases, including later purchases.", reconciled_rows)

    covered = source_ids.issubset(groups)
    add("source_evidence_complete", covered, "Every source event has an observable committed write.", lambda: diagnostics(
        "Every imported source event has at least one committed-write record",
        [{"entity": {"event_id": event_id}, "expected": "a committed write", "observed": "none"}
         for event_id in sorted(source_ids - set(groups))]))

    once = covered and all(
        sum(orders.get(item["order_id"], {}).get("status") == "active" for item in groups[event_id]) == 1
        for event_id in source_ids
    )
    def activation_counts():
        found = []
        for event_id in sorted(source_ids):
            recorded = [item["order_id"] for item in groups.get(event_id, [])]
            active = [key for key in recorded if orders.get(key, {}).get("status") == "active"]
            if len(active) != 1:
                found.append({"entity": {"event_id": event_id}, "expected": 1, "observed": len(active),
                              "related": {"active_order_ids": active, "recorded_order_ids": recorded}})
        return diagnostics("Exactly one recorded order stays active for each imported source event", found)
    add("source_events_applied_once", once, "Exactly one recorded order remains active per imported source event.", activation_counts)
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
