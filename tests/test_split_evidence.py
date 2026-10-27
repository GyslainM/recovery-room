"""Cross-format development fixtures; no model or external service is used."""
from __future__ import annotations

import copy
import csv
import html
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.agent import AgentTools
from recovery_room.baselines import event_aware_plan
from recovery_room.checks import evaluate_fixture
from recovery_room.db import snapshot
from recovery_room.evaluation import run_benchmark
from recovery_room.fixtures import artifact_names, create_incident, evidence_index, list_artifacts, read_artifact
from recovery_room.repairs import evidence_fingerprint, finalize_report, rehearse
from recovery_room.workbench import CASES, Workbench


class SplitEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.incident = create_incident(self.root / "case", "split-evidence", seed=19)
        self.before = snapshot(self.incident / "orders.db")
        self.csv_path = self.incident / "evidence" / "commit_receipts.csv"
        self.events_path = self.incident / "evidence" / "events.jsonl"

    def events(self):
        return [json.loads(line) for line in self.events_path.read_text(encoding="utf-8").splitlines()]

    def save_events(self, events):
        self.events_path.write_text("".join(json.dumps(row) + "\n" for row in events), encoding="utf-8")

    def mutate_csv(self, edit):
        rows = list(csv.reader(io.StringIO(self.csv_path.read_text(encoding="utf-8"))))
        edit(rows)
        stream = io.StringIO(newline="")
        csv.writer(stream, lineterminator="\n").writerows(rows)
        self.csv_path.write_text(stream.getvalue(), encoding="utf-8")

    def test_format_varies_without_hiding_ids_or_changing_the_incident(self):
        control = create_incident(self.root / "control", "complete", seed=19)
        self.assertEqual(snapshot(control / "orders.db"), self.before)
        self.assertEqual(len(self.before["orders"]), 80)
        self.assertEqual(len(list_artifacts(self.incident)), 5)
        self.assertIn("commit_receipts.csv", artifact_names(self.incident))
        csv_rows = list(csv.DictReader(io.StringIO(self.csv_path.read_text(encoding="utf-8"))))
        self.assertEqual(len(csv_rows), 20)
        self.assertTrue(all(row["event_id"] for row in csv_rows))
        writes = [r for r in self.events() if r["type"] == "write_committed"]
        self.assertEqual(len(writes), 60)
        self.assertFalse(any(r["attempt"] == "import-first" for r in writes))
        sequences = [r["commit_seq"] for r in writes]
        self.assertNotEqual(sequences, sorted(sequences))

    def test_competent_script_joins_both_formats_and_runtime_checks_actual_state(self):
        # Enforce evaluator separation even for the parser-aware script.
        original_read = Path.read_text

        def no_truth(path, *args, **kwargs):
            if "evaluation" in path.parts:
                raise AssertionError("Controller/runtime may not read fixture truth")
            return original_read(path, *args, **kwargs)

        with patch.object(Path, "read_text", no_truth):
            plan = event_aware_plan(self.incident)
            result = rehearse(self.incident, plan, self.root / "rehearsals")
            report = finalize_report(self.incident, result)
        self.assertEqual(len(plan["cancellations"]), 20)
        self.assertTrue(result["passed"], result["checks"])
        self.assertEqual(report["totals"]["after_active"], 60)
        self.assertEqual(len(result["checks"]), 10)
        self.assertTrue(evaluate_fixture(self.incident.parent, Path(result["candidate_path"]), "repair")["passed"])
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)
        page = (Path(result["folder"]) / "report.html").read_text()
        self.assertIn("commit_receipts.csv:L", page)
        self.assertIn("events.jsonl:L", page)
        csv_ref = next(ref for ref in plan["cancellations"][0]["evidence_refs"] if ref.startswith("commit_receipts.csv:"))
        csv_number = int(csv_ref.split(":L")[1])
        self.assertIn(html.escape(self.csv_path.read_text().splitlines()[csv_number - 1]), page)
        for action in plan["cancellations"]:
            self.assertEqual({ref.split(":L")[0] for ref in action["evidence_refs"]},
                             {"commit_receipts.csv", "events.jsonl"})
            for ref in action["evidence_refs"]:
                name, number = ref.split(":L")
                line = read_artifact(self.incident, name, int(number), 1)["lines"][0]
                self.assertTrue(action["order_id"] in line["text"] or action["duplicate_of"] in line["text"])

    def test_commit_sequence_determines_retained_write_not_file_or_line_order(self):
        groups, _ = evidence_index(self.incident)
        repeated = [rows for rows in groups.values() if len(rows) == 2]
        self.assertEqual(len(repeated), 20)
        for rows in repeated:
            self.assertLess(rows[0]["commit_seq"], rows[1]["commit_seq"])
            self.assertTrue(rows[0]["ref"].startswith("commit_receipts.csv:L"))
        expected = event_aware_plan(self.incident)
        lines = self.csv_path.read_text().splitlines()
        self.csv_path.write_text("\n".join([lines[0], *reversed(lines[1:])]) + "\n", encoding="utf-8")
        actual = event_aware_plan(self.incident)
        pairs = lambda plan: {(a["order_id"], a["duplicate_of"]) for a in plan["cancellations"]}
        self.assertEqual(pairs(expected), pairs(actual))
        self.assertTrue(rehearse(self.incident, actual, self.root / "reordered")["passed"])

    def test_missing_wrong_or_invented_csv_citations_never_authorize_cancellation(self):
        base = event_aware_plan(self.incident)
        for ref in ("commit_receipts.csv:L1", "commit_receipts.csv:L999", "ground_truth.json:L1"):
            plan = copy.deepcopy(base)
            plan["cancellations"][0]["evidence_refs"] = [ref, next(
                r for r in plan["cancellations"][0]["evidence_refs"] if r.startswith("events.jsonl:"))]
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                rehearse(self.incident, plan, self.root / "bad-ref")
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)
        self.assertFalse(list((self.root / "bad-ref").rglob("repair.sql")))

    def test_similar_later_purchase_and_reversed_canonical_are_rejected(self):
        base = event_aware_plan(self.incident)
        later = next(row for row in self.before["orders"] if row["source_reference"] == "checkout-000")
        wrong = copy.deepcopy(base)
        wrong["cancellations"][0]["order_id"] = later["id"]
        reversed_plan = copy.deepcopy(base)
        first = reversed_plan["cancellations"][0]
        first["order_id"], first["duplicate_of"] = first["duplicate_of"], first["order_id"]
        for plan in (wrong, reversed_plan):
            with self.assertRaises(ValueError):
                rehearse(self.incident, plan, self.root / "bad-target")
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)

    def test_archive_is_allowlisted_paginated_and_available_to_existing_agent_tools(self):
        tools = AgentTools(self.incident, self.root / "agent-results")
        names = {row["name"] for row in tools.call("list_artifacts", {})}
        self.assertIn("commit_receipts.csv", names)
        page = tools.call("read_artifact", {"name": "commit_receipts.csv", "max_lines": 3})
        self.assertEqual(page["total_lines"], 21)
        self.assertEqual(page["next_line"], 4)
        self.assertEqual(page["lines"][2]["ref"], "commit_receipts.csv:L3")
        for name in ("../evaluation/ground_truth.json", "ground_truth.json", "arbitrary.csv"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                tools.call("read_artifact", {"name": name})
        with self.assertRaises(ValueError):
            read_artifact(self.incident, "commit_receipts.csv", max_lines=201)

    def test_archive_size_and_symlink_boundaries_are_not_relaxed(self):
        original_symlink = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda p: p.name == "commit_receipts.csv" or original_symlink(p)):
            for read in (lambda: read_artifact(self.incident, "commit_receipts.csv"),
                         lambda: evidence_index(self.incident), lambda: evidence_fingerprint(self.incident)):
                with self.assertRaises(ValueError):
                    read()
        self.csv_path.write_bytes(b"x" * 1_000_001)
        with self.assertRaises(ValueError):
            read_artifact(self.incident, "commit_receipts.csv")
        with self.assertRaises(ValueError):
            evidence_index(self.incident)

    def test_csv_edit_or_removal_invalidates_a_successful_rehearsal(self):
        result = rehearse(self.incident, event_aware_plan(self.incident), self.root / "freshness")
        original = self.csv_path.read_bytes()
        for contents in (original + b"\n", None):
            if contents is None:
                self.csv_path.unlink()
            else:
                self.csv_path.write_bytes(contents)
            with self.assertRaisesRegex(ValueError, "evidence changed"):
                finalize_report(self.incident, result)
            self.csv_path.write_bytes(original)
        self.assertFalse((Path(result["folder"]) / "repair.sql").exists())

    def test_adding_the_optional_archive_also_invalidates_an_older_rehearsal(self):
        control = create_incident(self.root / "plain", "complete", seed=19)
        result = rehearse(control, event_aware_plan(control), self.root / "plain-result")
        (control / "evidence" / "commit_receipts.csv").write_bytes(self.csv_path.read_bytes())
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            finalize_report(control, result)
        self.assertFalse((Path(result["folder"]) / "repair.sql").exists())

    def test_conflicting_or_malformed_receipts_are_rejected_without_fallback(self):
        original_csv = self.csv_path.read_bytes()
        original_events = self.events_path.read_bytes()
        csv_edits = {
            "header": lambda rows: rows[0].__setitem__(5, "sequence"),
            "missing-row": lambda rows: rows.pop(),
            "duplicate-sequence": lambda rows: rows[1].__setitem__(5, rows[2][5]),
            "zero-sequence": lambda rows: rows[1].__setitem__(5, "0"),
            "text-sequence": lambda rows: rows[1].__setitem__(5, "unknown"),
            "duplicate-order": lambda rows: rows[1].__setitem__(3, rows[2][3]),
            "duplicate-movement": lambda rows: rows[1].__setitem__(4, rows[2][4]),
            "not-a-commit": lambda rows: rows[1].__setitem__(0, "request_sent"),
            "multiline": lambda rows: rows[1].__setitem__(1, "first\nsecond"),
        }
        for label, edit in csv_edits.items():
            self.csv_path.write_bytes(original_csv)
            self.mutate_csv(edit)
            with self.subTest(label=label), self.assertRaises(ValueError):
                evidence_index(self.incident)
        self.csv_path.write_bytes(original_csv)
        for label in ("manifest-path", "manifest-count", "two-manifests", "no-manifest", "bool-sequence", "bad-id"):
            self.events_path.write_bytes(original_events)
            events = self.events()
            write = next(row for row in events if row["type"] == "write_committed")
            if label == "manifest-path": events[0]["name"] = "../evaluation/ground_truth.json"
            if label == "manifest-count": events[0]["count"] += 1
            if label == "two-manifests": events.append(dict(events[0]))
            if label == "no-manifest": events.pop(0)
            if label == "bool-sequence": write["commit_seq"] = True
            if label == "bad-id": write["order_id"] = {"path": "../evaluation"}
            self.save_events(events)
            with self.subTest(label=label), self.assertRaises(ValueError):
                evidence_index(self.incident)
        self.events_path.write_bytes(original_events)
        self.csv_path.unlink()
        with self.assertRaisesRegex(ValueError, "archive"):
            evidence_index(self.incident)
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)

    def test_default_workbench_stays_at_three_cases_and_opt_in_trace_reads_csv(self):
        default = Workbench(self.root / "default")
        self.assertEqual([row["id"] for row in default.cases()], list(CASES))
        with self.assertRaises(KeyError):
            default.incident("split-evidence")
        app = Workbench(self.root / "opt-in", case_ids=("split-evidence",))
        run = app.investigate("split-evidence")
        reads = [step["arguments"]["name"] for step in run["trace"] if step["tool"] == "read_artifact"]
        self.assertIn("commit_receipts.csv", reads)
        self.assertNotIn("ground_truth.json", reads)
        reviewed = app.rehearse(run["id"])
        self.assertEqual(reviewed["status"], "ready_for_review")
        csv_path = app.incident("split-evidence") / "evidence" / "commit_receipts.csv"
        csv_path.write_bytes(csv_path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            app.download(run["id"], "repair.sql")
        self.assertEqual(app.run(run["id"])["status"], "blocked")

    def test_comparison_keeps_competent_parser_baseline_and_reports_hypothetical_similarity_risk(self):
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("External network forbidden")):
            report = run_benchmark(self.root / "compare", [7, 23], ["complete", "split-evidence"])
        self.assertEqual(report["trials_total"], 4)
        self.assertEqual(report["scenario_variants"], 2)
        self.assertEqual(report["incident_families"], 1)
        self.assertEqual(report["live_model_runs"], 0)
        self.assertEqual(report["judgments"]["correct_repair"], 4)
        for trial in report["trials"]:
            self.assertEqual(trial["later_orders_preserved"], 10)
            self.assertTrue(trial["source_unchanged"])
            self.assertEqual(trial["proposed_cancellations"], 20)
            self.assertEqual(trial["similarity_baseline"]["candidates"], 30)
            self.assertEqual(trial["similarity_baseline"]["later_purchases_at_risk"], 10)
            self.assertFalse(trial["similarity_baseline"]["rehearsed"])
            self.assertFalse(trial["similarity_baseline"]["exported"])
        page = Path(report["html_report"]).read_text()
        self.assertIn("Meta has not been measured", page)
        self.assertIn("competent event-aware script also parses", page)

    def test_bad_split_evidence_is_recorded_and_next_trial_still_runs(self):
        investigate = Workbench.investigate

        def corrupt_archive(app, identifier):
            if identifier == "split-evidence":
                (app.incident(identifier) / "evidence" / "commit_receipts.csv").write_text("wrong,header\n")
            return investigate(app, identifier)

        with patch.object(Workbench, "investigate", corrupt_archive):
            report = run_benchmark(self.root / "failure", [7], ["split-evidence", "complete"])
        self.assertEqual(report["judgments"]["technical_error"], 1)
        self.assertEqual(report["judgments"]["correct_repair"], 1)
        self.assertFalse(report["passed"])
        failure = report["trials"][0]
        self.assertTrue(failure["source_unchanged"])
        self.assertFalse(failure["exported_for_review"])
        self.assertIn("CSV header", failure["error"])
        self.assertTrue((self.root / "failure" / "trials" / "split-evidence-seed-7.json").is_file())

    def test_unknown_or_duplicate_scenario_selection_is_rejected_before_creating_output(self):
        for scenarios in ([], ["unknown"], ["split-evidence", "split-evidence"], "split-evidence", [True]):
            with self.subTest(scenarios=scenarios), self.assertRaises(ValueError):
                run_benchmark(self.root / "invalid", [7], scenarios)
            self.assertFalse((self.root / "invalid").exists())
        for ids in ((), ("../evaluation",), ("split-evidence", "split-evidence"), "split-evidence"):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                Workbench(self.root / "invalid-catalog", case_ids=ids)
            self.assertFalse((self.root / "invalid-catalog").exists())
