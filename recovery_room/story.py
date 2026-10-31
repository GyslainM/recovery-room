"""CLI-only, predeclared format experiment. Never registered as an agent tool."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from .agent import INSTRUCTIONS, TOOLS, PROMPT_VERSION, MetaClient, run_agent
from .db import fingerprint, snapshot
from .evaluation import assess_trial
from .fixtures import evidence_index
from .frozen_baseline import frozen_evidence_index
from .recordings import export_recording
from .repairs import evidence_fingerprint
from .workbench import Workbench


TRIALS = (("inbox-evidence", 101), ("inbox-evidence", 103), ("inbox-ambiguous", 107))
CONFIG = {"model": "muse-spark-1.3", "max_rounds": 20, "max_calls": 40,
          "max_completion_tokens": 16384, "prompt_version": "budget-aware-v1"}
PROMPT_HASH = "662ae310a5d387228df40cb9a6f451f41992cbe47941383586c65c21a2d3e650"
TOOLS_HASH = "7646c01db964cc2a5cb32aad17be6d12aa644ea48d8d84682d6458513a468ce2"
SCOPE = ("Authored synthetic receipt-inbox format experiments, not blind holdouts. "
         "The adapted deterministic parser can solve the supported case. "
         "A frozen parser's unsupported-format stop is not proof of AI necessity.")


def _save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def frozen_contract():
    actual_prompt = hashlib.sha256(INSTRUCTIONS.encode()).hexdigest()
    actual_tools = hashlib.sha256(json.dumps(TOOLS, sort_keys=True).encode()).hexdigest()
    if (PROMPT_VERSION != CONFIG["prompt_version"] or actual_prompt != PROMPT_HASH or actual_tools != TOOLS_HASH):
        raise ValueError("The frozen model prompt or tools changed; do not run this experiment under the old contract.")
    return {"prompt_sha256": actual_prompt, "tools_sha256": actual_tools}


def _code_hashes():
    package = Path(__file__).parent
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(package.glob("*.py"))}


def _inputs(incident):
    return {"source": fingerprint(snapshot(incident / "orders.db")), "evidence": evidence_fingerprint(incident)}


def prepare_story(root: Path) -> dict:
    """Offline gate first. The separate run command needs a key and cannot retry."""
    hashes = frozen_contract()
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    trials = []
    for case, seed in TRIALS:
        identifier = f"{case}-{seed}"
        app = Workbench(root / identifier, seed=seed, case_ids=(case,))
        incident = app.incident(case)
        before = snapshot(incident / "orders.db")
        try:
            groups, _ = frozen_evidence_index(incident)
            coverage = {"outcome": "parsed", "groups": len(groups)}
        except ValueError as exc:
            coverage = {"outcome": "unsupported_format", "reason": str(exc), "repair_attempted": False}
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
        trial = {"id": identifier, "incident_id": case, "seed": seed,
                 "incident": incident.relative_to(root).as_posix(), "inputs": _inputs(incident),
                 "frozen_parser": coverage, "adapted_parser": assessment}
        trials.append(trial)
        _save(root / "offline-progress.json", trials)
        if assessment["judgment"] not in ("correct_repair", "justified_stop"):
            raise ValueError("Offline adapted-parser gate failed; live evaluation is disabled.")
    manifest = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
                "scope": SCOPE, "configuration": CONFIG, "contract": hashes,
                "code_sha256": _code_hashes(), "offline_gate_passed": True, "trials": trials}
    _save(root / "prepared.json", manifest)
    return {"passed": True, "mode": "offline_preflight_no_API_calls", "planned_attempts": len(TRIALS),
            "scope": SCOPE, "prepared": str(root),
            "adapted_parser": [t["adapted_parser"]["judgment"] for t in trials],
            "frozen_parser": [t["frozen_parser"]["outcome"] for t in trials]}


def _prepared(root):
    manifest = json.loads((root / "prepared.json").read_text(encoding="utf-8"))
    if (manifest.get("configuration") != CONFIG or manifest.get("contract") != frozen_contract()
            or manifest.get("code_sha256") != _code_hashes() or manifest.get("offline_gate_passed") is not True
            or [(t.get("incident_id"), t.get("seed")) for t in manifest.get("trials", [])] != list(TRIALS)):
        raise ValueError("Prepared experiment no longer matches the locked code/configuration. Prepare a fresh batch.")
    for trial in manifest["trials"]:
        expected = f"{trial['incident_id']}-{trial['seed']}/{trial['incident_id']}/incident"
        if trial.get("incident") != expected or _inputs(root / expected) != trial.get("inputs"):
            raise ValueError("Prepared experiment inputs changed; no API call was sent.")
    return manifest


def _observed_stop(incident, session, summary):
    """Score a specific gap only after actual complete evidence reads, not fluent prose."""
    groups, _ = evidence_index(incident)
    sources = json.loads((incident / "evidence" / "source_orders.json").read_text(encoding="utf-8"))
    missing = sorted(row["event_id"] for row in sources if row["event_id"] not in groups)
    transcript = json.loads((session / "transcript.json").read_text(encoding="utf-8"))
    read_calls = set()
    covered = {}
    totals = {}
    for message in transcript:
        for call in message.get("tool_calls", []):
            if call.get("function", {}).get("name") == "read_artifact":
                read_calls.add(call["id"])
        if message.get("role") != "tool" or message.get("tool_call_id") not in read_calls:
            continue
        page = json.loads(message["content"])
        if not isinstance(page, dict) or "name" not in page or "total_lines" not in page:
            continue
        name = page["name"]
        totals[name] = page["total_lines"]
        covered.setdefault(name, set()).update(row["ref"] for row in page["lines"])
    complete_reads = all(name in totals and len(covered[name]) == totals[name] for name in
                         ("source_orders.json", "events.jsonl", "inbox_receipts.txt"))
    supported = bool(missing) and complete_reads and all(event in summary for event in missing)
    return {"missing": missing, "complete_relevant_reads": complete_reads,
            "summary_names_each_missing_event": bool(missing) and all(event in summary for event in missing),
            "supported": supported}


def _assess_agent(root, trial, result, before):
    incident = root / trial["incident"]
    session = Path(result["session"])
    outcome = result["final"]["outcome"]
    candidate = Path(result["candidate_path"]) if result["candidate_path"] else None
    record = {"status": {"repair": "ready_for_review", "stop": "stopped"}.get(outcome, outcome), "plan": None}
    stop = None
    if outcome == "repair":
        # finalize_report already ran through the engine's freshness gate. Assess actual state afresh.
        report = json.loads((candidate.parent / "report.json").read_text(encoding="utf-8"))
        record.update(plan=report["plan"], review=Workbench._review({**report, "before": before,
                                                                 "after": snapshot(candidate)}))
    elif outcome == "stop":
        stop = _observed_stop(incident, session, result["final"]["summary"])
        if stop["supported"]:
            record.update(stop_reason="missing_commit_mappings", missing_event_ids=stop["missing"])
    return {**assess_trial(incident.parent, record, before, candidate, outcome == "repair"), "stop_observation": stop}


def run_story(root: Path) -> dict:
    root = root.resolve()
    manifest = _prepared(root)
    if (root / "started.json").exists():
        raise ValueError("This batch has already started. Review its saved results; automatic retries are prohibited.")
    client = MetaClient(CONFIG["model"], max_completion_tokens=CONFIG["max_completion_tokens"])
    # Exclusive persistent marker: a second invocation cannot burn credits on the same batch.
    with (root / "started.json").open("x", encoding="utf-8") as stream:
        json.dump({"started_at": datetime.now(timezone.utc).isoformat(), "configuration": CONFIG}, stream)
    report = {"schema_version": 1, "mode": "live_meta_agent", "scope": SCOPE, "configuration": CONFIG,
              "planned_attempts": len(TRIALS), "attempts": [], "unattempted": [t["id"] for t in manifest["trials"]],
              "batch_stopped": False}
    _save(root / "batch-result.json", report)
    for trial in manifest["trials"]:
        incident = root / trial["incident"]
        before = snapshot(incident / "orders.db")
        result = run_agent(incident, root / trial["id"] / "live", client,
                           max_rounds=CONFIG["max_rounds"], max_calls=CONFIG["max_calls"])
        # Save the raw run before interpreting it; retain failed attempts too.
        attempt = {"id": trial["id"], "incident_id": trial["incident_id"], "seed": trial["seed"],
                   "outcome": result["final"]["outcome"], "result": result,
                   "frozen_parser": trial["frozen_parser"], "adapted_parser": trial["adapted_parser"]}
        report["attempts"].append(attempt)
        report["unattempted"].remove(trial["id"])
        _save(root / "batch-result.json", report)
        try:
            if result["mode"] != "live_meta_agent":
                raise ValueError("This batch requires actual Meta transport provenance.")
            attempt["assessment"] = _assess_agent(root, trial, result, before)
            attempt["recording"] = export_recording(incident, Path(result["session"]), trial["incident_id"], root / "recordings")
        except (ValueError, OSError, KeyError, TypeError) as exc:
            attempt["audit_error"] = str(exc)
        report["batch_stopped"] = (result["final"]["outcome"] in ("error", "incomplete")
                                   or not result["inputs_unchanged"] or "audit_error" in attempt)
        report["judgments"] = dict(Counter(a.get("assessment", {}).get("judgment", "audit_error") for a in report["attempts"]))
        report["usage"] = {field: sum(u.get(field, 0) for a in report["attempts"] for u in a["result"]["usage"])
                           for field in ("prompt_tokens", "completion_tokens", "total_tokens")}
        report["passed"] = (not report["unattempted"] and not report["batch_stopped"]
                            and all(a.get("assessment", {}).get("judgment") in ("correct_repair", "justified_stop")
                                    for a in report["attempts"]))
        _save(root / "batch-result.json", report)
        print(json.dumps({"trial": trial["id"], "outcome": attempt["outcome"],
                          "judgment": attempt.get("assessment", {}).get("judgment"),
                          "batch_stopped": report["batch_stopped"]}), flush=True)
        if report["batch_stopped"]:
            break
    return {key: value for key, value in report.items() if key != "attempts"}
