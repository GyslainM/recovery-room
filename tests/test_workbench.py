from __future__ import annotations

from contextlib import closing
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from recovery_room.db import snapshot
from recovery_room.workbench import MODE, ReviewConflict, Workbench, make_server


class WorkbenchCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Workbench(Path(self.temp.name) / "session")

    def ready(self):
        run = self.app.investigate("import-retry")
        result = self.app.rehearse(run["id"])
        self.assertEqual(result["status"], "ready_for_review", result)
        return result


class WorkbenchTests(WorkbenchCase):
    def test_offline_flow_records_actual_observations_and_preserves_source(self):
        original = snapshot(self.app.incident("import-retry") / "orders.db")
        # Even a configured key cannot turn this offline path into a model run.
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("Network forbidden")):
            run = self.ready()
        self.assertEqual(run["mode"], MODE)
        self.assertEqual(run["review"]["before_active"], 80)
        self.assertEqual(run["review"]["after_active"], 60)
        self.assertEqual(run["review"]["checkout_preserved"], 10)
        self.assertEqual(run["review"]["untargeted_preserved"], 60)
        self.assertEqual(len(run["review"]["checks"]), 10)
        self.assertTrue(all(row["passed"] for row in run["review"]["checks"]))
        self.assertEqual(run["trace"][-1]["result"]["rows"], [{"status": "active", "records": 80}])
        source_pages = [s for s in run["trace"] if s["arguments"].get("name") == "source_orders.json"]
        self.assertGreater(len(source_pages), 1)
        self.assertIsNone(source_pages[-1]["result"]["next_line"])
        self.assertEqual(snapshot(self.app.incident("import-retry") / "orders.db"), original)
        # Repeated action reuses its verified candidate, rather than applying again.
        self.assertEqual(self.app.rehearse(run["id"]), run)
        for name in run["downloads"]:
            self.assertGreater(len(self.app.download(run["id"], name)), 100)

    def test_missing_evidence_stops_with_specific_gap_without_a_candidate(self):
        before = snapshot(self.app.incident("missing-evidence") / "orders.db")
        run = self.app.investigate("missing-evidence")
        self.assertEqual(run["status"], "stopped")
        self.assertIn("20 of 50", run["summary"])
        self.assertEqual(len(run["missing_event_ids"]), 20)
        self.assertIsNone(run["plan"])
        self.assertEqual(run["downloads"], [])
        with self.assertRaises(ReviewConflict):
            self.app.rehearse(run["id"])
        with self.assertRaises(ReviewConflict):
            self.app.download(run["id"], "repair.sql")
        self.assertFalse(list((self.app.root / "investigations").rglob("candidate.db")))
        self.assertEqual(snapshot(self.app.incident("missing-evidence") / "orders.db"), before)

    def test_source_change_blocks_previously_generated_downloads(self):
        run = self.ready()
        with closing(sqlite3.connect(self.app.incident("import-retry") / "orders.db")) as conn:
            conn.execute("UPDATE products SET on_hand = on_hand + 1 WHERE sku = 'MOUSE'")
            conn.commit()
        with self.assertRaisesRegex(ReviewConflict, "source changed"):
            self.app.download(run["id"], "repair.sql")
        self.assertEqual(self.app.run(run["id"])["downloads"], [])
        self.assertEqual(self.app.run(run["id"])["status"], "blocked")

    def test_evidence_change_between_investigation_and_rehearsal_blocks_copy(self):
        run = self.app.investigate("import-retry")
        note = self.app.incident("import-retry") / "evidence" / "incident_note.txt"
        note.write_text(note.read_text(encoding="utf-8") + "\nNew evidence.", encoding="utf-8")
        result = self.app.rehearse(run["id"])
        self.assertEqual(result["status"], "blocked")
        self.assertIn("evidence changed", result["summary"])
        self.assertEqual(result["downloads"], [])
        self.assertNotIn(run["id"], self.app.results)

    def test_evidence_change_after_rehearsal_also_blocks_download(self):
        run = self.ready()
        note = self.app.incident("import-retry") / "evidence" / "incident_note.txt"
        note.write_text(note.read_text(encoding="utf-8") + "\nNew evidence.", encoding="utf-8")
        with self.assertRaisesRegex(ReviewConflict, "evidence changed"):
            self.app.download(run["id"], "report.html")

    def test_changed_candidate_cannot_be_exported_as_verified(self):
        run = self.ready()
        candidate = Path(self.app.results[run["id"]]["candidate_path"])
        with closing(sqlite3.connect(candidate)) as conn:
            conn.execute("UPDATE products SET on_hand = 0")
            conn.commit()
        with self.assertRaisesRegex(ReviewConflict, "candidate changed"):
            self.app.download(run["id"], "plan.json")

    def test_existing_session_is_never_overwritten(self):
        marker = self.app.root / "keep.txt"
        marker.write_text("existing work", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            Workbench(self.app.root)
        self.assertEqual(marker.read_text(), "existing work")


class HTTPTests(WorkbenchCase):
    def setUp(self):
        super().setUp()
        self.server = make_server(self.app, 0)
        self.server.RequestHandlerClass.log_message = lambda *args: None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, method="GET", body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_http_flow_and_real_artifact_download(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"OFFLINE SCRIPT", body)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        status, _, body = self.request("/api/incidents/import-retry/investigate", "POST", "{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 201)
        identifier = json.loads(body)["id"]
        status, _, body = self.request(f"/api/runs/{identifier}/rehearse", "POST", "{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "ready_for_review")
        status, headers, body = self.request(f"/api/runs/{identifier}/artifacts/repair.sql")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertIn(b"BEGIN IMMEDIATE", body)

    def test_browser_api_cannot_select_paths_evaluator_databases_or_sql(self):
        paths = ("/evaluation/ground_truth.json", "/api/incidents/../../evaluation/ground_truth.json",
                 "/api/incidents/C:%5CUsers%5Cmucyo", "/api/incidents/import-retry/artifacts/ground_truth.json",
                 "/api/incidents/import-retry/artifacts/orders.db", "/api/runs/fake/artifacts/candidate.db",
                 "/api/query_database", "/api/execute_sql", "/recovery_room/checks.py")
        for path in paths:
            with self.subTest(path=path):
                self.assertIn(self.request(path)[0], (400, 404))
        original = snapshot(self.app.incident("import-retry") / "orders.db")
        for body in ('{"path":"../evaluation/ground_truth.json"}', '{"plan":{}}', '{"sql":"DELETE FROM orders"}'):
            self.assertEqual(self.request("/api/incidents/import-retry/investigate", "POST", body,
                                          {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(snapshot(self.app.incident("import-retry") / "orders.db"), original)

    def test_cross_origin_host_rebinding_and_invalid_bodies_are_rejected(self):
        path = "/api/incidents/import-retry/investigate"
        for headers in ({"Origin": "https://other.example"}, {"Host": "other.example"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request(path, "POST", "{}", {"Content-Type": "application/json", **headers})[0], 403)
        for body, mime in (("{}", "text/plain"), ("{", "application/json"), ("[]", "application/json"), (" " * 4097, "application/json")):
            self.assertEqual(self.request(path, "POST", body, {"Content-Type": mime})[0], 400)
        self.assertFalse(self.app.runs)

    def test_evidence_is_paginated_and_bounded(self):
        path = "/api/incidents/import-retry/artifacts/events.jsonl"
        status, _, body = self.request(path + "?start_line=2&max_lines=2")
        page = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(page["lines"][0]["ref"], "events.jsonl:L2")
        self.assertEqual(page["next_line"], 4)
        for query in ("?start_line=0", "?max_lines=201", "?path=../secret", "?max_lines=1&max_lines=2"):
            self.assertEqual(self.request(path + query)[0], 400)
