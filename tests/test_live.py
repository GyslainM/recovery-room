"""Live Muse Spark runs from the local workbench, exercised with a scripted stand-in for the Meta client.

No test here makes a network call: the stand-in subclasses MetaClient only so the run is saved the way a
real live run is, and its model name says it is a test double.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from recovery_room.agent import MetaClient, run_agent
from recovery_room.baselines import event_aware_plan
from recovery_room.workbench import LIVE_LIMITS, ReviewConflict, Workbench, make_server

from test_agent import ScriptedTransport, response
import test_workbench as _tw


class StandInMeta(ScriptedTransport, MetaClient):
    """Scripted responses; never calls MetaClient.__init__, so it needs no key and opens no connection."""


class StoppingMeta(MetaClient):
    model = "deterministic-test-double-NOT-a-model"

    def __init__(self):
        self.max_completion_tokens = LIVE_LIMITS["max_completion_tokens"]

    def complete(self, messages):
        return response({"content": json.dumps({"outcome": "stop", "summary": "Commit records are missing.",
                                                "rehearsal_id": None})})


def wait(app, case, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = app.live_status(case)
        if status["status"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError("The live run did not finish.")


class LiveRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_live_runs_are_off_unless_the_server_opts_in_with_a_key(self):
        with patch.dict(os.environ, {"MODEL_API_KEY": "test-key-not-real"}):
            app = Workbench(Path(self.temp.name) / "off")
            self.assertFalse(app.live_available())
            with self.assertRaisesRegex(ReviewConflict, "--live"):
                app.start_live("import-retry")
        with patch.dict(os.environ, {"MODEL_API_KEY": ""}):
            app = Workbench(Path(self.temp.name) / "no-key", live=True)
            self.assertFalse(app.live_available())
            with self.assertRaisesRegex(ReviewConflict, "MODEL_API_KEY"):
                app.start_live("import-retry")
        self.assertEqual(app.live_status("import-retry")["status"], "idle")

    def test_a_live_repair_streams_steps_and_is_saved_as_a_recording_with_its_review(self):
        with patch.dict(os.environ, {"MODEL_API_KEY": "test-key-not-real"}):
            app = Workbench(Path(self.temp.name) / "on", live=True)
            app.client_factory = lambda: StandInMeta(event_aware_plan(app.incident("import-retry")))
            started = app.start_live("import-retry")
            self.assertEqual(started["status"], "running")
            done = wait(app, "import-retry")
        self.assertEqual(done["status"], "done", done)
        self.assertEqual(done["outcome"], "repair")
        self.assertEqual(done["tool_calls"], 4)
        kinds = [step["kind"] for step in done["steps"]]
        self.assertIn("tool_result", kinds)
        recording = app.recording(done["recording_id"])
        self.assertEqual(recording["outcome"], "repair")
        self.assertTrue(recording["fixture_matches"])
        self.assertTrue(recording["review"]["passed"])
        self.assertEqual(recording["review"]["cancellations"], 20)
        self.assertEqual([r["id"] for r in app.list_recordings("import-retry")], [done["recording_id"]])

    def test_a_live_stop_is_saved_and_a_second_start_waits_for_the_first(self):
        with patch.dict(os.environ, {"MODEL_API_KEY": "test-key-not-real"}):
            app = Workbench(Path(self.temp.name) / "stop", live=True)
            app.client_factory = StoppingMeta
            app.live_runs["missing-evidence"] = {"status": "running"}
            with self.assertRaisesRegex(ReviewConflict, "already in progress"):
                app.start_live("missing-evidence")
            del app.live_runs["missing-evidence"]
            app.start_live("missing-evidence")
            done = wait(app, "missing-evidence")
        self.assertEqual((done["status"], done["outcome"]), ("done", "stop"), done)
        self.assertEqual(app.recording(done["recording_id"])["outcome"], "stop")

    def test_an_observer_failure_never_changes_the_run(self):
        incident = Workbench(Path(self.temp.name) / "observer").incident("import-retry")
        seen = []

        def observer(messages):
            seen.append(len(messages))
            raise RuntimeError("display failed")

        result = run_agent(incident, Path(self.temp.name) / "runs", ScriptedTransport(event_aware_plan(incident)), on_step=observer)
        self.assertEqual(result["final"]["outcome"], "repair")
        self.assertEqual(seen, sorted(seen))
        self.assertGreaterEqual(len(seen), 6)


class LiveHTTPTests(_tw.WorkbenchCase):
    def setUp(self):
        super().setUp()
        self.server = make_server(self.app, 0)
        self.server.RequestHandlerClass.log_message = lambda *args: None
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    stop_server = _tw.HTTPTests.stop_server
    request = _tw.HTTPTests.request

    def test_live_routes_report_availability_and_refuse_when_off(self):
        status, _, body = self.request("/api/incidents")
        self.assertEqual(status, 200)
        self.assertIs(json.loads(body)["live_model"], False)
        status, _, body = self.request("/api/incidents/import-retry/live")
        self.assertEqual((status, json.loads(body)["status"]), (200, "idle"))
        status, _, _ = self.request("/api/incidents/import-retry/live", "POST", "{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 409)
        status, _, _ = self.request("/api/incidents/import-retry/live", "POST", '{"model":"other"}', {"Content-Type": "application/json"})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
