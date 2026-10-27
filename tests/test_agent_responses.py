"""Malformed provider data exercised entirely through offline test transports."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import unittest

from recovery_room.agent import run_agent
from recovery_room.baselines import event_aware_plan
from recovery_room.db import snapshot
from recovery_room.fixtures import create_incident


def completion(message, **extra):
    return {"choices": [{"message": {"role": "assistant", **message},
                         "finish_reason": "tool_calls" if message.get("tool_calls") else "stop"}], **extra}


def function_call(identifier, name="get_schema", arguments="{}"):
    return {"id": identifier, "type": "function", "function": {"name": name, "arguments": arguments}}


def stopped():
    return completion({"content": json.dumps({
        "outcome": "stop", "summary": "Test-only transport outcome; not evidence of justified stopping.",
        "rehearsal_id": None,
    })})


class SequenceTransport:
    model = "offline-malformed-response-test-NOT-a-model"

    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def complete(self, messages):
        self.requests.append(copy.deepcopy(messages))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class AgentResponseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.incident = create_incident(self.root / "case")
        self.original = snapshot(self.incident / "orders.db")

    def run_transport(self, responses):
        client = SequenceTransport(responses)
        result = run_agent(self.incident, self.root / "runs", client)
        self.assertEqual(result["mode"], "test_transport")
        self.assertEqual(snapshot(self.incident / "orders.db"), self.original)
        folder = Path(result["session"])
        self.assertEqual(json.loads((folder / "result.json").read_text()), result)
        self.assertTrue((folder / "transcript.json").is_file())
        self.assertTrue((folder / "responses.json").is_file())
        return result, client

    def assert_recorded_error(self, payload):
        result, _ = self.run_transport([payload])
        self.assertEqual(result["final"]["outcome"], "error")
        self.assertIsNone(result["candidate_path"])
        self.assertIsNone(result["report_path"])
        self.assertEqual(result["tool_calls"], 0)
        folder = Path(result["session"])
        self.assertEqual(json.loads((folder / "responses.json").read_text()), [payload])
        self.assertFalse(list(folder.rglob("candidate.db")))
        self.assertFalse(list(folder.rglob("repair.sql")))
        return result

    def test_malformed_envelopes_are_recorded_without_attribute_errors(self):
        payloads = [None, [], "invalid", 1, {}, {"choices": None}, {"choices": {}},
                    {"choices": []}, {"choices": [None]}, {"choices": ["invalid"]},
                    {"choices": [{}]}, {"choices": [{"message": None}]},
                    {"choices": [{"message": "not an assistant object"}]},
                    {"choices": [{"message": []}]}]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.assert_recorded_error(payload)

    def test_malformed_message_fields_cannot_be_mistaken_for_a_final_answer(self):
        for fields in ({"role": "user", "content": "text"}, {"content": []}, {"content": {}},
                       {"content": 1}, {"tool_calls": {}}, {"tool_calls": ""},
                       {"tool_calls": 0}, {"tool_calls": False}):
            with self.subTest(fields=fields):
                self.assert_recorded_error(completion(fields))

    def test_malformed_usage_is_rejected_before_dispatch(self):
        for usage in ([], "invalid", 4, False):
            with self.subTest(usage=usage):
                self.assert_recorded_error(completion({"tool_calls": [function_call("schema")]}, usage=usage))

    def test_malformed_finish_reason_is_rejected_before_dispatch(self):
        for reason in ([], {}, 4, False):
            with self.subTest(reason=reason):
                payload = completion({"tool_calls": [function_call("schema")]})
                payload["choices"][0]["finish_reason"] = reason
                self.assert_recorded_error(payload)

    def test_invalid_tool_call_shapes_are_recorded_without_dispatch(self):
        malformed = [None, "invalid", 4, {},
                     {**function_call("schema"), "id": []},
                     function_call("x" * 65),
                     {**function_call("schema"), "type": "shell"},
                     {**function_call("schema"), "function": None},
                     {**function_call("schema"), "function": []},
                     function_call("schema", name=[]), function_call("schema", name=""),
                     function_call("schema", arguments={}), function_call("schema", arguments=None)]
        for request in malformed:
            with self.subTest(request=request):
                self.assert_recorded_error(completion({"tool_calls": [request]}))

    def test_batch_validation_precedes_any_rehearsal(self):
        plan = event_aware_plan(self.incident)
        payload = completion({"tool_calls": [
            function_call("repair", "rehearse_repair", json.dumps({"plan": plan})),
            "malformed second request",
        ]})
        self.assert_recorded_error(payload)

    def test_duplicate_call_ids_in_one_batch_are_rejected_before_dispatch(self):
        payload = completion({"tool_calls": [function_call("same"), function_call("same", "list_artifacts")]})
        self.assert_recorded_error(payload)

    def test_duplicate_call_ids_across_rounds_preserve_prior_observations(self):
        first = completion({"tool_calls": [function_call("same")]})
        second = completion({"tool_calls": [function_call("same", "list_artifacts")]})
        result, _ = self.run_transport([first, second])
        self.assertEqual(result["final"]["outcome"], "error")
        self.assertEqual(result["tool_calls"], 1)
        transcript = json.loads((Path(result["session"]) / "transcript.json").read_text())
        observed = [m for m in transcript if m["role"] == "tool"]
        self.assertEqual(len(observed), 1)
        self.assertIn("products", observed[0]["content"])

    def test_invalid_argument_json_returns_a_tool_error_and_loop_can_continue(self):
        request = completion({"tool_calls": [function_call("bad-args", "query_database", '{"sql":')]})
        result, client = self.run_transport([request, stopped()])
        self.assertEqual(result["final"]["outcome"], "stop")
        self.assertEqual(result["tool_calls"], 1)
        feedback = client.requests[1][-1]
        self.assertEqual(feedback["tool_call_id"], "bad-args")
        self.assertIn("error", json.loads(feedback["content"]))

    def test_unknown_function_remains_an_allowlist_error_with_feedback(self):
        request = completion({"tool_calls": [function_call("unknown", "execute_sql", '{"sql":"DELETE FROM orders"}')]})
        result, client = self.run_transport([request, stopped()])
        self.assertEqual(result["final"]["outcome"], "stop")
        self.assertEqual(result["tool_calls"], 1)
        self.assertIn("Unsupported tool", json.loads(client.requests[1][-1]["content"])["error"])

    def test_valid_tool_response_accepts_null_content_and_optional_usage(self):
        request = completion({"content": None, "tool_calls": [function_call("schema")]}, usage=None)
        final = stopped()
        final["choices"][0]["message"]["tool_calls"] = None
        result, _ = self.run_transport([request, final])
        self.assertEqual(result["final"]["outcome"], "stop")
        self.assertEqual(result["tool_calls"], 1)
        self.assertEqual(result["usage"], [{}, {}])

    def test_final_result_requires_the_declared_fields_and_types(self):
        valid = {"outcome": "stop", "summary": "Test outcome", "rehearsal_id": None}
        payloads = [None, [], {}, {"outcome": "stop", "summary": "Missing ID"},
                    {**valid, "confidence": 1}, {**valid, "outcome": []},
                    {**valid, "summary": []}, {**valid, "rehearsal_id": "invented"},
                    {**valid, "outcome": "repair", "rehearsal_id": []}]
        for final in payloads:
            with self.subTest(final=final):
                self.assert_recorded_error(completion({"content": json.dumps(final)}))

    def test_successful_rehearsal_followed_by_malformed_response_cannot_export(self):
        plan = event_aware_plan(self.incident)
        request = completion({"tool_calls": [function_call("repair", "rehearse_repair", json.dumps({"plan": plan}))]})
        result, _ = self.run_transport([request, {"choices": [{"message": "invalid"}]}])
        self.assertEqual(result["final"]["outcome"], "error")
        self.assertEqual(result["tool_calls"], 1)
        self.assertIsNone(result["candidate_path"])
        folder = Path(result["session"])
        self.assertEqual(len(list(folder.rglob("candidate.db"))), 1)
        self.assertFalse(list(folder.rglob("repair.sql")))
        self.assertEqual(len(json.loads((folder / "responses.json").read_text())), 2)

    def test_transport_failure_retains_prior_response_and_tool_trace(self):
        request = completion({"tool_calls": [function_call("schema")]})
        result, _ = self.run_transport([request, ValueError("Test-only transport failure")])
        self.assertEqual(result["final"]["outcome"], "error")
        self.assertIn("Test-only transport failure", result["error"])
        self.assertEqual(result["tool_calls"], 1)
        self.assertEqual(json.loads((Path(result["session"]) / "responses.json").read_text()), [request])
