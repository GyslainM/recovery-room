from __future__ import annotations

import contextlib
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from recovery_room.baselines import event_aware_plan, similarity_only_candidates
from recovery_room.checks import check_state, evaluate_fixture
from recovery_room.db import copy_database, query_database, snapshot
from recovery_room.fixtures import create_incident, read_artifact
from recovery_room.repairs import execute_plan, export_sql, finalize_report, rehearse


class IncidentCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.incident = create_incident(self.root / "case", seed=11)
        self.plan = event_aware_plan(self.incident)
        self.original = snapshot(self.incident / "orders.db")

    def rehearsal(self):
        return rehearse(self.incident, self.plan, self.root / "results")


class RepairTests(IncidentCase):
    def test_selective_repair_preserves_every_later_purchase_and_original(self):
        result = self.rehearsal()
        self.assertTrue(result["passed"], result["checks"])
        evaluation = evaluate_fixture(self.root / "case", Path(result["candidate_path"]), "repair")
        self.assertTrue(evaluation["passed"], evaluation)
        self.assertEqual(len(self.plan["cancellations"]), 20)
        self.assertEqual(snapshot(self.incident / "orders.db"), self.original)
        self.assertEqual(sum(x["status"] == "active" for x in result["after"]["orders"]), 60)

    def test_similar_legitimate_purchases_defeat_similarity_baseline(self):
        truth = json.loads((self.root / "case/evaluation/ground_truth.json").read_text())
        selected = set(similarity_only_candidates(self.incident))
        self.assertEqual(len(selected & set(truth["legitimate_later_order_ids"])), 10)

    def test_invented_evidence_is_rejected_without_changing_source(self):
        plan = copy.deepcopy(self.plan)
        plan["cancellations"][0]["evidence_refs"] = ["events.jsonl:L999", "events.jsonl:L998"]
        with self.assertRaisesRegex(ValueError, "Evidence reference"):
            rehearse(self.incident, plan, self.root / "results")
        self.assertEqual(snapshot(self.incident / "orders.db"), self.original)

    def test_cancelling_a_similar_later_purchase_is_rejected(self):
        plan = copy.deepcopy(self.plan)
        later = next(row for row in self.original["orders"] if row["source_reference"] == "checkout-000")
        plan["cancellations"][0]["order_id"] = later["id"]
        with self.assertRaises(ValueError):
            rehearse(self.incident, plan, self.root / "results")

    def test_missing_evidence_does_not_become_a_repair(self):
        incomplete = create_incident(self.root / "unknown", "missing-evidence", seed=11)
        self.assertIsNone(event_aware_plan(incomplete))
        with self.assertRaises(ValueError):
            rehearse(incomplete, self.plan, self.root / "results")
        self.assertTrue(evaluate_fixture(self.root / "unknown", None, "stop")["passed"])
        self.assertFalse(evaluate_fixture(self.root / "unknown", None, "repair")["passed"])

    def test_repeated_execution_is_idempotent(self):
        result = self.rehearsal()
        candidate = Path(result["candidate_path"])
        once = snapshot(candidate)
        execute_plan(candidate, result["plan"])
        self.assertEqual(snapshot(candidate), once)

    def test_exported_sql_matches_rehearsal_and_is_repeatable(self):
        result = self.rehearsal()
        fresh = self.root / "export-target.db"
        copy_database(self.incident / "orders.db", fresh)
        script = export_sql(result)
        conn = sqlite3.connect(fresh)
        self.addCleanup(conn.close)
        conn.executescript(script)
        self.assertEqual(snapshot(fresh), result["after"])
        conn.executescript(script)
        self.assertEqual(snapshot(fresh), result["after"])

    def test_export_refuses_a_new_legitimate_purchase_and_rolls_back(self):
        result = self.rehearsal()
        fresh = self.root / "changed.db"
        copy_database(self.incident / "orders.db", fresh)
        conn = sqlite3.connect(fresh)
        self.addCleanup(conn.close)
        conn.execute(
            "INSERT INTO orders VALUES ('new-order','new-customer','MOUSE',1,'new-checkout','active','2026-10-27T13:00:00Z')"
        )
        conn.execute("INSERT INTO inventory_movements VALUES ('new-movement','new-order','MOUSE',-1,'sale',NULL)")
        conn.execute("UPDATE products SET on_hand = on_hand - 1 WHERE sku = 'MOUSE'")
        conn.commit()
        changed = snapshot(fresh)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.executescript(export_sql(result))
        self.assertFalse(conn.in_transaction)
        self.assertEqual(snapshot(fresh), changed)

    def test_invariant_checker_catches_balanced_but_wrong_product_stock(self):
        result = self.rehearsal()
        candidate = Path(result["candidate_path"])
        # sqlite3's context manager commits but does not close; Windows then
        # cannot delete the temp file. Close explicitly.
        with contextlib.closing(sqlite3.connect(candidate)) as conn:
            conn.execute("UPDATE products SET on_hand = on_hand + 1 WHERE sku = 'MOUSE'")
            conn.execute("UPDATE products SET on_hand = on_hand - 1 WHERE sku = 'HEADPHONES'")
            conn.commit()
        checks = check_state(
            self.incident, candidate, result["before"],
            {a["order_id"] for a in result["plan"]["cancellations"]},
        )
        self.assertFalse(next(x for x in checks if x["name"] == "stock_matches_active_orders")["passed"])

    def test_source_change_between_rehearsal_and_export_is_rejected(self):
        result = self.rehearsal()
        with contextlib.closing(sqlite3.connect(self.incident / "orders.db")) as conn:
            conn.execute("UPDATE orders SET customer = 'changed' WHERE id = (SELECT id FROM orders LIMIT 1)")
            conn.commit()
        with self.assertRaisesRegex(ValueError, "source changed"):
            finalize_report(self.incident, result)
        self.assertFalse((Path(result["folder"]) / "repair.sql").exists())

    def test_evidence_change_invalidates_the_rehearsal(self):
        result = self.rehearsal()
        note = self.incident / "evidence/incident_note.txt"
        note.write_text(note.read_text() + "\nAdditional evidence arrived.")
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            finalize_report(self.incident, result)
        self.assertFalse((Path(result["folder"]) / "repair.sql").exists())

    def test_report_and_script_are_usable_artifacts(self):
        result = self.rehearsal()
        report = finalize_report(self.incident, result)
        folder = Path(result["folder"])
        self.assertEqual(report["totals"]["after_active"], 60)
        for filename in ("report.html", "report.json", "repair.sql", "plan.json"):
            self.assertGreater((folder / filename).stat().st_size, 100)
        self.assertIn("events.jsonl:L", (folder / "report.html").read_text())

    def test_multiple_seeded_cases_pass_without_publishing_a_general_success_rate(self):
        for seed in (3, 19, 41):
            with self.subTest(seed=seed):
                root = self.root / f"seed-{seed}"
                incident = create_incident(root, seed=seed)
                result = rehearse(incident, event_aware_plan(incident), root / "results")
                self.assertTrue(result["passed"])
                self.assertTrue(evaluate_fixture(root, Path(result["candidate_path"]), "repair")["passed"])


class InvestigationBoundaryTests(IncidentCase):
    def test_ordinary_selects_and_aggregation_work(self):
        result = query_database(self.incident / "orders.db", "SELECT COUNT(*) AS n FROM orders")
        self.assertEqual(result["rows"], [{"n": 80}])
        result = query_database(self.incident / "orders.db", "SELECT * FROM orders", max_rows=3)
        self.assertEqual(len(result["rows"]), 3)
        self.assertTrue(result["truncated"])

    def test_writes_attach_pragma_and_external_functions_are_blocked(self):
        queries = (
            "DELETE FROM orders",
            "UPDATE products SET on_hand = 0",
            "DROP TABLE orders",
            "ATTACH DATABASE ':memory:' AS other",
            "PRAGMA writable_schema = ON",
            "PRAGMA table_info(orders)",
            "SELECT load_extension('/tmp/extension')",
            "SELECT readfile('/etc/passwd')",
            "SELECT * FROM orders; DELETE FROM orders",
            "VACUUM INTO '/tmp/rr-forbidden-test.db'",
        )
        for sql in queries:
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                query_database(self.incident / "orders.db", sql)
        self.assertEqual(snapshot(self.incident / "orders.db"), self.original)

    def test_expensive_recursive_query_is_interrupted(self):
        with self.assertRaisesRegex(ValueError, "interrupted"):
            query_database(
                self.incident / "orders.db",
                "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT SUM(x) FROM n",
                timeout=0.01,
            )

    def test_agent_cannot_read_evaluator_or_traverse_paths(self):
        for name in ("../evaluation/ground_truth.json", "../../evaluation/ground_truth.json", "/etc/passwd"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                read_artifact(self.incident, name)
        page = read_artifact(self.incident, "events.jsonl", max_lines=2)
        self.assertEqual(page["next_line"], 3)
        self.assertEqual(page["lines"][0]["ref"], "events.jsonl:L1")

    def test_evidence_symlink_escape_is_blocked(self):
        path = self.incident / "evidence/incident_note.txt"
        path.unlink()
        try:
            path.symlink_to(self.root / "case/evaluation/ground_truth.json")
        except OSError as exc:  # e.g. WinError 1314 without symlink privilege
            self.skipTest(f"Cannot create symlinks here: {exc}")
        with self.assertRaises(ValueError):
            read_artifact(self.incident, "incident_note.txt")

    def test_evidence_reported_as_symlink_is_rejected(self):
        # Runs everywhere: checks the rejection branch without creating a real link.
        target = self.incident / "evidence" / "incident_note.txt"
        original = Path.is_symlink

        def fake_is_symlink(path):
            return True if path == target else original(path)

        with mock.patch.object(Path, "is_symlink", fake_is_symlink):
            with self.assertRaisesRegex(ValueError, "evidence directory"):
                read_artifact(self.incident, "incident_note.txt")
        self.assertIn("lines", read_artifact(self.incident, "incident_note.txt"))
