"""Public export uses synthetic file fixtures, never live model traffic."""
import json
from unittest.mock import patch

from recovery_room.demo import export_demo
from tests.test_recordings import RecordingCase


class DemoTests(RecordingCase):
    def test_inert_dataset_keeps_all_outcomes_and_real_steps(self):
        self.publish(self.fixture(reject_first=True))
        self.publish(self.fixture(outcome="error"))
        self.publish(self.fixture(outcome="stop", scenario="missing-evidence"), case="missing-evidence")
        output = self.root / "export"
        with patch("recovery_room.agent.MetaClient.complete", side_effect=AssertionError("No API calls")), \
                patch("recovery_room.agent.AgentTools.call", side_effect=AssertionError("No replayed tools")):
            manifest = export_demo(output, self.library)
        self.assertEqual(manifest["recordings"], 3)
        self.assertEqual(manifest["outcomes"], {"repair": 1, "stop": 1, "error": 1, "incomplete": 0})
        self.assertEqual([p.name for p in (output / "public").iterdir()], ["demo-data.json"])
        raw = (output / "public" / "demo-data.json").read_text(encoding="utf-8")
        self.assertNotIn(str(self.root).replace("\\", "\\\\"), raw)
        self.assertNotIn("candidate_path", raw)
        self.assertNotIn("responses_path", raw)
        self.assertNotIn("Authorization: Bearer", raw)
        data = json.loads(raw)
        self.assertTrue(data["read_only"])
        self.assertFalse(any(data["capabilities"].values()))
        self.assertEqual(data["evaluation"]["recording_count"], 3)
        default = data["api_get"]["/api/recordings/" + data["defaults"]["recording_id"]]
        self.assertTrue(default["fixture_matches"])
        self.assertTrue(any(step.get("error") is True for step in default["steps"]))
        for path, response in data["api_get"].items():
            self.assertNotIn("/rehearse", path)
            self.assertNotIn("/investigate", path)
            self.assertNotIn("/artifacts/", path)
            if path.startswith("/api/runs/run-"):
                self.assertTrue(response["read_only"])
                self.assertEqual(response["downloads"], [])
        events = data["artifacts"]["import-retry"]["source_orders.json"]
        self.assertGreater(events["total_lines"], 200)
        self.assertEqual(len(events["lines"]), events["total_lines"])
        self.assertEqual(events["lines"][-1]["ref"], f"source_orders.json:L{events['total_lines']}")
        stops = data["api_get"]["/api/runs?incident=missing-evidence"]["runs"]
        self.assertEqual(stops[0]["status"], "stopped")

    def test_mismatched_or_missing_repair_cannot_be_default(self):
        self.publish(self.fixture(outcome="stop", scenario="missing-evidence"), case="missing-evidence")
        with self.assertRaisesRegex(ValueError, "No recorded repair"):
            export_demo(self.root / "no-matched-repair", self.library)

    def test_mismatched_recording_remains_visible_but_cannot_link_citations(self):
        self.publish(self.fixture(reject_first=True))
        incident, session, _, _ = self.fixture(scenario="split-evidence")
        # Operator-assigned wrong case creates a valid file-format fixture whose inputs mismatch.
        from recovery_room.recordings import export_recording
        export_recording(incident, session, "import-retry", self.library)
        export_demo(self.root / "mismatch", self.library)
        data = json.loads((self.root / "mismatch/public/demo-data.json").read_text(encoding="utf-8"))
        rows = data["api_get"]["/api/incidents/import-retry/recordings"]
        self.assertEqual(len(rows), 2)
        bad = next(row for row in rows if not row["fixture_matches"])
        detail = data["api_get"]["/api/recordings/" + bad["id"]]
        self.assertFalse(detail["citations_enabled"])
        self.assertTrue(detail["fixture_warning"])
        self.assertNotEqual(data["defaults"]["recording_id"], bad["id"])
