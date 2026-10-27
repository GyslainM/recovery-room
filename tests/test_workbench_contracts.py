"""Approved A/B contracts, checked against real engine results and HTTP routes."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import http.client
import json
from pathlib import Path
import threading
from unittest.mock import patch

from recovery_room.db import snapshot
from recovery_room.workbench import MODE, ReviewConflict, Workbench, make_server
from tests import test_workbench as existing


SUMMARY_FIELDS = {"id", "incident_id", "status", "summary", "mode", "created_at"}


class WorkbenchContractTests(existing.WorkbenchCase):
    def test_created_at_is_utc_server_time_and_is_persisted(self):
        before = datetime.now(timezone.utc)
        run = self.app.investigate("import-retry")
        after = datetime.now(timezone.utc)
        created = datetime.fromisoformat(run["created_at"])
        self.assertEqual(created.utcoffset(), timedelta(0))
        self.assertLessEqual(before, created)
        self.assertLessEqual(created, after)
        stored = self.app.root / "investigations" / run["id"] / "investigation.json"
        self.assertEqual(json.loads(stored.read_text())["created_at"], run["created_at"])

    def test_checkout_ids_match_fixture_purchases_in_both_repair_cases(self):
        for identifier in ("import-retry", "multiple-retries"):
            with self.subTest(identifier=identifier):
                incident = self.app.incident(identifier)
                source = snapshot(incident / "orders.db")
                truth = json.loads((incident.parent / "evaluation" / "ground_truth.json").read_text())
                run = self.app.investigate(identifier)
                reviewed = self.app.rehearse(run["id"])
                ids = reviewed["review"]["checkout_order_ids"]
                self.assertEqual(set(ids), set(truth["legitimate_later_order_ids"]))
                self.assertEqual(len(ids), reviewed["review"]["checkout_total"])
                self.assertEqual(len(ids), len(set(ids)))
                self.assertEqual(self.app.run(run["id"])["review"]["checkout_order_ids"], ids)
                self.assertEqual(snapshot(incident / "orders.db"), source)

    def test_checkout_metadata_survives_failed_checks_and_stop_has_no_review(self):
        incident = self.app.incident("multiple-retries")
        stock_file = incident / "evidence" / "opening_stock.json"
        stock = json.loads(stock_file.read_text())
        stock["MOUSE"] += 1
        stock_file.write_text(json.dumps(stock), encoding="utf-8")
        run = self.app.investigate("multiple-retries")
        reviewed = self.app.rehearse(run["id"])
        self.assertEqual(reviewed["status"], "failed_checks")
        self.assertEqual(len(reviewed["review"]["checkout_order_ids"]), 10)
        self.assertEqual(reviewed["downloads"], [])
        stopped = self.app.investigate("missing-evidence")
        self.assertIsNone(stopped["review"])
        self.assertIn("created_at", stopped)

    def test_list_is_newest_first_by_timestamp_with_newest_insertion_for_ties(self):
        instant = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
        with patch("recovery_room.workbench.datetime") as clock:
            clock.now.return_value = instant
            oldest = self.app.investigate("import-retry")
            clock.now.return_value = instant + timedelta(seconds=2)
            newer = self.app.investigate("import-retry")
            clock.now.return_value = instant + timedelta(seconds=1)
            middle = self.app.investigate("import-retry")
            clock.now.return_value = instant + timedelta(seconds=2)
            newest_tie = self.app.investigate("import-retry")
        summaries = self.app.list_runs("import-retry")
        self.assertEqual([r["id"] for r in summaries],
                         [newest_tie["id"], newer["id"], middle["id"], oldest["id"]])

    def test_list_projects_only_approved_fields_and_returns_independent_objects(self):
        run = self.app.investigate("import-retry")
        self.app.investigate("missing-evidence")
        summaries = self.app.list_runs("import-retry")
        self.assertEqual(len(summaries), 1)
        self.assertEqual(set(summaries[0]), SUMMARY_FIELDS)
        self.assertEqual(summaries[0]["mode"], MODE)
        self.assertNotIn(str(self.app.root), json.dumps(summaries))
        self.assertNotIn("rehearsed_at", summaries[0])
        summaries[0]["summary"] = "client mutation"
        self.assertNotEqual(self.app.run(run["id"])["summary"], "client mutation")

    def test_existing_valid_case_has_empty_list_and_unknown_case_is_rejected(self):
        self.assertEqual(self.app.list_runs("import-retry"), [])
        for identifier in ("unknown", "../evaluation", str(self.app.root)):
            with self.subTest(identifier=identifier), self.assertRaises(KeyError):
                self.app.list_runs(identifier)

    def test_creation_time_and_sort_position_do_not_change_on_rehearsal(self):
        first = self.app.investigate("import-retry")
        second = self.app.investigate("import-retry")
        reviewed = self.app.rehearse(first["id"])
        self.assertEqual(reviewed["created_at"], first["created_at"])
        listed = self.app.list_runs("import-retry")
        self.assertEqual([r["id"] for r in listed], [second["id"], first["id"]])
        self.assertEqual(listed[1]["status"], "ready_for_review")
        self.assertEqual(self.app.rehearse(first["id"])["created_at"], first["created_at"])

    def test_existing_session_cap_still_applies_to_listed_runs(self):
        for _ in range(64):
            self.app.investigate("missing-evidence")
        self.assertEqual(len(self.app.list_runs("missing-evidence")), 64)
        with self.assertRaises(ReviewConflict):
            self.app.investigate("import-retry")
        self.assertEqual(self.app.list_runs("import-retry"), [])


class ContractHTTPTests(existing.WorkbenchCase):
    def setUp(self):
        super().setUp()
        self.server = self.start_server(self.app)

    def start_server(self, app):
        server = make_server(app, 0)
        server.RequestHandlerClass.log_message = lambda *args: None
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.close_server, server, thread)
        return server

    @staticmethod
    def close_server(server, thread):
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)

    def request(self, path, method="GET", body=None, server=None):
        server = server or self.server
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            conn.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_http_rehearse_and_get_run_include_checkout_ids(self):
        status, proposed = self.request("/api/incidents/import-retry/investigate", "POST", "{}")
        self.assertEqual(status, 201)
        self.assertIn("created_at", proposed)
        self.assertIsNone(proposed["review"])
        status, reviewed = self.request(f"/api/runs/{proposed['id']}/rehearse", "POST", "{}")
        self.assertEqual(status, 200)
        self.assertEqual(len(reviewed["review"]["checkout_order_ids"]), 10)
        status, fetched = self.request(f"/api/runs/{proposed['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(fetched["review"], reviewed["review"])
        self.assertEqual(fetched["created_at"], proposed["created_at"])
        self.assertNotIn(str(self.app.root), json.dumps(fetched))

    def test_list_contract_and_scope_can_restore_server_held_runs_in_a_new_client(self):
        first = self.app.investigate("import-retry")
        second = self.app.investigate("import-retry")
        self.app.investigate("missing-evidence")
        status, listed = self.request("/api/runs?incident=import-retry")
        self.assertEqual(status, 200)
        self.assertEqual(set(listed), {"runs"})
        self.assertEqual([r["id"] for r in listed["runs"]], [second["id"], first["id"]])
        self.assertTrue(all(set(r) == SUMMARY_FIELDS for r in listed["runs"]))
        status, fetched = self.request(f"/api/runs/{listed['runs'][0]['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(fetched["id"], second["id"])
        self.assertEqual(self.request("/api/runs?incident=multiple-retries"), (200, {"runs": []}))

    def test_list_requires_one_known_incident_and_rejects_other_query_arguments(self):
        invalid = ("/api/runs", "/api/runs?incident=", "/api/runs?incident", "/api/runs?path=x",
                   "/api/runs?incident=import-retry&incident=missing-evidence",
                   "/api/runs?incident=import-retry&limit=1", "/api/runs?incident=import-retry&fields=trace",
                   "/api/runs?incident=import-retry&incident=")
        for path in invalid:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 400)
        for path in ("/api/runs?incident=unknown", "/api/runs?incident=..%2Fevaluation%2Fground_truth.json"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)
        status, error = self.request("/api/incidents/import-retry/investigate", "POST", '{"created_at":"2050-01-01"}')
        self.assertEqual(status, 400)
        self.assertFalse(self.app.runs)

    def test_list_reflects_rehearsal_and_blocked_status_without_changing_created_at(self):
        proposed = self.app.investigate("import-retry")
        self.app.rehearse(proposed["id"])
        status, listed = self.request("/api/runs?incident=import-retry")
        self.assertEqual(status, 200)
        self.assertEqual(listed["runs"][0]["status"], "ready_for_review")
        note = self.app.incident("import-retry") / "evidence" / "incident_note.txt"
        note.write_text(note.read_text() + "\nAdditional evidence.", encoding="utf-8")
        status, error = self.request(f"/api/runs/{proposed['id']}/artifacts/repair.sql")
        self.assertEqual(status, 409)
        status, listed = self.request("/api/runs?incident=import-retry")
        self.assertEqual(listed["runs"][0]["status"], "blocked")
        self.assertEqual(listed["runs"][0]["created_at"], proposed["created_at"])
        self.assertEqual(listed["runs"][0]["summary"], error["error"])

    def test_run_list_does_not_scan_saved_runs_from_a_previous_server_session(self):
        old_run = self.app.investigate("import-retry")
        self.assertTrue((self.app.root / "investigations" / old_run["id"] / "investigation.json").exists())
        new_app = Workbench(Path(self.temp.name) / "next-session")
        new_server = self.start_server(new_app)
        self.assertEqual(self.request("/api/runs?incident=import-retry", server=new_server), (200, {"runs": []}))
        self.assertEqual(self.request(f"/api/runs/{old_run['id']}", server=new_server)[0], 404)

    def test_native_file_failure_cannot_leak_server_paths_through_summary_or_detail(self):
        proposed = self.app.investigate("import-retry")
        self.app.rehearse(proposed["id"])
        (self.app.incident("import-retry") / "evidence" / "events.jsonl").unlink()
        status, error = self.request(f"/api/runs/{proposed['id']}/artifacts/repair.sql")
        self.assertEqual(status, 409)
        status, detail = self.request(f"/api/runs/{proposed['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(detail["status"], "blocked")
        status, listed = self.request("/api/runs?incident=import-retry")
        self.assertEqual(status, 200)
        for value in (error, detail, listed):
            serialized = json.dumps(value)
            self.assertNotIn(str(self.app.root).replace("\\", "\\\\"), serialized)
            self.assertNotIn(self.app.root.as_posix(), serialized)
            self.assertNotIn("WinError", serialized)
