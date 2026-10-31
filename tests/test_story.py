"""No API calls: test the offline gate, refusal paths, and actual state assessment."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.agent import AgentTools, run_agent
from recovery_room.baselines import event_aware_plan
from recovery_room.db import snapshot
from recovery_room.story import CONFIG, TRIALS, _assess_agent, _observed_stop, _prepared, frozen_contract, prepare_story, run_story
from tests.test_recordings import FileFixtureTransport


class StoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "batch"

    def test_preflight_records_all_controls_and_actual_expected_states(self):
        report = prepare_story(self.root)
        self.assertEqual(report["adapted_parser"], ["correct_repair", "correct_repair", "justified_stop"])
        self.assertEqual(report["frozen_parser"], ["unsupported_format"] * 3)
        manifest = _prepared(self.root)
        self.assertEqual(len(manifest["trials"]), 3)
        self.assertEqual(manifest["configuration"], CONFIG)
        self.assertEqual(manifest["contract"], frozen_contract())
        for trial in manifest["trials"]:
            self.assertTrue(trial["adapted_parser"]["source_unchanged"])
            self.assertEqual(trial["adapted_parser"]["later_orders_harmed"], [])
        self.assertFalse((self.root / "started.json").exists())

    def test_changed_inputs_code_or_prompt_prevent_even_client_construction(self):
        prepare_story(self.root)
        with patch("recovery_room.story.MetaClient", side_effect=AssertionError("No transport allowed")):
            with patch("recovery_room.story.INSTRUCTIONS", "changed"):
                with self.assertRaisesRegex(ValueError, "frozen"):
                    run_story(self.root)
            with patch("recovery_room.story._code_hashes", return_value={}):
                with self.assertRaisesRegex(ValueError, "locked code"):
                    run_story(self.root)
            manifest = _prepared(self.root)
            note = self.root / manifest["trials"][0]["incident"] / "evidence" / "incident_note.txt"
            note.write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "inputs changed"):
                run_story(self.root)
        self.assertFalse((self.root / "started.json").exists())

    def test_already_started_batch_cannot_run_again(self):
        prepare_story(self.root)
        (self.root / "started.json").write_text("{}")
        with patch("recovery_room.story.MetaClient", side_effect=AssertionError("No transport allowed")):
            with self.assertRaisesRegex(ValueError, "already started"):
                run_story(self.root)

    def test_non_provider_attempt_is_retained_and_stops_batch_without_retry(self):
        prepare_story(self.root)
        # Explicit synthetic fixture, not a claimed Meta evaluation.
        fake = {"mode": "test_transport", "final": {"outcome": "incomplete", "summary": "TEST FIXTURE", "rehearsal_id": None},
                "inputs_unchanged": True, "session": "TEST FIXTURE", "usage": [{"total_tokens": 8}], "candidate_path": None}
        with patch("recovery_room.story.MetaClient"), patch("recovery_room.story.run_agent", return_value=fake) as run:
            report = run_story(self.root)
        self.assertEqual(run.call_count, 1)
        self.assertTrue(report["batch_stopped"])
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["unattempted"]), 2)
        saved = json.loads((self.root / "batch-result.json").read_text())
        self.assertEqual(saved["attempts"][0]["result"], fake)
        self.assertIn("actual Meta transport", saved["attempts"][0]["audit_error"])

    def test_agent_assessment_uses_candidate_truth_not_repair_prose(self):
        prepare_story(self.root)
        trial = _prepared(self.root)["trials"][0]
        incident = self.root / trial["incident"]
        before = snapshot(incident / "orders.db")
        client = FileFixtureTransport(event_aware_plan(incident), "repair", reject_first=True)
        result = run_agent(incident, self.root / "fixture-only", client)
        self.assertEqual(result["mode"], "test_transport")
        assessment = _assess_agent(self.root, trial, result, before)
        self.assertEqual(assessment["judgment"], "correct_repair")
        self.assertEqual(assessment["later_orders_preserved"], 10)

    def test_stop_needs_actual_gap_specific_summary_and_complete_reads(self):
        prepare_story(self.root)
        trial = _prepared(self.root)["trials"][2]
        incident = self.root / trial["incident"]
        session = self.root / "stop-fixture-only"
        session.mkdir()
        transcript = []
        tools = AgentTools(incident, session)
        for i, name in enumerate(("source_orders.json", "events.jsonl", "inbox_receipts.txt")):
            line = 1
            while line is not None:
                call_id = f"{i}-{line}"
                page = tools.call("read_artifact", {"name": name, "start_line": line, "max_lines": 200})
                transcript.extend([{"role": "assistant", "tool_calls": [{"id": call_id, "function": {"name": "read_artifact"}}]},
                                   {"role": "tool", "tool_call_id": call_id, "content": json.dumps(page)}])
                line = page["next_line"]
        (session / "transcript.json").write_text(json.dumps(transcript), encoding="utf-8")
        observed = _observed_stop(incident, session, "Missing evidence")
        self.assertFalse(observed["supported"])
        self.assertTrue(observed["complete_relevant_reads"])
        self.assertEqual(len(observed["missing"]), 1)
        summary = "Missing committed-write evidence for " + observed["missing"][0]
        self.assertTrue(_observed_stop(incident, session, summary)["supported"])
        (session / "transcript.json").write_text("[]")
        self.assertFalse(_observed_stop(incident, session, summary)["supported"])
