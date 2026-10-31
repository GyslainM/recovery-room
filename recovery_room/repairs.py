"""Only supported, evidence-backed cancellations can be rehearsed or exported."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import sqlite3
import uuid

from .checks import check_state, diagnostics, safely
from .db import TABLES, copy_database, fingerprint, snapshot
from .fixtures import artifact_names, evidence_index, read_artifact


def evidence_fingerprint(incident: Path) -> str:
    digest = hashlib.sha256()
    for name in artifact_names(incident):
        path = incident / "evidence" / name
        if path.is_symlink() or path.resolve().parent != (incident / "evidence").resolve():
            raise ValueError("Evidence files must remain inside the incident evidence directory.")
        digest.update(name.encode())
        digest.update(b"\x00")
        digest.update(path.read_bytes())
        digest.update(b"\x00")
    return digest.hexdigest()


def evidence_digests(incident: Path) -> dict[str, str]:
    """Per-file digests of the same allowlisted evidence, to say which file changed (never shown as hashes)."""
    digests = {}
    for name in artifact_names(incident):
        path = incident / "evidence" / name
        if path.is_symlink() or path.resolve().parent != (incident / "evidence").resolve():
            raise ValueError("Evidence files must remain inside the incident evidence directory.")
        digests[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return digests


def input_changes(kind: str, before: dict, now: dict) -> list[dict]:
    """Which tables (source) or files (evidence) differ between two observations; values are never included."""
    items = []
    for key in sorted(set(before) | set(now)):
        if key not in now:
            items.append({"entity": {kind: key}, "expected": "unchanged since the rehearsal began", "observed": "missing"})
        elif key not in before:
            items.append({"entity": {kind: key}, "expected": "absent", "observed": "added"})
        elif before[key] != now[key]:
            items.append({"entity": {kind: key}, "expected": "unchanged since the rehearsal began", "observed": "changed"})
    return items


def normalize_plan(plan: dict) -> dict:
    if not isinstance(plan, dict) or set(plan) != {"rationale", "cancellations"}:
        raise ValueError("A plan must contain exactly rationale and cancellations.")
    if not isinstance(plan["rationale"], str) or not 1 <= len(plan["rationale"]) <= 4000:
        raise ValueError("Provide a rationale of 1 to 4000 characters.")
    actions = plan["cancellations"]
    if not isinstance(actions, list) or not 1 <= len(actions) <= 40:
        raise ValueError("This repair supports 1 to 40 evidence-backed duplicate cancellations.")
    normalized = []
    seen = set()
    for action in actions:
        if not isinstance(action, dict) or set(action) != {"order_id", "duplicate_of", "evidence_refs"}:
            raise ValueError("Each cancellation requires order_id, duplicate_of and evidence_refs.")
        for key in ("order_id", "duplicate_of"):
            if not isinstance(action[key], str) or not 1 <= len(action[key]) <= 80:
                raise ValueError("Order identifiers must be strings of 1 to 80 characters.")
        refs = action["evidence_refs"]
        if (
            not isinstance(refs, list) or not 2 <= len(refs) <= 8
            or any(not isinstance(ref, str) or len(ref) > 120 for ref in refs)
        ):
            raise ValueError("Cite 2 to 8 evidence line references for each cancellation.")
        if action["order_id"] in seen:
            raise ValueError("An order may appear only once in a repair plan.")
        if action["order_id"] == action["duplicate_of"]:
            raise ValueError("An order cannot duplicate itself.")
        seen.add(action["order_id"])
        normalized.append({
            "order_id": action["order_id"], "duplicate_of": action["duplicate_of"],
            "evidence_refs": sorted(set(refs)),
        })
    if any(action["duplicate_of"] in seen for action in normalized):
        raise ValueError("An order retained as canonical cannot also be cancelled.")
    return {"rationale": plan["rationale"], "cancellations": sorted(normalized, key=lambda row: row["order_id"])}


def validate_evidence(incident: Path, state: dict, plan: dict) -> None:
    groups, refs = evidence_index(incident)
    source = {
        row["event_id"]: row
        for row in json.loads((incident / "evidence" / "source_orders.json").read_text(encoding="utf-8"))
    }
    orders = {row["id"]: row for row in state["orders"]}
    for action in plan["cancellations"]:
        order_id, canonical_id = action["order_id"], action["duplicate_of"]
        if order_id not in orders or canonical_id not in orders:
            raise ValueError("A proposed order does not exist.")
        if orders[canonical_id]["status"] != "active":
            raise ValueError("The canonical purchase must remain active.")
        records = []
        for ref in action["evidence_refs"]:
            if ref not in refs or refs[ref].get("type") != "write_committed":
                raise ValueError(f"Evidence reference is not a committed-write record: {ref}")
            records.append(refs[ref])
        pair = next((
            (a, b) for a in records for b in records
            if a.get("order_id") == order_id and b.get("order_id") == canonical_id
            and a.get("event_id") == b.get("event_id")
        ), None)
        if pair is None:
            raise ValueError("Cited evidence must link both orders to the same source event.")
        event_id = pair[0]["event_id"]
        if event_id not in source or groups[event_id][0]["order_id"] != canonical_id:
            raise ValueError("Keep the first recorded write for a known imported source event.")
        event = source[event_id]
        if any(
            orders[key][field] != event[field]
            for key in (order_id, canonical_id)
            for field in ("customer", "sku", "quantity")
        ):
            raise ValueError("Source content and proposed duplicate records disagree.")
        sales = [
            row for row in state["inventory_movements"]
            if row["order_id"] == order_id and row["reason"] == "sale"
        ]
        if len(sales) != 1 or sales[0]["delta"] != -orders[order_id]["quantity"] or sales[0]["sku"] != orders[order_id]["sku"]:
            raise ValueError("A supported cancellation needs exactly one matching sale movement.")
        if any(ref.startswith("inbox_receipts.txt:L") for ref in action["evidence_refs"]):
            for receipt in pair:
                recorded_sales = [row for row in state["inventory_movements"]
                                  if row["order_id"] == receipt["order_id"] and row["reason"] == "sale"]
                if (len(recorded_sales) != 1 or recorded_sales[0]["id"] != receipt.get("movement_id")
                        or recorded_sales[0]["sku"] != event["sku"]
                        or recorded_sales[0]["delta"] != -event["quantity"]):
                    raise ValueError("Inbox receipts must identify the actual sale movement for both orders.")


def execute_plan(path: Path, plan: dict) -> None:
    encoded = json.dumps(plan, sort_keys=True, separators=(",", ":"))
    repair_id = "repair_" + hashlib.sha256(encoded.encode()).hexdigest()[:20]
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("BEGIN IMMEDIATE")
        for action in plan["cancellations"]:
            order = conn.execute("SELECT * FROM orders WHERE id = ?", (action["order_id"],)).fetchone()
            sale = conn.execute(
                "SELECT * FROM inventory_movements WHERE order_id = ? AND reason = 'sale'",
                (action["order_id"],),
            ).fetchone()
            reversal = conn.execute(
                "SELECT * FROM inventory_movements WHERE reverses_movement_id = ?", (sale["id"],)
            ).fetchone()
            if order["status"] == "cancelled":
                if reversal is None or reversal["delta"] != -sale["delta"]:
                    raise ValueError("An existing cancellation lacks a matching compensation.")
                continue
            if reversal is not None:
                raise ValueError("An active purchase already has a compensation; manual investigation is required.")
            conn.execute("UPDATE orders SET status = 'cancelled' WHERE id = ?", (order["id"],))
            conn.execute(
                "UPDATE products SET on_hand = on_hand + ? WHERE sku = ?",
                (-sale["delta"], sale["sku"]),
            )
            conn.execute(
                "INSERT INTO inventory_movements VALUES (?, ?, ?, ?, 'repair_compensation', ?)",
                ("comp_" + sale["id"], order["id"], sale["sku"], -sale["delta"], sale["id"]),
            )
        existing = conn.execute("SELECT plan_json FROM repair_runs WHERE id = ?", (repair_id,)).fetchone()
        if existing is not None and existing["plan_json"] != encoded:
            raise ValueError("Repair identifier collision.")
        if existing is None:
            conn.execute("INSERT INTO repair_runs VALUES (?, ?)", (repair_id, encoded))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def rehearse(incident: Path, plan: dict, output: Path) -> dict:
    plan = normalize_plan(plan)
    evidence_hash = evidence_fingerprint(incident)
    evidence_files = safely(lambda: evidence_digests(incident))
    output.mkdir(parents=True, exist_ok=True)
    folder = output / f"rehearsal-{uuid.uuid4().hex[:12]}"
    folder.mkdir()
    candidate = folder / "candidate.db"
    original = incident / "orders.db"
    copy_database(original, candidate)
    before = snapshot(candidate)
    validate_evidence(incident, before, plan)
    execute_plan(candidate, plan)
    checks = check_state(incident, candidate, before, {a["order_id"] for a in plan["cancellations"]})
    source_now = snapshot(original)
    source_unchanged = source_now == before

    def source_changes():
        changed = input_changes("table", before, source_now)
        return diagnostics("The source database matches the snapshot taken when the rehearsal began",
                           changed or ([] if source_unchanged else [{"entity": {"table": "source database"},
                                                                     "expected": "unchanged since the rehearsal began", "observed": "changed"}]))
    source_check = {"name": "source_snapshot_unchanged", "passed": source_unchanged,
                    "detail": "The original still matches the snapshot used for rehearsal; otherwise this plan is stale."}
    evidence_unchanged = evidence_fingerprint(incident) == evidence_hash

    def evidence_changes():
        changed = input_changes("file", evidence_files, evidence_digests(incident))
        return diagnostics("Every evidence file matches the one read when the rehearsal began",
                           changed or ([] if evidence_unchanged else [{"entity": {"file": "evidence set"},
                                                                       "expected": "unchanged since the rehearsal began", "observed": "changed"}]))
    evidence_check = {"name": "evidence_snapshot_unchanged", "passed": evidence_unchanged,
                      "detail": "The evidence files still match those used for the rehearsal."}
    for check, explain in ((source_check, source_changes), (evidence_check, evidence_changes)):
        explained = safely(explain)
        if explained is not None:
            check["diagnostics"] = explained
        checks.append(check)
    after = snapshot(candidate)
    return {
        "passed": all(check["passed"] for check in checks),
        "checks": checks, "plan": plan,
        "candidate_path": str(candidate.resolve()),
        "folder": str(folder.resolve()),
        "source_fingerprint": fingerprint(before),
        "evidence_fingerprint": evidence_hash,
        "before": before, "after": after,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def literal(value) -> str:
    if value is None:
        return "NULL"
    if type(value) is int:
        return str(value)
    if not isinstance(value, str):
        raise ValueError("Unsupported SQL literal.")
    return "'" + value.replace("'", "''") + "'"


def export_sql(result: dict) -> str:
    if not result["passed"]:
        raise ValueError("A failed rehearsal cannot be exported as a reviewed repair.")
    lines = [
        "-- Recovery Room: review before use. SQLite only; bounded fixture schema.",
        "-- This script was rehearsed on a copy. No production connection was used.",
        "-- Full-state guards reject any changed snapshot; re-rehearse on fresh data.",
        "PRAGMA foreign_keys = ON;",
        "BEGIN IMMEDIATE;",
        "CREATE TEMP TABLE rr_assert (ok INTEGER NOT NULL CHECK (ok = 1));",
    ]

    def equality(label: str) -> str:
        terms = []
        for table, columns in TABLES.items():
            cols = ", ".join(columns)
            expected = f"rr_{label}_{table}"
            terms.extend([
                f"NOT EXISTS (SELECT {cols} FROM main.{table} EXCEPT SELECT {cols} FROM temp.{expected})",
                f"NOT EXISTS (SELECT {cols} FROM temp.{expected} EXCEPT SELECT {cols} FROM main.{table})",
                f"(SELECT COUNT(*) FROM main.{table}) = (SELECT COUNT(*) FROM temp.{expected})",
            ])
        return "(" + " AND ".join(terms) + ")"

    for label in ("before", "after"):
        for table, columns in TABLES.items():
            name = f"rr_{label}_{table}"
            cols = ", ".join(columns)
            lines.append(f"CREATE TEMP TABLE {name} AS SELECT {cols} FROM main.{table} WHERE 0;")
            for row in result[label][table]:
                values = ", ".join(literal(row[column]) for column in columns)
                lines.append(f"INSERT INTO temp.{name} VALUES ({values});")
    lines.append(
        "INSERT OR ROLLBACK INTO rr_assert VALUES "
        f"(CASE WHEN {equality('before')} OR {equality('after')} THEN 1 ELSE 0 END);"
    )
    before_orders = {row["id"]: row for row in result["before"]["orders"]}
    for action in result["plan"]["cancellations"]:
        order = before_orders[action["order_id"]]
        sale = next(
            row for row in result["before"]["inventory_movements"]
            if row["order_id"] == order["id"] and row["reason"] == "sale"
        )
        missing = (
            "NOT EXISTS (SELECT 1 FROM inventory_movements WHERE reverses_movement_id = "
            + literal(sale["id"]) + ")"
        )
        lines.extend([
            f"-- Evidence: {', '.join(action['evidence_refs'])}",
            "UPDATE products SET on_hand = on_hand + " + str(-sale["delta"])
            + " WHERE sku = " + literal(sale["sku"]) + " AND " + missing + ";",
            "UPDATE orders SET status = 'cancelled' WHERE id = " + literal(order["id"]) + ";",
            "INSERT INTO inventory_movements (id, order_id, sku, delta, reason, reverses_movement_id) SELECT "
            + ", ".join(literal(value) for value in (
                "comp_" + sale["id"], order["id"], sale["sku"], -sale["delta"],
                "repair_compensation", sale["id"],
            )) + " WHERE " + missing + ";",
        ])
    before_runs = {row["id"] for row in result["before"]["repair_runs"]}
    for row in result["after"]["repair_runs"]:
        if row["id"] not in before_runs:
            lines.append(
                "INSERT INTO repair_runs SELECT " + literal(row["id"]) + ", " + literal(row["plan_json"])
                + " WHERE NOT EXISTS (SELECT 1 FROM repair_runs WHERE id = " + literal(row["id"]) + ");"
            )
    lines.append(
        "INSERT OR ROLLBACK INTO rr_assert VALUES "
        f"(CASE WHEN {equality('after')} THEN 1 ELSE 0 END);"
    )
    for label in ("before", "after"):
        for table in TABLES:
            lines.append(f"DROP TABLE temp.rr_{label}_{table};")
    lines.extend(["DROP TABLE temp.rr_assert;", "COMMIT;", ""])
    return "\n".join(lines)


def finalize_report(incident: Path, result: dict) -> dict:
    if not result["passed"]:
        raise ValueError("Only a successful rehearsal can produce a review-ready package.")
    if fingerprint(snapshot(incident / "orders.db")) != result["source_fingerprint"]:
        raise ValueError("The source changed since rehearsal. Run a new rehearsal before exporting.")
    if evidence_fingerprint(incident) != result["evidence_fingerprint"]:
        raise ValueError("The evidence changed since rehearsal. Run a new rehearsal before exporting.")
    _, refs = evidence_index(incident)
    cited_lines = {}
    for action in result["plan"]["cancellations"]:
        for ref in action["evidence_refs"]:
            if ref not in refs:
                raise ValueError("A cited evidence line is unavailable.")
            name, number = ref.rsplit(":L", 1)
            cited_lines[ref] = read_artifact(incident, name, int(number), 1)["lines"][0]["text"]
    folder = Path(result["folder"])
    (folder / "repair.sql").write_text(export_sql(result), encoding="utf-8")
    (folder / "plan.json").write_text(json.dumps(result["plan"], indent=2), encoding="utf-8")
    report = {key: value for key, value in result.items() if key not in ("before", "after")}
    report["status"] = "rehearsed_on_copy_ready_for_human_review"
    report["totals"] = {
        "before_active": sum(row["status"] == "active" for row in result["before"]["orders"]),
        "after_active": sum(row["status"] == "active" for row in result["after"]["orders"]),
        "cancellations": len(result["plan"]["cancellations"]),
    }
    (folder / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    escape = html.escape
    products_after = {row["sku"]: row for row in result["after"]["products"]}
    stock_rows = "".join(
        "<tr><td>" + escape(row["sku"]) + "</td><td>" + str(row["on_hand"]) + "</td><td>"
        + str(products_after[row["sku"]]["on_hand"]) + "</td></tr>"
        for row in result["before"]["products"]
    )
    check_rows = "".join(
        "<li><strong>PASS · " + escape(check["name"]) + "</strong><br>" + escape(check["detail"]) + "</li>"
        for check in result["checks"]
    )
    action_rows = "".join(
        "<tr><td>" + escape(action["order_id"]) + "</td><td>" + escape(action["duplicate_of"])
        + "</td><td>" + "<br>".join(
            escape(ref) + "<br><small>" + escape(cited_lines[ref]) + "</small>"
            for ref in action["evidence_refs"]
        ) + "</td></tr>"
        for action in result["plan"]["cancellations"]
    )
    document = """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recovery Room · Repair rehearsal</title>
<style>
body{margin:0;background:#f4f3ee;color:#182720;font:16px/1.55 system-ui,sans-serif}
main{max-width:1100px;margin:40px auto;padding:0 24px 60px}
h1{font-size:42px;line-height:1.12;margin:8px 0 12px}h2{margin-top:36px}
.label{font:12px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#45654f}
.summary{padding:20px;border-left:4px solid #326e4f;background:#e7eee3}
table{width:100%;border-collapse:collapse;font-size:14px;background:#fff}
th,td{padding:12px;text-align:left;border-bottom:1px solid #dedfd8;vertical-align:top}
th{background:#e7e9e1}small{overflow-wrap:anywhere;color:#526057}
li{margin:14px 0}code{overflow-wrap:anywhere}a{color:#19543b}
@media(max-width:650px){h1{font-size:30px}.scroll{overflow:auto}table{min-width:500px}}
</style><main><div class="label">Recovery Room / Synthetic incident / Rehearsed on a copy</div>
<h1>Repair the incident.<br>Preserve the valid work.</h1>
<p class="summary">SUMMARY</p><p>RATIONALE</p>
<p><a href="repair.sql">Review guarded SQLite script</a> · <a href="plan.json">Repair plan</a> ·
<a href="report.json">Check results</a></p>
<h2>Inventory before and after</h2><table><tr><th>Product</th><th>Before</th><th>After</th></tr>STOCK</table>
<h2>Independent operational checks</h2><ul>CHECKS</ul>
<h2>Proposed corrections and supporting evidence</h2>
<div class="scroll"><table><tr><th>Cancel duplicate</th><th>Keep original</th><th>Evidence</th></tr>ACTIONS</table></div>
<p>These checks cover this application's declared rules. They do not establish general production safety.
The original database was not modified.</p></main></html>"""
    document = document.replace(
        "SUMMARY", f"{report['totals']['before_active']} active records → "
        f"{report['totals']['after_active']} active purchases; "
        f"{report['totals']['cancellations']} duplicate records cancelled with compensating stock entries."
    ).replace("RATIONALE", escape(result["plan"]["rationale"]))
    document = document.replace("STOCK", stock_rows).replace("CHECKS", check_rows).replace("ACTIONS", action_rows)
    (folder / "report.html").write_text(document, encoding="utf-8")
    return report
