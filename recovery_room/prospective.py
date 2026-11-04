"""CLI-only prospective consistency check; never an agent tool or HTTP endpoint.

This uses the existing investigator, competent script, and private state assessor.
Fresh identifiers in a known generator are not unseen incident families.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from .agent import MetaClient, run_agent
from .db import snapshot
from .evaluation import assess_trial
from .story import _assess_agent, _code_hashes, _inputs, frozen_contract
from .workbench import Workbench


TRIALS = (("inbox-evidence", 211), ("inbox-ambiguous", 223),
          ("inbox-evidence", 227), ("inbox-ambiguous", 229),
          ("inbox-evidence", 233), ("inbox-ambiguous", 239))
CONFIG = {"model": "muse-spark-1.3", "max_rounds": 20, "max_calls": 40,
          "max_completion_tokens": 16384, "prompt_version": "budget-aware-v1"}
GOOD = ("correct_repair", "justified_stop")
SCOPE = ("Prospective consistency on fresh seeds of known synthetic development cases. "
         "The generator, failure family and receipt format are already known. "
         "This is not a blind holdout, production reliability estimate, or proof of AI superiority. "
         "The competent adapted script receives identical inputs and is reported alongside the model.")
PRICING = {"checked_at": "2026-11-04", "source": "https://dev.meta.ai/docs/pricing-rate-limits",
           "usd_per_million": {"input": "1.25", "cached_input": "0.15", "output": "4.25"},
           "estimated_batch_limit_usd": "5.00", "reserve_before_each_request_usd": "0.50",
           "note": "Local estimate and stop rule, not a Meta account spending cap. Billing is authoritative."}


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def proposal_observations(steps):
    """Pair sanitized saved calls with their actual results, not assistant prose."""
    results = {s["call_id"]: s for s in steps if s.get("kind") == "tool_result"}
    proposals = []
    for step in steps:
        if step.get("kind") != "tool_call" or step.get("name") != "rehearse_repair":
            continue
        result = results.get(step["call_id"])
        value = result.get("result") if result else None
        if result is None or result.get("truncated") or not isinstance(value, dict):
            status = "unknown"
        elif result.get("error") or value.get("error"):
            status = "rejected"
        elif value.get("passed") is True:
            status = "passed"
        elif value.get("passed") is False:
            status = "failed_checks"
        else:
            status = "unknown"
        proposals.append({"call_id": step["call_id"], "status": status,
                          "reason": value.get("error") if isinstance(value, dict) else None})
    first = proposals[0]["status"] if proposals else "not_attempted"
    return {"first_proposal": first, "proposals": proposals,
            "later_passed_after_first_rejection": first in ("rejected", "failed_checks")
            and any(p["status"] == "passed" for p in proposals[1:])}


def transcript_observations(path):
    steps = []
    for message in json.loads(path.read_text(encoding="utf-8")):
        for call in message.get("tool_calls", []):
            steps.append({"kind": "tool_call", "call_id": call["id"], "name": call["function"]["name"]})
        if message.get("role") == "tool":
            result = json.loads(message["content"])
            steps.append({"kind": "tool_result", "call_id": message["tool_call_id"], "result": result,
                          "error": isinstance(result, dict) and "error" in result})
    return proposal_observations(steps)


def audit_recordings(data_path, output):
    """Descriptive audit of the entire fixed public library; no causal claim."""
    data = json.loads(data_path.read_text(encoding="utf-8"))
    rows = []
    for route, record in sorted(data["api_get"].items()):
        if route.startswith("/api/recordings/") and isinstance(record, dict) and "steps" in record:
            rows.append({"id": record["id"], "incident_id": record["incident_id"],
                         "outcome": record["outcome"], **proposal_observations(record["steps"])})
    completed = [r for r in rows if r["outcome"] == "repair"]
    report = {"scope": "Retrospective descriptive audit of all published development recordings. "
              "First-proposal validity is not a no-feedback ablation; recovery is not proof of causation.",
              "source_sha256": digest(data_path), "recordings": len(rows),
              "outcomes": dict(Counter(r["outcome"] for r in rows)),
              "completed_repairs": len(completed),
              "completed_repairs_first_proposal_passed": sum(r["first_proposal"] == "passed" for r in completed),
              "completed_repairs_recovered_after_rejection": sum(r["later_passed_after_first_rejection"] for r in completed),
              "runs": rows}
    output.parent.mkdir(parents=True, exist_ok=True)
    save(output, report)
    return {k: v for k, v in report.items() if k != "runs"}


def prepare(root):
    hashes = frozen_contract()
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    trials = []
    for case, seed in TRIALS:
        identifier = f"{case}-{seed}"
        app = Workbench(root / identifier, seed=seed, case_ids=(case,))
        incident = app.incident(case)
        before = snapshot(incident / "orders.db")
        record = app.investigate(case)
        candidate = None
        exported = False
        if record["status"] == "proposed":
            record = app.rehearse(record["id"])
            candidate = Path(app.results[record["id"]]["candidate_path"])
            for name in record["downloads"]:
                app.download(record["id"], name)
            exported = "repair.sql" in record["downloads"]
        assessment = assess_trial(incident.parent, record, before, candidate, exported)
        trials.append({"id": identifier, "incident_id": case, "seed": seed,
                       "incident": incident.relative_to(root).as_posix(), "inputs": _inputs(incident),
                       "truth_sha256": digest(incident.parent / "evaluation" / "ground_truth.json"),
                       "adapted_script": assessment})
        save(root / "offline-progress.json", trials)
        if assessment["judgment"] not in GOOD:
            raise ValueError("Offline script gate failed. No live evaluation is enabled.")
    manifest = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
                "scope": SCOPE, "configuration": CONFIG, "pricing": PRICING,
                "contract": hashes, "code_sha256": _code_hashes(),
                "offline_gate_passed": True, "trials": trials}
    save(root / "prepared.json", manifest)
    return {"mode": "offline_preflight_no_API_calls", "prepared": str(root), "planned_attempts": len(trials),
            "script_judgments": [t["adapted_script"]["judgment"] for t in trials], "scope": SCOPE}


def prepared(root):
    manifest = json.loads((root / "prepared.json").read_text(encoding="utf-8"))
    if (manifest.get("configuration") != CONFIG or manifest.get("pricing") != PRICING
            or manifest.get("contract") != frozen_contract() or manifest.get("code_sha256") != _code_hashes()
            or manifest.get("offline_gate_passed") is not True
            or [(t.get("incident_id"), t.get("seed")) for t in manifest.get("trials", [])] != list(TRIALS)):
        raise ValueError("Locked code, prompt, pricing, or trial configuration changed; no API call was sent.")
    for trial in manifest["trials"]:
        expected = f"{trial['incident_id']}-{trial['seed']}/{trial['incident_id']}/incident"
        incident = root / expected
        if (trial.get("incident") != expected or _inputs(incident) != trial.get("inputs")
                or digest(incident.parent / "evaluation" / "ground_truth.json") != trial.get("truth_sha256")
                or trial.get("adapted_script", {}).get("judgment") not in GOOD):
            raise ValueError("Prepared inputs or evaluator changed; no API call was sent.")
    return manifest


def usage_cost(usage):
    if not isinstance(usage, dict):
        raise ValueError("Missing provider usage; further API calls disabled.")
    prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
    details = usage.get("prompt_tokens_details") or {}
    cached = details.get("cached_tokens", 0) if isinstance(details, dict) else None
    if any(type(v) is not int or v < 0 for v in (prompt, completion, cached)) or cached > prompt:
        raise ValueError("Invalid provider usage; further API calls disabled.")
    rates = PRICING["usd_per_million"]
    return ((prompt - cached) * Decimal(rates["input"]) + cached * Decimal(rates["cached_input"])
            + completion * Decimal(rates["output"])) / 1_000_000


def render_results(report):
    lines = ["# Prospective evaluation: saved results", "", SCOPE, "",
             "| Trial | Script assessment | Model assessment | First proposal | Later passed | Tools | Seconds |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for attempt in report["attempts"]:
        result = attempt["result"]
        feedback = attempt.get("proposal_feedback", {})
        lines.append("| " + " | ".join(str(v) for v in (
            attempt["id"], attempt["adapted_script"]["judgment"],
            attempt.get("assessment", {}).get("judgment", "audit_error"),
            feedback.get("first_proposal", "unknown"),
            feedback.get("later_passed_after_first_rejection", False), result.get("tool_calls", "unknown"),
            result.get("elapsed_seconds", "unknown"))) + " |")
    for identifier in report["unattempted"]:
        lines.append(f"| {identifier} | offline gate passed | unattempted | — | — | — | — |")
    lines.extend(["", f"Batch stopped: {report['batch_stopped']}. All six assessed successfully: {report.get('passed', False)}.",
                  f"Estimated provider cost: ${report.get('estimated_usd', 'unknown')}. Meta billing is authoritative.",
                  "", "A later passing rehearsal is a within-run observation, not a causal feedback ablation.",
                  "The model and script share a known generator. Do not claim AI superiority or production reliability.", ""])
    return "\n".join(lines)


class BudgetedMetaClient(MetaClient):
    """Same transport/prompt/tools; a shared local spending stop rule for this batch."""
    def __init__(self, ledger_path):
        super().__init__(CONFIG["model"], max_completion_tokens=CONFIG["max_completion_tokens"])
        self.ledger_path = ledger_path
        self.spent = Decimal(0)
        self.blocked = None
        self.requests = []

    def complete(self, messages):
        if self.blocked:
            raise ValueError(self.blocked)
        if self.spent + Decimal(PRICING["reserve_before_each_request_usd"]) > Decimal(PRICING["estimated_batch_limit_usd"]):
            raise ValueError("Local estimated batch spending limit reached; no further request was sent.")
        response = super().complete(messages)
        usage = response.get("usage") if isinstance(response, dict) else None
        cost = None
        try:
            cost = usage_cost(usage)
            self.spent += cost
        except ValueError as exc:
            # Return this completed response so run_agent retains it before any next-call refusal.
            self.blocked = str(exc)
        self.requests.append({"usage": usage, "estimated_usd": str(cost) if cost is not None else None})
        save(self.ledger_path, {"pricing": PRICING, "requests": self.requests,
                               "estimated_usd": str(self.spent), "blocked": self.blocked})
        return response


def run(root):
    root = root.resolve()
    manifest = prepared(root)
    if (root / "started.json").exists():
        raise ValueError("This batch already started. Its attempts cannot be rerun automatically.")
    client = BudgetedMetaClient(root / "cost-ledger.json")
    with (root / "started.json").open("x", encoding="utf-8") as stream:
        json.dump({"started_at": datetime.now(timezone.utc).isoformat(),
                   "prepared_sha256": digest(root / "prepared.json")}, stream)
    report = {"mode": "live_meta_agent", "scope": SCOPE, "configuration": CONFIG, "pricing": PRICING,
              "attempts": [], "unattempted": [t["id"] for t in manifest["trials"]], "batch_stopped": False}
    save(root / "batch-result.json", report)
    for trial in manifest["trials"]:
        incident = root / trial["incident"]
        before = snapshot(incident / "orders.db")
        result = run_agent(incident, root / trial["id"] / "live", client,
                           max_rounds=CONFIG["max_rounds"], max_calls=CONFIG["max_calls"])
        attempt = {"id": trial["id"], "incident_id": trial["incident_id"], "seed": trial["seed"],
                   "result": result, "adapted_script": trial["adapted_script"]}
        report["attempts"].append(attempt)
        report["unattempted"].remove(trial["id"])
        save(root / "batch-result.json", report)  # Preserve raw attempt before assessment.
        try:
            if result["mode"] != "live_meta_agent":
                raise ValueError("Actual Meta transport provenance required.")
            attempt["assessment"] = _assess_agent(root, trial, result, before)
            attempt["proposal_feedback"] = transcript_observations(Path(result["session"]) / "transcript.json")
        except (ValueError, OSError, KeyError, TypeError) as exc:
            attempt["audit_error"] = str(exc)
        judgment = attempt.get("assessment", {}).get("judgment", "audit_error")
        report["batch_stopped"] = (result["final"]["outcome"] in ("error", "incomplete")
                                   or not result["inputs_unchanged"] or "audit_error" in attempt
                                   or judgment == "incorrect_export" or bool(client.blocked))
        report["judgments"] = dict(Counter(a.get("assessment", {}).get("judgment", "audit_error") for a in report["attempts"]))
        report["estimated_usd"] = str(client.spent)
        report["usage"] = {key: sum(u[key] for a in report["attempts"] for u in a["result"]["usage"]
                                    if type(u.get(key)) is int and u[key] >= 0)
                           for key in ("prompt_tokens", "completion_tokens", "total_tokens")}
        report["usage_estimate_complete"] = not bool(client.blocked)
        report["passed"] = (not report["unattempted"] and not report["batch_stopped"]
                            and all(a.get("assessment", {}).get("judgment") in GOOD for a in report["attempts"]))
        save(root / "batch-result.json", report)
        (root / "RESULTS.md").write_text(render_results(report), encoding="utf-8")
        print(json.dumps({"trial": trial["id"], "outcome": result["final"]["outcome"], "judgment": judgment,
                          "estimated_batch_usd": report["estimated_usd"], "batch_stopped": report["batch_stopped"]}), flush=True)
        if report["batch_stopped"]:
            break
    return {k: v for k, v in report.items() if k != "attempts"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "run"):
        commands.add_parser(name).add_argument("root", type=Path)
    audit = commands.add_parser("audit")
    audit.add_argument("data", type=Path)
    audit.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "audit":
            result = audit_recordings(args.data, args.output)
        else:
            result = {"prepare": prepare, "run": run}[args.command](args.root)
        print(json.dumps(result, indent=2))
        return 1 if result.get("passed") is False else 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"error": str(exc), "automatic_retry": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
