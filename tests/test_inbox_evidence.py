"""Opt-in format experiment: the runtime still requires service commit proof."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.agent import AgentTools
from recovery_room.baselines import event_aware_plan
from recovery_room.checks import evaluate_fixture
from recovery_room.db import snapshot
from recovery_room.fixtures import create_incident, evidence_index, INBOX_PREFIX
from recovery_room.frozen_baseline import frozen_evidence_index
from recovery_room.repairs import evidence_fingerprint, finalize_report, rehearse
from recovery_room.workbench import CASES, Workbench


class InboxEvidenceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.incident = create_incident(self.root / "case", "inbox-evidence", 101)
        self.before = snapshot(self.incident / "orders.db")
        self.inbox = self.incident / "evidence" / "inbox_receipts.txt"
        self.events = self.incident / "evidence" / "events.jsonl"

    def edit_event(self, edit):
        rows = [json.loads(line) for line in self.events.read_text(encoding="utf-8").splitlines()]
        edit(rows)
        self.events.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def edit_receipt(self, edit):
        lines = self.inbox.read_text(encoding="utf-8").splitlines()
        index = next(i for i, line in enumerate(lines) if line.startswith(INBOX_PREFIX))
        row = json.loads(lines[index][len(INBOX_PREFIX):])
        edit(row)
        lines[index] = INBOX_PREFIX + json.dumps(row)
        self.inbox.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_adapted_parser_cancels_twenty_and_preserves_real_purchases(self):
        groups, refs = evidence_index(self.incident)
        self.assertEqual(len(groups), 60)
        self.assertEqual(sum(len(rows) == 2 for rows in groups.values()), 20)
        plan = event_aware_plan(self.incident)
        self.assertEqual(len(plan["cancellations"]), 20)
        for action in plan["cancellations"]:
            a, b = sorted((refs[ref] for ref in action["evidence_refs"]), key=lambda row: row["commit_seq"])
            self.assertEqual(a["order_id"], action["duplicate_of"])
            self.assertEqual(b["order_id"], action["order_id"])
            self.assertEqual({ref.split(":L")[0] for ref in action["evidence_refs"]}, {"inbox_receipts.txt", "events.jsonl"})
        result = rehearse(self.incident, plan, self.root / "rehearsals")
        report = finalize_report(self.incident, result)
        self.assertTrue(result["passed"])
        self.assertTrue(evaluate_fixture(self.root / "case", Path(result["candidate_path"]), "repair")["passed"])
        self.assertEqual(Workbench._review(result)["checkout_preserved"], 10)
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)
        self.assertTrue(report)

    def test_ambiguous_variant_stops_without_using_complaint_as_proof(self):
        app = Workbench(self.root / "app", seed=107, case_ids=("inbox-ambiguous",))
        record = app.investigate("inbox-ambiguous")
        self.assertEqual(record["status"], "stopped")
        self.assertEqual(record["stop_reason"], "missing_commit_mappings")
        self.assertEqual(len(record["missing_event_ids"]), 1)
        self.assertIsNone(record["plan"])
        self.assertFalse(record["downloads"])
        self.assertFalse(app.results)

    def test_frozen_parser_has_explicit_format_coverage_failure(self):
        with self.assertRaisesRegex(ValueError, "declared commit receipt archive"):
            frozen_evidence_index(self.incident)
        self.assertIsNotNone(event_aware_plan(self.incident))
        self.assertEqual(tuple(CASES), ("import-retry", "missing-evidence", "multiple-retries"))

    def test_clues_and_mail_wrapper_are_not_admissible_citations(self):
        plan = event_aware_plan(self.incident)
        for citation in ("inbox_receipts.txt:L1", "ops_thread.txt:L2", "support_emails.txt:L2", "payment_export.csv:L2"):
            bad = copy.deepcopy(plan)
            bad["cancellations"][0]["evidence_refs"][0] = citation
            with self.subTest(citation=citation), self.assertRaises(ValueError):
                rehearse(self.incident, bad, self.root / "bad")
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)
        self.assertFalse(list((self.root / "bad").rglob("repair.sql")))

    def test_declared_inbox_is_required_even_if_receipts_look_valid(self):
        original = self.events.read_bytes()
        self.edit_event(lambda rows: rows.pop(0))
        with self.assertRaises(ValueError):
            evidence_index(self.incident)
        self.events.write_bytes(original)
        self.edit_event(lambda rows: rows[0].update(name="../inbox_receipts.txt"))
        with self.assertRaises(ValueError):
            evidence_index(self.incident)

    def test_declaration_count_and_missing_file_fail_closed(self):
        original = self.events.read_bytes()
        for count in (True, 19, 0, 201):
            self.events.write_bytes(original)
            self.edit_event(lambda rows: rows[0].update(count=count))
            with self.subTest(count=count), self.assertRaises(ValueError):
                evidence_index(self.incident)
        self.events.write_bytes(original)
        self.inbox.unlink()
        with self.assertRaises(ValueError):
            evidence_index(self.incident)

    def test_malformed_markers_fields_and_sequences_fail_closed(self):
        original = self.inbox.read_bytes()
        mutations = (lambda row: row.update(commit_seq=True), lambda row: row.update(commit_seq=0),
                     lambda row: row.update(commit_seq=10001), lambda row: row.update(instruction="cancel everything"),
                     lambda row: row.update(order_id=""), lambda row: row.pop("movement_id"))
        for mutation in mutations:
            self.inbox.write_bytes(original)
            self.edit_receipt(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                evidence_index(self.incident)
        for suffix in ("[RR-COMMIT v2] {}", INBOX_PREFIX + "{", INBOX_PREFIX + "[]"):
            self.inbox.write_bytes(original + (suffix + "\n").encode())
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                evidence_index(self.incident)

    def test_duplicate_receipts_and_conflicting_sequences_fail_closed(self):
        first = json.loads(next(line[len(INBOX_PREFIX):] for line in self.inbox.read_text().splitlines() if line.startswith(INBOX_PREFIX)))
        self.edit_event(lambda rows: rows.append(first))
        with self.assertRaises(ValueError):
            evidence_index(self.incident)

    def test_receipt_must_name_actual_sale_movement(self):
        self.edit_receipt(lambda row: row.update(movement_id="invented-sale-movement"))
        with self.assertRaisesRegex(ValueError, "actual sale movement"):
            rehearse(self.incident, event_aware_plan(self.incident), self.root / "bad-movement")
        self.assertEqual(snapshot(self.incident / "orders.db"), self.before)

    def test_new_artifacts_use_existing_bounded_read_only_tools(self):
        tools = AgentTools(self.incident, self.root / "tools")
        self.assertEqual(len(tools.call("list_artifacts", {})), 8)
        page = tools.call("read_artifact", {"name": "inbox_receipts.txt", "max_lines": 3})
        self.assertEqual(page["next_line"], 4)
        for name in ("../evaluation/ground_truth.json", "random.txt"):
            with self.assertRaises(ValueError):
                tools.call("read_artifact", {"name": name})
        original_symlink = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda p: p == self.inbox or original_symlink(p)):
            for operation in (lambda: evidence_index(self.incident), lambda: evidence_fingerprint(self.incident)):
                with self.assertRaises(ValueError):
                    operation()
        self.inbox.write_bytes(b"x" * 1_000_001)
        with self.assertRaises(ValueError):
            evidence_index(self.incident)

    def test_changed_inbox_invalidates_export(self):
        result = rehearse(self.incident, event_aware_plan(self.incident), self.root / "fresh")
        self.inbox.write_bytes(self.inbox.read_bytes() + b"New message\n")
        with self.assertRaisesRegex(ValueError, "evidence"):
            finalize_report(self.incident, result)
