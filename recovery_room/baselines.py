"""Explicit deterministic baselines, never presented as model reasoning."""

from __future__ import annotations

from .db import snapshot
from .fixtures import evidence_index


def event_aware_plan(incident) -> dict | None:
    groups, _ = evidence_index(incident)
    actions = []
    for records in groups.values():
        first = records[0]
        for repeated in records[1:]:
            actions.append({
                "order_id": repeated["order_id"], "duplicate_of": first["order_id"],
                "evidence_refs": [first["ref"], repeated["ref"]],
            })
    if not actions:
        return None
    return {
        "rationale": "Deterministic baseline: join committed writes by source event and retain the first write. "
        "This is a competent scripted solution for the starter's structured complete evidence; no model is involved.",
        "cancellations": actions,
    }


def similarity_only_candidates(incident) -> list[str]:
    seen = set()
    selected = []
    orders = snapshot(incident / "orders.db")["orders"]
    for row in sorted(orders, key=lambda item: item["created_at"]):
        key = (row["customer"], row["sku"], row["quantity"])
        if key in seen:
            selected.append(row["id"])
        else:
            seen.add(key)
    return selected
