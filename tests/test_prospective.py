"""Evaluation gates and measurement tests. No model/API calls."""
import json
from decimal import Decimal
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.agent import MetaClient, run_agent
from recovery_room.baselines import event_aware_plan
from recovery_room.db import snapshot
from recovery_room.prospective import (
    BudgetedMetaClient, CONFIG, TRIALS, audit_recordings, prepare, prepared,
    proposal_observations, run, transcript_observations, usage_cost,
)
from recovery_room.story import _assess_agent
from tests.test_recordings import FileFixtureTransport


class ProspectiveTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "batch"

    def test_fixed_six_attempts_and_identical_input_script_gate(self):
        with patch.object(MetaClient, "complete", side_effect=AssertionError("No API allowed")):
            report = prepare(self.root)
        self.assertEqual(report["script_judgments"], ["correct_repair", "justified_stop"] * 3)
        manifest = prepared(self.root)
        self.assertEqual([(t["incident_id"], t["seed"]) for t in manifest["trials"]], list(TRIALS))
        self.assertEqual(manifest["configuration"], CONFIG)
        self.assertTrue(all(t["adapted_script"]["source_unchanged"] for t in manifest["trials"]))
        self.assertFalse((self.root / "started.json").exists())
        with self.assertRaises(FileExistsError):
            prepare(self.root)

    def test_changed_input_truth_code_or_manifest_blocks_client_construction(self):
        prepare(self.root)
        manifest = prepared(self.root)
        path = self.root / "prepared.json"
        original = path.read_text(encoding="utf-8")
        for field in ("configuration", "pricing", "code_sha256", "contract"):
            modified = json.loads(original)
            modified[field] = {}
            path.write_text(json.dumps(modified), encoding="utf-8")
            with patch("recovery_room.prospective.BudgetedMetaClient", side_effect=AssertionError("No client")):
                with self.assertRaisesRegex(ValueError, "Locked"):
                    run(self.root)
        path.write_text(original, encoding="utf-8")
        incident = self.root / manifest["trials"][0]["incident"]
        truth = incident.parent / "evaluation" / "ground_truth.json"
        truth.write_text("{}", encoding="utf-8")
        with patch("recovery_room.prospective.BudgetedMetaClient", side_effect=AssertionError("No client")):
            with self.assertRaisesRegex(ValueError, "evaluator changed"):
                run(self.root)
        self.assertFalse((self.root / "started.json").exists())

    def test_started_batch_and_technical_failure_never_retry(self):
        prepare(self.root)
        fake = {"mode": "test_transport", "final": {"outcome": "incomplete"},
                "inputs_unchanged": True, "session": "TEST FIXTURE", "usage": [], "candidate_path": None}
        with patch("recovery_room.prospective.BudgetedMetaClient") as client, \
                patch("recovery_room.prospective.run_agent", return_value=fake) as execute:
            client.return_value.spent = Decimal(0)
            report = run(self.root)
        self.assertEqual(execute.call_count, 1)
        self.assertTrue(report["batch_stopped"])
        self.assertEqual(len(report["unattempted"]), 5)
        saved = json.loads((self.root / "batch-result.json").read_text())
        self.assertEqual(saved["attempts"][0]["result"], fake)
        self.assertIn("Actual Meta transport", saved["attempts"][0]["audit_error"])
        with patch("recovery_room.prospective.BudgetedMetaClient", side_effect=AssertionError("No client")):
            with self.assertRaisesRegex(ValueError, "already started"):
                run(self.root)

    def test_measurement_uses_actual_rejection_and_actual_candidate_truth(self):
        prepare(self.root)
        trial = prepared(self.root)["trials"][0]
        incident = self.root / trial["incident"]
        before = snapshot(incident / "orders.db")
        result = run_agent(incident, self.root / "test-only", FileFixtureTransport(
            event_aware_plan(incident), "repair", reject_first=True))
        observed = transcript_observations(Path(result["session"]) / "transcript.json")
        self.assertEqual(observed["first_proposal"], "rejected")
        self.assertTrue(observed["later_passed_after_first_rejection"])
        assessment = _assess_agent(self.root, trial, result, before)
        self.assertEqual(assessment["judgment"], "correct_repair")
        self.assertEqual(assessment["later_orders_preserved"], 10)
        self.assertTrue(assessment["source_unchanged"])
        self.assertEqual(result["mode"], "test_transport")

    def test_pairing_does_not_turn_prose_missing_or_truncated_results_into_passes(self):
        steps = [{"kind": "assistant", "text": "All checks passed"},
                 {"kind": "tool_call", "call_id": "a", "name": "rehearse_repair"},
                 {"kind": "tool_result", "call_id": "b", "result": {"passed": True}},
                 {"kind": "tool_call", "call_id": "c", "name": "rehearse_repair"},
                 {"kind": "tool_result", "call_id": "c", "truncated": True, "result": {"passed": True}}]
        observed = proposal_observations(steps)
        self.assertEqual([p["status"] for p in observed["proposals"]], ["unknown", "unknown"])
        self.assertFalse(observed["later_passed_after_first_rejection"])

    def test_retrospective_audit_keeps_stops_errors_and_incomplete_runs(self):
        data = Path(__file__).resolve().parents[1] / "examples" / "public-demo" / "demo-data.json"
        report = audit_recordings(data, self.root / "audit.json")
        self.assertEqual(report["recordings"], 16)
        self.assertEqual(report["outcomes"], {"repair": 9, "stop": 4, "error": 2, "incomplete": 1})
        self.assertEqual(report["completed_repairs_first_proposal_passed"], 3)
        self.assertEqual(report["completed_repairs_recovered_after_rejection"], 6)
        self.assertEqual(len(json.loads((self.root / "audit.json").read_text())["runs"]), 16)

    def test_usage_cost_includes_reasoning_once_and_applies_cache_discount(self):
        usage = {"prompt_tokens": 1000, "completion_tokens": 200,
                 "prompt_tokens_details": {"cached_tokens": 400},
                 "completion_tokens_details": {"reasoning_tokens": 150}}
        self.assertEqual(usage_cost(usage), Decimal("0.001660"))
        for bad in ({}, {**usage, "prompt_tokens": True}, {**usage, "completion_tokens": -1},
                    {**usage, "prompt_tokens_details": {"cached_tokens": 1001}}):
            with self.assertRaises(ValueError):
                usage_cost(bad)

    def test_budget_stops_before_transport_and_retains_response_with_unknown_usage(self):
        self.root.mkdir()
        with patch.dict("os.environ", {"MODEL_API_KEY": "UNIT-TEST-NOT-A-KEY"}):
            client = BudgetedMetaClient(self.root / "ledger.json")
        client.spent = Decimal("4.51")
        with patch.object(MetaClient, "complete", side_effect=AssertionError("No API")):
            with self.assertRaisesRegex(ValueError, "spending limit"):
                client.complete([])
        client.spent = Decimal(0)
        response = {"choices": [], "usage": {}}
        with patch.object(MetaClient, "complete", return_value=response) as transport:
            self.assertIs(client.complete([]), response)
            with self.assertRaisesRegex(ValueError, "usage"):
                client.complete([])
        self.assertEqual(transport.call_count, 1)
        ledger = json.loads((self.root / "ledger.json").read_text())
        self.assertIsNone(ledger["requests"][0]["estimated_usd"])
        self.assertNotIn("UNIT-TEST-NOT-A-KEY", (self.root / "ledger.json").read_text())

    def test_cached_costs_accumulate_across_attempts_and_ledger_has_no_messages(self):
        self.root.mkdir()
        with patch.dict("os.environ", {"MODEL_API_KEY": "UNIT-TEST-NOT-A-KEY"}):
            client = BudgetedMetaClient(self.root / "ledger.json")
        response = {"usage": {"prompt_tokens": 1000, "completion_tokens": 200,
                              "prompt_tokens_details": {"cached_tokens": 400}}}
        with patch.object(MetaClient, "complete", return_value=response):
            client.complete([{"content": "PRIVATE MESSAGE"}])
            client.complete([{"content": "SECOND ATTEMPT"}])
        self.assertEqual(client.spent, Decimal("0.003320"))
        text = (self.root / "ledger.json").read_text()
        self.assertEqual(len(json.loads(text)["requests"]), 2)
        self.assertNotIn("PRIVATE MESSAGE", text)

    def test_six_completed_attempts_keep_an_assessed_failure_and_never_claim_success(self):
        prepare(self.root)
        # Orchestration fixture only. This never creates or publishes a live recording.
        fake = {"mode": "live_meta_agent", "final": {"outcome": "stop"}, "inputs_unchanged": True,
                "session": "TEST FIXTURE", "usage": [], "candidate_path": None}
        judgments = ["correct_repair", "justified_stop", "correct_repair", "unjustified_stop",
                     "correct_repair", "justified_stop"]
        with patch("recovery_room.prospective.BudgetedMetaClient") as client, \
                patch("recovery_room.prospective.run_agent", return_value=fake) as execute, \
                patch("recovery_room.prospective._assess_agent", side_effect=[{"judgment": j} for j in judgments]), \
                patch("recovery_room.prospective.transcript_observations", return_value={}):
            client.return_value.spent, client.return_value.blocked = Decimal(0), None
            report = run(self.root)
        self.assertEqual(execute.call_count, 6)
        self.assertEqual(report["unattempted"], [])
        self.assertFalse(report["passed"])
        self.assertEqual(report["judgments"]["unjustified_stop"], 1)
        saved = json.loads((self.root / "batch-result.json").read_text())
        self.assertEqual(len(saved["attempts"]), 6)
        self.assertIn("unjustified_stop", (self.root / "RESULTS.md").read_text())
