from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from recovery_room.agent import AgentTools, MetaClient, run_agent
from recovery_room.baselines import event_aware_plan
from recovery_room.db import snapshot
from recovery_room.fixtures import create_incident


def response(message):
    return {"choices": [{"message": {"role": "assistant", **message}, "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}]}


def call(identifier, name, arguments):
    return {"id": identifier, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


class ScriptedTransport:
    model = "deterministic-test-double-NOT-a-model"

    def __init__(self, plan):
        self.plan = plan
        self.requests = []

    def complete(self, messages):
        self.requests.append(copy.deepcopy(messages))
        step = len(self.requests)
        if step == 1:
            return response({"content": None, "tool_calls": [
                call("schema", "get_schema", {}),
                call("evidence", "read_artifact", {"name": "events.jsonl", "max_lines": 200}),
                call("query", "query_database", {"sql": "SELECT COUNT(*) AS n FROM orders"}),
            ]})
        if step == 2:
            self.assert_tool_pairs(messages)
            return response({"content": None, "tool_calls": [call("repair", "rehearse_repair", {"plan": self.plan})]})
        observed = json.loads(messages[-1]["content"])
        return response({"content": json.dumps({
            "outcome": "repair", "summary": "Deterministic transport exercising the actual tool boundary.",
            "rehearsal_id": observed["rehearsal_id"],
        })})

    def assert_tool_pairs(self, messages):
        actual = {m["tool_call_id"] for m in messages if m["role"] == "tool"}
        if not {"schema", "evidence", "query"}.issubset(actual):
            raise AssertionError("A tool call was not paired with a result.")
        query_result = next(m for m in messages if m.get("tool_call_id") == "query")
        if json.loads(query_result["content"]).get("rows") != [{"n": 80}]:
            raise AssertionError("The read-only count query did not return the observed state.")


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.incident = create_incident(self.root / "case")

    def test_full_tool_loop_uses_actual_checks_and_labels_test_transport(self):
        original = snapshot(self.incident / "orders.db")
        client = ScriptedTransport(event_aware_plan(self.incident))
        result = run_agent(self.incident, self.root / "runs", client)
        self.assertEqual(result["mode"], "test_transport")
        self.assertEqual(result["final"]["outcome"], "repair", result)
        self.assertEqual(result["tool_calls"], 4)
        self.assertTrue(Path(result["report_path"]).exists())
        self.assertEqual(snapshot(self.incident / "orders.db"), original)
        self.assertEqual(client.requests[0][0]["role"], "developer")

    def test_model_claim_cannot_substitute_for_a_successful_rehearsal(self):
        class FalseClaim:
            def complete(self, messages):
                return response({"content": json.dumps({
                    "outcome": "repair", "summary": "Trust me.", "rehearsal_id": "invented",
                })})
        result = run_agent(self.incident, self.root / "runs", FalseClaim())
        self.assertEqual(result["final"]["outcome"], "error")
        self.assertIsNone(result["candidate_path"])
        self.assertFalse(list((self.root / "runs").rglob("repair.sql")))

    def test_stop_never_exports_a_repair(self):
        class Stop:
            def complete(self, messages):
                return response({"content": json.dumps({
                    "outcome": "stop", "summary": "The required commit records are missing.", "rehearsal_id": None,
                })})
        unknown = create_incident(self.root / "unknown", "missing-evidence")
        result = run_agent(unknown, self.root / "runs", Stop())
        self.assertEqual(result["final"]["outcome"], "stop")
        self.assertIsNone(result["candidate_path"])
        self.assertFalse(list((self.root / "runs").rglob("repair.sql")))

    def test_function_budget_is_enforced_locally(self):
        client = ScriptedTransport(event_aware_plan(self.incident))
        result = run_agent(self.incident, self.root / "runs", client, max_calls=1)
        self.assertEqual(result["final"]["outcome"], "error")
        self.assertEqual(result["tool_calls"], 0)

    def test_tool_dispatch_has_no_generic_write_or_file_access(self):
        tools = AgentTools(self.incident, self.root / "runs")
        for name, args in (
            ("execute_sql", {"sql": "DELETE FROM orders"}),
            ("read_file", {"path": "../evaluation/ground_truth.json"}),
            ("__getattribute__", {"name": "incident"}),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                tools.call(name, args)

    def test_meta_client_requires_key_before_any_network_activity(self):
        with patch.dict(os.environ, {"MODEL_API_KEY": ""}):
            with self.assertRaisesRegex(ValueError, "Set MODEL_API_KEY"):
                MetaClient()

    def test_http_request_matches_documented_chat_tool_protocol_without_a_real_call(self):
        captured = {}

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, count):
                return json.dumps(response({"content": '{"outcome":"stop","summary":"test","rehearsal_id":null}'})).encode()

        class Opener:
            def open(self, request, timeout):
                captured["url"] = request.full_url
                captured["body"] = json.loads(request.data)
                return Response()

        with patch.dict(os.environ, {"MODEL_API_KEY": "local-test-placeholder"}):
            client = MetaClient("muse-spark-1.3")
            client.opener = Opener()
            client.complete([{"role": "user", "content": "test"}])
        self.assertEqual(captured["url"], "https://api.meta.ai/v1/chat/completions")
        self.assertFalse(captured["body"]["parallel_tool_calls"])
        self.assertEqual(captured["body"]["max_completion_tokens"], 4096)
        self.assertIn("function", captured["body"]["tools"][0])
        self.assertNotIn("local-test-placeholder", json.dumps(captured["body"]))
