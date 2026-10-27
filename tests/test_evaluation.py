from __future__ import annotations

import copy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.baselines import event_aware_plan
from recovery_room.checks import evaluate_fixture
from recovery_room.db import copy_database, snapshot
from recovery_room.evaluation import assess_trial, render_report, run_benchmark
from recovery_room.fixtures import create_incident, evidence_index
from recovery_room.repairs import export_sql, normalize_plan, rehearse
from recovery_room.workbench import MODE, Workbench


class EvaluationCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)


class MultipleRetryTests(EvaluationCase):
    def test_three_writes_keep_first_and_compensate_twice_at_existing_limit(self):
        incident = create_incident(self.root / "case", "multiple-retries", seed=19)
        original = snapshot(incident / "orders.db")
        self.assertEqual(len(original["orders"]), 100)
        groups, _ = evidence_index(incident)
        repeated = [group for group in groups.values() if len(group) > 1]
        self.assertEqual(len(repeated), 20)
        self.assertTrue(all(len(group) == 3 for group in repeated))
        plan = event_aware_plan(incident)
        self.assertEqual(len(plan["cancellations"]), 40)
        for group in repeated:
            pair = [a for a in plan["cancellations"] if a["duplicate_of"] == group[0]["order_id"]]
            self.assertEqual({a["order_id"] for a in pair}, {r["order_id"] for r in group[1:]})
        result = rehearse(incident, plan, self.root / "rehearsals")
        self.assertTrue(result["passed"], result["checks"])
        self.assertEqual(len(result["checks"]), 10)
        self.assertEqual(sum(r["status"] == "active" for r in result["after"]["orders"]), 60)
        self.assertEqual(sum(r["reason"] == "repair_compensation" for r in result["after"]["inventory_movements"]), 40)
        self.assertTrue(evaluate_fixture(incident.parent, Path(result["candidate_path"]), "repair")["passed"])
        target = self.root / "export.db"
        copy_database(incident / "orders.db", target)
        with closing(sqlite3.connect(target)) as conn:
            conn.executescript(export_sql(result))
            conn.executescript(export_sql(result))
        self.assertEqual(snapshot(target), result["after"])
        self.assertEqual(snapshot(incident / "orders.db"), original)
        beyond_limit = copy.deepcopy(plan)
        beyond_limit["cancellations"].append(copy.deepcopy(plan["cancellations"][0]))
        with self.assertRaisesRegex(ValueError, "1 to 40"):
            normalize_plan(beyond_limit)

    def test_workbench_investigation_does_not_read_fixture_answers(self):
        app = Workbench(self.root / "session")
        original_read = Path.read_text

        def read_without_truth(path, *args, **kwargs):
            if path.name == "ground_truth.json":
                raise AssertionError("Fixture answers leaked into the controller.")
            return original_read(path, *args, **kwargs)

        with patch.object(Path, "read_text", read_without_truth):
            overview = app.overview("multiple-retries")
            run = app.investigate("multiple-retries")
            reviewed = app.rehearse(run["id"])
        self.assertEqual(overview["active_orders"], 100)
        self.assertEqual(reviewed["review"]["after_active"], 60)
        self.assertEqual(reviewed["review"]["cancellations"], 40)
        self.assertEqual(reviewed["review"]["checkout_preserved"], 10)
        self.assertEqual(run["mode"], MODE)


class ScoringTests(EvaluationCase):
    def setUp(self):
        super().setUp()
        self.app = Workbench(self.root / "session")

    def score(self, identifier, run, candidate=None, exported=False):
        incident = self.app.incident(identifier)
        return assess_trial(incident.parent, run, snapshot(incident / "orders.db"), candidate, exported)

    def test_stop_label_alone_or_wrong_gap_is_not_rewarded(self):
        run = self.app.investigate("missing-evidence")
        self.assertEqual(self.score("missing-evidence", run)["judgment"], "justified_stop")
        for changes in ({"stop_reason": None}, {"missing_event_ids": []},
                        {"missing_event_ids": ["invented-event"]}, {"plan": {"cancellations": []}}):
            bad = {**run, **changes}
            with self.subTest(changes=changes):
                self.assertEqual(self.score("missing-evidence", bad)["judgment"], "unjustified_stop")
        run = self.app.investigate("import-retry")
        run.update(status="stopped", plan=None, stop_reason="missing_commit_mappings")
        self.assertEqual(self.score("import-retry", run)["judgment"], "unjustified_stop")

    def test_wrong_candidate_and_claimed_pass_are_scored_from_actual_state(self):
        run = self.app.investigate("import-retry")
        run = self.app.rehearse(run["id"])
        candidate = Path(self.app.results[run["id"]]["candidate_path"])
        self.assertEqual(self.score("import-retry", run, candidate, True)["judgment"], "correct_repair")
        later = next(r for r in run["review"]["preserved_orders"] if r["source_reference"] == "checkout-000")
        with closing(sqlite3.connect(candidate)) as conn:
            conn.execute("UPDATE orders SET status='cancelled' WHERE id=?", (later["id"],))
            conn.commit()
        result = self.score("import-retry", run, candidate, True)
        self.assertEqual(result["judgment"], "incorrect_export")
        self.assertEqual(result["later_orders_harmed"], [later["id"]])
        self.assertEqual(result["later_orders_preserved"], 9)
        self.assertFalse(result["fixture_evaluation"]["passed"])

    def test_state_checks_are_recomputed_instead_of_trusting_old_passes(self):
        run = self.app.investigate("import-retry")
        run = self.app.rehearse(run["id"])
        candidate = Path(self.app.results[run["id"]]["candidate_path"])
        with closing(sqlite3.connect(candidate)) as conn:
            conn.execute("DELETE FROM inventory_movements WHERE reason='repair_compensation'")
            conn.commit()
        result = self.score("import-retry", run, candidate, True)
        self.assertTrue(result["fixture_evaluation"]["passed"])
        self.assertTrue(all(c["passed"] for c in run["review"]["checks"]))
        self.assertEqual(result["judgment"], "incorrect_export")
        self.assertFalse(all(c["passed"] for c in result["candidate_checks_at_evaluation"]))

    def test_rejected_proposal_is_distinct_from_incorrect_export(self):
        run = self.app.investigate("import-retry")
        run.update(status="failed_checks", summary="Actual rehearsal was rejected.")
        result = self.score("import-retry", run)
        self.assertEqual(result["judgment"], "rejected_repair")
        self.assertFalse(result["exported_for_review"])

    def test_changed_source_prevents_a_correct_repair_judgment(self):
        incident = self.app.incident("import-retry")
        before = snapshot(incident / "orders.db")
        run = self.app.investigate("import-retry")
        run = self.app.rehearse(run["id"])
        candidate = Path(self.app.results[run["id"]]["candidate_path"])
        with closing(sqlite3.connect(incident / "orders.db")) as conn:
            conn.execute("UPDATE products SET on_hand=on_hand+1 WHERE sku='MOUSE'")
            conn.commit()
        result = assess_trial(incident.parent, run, before, candidate, True)
        self.assertEqual(result["judgment"], "incorrect_export")
        self.assertFalse(result["source_unchanged"])


class BenchmarkTests(EvaluationCase):
    def test_suite_records_denominator_scopes_and_real_offline_outcomes(self):
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("External network forbidden")):
            report = run_benchmark(self.root / "bench", [7, 23])
        self.assertEqual(report["trials_total"], 6)
        self.assertEqual(report["scenario_variants"], 3)
        self.assertEqual(report["incident_families"], 1)
        self.assertEqual(report["live_model_runs"], 0)
        self.assertEqual(report["judgments"]["correct_repair"], 4)
        self.assertEqual(report["judgments"]["justified_stop"], 2)
        self.assertTrue(report["passed"])
        self.assertTrue(all(t["source_unchanged"] for t in report["trials"]))
        self.assertTrue(all(t["later_orders_preserved"] == 10 for t in report["trials"]))
        disk = json.loads(Path(report["json_report"]).read_text(encoding="utf-8"))
        self.assertEqual(disk, report)
        for trial in report["trials"]:
            self.assertTrue((self.root / "bench" / trial["investigation_path"]).is_file())
            self.assertTrue((self.root / "bench" / "trials" / (trial["id"] + ".json")).is_file())
        self.assertIn("Meta has not been measured", Path(report["html_report"]).read_text())

    def test_failure_is_retained_and_remaining_cases_still_run(self):
        investigate = Workbench.investigate

        def fail_one(app, identifier):
            if identifier == "import-retry":
                raise ValueError("Test-induced investigation failure")
            return investigate(app, identifier)

        with patch.object(Workbench, "investigate", fail_one):
            report = run_benchmark(self.root / "failure", [7])
        self.assertFalse(report["passed"])
        self.assertEqual(report["judgments"]["technical_error"], 1)
        self.assertEqual(report["judgments"]["correct_repair"], 1)
        self.assertEqual(report["judgments"]["justified_stop"], 1)
        self.assertEqual(report["trials_total"], 3)
        self.assertIn("Test-induced", report["trials"][0]["error"])
        self.assertTrue((self.root / "failure" / "trials" / "complete-seed-7.json").is_file())

    def test_benchmark_refuses_duplicate_seeds_and_preserves_existing_output(self):
        for seeds in ([], [7, 7], [True], [-1], [2**32], list(range(11))):
            with self.subTest(seeds=seeds), self.assertRaises(ValueError):
                run_benchmark(self.root / "invalid", seeds)
        target = self.root / "keep"
        target.mkdir()
        marker = target / "existing.txt"
        marker.write_text("keep this", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            run_benchmark(target, [7])
        self.assertEqual(marker.read_text(), "keep this")

    def test_report_escapes_observed_text_and_error_details(self):
        report = run_benchmark(self.root / "escape", [7])
        report["trials"][0]["summary"] = '<script>alert("untrusted")</script>'
        page = render_report(report)
        self.assertNotIn('<script>alert(', page)
        self.assertIn('&lt;script&gt;', page)
