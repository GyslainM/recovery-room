"""Bounded, sanitized, read-only projections of operator-imported model recordings.

Only the CLI imports files. HTTP identifiers never select filesystem paths, replay
tools, execute plans, or produce exports. Local bundles are server-owned records,
not cryptographic attestations of provider behavior.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import sqlite3
import uuid

from .checks import check_state, public_diagnostics
from .db import fingerprint, snapshot
from .fixtures import artifact_names
from .repairs import evidence_fingerprint, normalize_plan, validate_evidence


LABEL = "Recorded model run, not live"
MAX_RECORDINGS = 64
MAX_FILE_BYTES = 2_000_000
MAX_BUNDLE_BYTES = 1_000_000
MAX_DETAIL_BYTES = 750_000
MAX_PAYLOAD_BYTES = 16_384
CASE_IDS = ("import-retry", "missing-evidence", "multiple-retries", "split-evidence")
REVIEW_FIELDS = ("checks", "passed", "before_active", "after_active", "cancellations",
                 "untargeted_preserved", "checkout_total", "checkout_order_ids", "checkout_preserved",
                 "changes", "stock", "preserved_orders")
_IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_PRIVATE_KEY = re.compile(r"(^|_)(path|folder|directory|headers?|authorization|api_?key|access_?token|token|key|credentials?|secret|password|cookie)(_|$)", re.I)
_CREDENTIAL = re.compile(r"LLM\|[^\s\"',;<>]+|\bBearer\s+[^\s\"',;<>]+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[_ -]?key|password|secret|access[_ -]?token|authorization)[\"']?\s*[:=]\s*[\"']?(?:Bearer\s+)?[^\s,;<>\"']+", re.I)
_PATH = re.compile(r"(?:[A-Za-z]:[\\/]|\\\\|file://|\.\.[\\/])[^\s\"'<>]*|(?<![A-Za-z0-9_:])/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+")


def _text(value: str, limit: int = 4096) -> str:
    value = _CREDENTIAL.sub("[redacted credential]", value)
    value = _PATH.sub("[redacted path]", value)
    value = "".join(char for char in value if char in "\n\t" or ord(char) >= 32)
    return value if len(value) <= limit else value[:limit] + " [truncated]"


def _redacted(value):
    """Apply the recording text rules to every string inside already-bounded diagnostics."""
    if isinstance(value, str):
        return _text(value, 160)
    if isinstance(value, list):
        return [_redacted(item) for item in value]
    if isinstance(value, dict):
        return {key: _redacted(item) for key, item in value.items()}
    return value


def _public_check(check: dict) -> dict:
    """A recorded check keeps its known fields; diagnostics only when they fit the public bounds.
    Older recordings have none, and none are recomputed or invented for them."""
    public = {"name": check["name"], "passed": check["passed"], "detail": check["detail"]}
    explained = public_diagnostics(check.get("diagnostics"))
    if explained is not None:
        public["diagnostics"] = _redacted(explained)
    return public


def _clean(value, depth=0):
    if depth > 9:
        return "[truncated]"
    if isinstance(value, str):
        return _text(value)
    if value is None or type(value) in (bool, int):
        return value
    if type(value) is float:
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        result = [_clean(item, depth+1) for item in value[:200]]
        if len(value) > 200:
            result.append({"__truncated_items__": len(value)-200})
        return result
    if isinstance(value, dict):
        result = {}
        for key,item in itertools.islice(value.items(),200):
            if not isinstance(key,str) or len(key) > 128:
                continue
            normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", key)
            normalized = re.sub(r"[\s-]+", "_", normalized)
            if _PRIVATE_KEY.search(normalized) or key.lower() in {"__proto__", "constructor", "prototype"}:
                continue
            # Keep legitimate SQLite result labels such as COUNT(*).
            result[_text(key,80)] = _clean(item,depth+1)
        return result
    return "[unsupported recorded value]"


def _payload(value):
    cleaned = _clean(value)
    encoded = json.dumps(cleaned, ensure_ascii=False)
    if len(encoded.encode()) > MAX_PAYLOAD_BYTES:
        return {"preview": _text(encoded, 3500)}, True
    return cleaned, "[truncated]" in encoded or "__truncated_items__" in encoded


def _linked(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _contained(path: Path, base: Path) -> None:
    if _linked(base):
        raise ValueError("Recording locations must be ordinary server-owned directories.")
    try:
        relative = path.absolute().relative_to(base.absolute())
    except ValueError:
        raise ValueError("Recording files must remain inside their server-owned directory.") from None
    current = base
    for part in relative.parts:
        current = current / part
        if _linked(current):
            raise ValueError("Recording links and junctions are not accepted.")
    if not path.resolve().is_relative_to(base.resolve()):
        raise ValueError("Recording files must remain inside their server-owned directory.")


def _read(path: Path, base: Path, maximum=MAX_FILE_BYTES):
    _contained(path, base)
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError("Recording file unavailable or over its size limit.")
    try:
        with path.open("rb") as handle:
            raw = handle.read(maximum+1)
        if len(raw) > maximum:
            raise ValueError("Recording file exceeded its size limit.")
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ValueError("Recording JSON is invalid.") from None


def _utc(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    except (ValueError, AttributeError, TypeError):
        raise ValueError("A recording requires a timezone-aware recorded_at timestamp.") from None


def _number(value, *, integer=False):
    if type(value) not in ((int,) if integer else (int,float)) or not 0 <= value <= 10**12 or not math.isfinite(value):
        raise ValueError("Recording count or duration is invalid.")
    return value


def _usage(records):
    if not isinstance(records, list) or len(records) > 24:
        raise ValueError("Recording usage must contain at most 24 responses.")
    totals = {key: 0 for key in ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens", "total_tokens")}
    available = bool(records)
    for entry in records:
        if not isinstance(entry, dict):
            raise ValueError("Recording usage is invalid.")
        if any(entry.get(key) is not None and not isinstance(entry[key],dict)
               for key in ("prompt_tokens_details","completion_tokens_details")):
            raise ValueError("Recording usage details must be objects.")
        available = available and all(key in entry for key in ("prompt_tokens", "completion_tokens", "total_tokens"))
        fields = {"input_tokens": entry.get("prompt_tokens", 0), "output_tokens": entry.get("completion_tokens", 0),
                  "total_tokens": entry.get("total_tokens", 0),
                  "cached_input_tokens": (entry.get("prompt_tokens_details") or {}).get("cached_tokens", 0),
                  "reasoning_tokens": (entry.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)}
        for key,value in fields.items():
            totals[key] += _number(value, integer=True)
    return {**totals, "response_count": len(records), "available": bool(available),
            "reasoning_included_in_output": True}


def _timeline(messages):
    if not isinstance(messages, list) or len(messages) > 128:
        raise ValueError("Recording transcript is invalid or too long.")
    steps, calls, answered = [], {}, set()
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("Recorded messages must be objects.")
        if message.get("role") == "assistant":
            content = message.get("content")
            if content:
                if not isinstance(content, str):
                    raise ValueError("Recorded assistant text must be a string.")
                steps.append({"kind": "assistant", "text": _text(content, 6000)})
            requested = message.get("tool_calls") or []
            if not isinstance(requested, list) or len(requested) > 8:
                raise ValueError("Recorded tool batch is invalid.")
            for request in requested:
                if not isinstance(request, dict) or not isinstance(request.get("id"), str) or request["id"] in calls:
                    raise ValueError("Recorded tool identifiers must be distinct.")
                function = request.get("function")
                if not isinstance(function, dict) or not isinstance(function.get("name"), str):
                    raise ValueError("Recorded tool function is invalid.")
                raw = function.get("arguments")
                try:
                    if not isinstance(raw, str) or len(raw) > 64_000:
                        raise ValueError()
                    arguments = json.loads(raw)
                except (ValueError, RecursionError):
                    arguments = {"unparsed": "Invalid recorded argument JSON; raw text omitted."}
                arguments, truncated = _payload(arguments)
                step = {"kind": "tool_call", "call_id": "call-" + str(len(calls)+1),
                        "name": _text(function["name"], 80), "arguments": arguments,
                        "truncated": truncated, "has_result": False}
                calls[request["id"]] = step
                steps.append(step)
        elif message.get("role") == "tool":
            identifier = message.get("tool_call_id")
            if not isinstance(identifier, str) or identifier not in calls or identifier in answered:
                raise ValueError("Recorded tool result has no unique preceding call.")
            try:
                raw = message.get("content")
                if not isinstance(raw, str) or len(raw) > MAX_FILE_BYTES:
                    raise ValueError()
                result = json.loads(raw)
            except (ValueError, RecursionError):
                raise ValueError("Recorded tool result JSON is invalid.") from None
            rejected = isinstance(result, dict) and ("error" in result or result.get("passed") is False)
            cleaned, truncated = _payload(result)
            calls[identifier]["has_result"] = True
            answered.add(identifier)
            steps.append({"kind": "tool_result", "call_id": calls[identifier]["call_id"],
                          "result": cleaned, "error": bool(rejected), "truncated": truncated})
    if len(calls) > 48 or len(steps) > 160:
        raise ValueError("Recording exceeds the controller's tool/step bounds.")
    for number,step in enumerate(steps, 1):
        step["id"] = "step-" + str(number)
    return steps, len(answered)


def _legacy_inputs(incident: Path, manifest: Path) -> dict:
    entries = _read(manifest, manifest.parent)
    if not isinstance(entries, list) or not 1 <= len(entries) <= 8:
        raise ValueError("Legacy recordings require a bounded pre-run input manifest.")
    expected = {incident/"orders.db", *(incident/"evidence"/name for name in artifact_names(incident))}
    seen = set()
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not isinstance(item.get("sha256"), str):
            raise ValueError("Legacy input manifest is invalid.")
        path = Path(item["path"]).absolute()
        if path not in expected or path in seen:
            raise ValueError("Legacy input manifest must name exactly this incident's allowed files.")
        _contained(path, incident)
        if path.stat().st_size > MAX_FILE_BYTES or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"].lower():
            raise ValueError("The legacy recording's original input files no longer match.")
        seen.add(path)
    if seen != expected:
        raise ValueError("Legacy input manifest must cover every original incident file.")
    return {"source": fingerprint(snapshot(incident/"orders.db")), "evidence": evidence_fingerprint(incident)}


def _recorded_review(incident: Path, session: Path, result: dict, inputs: dict):
    identifier = result["final"].get("rehearsal_id")
    if not isinstance(identifier, str) or not re.fullmatch(r"rehearsal-[0-9a-f]{12}", identifier):
        raise ValueError("Recorded repair requires a server-generated rehearsal identifier.")
    folder = session/identifier
    report = _read(folder/"report.json", session)
    if (not isinstance(report,dict) or not isinstance(report.get("checks"),list)
            or any(not isinstance(check,dict) or not isinstance(check.get("name"),str)
                   for check in report.get("checks",[]))):
        raise ValueError("Recorded rehearsal report is invalid.")
    candidate = folder/"candidate.db"
    _contained(candidate, session)
    if not candidate.is_file() or candidate.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Recorded candidate is unavailable or too large.")
    if (report.get("source_fingerprint") != inputs["source"] or report.get("evidence_fingerprint") != inputs["evidence"]
            or report.get("passed") is not True):
        raise ValueError("Recorded rehearsal does not match the original inputs.")
    before, after = snapshot(incident/"orders.db"), snapshot(candidate)
    plan = normalize_plan(report["plan"])
    validate_evidence(incident, before, plan)
    checks = check_state(incident, candidate, before, {item["order_id"] for item in plan["cancellations"]})
    if not all(check["passed"] for check in checks) or not all(check.get("passed") is True for check in report["checks"]):
        raise ValueError("Recorded repair failed independent read-only validation.")
    if len(report["checks"]) != len(checks)+2 or {row["name"] for row in report["checks"]} != {
            *(row["name"] for row in checks), "source_snapshot_unchanged", "evidence_snapshot_unchanged"}:
        raise ValueError("Recorded rehearsal check coverage is incomplete.")
    # Reuse the exact existing public review shape; no plan is executed here.
    from .workbench import Workbench
    return Workbench._review({**report, "before": before, "after": after, "plan": plan})


def export_recording(incident: Path, session: Path, incident_id: str, root: Path, *, input_manifest: Path | None = None) -> dict:
    """Explicit local import; never available over HTTP and never calls a model."""
    if incident_id not in CASE_IDS:
        raise ValueError("Choose a built-in incident identifier for the recording.")
    incident, session = incident.absolute(), session.absolute()
    _contained(incident/"orders.db", incident)
    _contained(incident/"evidence", incident)
    if (incident/"orders.db").stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Recording source database exceeds the size limit.")
    result = _read(session/"result.json", session)
    messages = _read(session/"transcript.json", session)
    if not isinstance(result, dict) or result.get("mode") != "live_meta_agent":
        raise ValueError("Only recorded live Meta attempts may be imported as model recordings.")
    current = {"source": fingerprint(snapshot(incident/"orders.db")), "evidence": evidence_fingerprint(incident)}
    native = result.get("input_fingerprints")
    if native is not None:
        if native != current or result.get("inputs_unchanged") is not True:
            raise ValueError("Native recorded inputs are unavailable, changed or mismatched.")
        inputs, source = native, "native_capture"
    elif input_manifest is not None:
        if (input_manifest.absolute().parent.resolve() != incident.parent.resolve()
                or not session.resolve().is_relative_to(incident.parent.resolve())):
            raise ValueError("Legacy session and pre-run manifest must remain with their original incident root.")
        inputs, source = _legacy_inputs(incident, input_manifest.absolute()), "verified_legacy_file_manifest"
    else:
        raise ValueError("Legacy recording needs its original pre-run input manifest; provenance is never guessed.")
    steps, count = _timeline(messages)
    final = result.get("final")
    if not isinstance(final, dict) or final.get("outcome") not in {"repair", "stop", "error", "incomplete"} or not isinstance(final.get("summary"), str):
        raise ValueError("Recording final outcome is invalid.")
    model = result.get("model")
    if not isinstance(model, str) or not 1 <= len(model) <= 80:
        raise ValueError("Recorded model name is invalid.")
    timestamp_source = "agent_result" if result.get("recorded_at") else "result_file_mtime"
    recorded_at = result.get("recorded_at") or datetime.fromtimestamp((session/"result.json").stat().st_mtime, timezone.utc).isoformat()
    review = _recorded_review(incident, session, result, inputs) if final["outcome"] == "repair" else None
    bundle = {"schema_version": 1, "incident_id": incident_id, "input_fingerprints": inputs,
        "provenance": {"mode": "live_meta_agent", "model": _text(model,80), "recorded_at": _utc(recorded_at),
                       "timestamp_source": timestamp_source, "input_provenance": source, "label": LABEL},
        "outcome": final["outcome"], "summary": _text(final["summary"]), "tool_calls": count,
        "elapsed_seconds": _number(result.get("elapsed_seconds")), "steps": steps,
        "final": {"outcome": final["outcome"], "summary": _text(final["summary"]),
                  "rehearsal_id": final.get("rehearsal_id") if final["outcome"] == "repair" else None},
        "usage": _usage(result.get("usage", [])), "review": _clean(review)}
    if current != {"source": fingerprint(snapshot(incident/"orders.db")), "evidence": evidence_fingerprint(incident)}:
        raise ValueError("Inputs changed during recording import.")
    encoded = json.dumps(bundle, ensure_ascii=False)
    if len(encoded.encode()) > MAX_BUNDLE_BYTES:
        raise ValueError("Sanitized recording exceeds the bundle size limit.")
    _contained(root, root)
    destination = root/incident_id/("recording-" + uuid.uuid4().hex[:12])
    _contained(destination, root)
    destination.mkdir(parents=True, exist_ok=False)
    with (destination/"recording.json").open("x", encoding="utf-8") as handle:
        handle.write(encoded)
    return {"incident_id": incident_id, "recording_folder": str(destination.resolve()), "outcome": final["outcome"], "tool_calls": count}


def _without_citations(value):
    if isinstance(value, list):
        return [_without_citations(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key,item in value.items():
            if key == "evidence_refs":
                result[key] = []
                result["recorded_evidence_refs_text"] = ", ".join(str(ref) for ref in item) if isinstance(item,list) else ""
            elif key == "ref":
                result["recorded_ref_text"] = item
            else:
                result[key] = _without_citations(item)
        return result
    return value


def _project_steps(steps):
    """Reapply the public step allowlist even to an already imported bundle."""
    result, calls, answered = [], {}, set()
    for index,row in enumerate(steps, 1):
        if not isinstance(row,dict):
            raise ValueError("Recorded step is invalid.")
        kind = row.get("kind")
        if kind == "assistant" and isinstance(row.get("text"),str):
            projected = {"kind":kind, "text":_text(row["text"])}
        elif kind in ("tool_call", "tool_result"):
            identifier = row.get("call_id")
            if not isinstance(identifier,str) or not re.fullmatch(r"call-[1-9][0-9]?",identifier):
                raise ValueError("Public recorded call identifier is invalid.")
            projected = {"kind":kind, "call_id":identifier}
            if kind == "tool_call":
                if identifier in calls or not isinstance(row.get("name"),str):
                    raise ValueError("Recorded call is duplicated or invalid.")
                value,truncated = _payload(row.get("arguments"))
                projected.update(name=_text(row["name"],80), arguments=value,
                                 truncated=truncated or row.get("truncated") is True, has_result=False)
                calls[identifier] = projected
            else:
                if identifier not in calls or identifier in answered or type(row.get("error")) is not bool:
                    raise ValueError("Recorded result is unpaired or invalid.")
                value,truncated = _payload(row.get("result"))
                projected.update(result=value, error=row["error"], truncated=truncated or row.get("truncated") is True)
                calls[identifier]["has_result"] = True
                answered.add(identifier)
        else:
            raise ValueError("Only assistant text and recorded tool steps can be served.")
        result.append({"id":"step-"+str(index), **projected})
        # The dictionary stored in calls must remain the one returned to the UI.
        if kind == "tool_call":
            calls[identifier] = result[-1]
    if len(calls) > 48:
        raise ValueError("Recorded call count exceeds the controller limit.")
    return result


class RecordingCatalog:
    def __init__(self, root: Path | None, incident_ids):
        self.records = {}
        if root is None:
            return
        _contained(root, root)
        if not root.is_dir():
            raise ValueError("Choose an existing server-owned recordings directory.")
        seen = 0
        for case in CASE_IDS:
            directory = root/case
            if not directory.exists():
                continue
            _contained(directory, root)
            if not directory.is_dir():
                raise ValueError("Recording case entries must be directories.")
            for folder in itertools.islice(directory.iterdir(), MAX_RECORDINGS+1):
                seen += 1
                if seen > MAX_RECORDINGS or not _IDENTIFIER.fullmatch(folder.name):
                    raise ValueError("Recording library exceeds its directory/name limits.")
                _contained(folder, root)
                bundle = _read(folder/"recording.json", root, MAX_BUNDLE_BYTES)
                if (not isinstance(bundle, dict) or type(bundle.get("schema_version")) is not int
                        or bundle["schema_version"] != 1 or bundle.get("incident_id") != case):
                    raise ValueError("Recording bundle does not match its case directory.")
                provenance = bundle.get("provenance")
                inputs = bundle.get("input_fingerprints")
                if (not isinstance(provenance, dict) or provenance.get("mode") != "live_meta_agent"
                        or not isinstance(provenance.get("model"),str) or not 1 <= len(provenance["model"]) <= 80
                        or provenance.get("input_provenance") not in {"native_capture","verified_legacy_file_manifest"}
                        or provenance.get("timestamp_source") not in {"agent_result","result_file_mtime"}
                        or not isinstance(inputs, dict) or set(inputs) != {"source", "evidence"}
                        or any(not isinstance(value,str) or not _HASH.fullmatch(value) for value in inputs.values())):
                    raise ValueError("Recording provenance is invalid.")
                if bundle.get("outcome") not in {"repair", "stop", "error", "incomplete"}:
                    raise ValueError("Recording outcome is invalid.")
                if not isinstance(bundle.get("steps"),list) or len(bundle["steps"]) > 160:
                    raise ValueError("Recording steps exceed the size limit.")
                bundle = _clean(bundle)
                bundle["provenance"] = {key: bundle["provenance"].get(key) for key in
                    ("mode", "model", "timestamp_source", "input_provenance")}
                bundle["provenance"].update(recorded_at=_utc(provenance.get("recorded_at")), label=LABEL)
                bundle["tool_calls"] = _number(bundle.get("tool_calls"), integer=True)
                bundle["elapsed_seconds"] = _number(bundle.get("elapsed_seconds"))
                bundle["steps"] = _project_steps(bundle["steps"])
                if bundle["tool_calls"] != sum(row["kind"]=="tool_result" for row in bundle["steps"]):
                    raise ValueError("Recorded tool count does not match the observed results.")
                review = bundle.get("review")
                if (bundle["outcome"] == "repair") != isinstance(review,dict):
                    raise ValueError("Only a verified recorded repair may contain a review.")
                if review is not None:
                    if not isinstance(review,dict) or any(field not in review for field in REVIEW_FIELDS):
                        raise ValueError("Recorded review is incomplete.")
                    if (type(review["passed"]) is not bool or not isinstance(review["checks"],list) or len(review["checks"]) > 32
                            or not isinstance(review["changes"],list) or len(review["changes"]) > 40
                            or any(not isinstance(review[field],list) or len(review[field]) > 200 for field in
                                   ("stock","preserved_orders","checkout_order_ids"))):
                        raise ValueError("Recorded review exceeds the public shape or size limits.")
                    for field in ("before_active","after_active","cancellations","untargeted_preserved",
                                  "checkout_total","checkout_preserved"):
                        _number(review[field],integer=True)
                    if (review["passed"] is not True or not review["checks"] or not 1 <= review["cancellations"] <= 40
                            or len(review["changes"]) != review["cancellations"]
                            or any(not isinstance(check,dict) or check.get("passed") is not True
                                   or not isinstance(check.get("name"),str) or not isinstance(check.get("detail"),str)
                                   for check in review["checks"])):
                        raise ValueError("Recorded repair review does not describe a passed rehearsal.")
                    bundle["review"] = {field:review[field] for field in REVIEW_FIELDS}
                    bundle["review"]["checks"] = [_public_check(check) for check in review["checks"]]
                final = bundle.get("final")
                if not isinstance(final,dict) or final.get("outcome") != bundle["outcome"]:
                    raise ValueError("Recorded final outcome is inconsistent.")
                if not isinstance(bundle.get("summary"),str) or not isinstance(final.get("summary"),str):
                    raise ValueError("Recorded summary must be text.")
                bundle["summary"] = _text(bundle["summary"])
                bundle["final"] = {"outcome":bundle["outcome"], "summary":_text(final.get("summary", ""))}
                usage = bundle.get("usage")
                if not isinstance(usage,dict):
                    raise ValueError("Recorded usage totals are invalid.")
                bundle["usage"] = {key:_number(usage.get(key),integer=True) for key in
                    ("input_tokens","output_tokens","cached_input_tokens","reasoning_tokens","total_tokens","response_count")}
                if usage["response_count"] > 24 or usage["cached_input_tokens"] > usage["input_tokens"] or usage["reasoning_tokens"] > usage["output_tokens"]:
                    raise ValueError("Recorded usage totals exceed their bounds.")
                bundle["usage"].update(available=usage.get("available") is True, reasoning_included_in_output=True)
                if case not in incident_ids:
                    continue
                identifier = "recording-" + uuid.uuid4().hex[:12]
                self.records[identifier] = (case, bundle)

    def _detail(self, identifier, incident):
        if identifier not in self.records:
            raise KeyError("Unknown recording identifier.")
        case, bundle = self.records[identifier]
        try:
            matches = bundle["input_fingerprints"] == {"source": fingerprint(snapshot(incident/"orders.db")), "evidence": evidence_fingerprint(incident)}
        except (OSError, ValueError, sqlite3.Error):
            matches = False
        detail = {key: copy.deepcopy(bundle.get(key)) for key in
                  ("provenance", "outcome", "summary", "tool_calls", "elapsed_seconds", "steps", "final", "usage", "review")}
        detail.update(id=identifier, incident_id=case, fixture_matches=matches, citations_enabled=matches,
                      fixture_warning=None if matches else "Recording inputs do not match the served case. Current-case citations are disabled.",
                      read_only=True, downloads=[], review_observation="Recorded at rehearsal; not a current export check.")
        if not matches:
            detail = _without_citations(detail)
        if len(json.dumps(detail).encode()) > MAX_DETAIL_BYTES:
            raise ValueError("Recording projection exceeds its response size limit.")
        return detail

    def list(self, case, incident):
        records = []
        for identifier,(recorded_case,_) in self.records.items():
            if recorded_case != case:
                continue
            detail = self._detail(identifier,incident)
            provenance = detail["provenance"]
            records.append({"id": identifier, "model": provenance["model"], "mode": provenance["mode"],
                "recorded_at": provenance["recorded_at"], **{key:detail[key] for key in
                ("outcome", "summary", "tool_calls", "elapsed_seconds", "fixture_matches")}})
        return sorted(records, key=lambda record: (record["recorded_at"],record["id"]), reverse=True)

    def detail(self, identifier, incidents):
        if identifier not in self.records:
            raise KeyError("Unknown recording identifier.")
        return self._detail(identifier, incidents[self.records[identifier][0]])
