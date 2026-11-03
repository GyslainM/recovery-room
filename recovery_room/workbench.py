"""Loopback-only review UI for curated synthetic cases; no model transport.

HTTP identifiers select server-owned cases and runs, never filesystem paths.
The existing engine owns plan validation, copy-only execution and export checks.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
import uuid

from .baselines import event_aware_plan
from .db import fingerprint, query_database, schema_for_agent, snapshot
from .fixtures import create_incident, evidence_index, list_artifacts, read_artifact
from .repairs import evidence_fingerprint, finalize_report, rehearse
from .recordings import RecordingCatalog


MODE = "offline_deterministic_engine_demo_NOT_a_model_run"
CASES = {
    "import-retry": ("Import retried after timeout", "complete"),
    "missing-evidence": ("Commit evidence missing", "missing-evidence"),
    "multiple-retries": ("Two retries after partial imports", "multiple-retries"),
}
# CLI evaluation can opt into this format variation; the browser's default cases stay unchanged.
CASE_CATALOG = {**CASES, "split-evidence": ("Archived commits across CSV and JSONL", "split-evidence"),
                "inbox-evidence": ("The receipts are in the inbox", "inbox-evidence"),
                "inbox-ambiguous": ("An inbox claim without commit proof", "inbox-ambiguous")}
DOWNLOADS = {"repair.sql": "application/sql", "plan.json": "application/json",
             "report.json": "application/json", "report.html": "text/html"}
ASSETS = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/style.css": ("style.css", "text/css"),
          "/fonts/InterVariable.woff2": ("fonts/InterVariable.woff2", "font/woff2"),
          "/favicon.svg": ("favicon.svg", "image/svg+xml")}
RUN_SUMMARY_FIELDS = ("id", "incident_id", "status", "summary", "mode", "created_at")


class ReviewConflict(ValueError):
    """A run is stopped, failed, or no longer matches its inputs."""


def _public_review_error(exc: Exception) -> str:
    if isinstance(exc, OSError):
        return "Local incident or rehearsal artifact unavailable. Restore the session files and start a new investigation."
    return str(exc)


class Workbench:
    def __init__(self, root: Path, seed: int = 23, *, case_ids: tuple[str, ...] | None = None,
                 recordings: Path | None = None):
        identifiers = tuple(CASES) if case_ids is None else case_ids
        if (not isinstance(identifiers, tuple) or not identifiers
                or any(not isinstance(key, str) or key not in CASE_CATALOG for key in identifiers)
                or len(set(identifiers)) != len(identifiers)):
            raise ValueError("Choose distinct case identifiers from the built-in catalog.")
        self.catalog = {key: CASE_CATALOG[key] for key in identifiers}
        self.recordings = RecordingCatalog(recordings, self.catalog)
        # Every launch gets a fresh namespace, preserving earlier user runs.
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=False)
        self.incidents = {
            key: create_incident(self.root / key, scenario, seed=seed)
            for key, (_, scenario) in self.catalog.items()
        }
        self.runs: dict[str, dict] = {}
        self.results: dict[str, dict] = {}

    def incident(self, identifier: str) -> Path:
        if identifier not in self.incidents:
            raise KeyError("Unknown incident identifier.")
        return self.incidents[identifier]

    def run(self, identifier: str) -> dict:
        if identifier not in self.runs:
            raise KeyError("Unknown run identifier.")
        return self.runs[identifier]

    def list_runs(self, incident_id: str) -> list[dict]:
        self.incident(incident_id)
        # Reverse insertion order makes tied timestamps deterministic: newest first.
        records = [record for record in reversed(list(self.runs.values()))
                   if record["incident_id"] == incident_id]
        records.sort(key=lambda record: record["created_at"], reverse=True)
        return [{field: record[field] for field in RUN_SUMMARY_FIELDS} for record in records]

    def cases(self) -> list[dict]:
        return [{"id": key, "title": title, "scenario": scenario, "synthetic": True}
                for key, (title, scenario) in self.catalog.items()]

    def list_recordings(self, identifier: str) -> list[dict]:
        return self.recordings.list(identifier, self.incident(identifier))

    def recording(self, identifier: str) -> dict:
        return self.recordings.detail(identifier, self.incidents)

    def overview(self, identifier: str) -> dict:
        incident = self.incident(identifier)
        state = snapshot(incident / "orders.db")
        return {"id": identifier, "title": self.catalog[identifier][0], "scenario": self.catalog[identifier][1], "mode": MODE,
                "note": read_artifact(incident, "incident_note.txt"),
                "artifacts": list_artifacts(incident), "schema": schema_for_agent(incident / "orders.db"),
                "orders": state["orders"], "products": state["products"],
                "active_orders": sum(row["status"] == "active" for row in state["orders"])}

    def investigate(self, identifier: str) -> dict:
        incident = self.incident(identifier)
        if len(self.runs) >= 64:
            raise ReviewConflict("This local session has reached 64 investigations. Start a new session.")
        run_id = "run-" + uuid.uuid4().hex[:12]
        created_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        folder = self.root / "investigations" / run_id
        folder.mkdir(parents=True)
        trace = []

        def observe(tool, arguments, value):
            trace.append({"tool": tool, "arguments": arguments, "result": value,
                          "observed_at": datetime.now(timezone.utc).isoformat()})
            return value

        evidence_hash = evidence_fingerprint(incident)
        source_hash = fingerprint(snapshot(incident / "orders.db"))
        observe("get_schema", {}, schema_for_agent(incident / "orders.db"))
        artifacts = observe("list_artifacts", {}, list_artifacts(incident))
        # These are actual bounded reads, recorded as script observations.
        names = ["incident_note.txt", "source_orders.json", "events.jsonl"]
        names.extend(item["name"] for item in artifacts if item["name"] not in names and item["name"] != "opening_stock.json")
        for name in names:
            line = 1
            while line is not None:
                arguments = {"name": name, "start_line": line, "max_lines": 200}
                page = observe("read_artifact", arguments, read_artifact(incident, **arguments))
                line = page["next_line"]
        sql = "SELECT status, COUNT(*) AS records FROM orders GROUP BY status"
        observe("query_database", {"sql": sql}, query_database(incident / "orders.db", sql))
        groups, _ = evidence_index(incident)
        sources = json.loads((incident / "evidence" / "source_orders.json").read_text(encoding="utf-8"))
        missing = [row["event_id"] for row in sources if row["event_id"] not in groups]
        plan = event_aware_plan(incident) if not missing else None
        if missing:
            reason = (f"Committed-write mappings are missing for {len(missing)} of {len(sources)} imported source events. "
                      "Supply the original and retry commit records linking these events to order IDs; "
                      "similar customer, product and quantity values do not establish duplication.")
        elif plan is None:
            reason = "No repeated committed writes are supported by the supplied evidence. No cancellation plan was created."
        else:
            reason = (f"The event-aware script found {len(plan['cancellations'])} repeated writes linked to the same "
                      "source events. It proposes retaining each first recorded write. Rehearsal is still required.")
        record = {"id": run_id, "incident_id": identifier, "mode": MODE,
                  "created_at": created_at,
                  "status": "proposed" if plan else "stopped", "summary": reason,
                  "stop_reason": ("missing_commit_mappings" if missing else "no_supported_repeats") if not plan else None,
                  "missing_event_ids": missing, "trace": trace, "plan": plan,
                  "source_fingerprint": source_hash, "evidence_fingerprint": evidence_hash,
                  "review": None, "downloads": []}
        self.runs[run_id] = record
        self._save(record)
        return copy.deepcopy(record)

    def _save(self, record: dict) -> None:
        path = self.root / "investigations" / record["id"] / "investigation.json"
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")

    def _fresh(self, record: dict) -> None:
        incident = self.incident(record["incident_id"])
        if fingerprint(snapshot(incident / "orders.db")) != record["source_fingerprint"]:
            raise ReviewConflict("The source changed since investigation. Start a new investigation and rehearsal.")
        if evidence_fingerprint(incident) != record["evidence_fingerprint"]:
            raise ReviewConflict("The evidence changed since investigation. Start a new investigation and rehearsal.")

    def rehearse(self, identifier: str) -> dict:
        record = self.run(identifier)
        if record["status"] not in ("proposed", "ready_for_review"):
            raise ReviewConflict("This investigation has no supported plan to rehearse. Start a new investigation.")
        try:
            self._fresh(record)
            if identifier not in self.results:
                result = rehearse(self.incident(record["incident_id"]), record["plan"],
                                  self.root / "investigations" / identifier / "rehearsals")
                self.results[identifier] = result
                record["review"] = self._review(result)
                record["status"] = "ready_for_review" if result["passed"] else "failed_checks"
                record["summary"] = ("Rehearsed on a disposable copy. Review the changes, checks and guarded SQL."
                                     if result["passed"] else "Operational checks failed. Review the results; export is unavailable.")
            if self.results[identifier]["passed"]:
                self._finalize(identifier)
                record["downloads"] = list(DOWNLOADS)
        except (ValueError, OSError, sqlite3.Error) as exc:
            record.update(status="blocked", summary=_public_review_error(exc), downloads=[])
        self._save(record)
        return copy.deepcopy(record)

    @staticmethod
    def _review(result: dict) -> dict:
        before, after = result["before"], result["after"]
        originals = {row["id"]: row for row in before["orders"]}
        current = {row["id"]: row for row in after["orders"]}
        targets = {row["order_id"] for row in result["plan"]["cancellations"]}
        checkout = [row for row in before["orders"] if (row["source_reference"] or "").startswith("checkout-")]
        products = {row["sku"]: row for row in after["products"]}
        return {"checks": result["checks"], "passed": result["passed"],
                "before_active": sum(row["status"] == "active" for row in before["orders"]),
                "after_active": sum(row["status"] == "active" for row in after["orders"]),
                "cancellations": len(targets),
                "untargeted_preserved": sum(current.get(key) == row for key, row in originals.items() if key not in targets),
                "checkout_total": len(checkout),
                "checkout_order_ids": [row["id"] for row in checkout],
                "checkout_preserved": sum(current.get(row["id"]) == row for row in checkout),
                "changes": [{"before": originals[action["order_id"]], "after": current[action["order_id"]],
                             "duplicate_of": action["duplicate_of"], "evidence_refs": action["evidence_refs"]}
                            for action in result["plan"]["cancellations"]],
                "stock": [{"sku": row["sku"], "name": row["name"], "before": row["on_hand"],
                           "after": products[row["sku"]]["on_hand"]} for row in before["products"]],
                "preserved_orders": [row for key, row in originals.items()
                                     if key not in targets and current.get(key) == row]}

    def _finalize(self, identifier: str) -> None:
        record = self.run(identifier)
        self._fresh(record)
        result = self.results[identifier]
        if snapshot(Path(result["candidate_path"])) != result["after"]:
            raise ReviewConflict("The candidate changed since rehearsal. Start a new investigation and rehearsal.")
        finalize_report(self.incident(record["incident_id"]), result)

    def download(self, identifier: str, filename: str) -> bytes:
        record = self.run(identifier)
        if filename not in DOWNLOADS:
            raise KeyError("Unknown review artifact.")
        if record["status"] != "ready_for_review":
            raise ReviewConflict("Only a successful current rehearsal can be exported for review.")
        try:
            # Revalidate every download, even if artifacts already exist on disk.
            self._finalize(identifier)
        except (ValueError, OSError, sqlite3.Error) as exc:
            record.update(status="blocked", summary=_public_review_error(exc), downloads=[])
            self._save(record)
            raise ReviewConflict(record["summary"]) from None
        return (Path(self.results[identifier]["folder"]) / filename).read_bytes()


def make_server(workbench: Workbench, port: int = 8765) -> HTTPServer:
    class Handler(BaseHTTPRequestHandler):
        server_version = "RecoveryRoom"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def _send(self, value: bytes, content_type: str, status=200, filename=None):
            self.send_response(status)
            # Text responses retain UTF-8; binary assets such as WOFF2 have no charset.
            textual = content_type.startswith("text/") or content_type in {"application/json", "application/sql"}
            suffix = "; charset=utf-8" if textual else ""
            self.send_header("Content-Type", content_type + suffix)
            self.send_header("Content-Length", str(len(value)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
            self.send_header("Referrer-Policy", "no-referrer")
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(value)

        def _json(self, value, status=200):
            if status >= 400 and self.command == "POST":
                self._discard_rejected_body()
            self._send(json.dumps(value).encode(), "application/json", status)

        def _guard(self):
            # Host checking also rejects DNS rebinding to this loopback listener.
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            host = self.headers.get("Host", "")
            if host not in allowed:
                raise PermissionError("Only the local workbench host is accepted.")
            origin = self.headers.get("Origin")
            if origin is not None and origin != "http://" + host:
                raise PermissionError("Cross-origin requests are not accepted.")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise PermissionError("Cross-site requests are not accepted.")

        def do_GET(self):
            self._dispatch(False)

        def do_POST(self):
            self._dispatch(True)

        def _discard_rejected_body(self):
            # Closing with unread incoming data can reset the socket on Windows,
            # hiding the rejection response. Cleanup is best-effort, never an unlimited
            # read of the untrusted Content-Length or a new slow-sender timeout.
            self.close_connection = True
            if self.headers.get("Transfer-Encoding"):
                return  # Unsupported framing is never interpreted as Content-Length.
            try:
                size = int(self.headers.get("Content-Length", "0")) - self._body_consumed
            except ValueError:
                return
            if size <= 0:
                return
            remaining = min(size, 8192)
            deadline = time.monotonic() + 0.25
            previous_timeout = self.connection.gettimeout()
            try:
                while remaining:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        break
                    self.connection.settimeout(timeout)
                    data = self.rfile.read1(remaining)
                    if not data:
                        break
                    remaining -= len(data)
            except OSError:
                pass  # Still send the rejection if the peer stops sending.
            finally:
                self.connection.settimeout(previous_timeout)

        def _dispatch(self, post):
            self._body_consumed = 0
            try:
                self._guard()
                url = urlsplit(self.path)
                parts = url.path.strip("/").split("/")
                if post:
                    if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                        raise ValueError("Send a small JSON object without transfer encoding.")
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 1 <= size <= 4096:
                        raise ValueError("Request body must be 1 to 4096 bytes.")
                    body = self.rfile.read(size)
                    self._body_consumed = len(body)
                    if json.loads(body) != {}:
                        raise ValueError("This offline action accepts an empty object only; plans and paths are server-owned.")
                    if len(parts) == 4 and parts[:2] == ["api", "incidents"] and parts[3] == "investigate":
                        return self._json(workbench.investigate(parts[2]), 201)
                    if len(parts) == 4 and parts[:2] == ["api", "runs"] and parts[3] == "rehearse":
                        return self._json(workbench.rehearse(parts[2]))
                else:
                    if self.path in ASSETS:
                        filename, mime = ASSETS[self.path]
                        return self._send((Path(__file__).parent / "web" / filename).read_bytes(), mime)
                    if parts == ["api", "incidents"]:
                        return self._json({"mode": MODE, "incidents": workbench.cases()})
                    if parts == ["api", "runs"]:
                        query = parse_qs(url.query, keep_blank_values=True, strict_parsing=True)
                        if (set(query) != {"incident"} or len(query["incident"]) != 1
                                or not query["incident"][0]):
                            raise ValueError("Supply exactly one nonempty incident identifier.")
                        return self._json({"runs": workbench.list_runs(query["incident"][0])})
                    if len(parts) == 4 and parts[:2] == ["api", "incidents"] and parts[3] == "recordings":
                        if url.query or "?" in self.path or url.path.endswith("/"):
                            raise ValueError("Recording endpoints accept exact paths without query parameters.")
                        return self._json(workbench.list_recordings(parts[2]))
                    if len(parts) == 3 and parts[:2] == ["api", "recordings"]:
                        if url.query or "?" in self.path or url.path.endswith("/"):
                            raise ValueError("Recording endpoints accept exact paths without query parameters.")
                        return self._json(workbench.recording(parts[2]))
                    if len(parts) == 3 and parts[:2] == ["api", "incidents"]:
                        return self._json(workbench.overview(parts[2]))
                    if len(parts) == 5 and parts[:2] == ["api", "incidents"] and parts[3] == "artifacts":
                        query = parse_qs(url.query, keep_blank_values=True)
                        if set(query) - {"start_line", "max_lines"} or any(len(v) != 1 for v in query.values()):
                            raise ValueError("Unknown or repeated evidence pagination argument.")
                        options = {key: int(value[0]) for key, value in query.items()}
                        return self._json(read_artifact(workbench.incident(parts[2]), parts[4], **options))
                    if len(parts) == 3 and parts[:2] == ["api", "runs"]:
                        return self._json(workbench.run(parts[2]))
                    if len(parts) == 5 and parts[:2] == ["api", "runs"] and parts[3] == "artifacts":
                        data = workbench.download(parts[2], parts[4])
                        return self._send(data, DOWNLOADS[parts[4]], filename=parts[4])
                self._json({"error": "Unknown local endpoint."}, 404)
            except PermissionError as exc:
                message = _public_review_error(exc) if exc.filename is not None or exc.errno is not None else str(exc)
                self._json({"error": message}, 403)
            except KeyError:
                self._json({"error": "Unknown incident, run or artifact identifier."}, 404)
            except ReviewConflict as exc:
                self._json({"error": str(exc)}, 409)
            except (ValueError, TypeError) as exc:
                self._json({"error": str(exc)}, 400)
            except (OSError, sqlite3.Error):
                self._json({"error": "Local incident or artifact unavailable. Inspect the session files and start a new session."}, 409)

    return HTTPServer(("127.0.0.1", port), Handler)


def serve(root: Path, port: int = 8765, *, recordings: Path | None = None,
          case_ids: tuple[str, ...] | None = None) -> None:
    if not 0 <= port <= 65535:
        raise ValueError("Port must be from 0 to 65535 (0 selects a free local port).")
    workbench = Workbench(root, recordings=recordings, case_ids=case_ids)
    with make_server(workbench, port) as server:
        print(f"Recovery Room local workbench: http://127.0.0.1:{server.server_port}", flush=True)
        print("OFFLINE deterministic script. Synthetic cases. No model or API calls.", flush=True)
        if recordings is not None:
            print(f"{len(workbench.recordings.records)} recordings available: Recorded model run, not live.", flush=True)
        print(f"Session artifacts: {workbench.root}\nPress Ctrl+C to stop.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
