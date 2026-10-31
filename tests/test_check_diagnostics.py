"""Structured check diagnostics: bounded explanations beside unchanged pass/fail decisions."""
from __future__ import annotations

import contextlib
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from recovery_room import repairs
from recovery_room.agent import AgentTools
from recovery_room.baselines import event_aware_plan
from recovery_room.checks import MAX_ITEMS, MAX_TEXT, check_state, public_diagnostics
from recovery_room.db import copy_database, snapshot
from recovery_room.fixtures import create_incident
from recovery_room.repairs import input_changes, rehearse

from test_recordings import RecordingCase


def by_name(checks):
    return {check["name"]: check for check in checks}


class DiagnosticsCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.incident = create_incident(self.root / "case", seed=11)
        self.plan = event_aware_plan(self.incident)

    def rehearsal(self):
        return rehearse(self.incident, self.plan, self.root / "results")

    def recheck(self, result, sql):
        candidate = Path(result["candidate_path"])
        with contextlib.closing(sqlite3.connect(candidate)) as conn:
            conn.executescript(sql)
            conn.commit()
        return by_name(check_state(self.incident, candidate, result["before"],
                                   {a["order_id"] for a in result["plan"]["cancellations"]}))


class CheckDiagnosticsTests(DiagnosticsCase):
    def test_a_passing_rehearsal_explains_every_check_consistently_with_its_decision(self):
        result = self.rehearsal()
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["checks"]), 10)
        for check in result["checks"]:
            with self.subTest(check=check["name"]):
                explained = check["diagnostics"]
                self.assertIn(explained["listing"], ("exceptions", "all"))
                self.assertTrue(explained["rule"])
                self.assertFalse(explained["truncated"])
                if explained["listing"] == "exceptions":
                    self.assertEqual(check["passed"], explained["total"] == 0)
                else:
                    self.assertEqual(check["passed"], all(item["difference"] == 0 for item in explained["items"]))
        ledger = by_name(result["checks"])["stock_matches_movement_ledger"]["diagnostics"]
        self.assertEqual({item["entity"]["sku"] for item in ledger["items"]}, {row["sku"] for row in result["after"]["products"]})
        for item in ledger["items"]:
            self.assertEqual(item["expected"], item["parts"]["opening"] + item["parts"]["movements"])
        # The repair's compensating entries are named on the products they returned stock to.
        self.assertTrue(any(item.get("related", {}).get("added_movement_ids") for item in ledger["items"]))
        self.assertEqual(json.loads(json.dumps(result["checks"])), result["checks"])

    def test_a_stock_mismatch_names_each_product_with_expected_observed_and_difference(self):
        checks = self.recheck(self.rehearsal(), "UPDATE products SET on_hand = on_hand + 1 WHERE sku = 'MOUSE';"
                                                "UPDATE products SET on_hand = on_hand - 1 WHERE sku = 'HEADPHONES';")
        for name in ("stock_matches_active_orders", "stock_matches_movement_ledger"):
            with self.subTest(check=name):
                self.assertFalse(checks[name]["passed"])
                differences = {item["entity"]["sku"]: item["difference"] for item in checks[name]["diagnostics"]["items"]}
                self.assertEqual(differences["MOUSE"], 1)
                self.assertEqual(differences["HEADPHONES"], -1)
                self.assertEqual({sku for sku, diff in differences.items() if diff}, {"MOUSE", "HEADPHONES"})
        active = {item["entity"]["sku"]: item for item in checks["stock_matches_active_orders"]["diagnostics"]["items"]}
        mouse = active["MOUSE"]
        self.assertEqual(mouse["observed"] - mouse["expected"], 1)
        self.assertEqual(mouse["expected"], mouse["parts"]["opening"] - mouse["parts"]["active_quantity"])

    def test_a_changed_untouched_order_lists_the_field_with_its_original_and_current_value(self):
        result = self.rehearsal()
        targets = {a["order_id"] for a in result["plan"]["cancellations"]}
        order = next(row for row in result["before"]["orders"] if row["id"] not in targets)
        checks = self.recheck(result, f"UPDATE orders SET customer = 'someone-else' WHERE id = '{order['id']}';")
        for name in ("unaffected_orders_preserved", "order_history_preserved"):
            with self.subTest(check=name):
                explained = checks[name]["diagnostics"]
                self.assertFalse(checks[name]["passed"])
                self.assertEqual(explained["total"], 1)
                self.assertEqual(explained["items"][0], {"entity": {"table": "orders", "id": order["id"], "field": "customer"},
                                                         "expected": order["customer"], "observed": "someone-else"})

    def test_many_exceptions_are_truncated_explicitly_and_long_values_are_bounded(self):
        result = self.rehearsal()
        targets = {a["order_id"] for a in result["plan"]["cancellations"]}
        untouched = [row["id"] for row in result["before"]["orders"] if row["id"] not in targets]
        checks = self.recheck(result, "UPDATE orders SET customer = '" + "x" * 500 + "' WHERE status = 'active';")
        explained = checks["unaffected_orders_preserved"]["diagnostics"]
        self.assertEqual(explained["total"], len(untouched))
        self.assertEqual(len(explained["items"]), MAX_ITEMS)
        self.assertTrue(explained["truncated"])
        observed = explained["items"][0]["observed"]
        self.assertEqual(len(observed), MAX_TEXT)
        self.assertTrue(observed.endswith("…"))

    def test_missing_commit_evidence_lists_each_unmatched_source_event(self):
        incident = create_incident(self.root / "missing", "missing-evidence", 11)
        candidate = self.root / "missing-candidate.db"
        copy_database(incident / "orders.db", candidate)
        checks = by_name(check_state(incident, candidate, snapshot(candidate), set()))
        complete = checks["source_evidence_complete"]
        self.assertFalse(complete["passed"])
        self.assertEqual(complete["diagnostics"]["total"], 20)
        self.assertEqual({item["observed"] for item in complete["diagnostics"]["items"]}, {"none"})
        once = checks["source_events_applied_once"]
        self.assertFalse(once["passed"])
        unmatched = {item["entity"]["event_id"] for item in complete["diagnostics"]["items"]}
        zero = {item["entity"]["event_id"] for item in once["diagnostics"]["items"] if item["observed"] == 0}
        self.assertTrue(unmatched.issubset(zero) or once["diagnostics"]["truncated"])

    def test_input_changes_name_tables_and_files_without_their_contents(self):
        items = input_changes("file", {"a.txt": "digest-a", "b.txt": "digest-b"}, {"a.txt": "digest-a", "b.txt": "other", "c.txt": "new"})
        self.assertEqual([(item["entity"]["file"], item["observed"]) for item in items], [("b.txt", "changed"), ("c.txt", "added")])
        self.assertNotIn("digest", json.dumps(items))
        self.assertNotIn("other", json.dumps(items))

    def test_inputs_changed_during_a_rehearsal_are_named_in_its_failed_checks(self):
        real = repairs.execute_plan

        def tamper(candidate, plan):
            real(candidate, plan)
            with contextlib.closing(sqlite3.connect(self.incident / "orders.db")) as conn:
                conn.execute("UPDATE products SET on_hand = on_hand + 1 WHERE sku = 'MOUSE'")
                conn.commit()
            note = self.incident / "evidence" / "incident_note.txt"
            note.write_text(note.read_text(encoding="utf-8") + "\nLate note.", encoding="utf-8")

        with mock.patch("recovery_room.repairs.execute_plan", tamper):
            checks = by_name(self.rehearsal()["checks"])
        source, evidence = checks["source_snapshot_unchanged"], checks["evidence_snapshot_unchanged"]
        self.assertFalse(source["passed"])
        self.assertEqual([item["entity"] for item in source["diagnostics"]["items"]], [{"table": "products"}])
        self.assertFalse(evidence["passed"])
        self.assertEqual([item["entity"] for item in evidence["diagnostics"]["items"]], [{"file": "incident_note.txt"}])

    def test_the_model_tool_result_keeps_its_existing_check_fields(self):
        result = AgentTools(self.incident, self.root / "agent").call("rehearse_repair", {"plan": self.plan})
        self.assertTrue(result["passed"])
        self.assertTrue(all(set(check) == {"name", "passed", "detail"} for check in result["checks"]))


class PublicDiagnosticsTests(unittest.TestCase):
    VALID = {"rule": "r", "listing": "all", "total": 1, "truncated": False,
             "items": [{"entity": {"sku": "MOUSE"}, "expected": 3, "observed": 4, "difference": 1,
                        "parts": {"opening": 5}, "related": {"order_ids": ["ord_1"]}}]}

    def test_well_formed_diagnostics_are_kept(self):
        self.assertEqual(public_diagnostics(copy.deepcopy(self.VALID)), self.VALID)

    def test_off_shape_diagnostics_are_dropped_not_repaired(self):
        changes = [lambda d: d.update(listing="some"), lambda d: d.update(total=0), lambda d: d.update(truncated=True),
                   lambda d: d.update(extra=1), lambda d: d.update(items=[d["items"][0]] * (MAX_ITEMS + 1), total=MAX_ITEMS + 1),
                   lambda d: d["items"][0]["entity"].update(sku={"nested": 1}),
                   lambda d: d["items"][0].update(expected=[1, 2]), lambda d: d["items"][0].update(difference=True),
                   lambda d: d["items"][0].update(related={"order_ids": [1]}), lambda d: d["items"][0].update(note="x"),
                   lambda d: d.update(items="none")]
        for change in changes:
            value = copy.deepcopy(self.VALID)
            change(value)
            with self.subTest(value=value):
                self.assertIsNone(public_diagnostics(value))
        self.assertIsNone(public_diagnostics(None))

    def test_long_or_control_text_is_rebounded(self):
        value = copy.deepcopy(self.VALID)
        value["items"][0]["observed"] = "a\x00b" + "c" * 400
        kept = public_diagnostics(value)["items"][0]["observed"]
        self.assertEqual(len(kept), MAX_TEXT)
        self.assertNotIn("\x00", kept)


class RecordedDiagnosticsTests(RecordingCase):
    def test_recorded_checks_carry_bounded_diagnostics_and_drop_off_shape_ones(self):
        folder = Path(self.publish(self.fixture())["recording_folder"])
        app = self.app()
        checks = by_name(app.recording(app.list_recordings("import-retry")[0]["id"])["review"]["checks"])
        self.assertEqual(len(checks), 10)
        self.assertTrue(all(public_diagnostics(check["diagnostics"]) == check["diagnostics"] for check in checks.values()))

        path = folder / "recording.json"
        bundle = json.loads(path.read_text())
        recorded = bundle["review"]["checks"]
        recorded[0]["diagnostics"] = {"rule": "r", "listing": "exceptions", "items": [{"entity": {"x": {"y": 1}}}], "total": 1, "truncated": False}
        recorded[1]["diagnostics"]["rule"] = "See C:\\Users\\someone\\private.db"
        recorded[2].pop("diagnostics")
        recorded[3]["unexpected"] = "dropped"
        path.write_text(json.dumps(bundle))
        app = self.app()
        checks = app.recording(app.list_recordings("import-retry")[0]["id"])["review"]["checks"]
        self.assertNotIn("diagnostics", checks[0])
        self.assertNotIn("C:\\Users", checks[1]["diagnostics"]["rule"])
        self.assertNotIn("diagnostics", checks[2])  # an older recording without diagnostics stays without them
        self.assertEqual(set(checks[3]), {"name", "passed", "detail", "diagnostics"})
        self.assertTrue(all(check["passed"] for check in checks))


if __name__ == "__main__":
    unittest.main()
