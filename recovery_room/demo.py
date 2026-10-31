"""Build public, inert demo data from synthetic fixtures and sanitized recordings.

No HTTP server, model client, private evaluator, SQL download or live action is
exposed. Claude's UI adapter consumes this versioned contract on a static host.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from .fixtures import list_artifacts, read_artifact
from .recordings import _clean
from .workbench import Workbench


MAX_DATA_BYTES = 8_000_000
BASE_CASES = ("import-retry", "missing-evidence", "multiple-retries", "split-evidence")
LABEL = "Recorded demo · No live API calls"
SCOPE = ("Public synthetic cases from one import/retry family. Seeds vary identifiers. "
         "All saved model outcomes are shown, including errors and incomplete attempts. "
         "The competent adapted script solves the supported cases; no general AI advantage or blind-holdout reliability is established.")


def export_demo(root: Path, recordings: Path, *, story: Path | None = None) -> dict:
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    apps = [Workbench(root / "private-build" / "original", recordings=recordings, case_ids=BASE_CASES)]
    story_report = None
    if story is not None:
        # This is an operator-selected CLI path, never a browser parameter.
        story_report = json.loads((story / "batch-result.json").read_text(encoding="utf-8"))
        if story_report.get("mode") != "live_meta_agent":
            raise ValueError("Story evaluation must describe an actual saved Meta batch.")
        for case, seed in (("inbox-evidence", 101), ("inbox-ambiguous", 107)):
            apps.append(Workbench(root / "private-build" / case, seed=seed,
                                  recordings=story / "recordings", case_ids=(case,)))
    cases, api_get, artifacts, details = [], {}, {}, []
    for app in apps:
        for case in app.catalog:
            cases.extend(row for row in app.cases() if row["id"] == case)
            api_get[f"/api/incidents/{case}"] = app.overview(case)
            listing = app.list_recordings(case)
            api_get[f"/api/incidents/{case}/recordings"] = listing
            for row in listing:
                detail = app.recording(row["id"])
                api_get[f"/api/recordings/{row['id']}"] = detail
                details.append(detail)
            # Run one actual offline comparison at build time. It is a snapshot,
            # and never grants a public export or creates a simulated live run.
            run = app.investigate(case)
            if run["status"] == "proposed":
                run = app.rehearse(run["id"])
            run = _clean({key: value for key, value in run.items()
                          if key not in ("source_fingerprint", "evidence_fingerprint")})
            run.update(downloads=[], read_only=True,
                       review_observation="Recorded offline baseline; exports are disabled in the public demo.")
            api_get[f"/api/runs/{run['id']}"] = run
            history = app.list_runs(case)
            for item in history:
                item.update(read_only=True)
            api_get[f"/api/runs?incident={case}"] = {"runs": history}
            artifacts[case] = {}
            for item in list_artifacts(app.incident(case)):
                name, lines, line = item["name"], [], 1
                while line is not None:
                    page = read_artifact(app.incident(case), name, line, 200)
                    lines.extend(page["lines"])
                    line = page["next_line"]
                artifacts[case][name] = {"name": name, "total_lines": len(lines), "lines": lines}
    if not details:
        raise ValueError("A Meta-first demo needs actual sanitized model recordings.")
    eligible = [detail for detail in details if detail["fixture_matches"] and detail["outcome"] == "repair"]
    if not eligible:
        raise ValueError("No recorded repair matches the synthetic case being exported.")
    # Prefer an actual rejection/recovery, never fabricate an extra step.
    eligible.sort(key=lambda detail: (any(step.get("error") is True for step in detail["steps"]),
                                      detail["provenance"]["recorded_at"]), reverse=True)
    default = eligible[0]
    counts = Counter(detail["outcome"] for detail in details)
    evaluation = {"scope": SCOPE, "recording_count": len(details),
                  "outcomes": {name: counts[name] for name in ("repair", "stop", "error", "incomplete")},
                  "interpretation": "Observed outcomes, not a general success rate. A repair label alone is not an independent evaluation.",
                  "adapted_script_comparison": [
                      {"incident_id": case["id"], "outcome": api_get[f"/api/runs?incident={case['id']}"]["runs"][0]["status"]}
                      for case in cases]}
    if story_report is not None:
        # Only bounded, public observations; never include raw response/session/disk paths.
        evaluation["story"] = _clean({"scope": story_report.get("scope"),
            "configuration": story_report.get("configuration"), "planned_attempts": story_report.get("planned_attempts"),
            "unattempted": story_report.get("unattempted"), "batch_stopped": story_report.get("batch_stopped"),
            "judgments": story_report.get("judgments"), "usage": story_report.get("usage"),
            "attempts": [{"id": a["id"], "incident_id": a["incident_id"], "seed": a["seed"], "outcome": a["outcome"],
                          "judgment": a.get("assessment", {}).get("judgment"),
                          "frozen_parser": a["frozen_parser"]["outcome"],
                          "adapted_parser": a["adapted_parser"]["judgment"]}
                         for a in story_report.get("attempts", [])]})
    api_get["/api/incidents"] = {"mode": "recorded_read_only_demo", "incidents": cases}
    data = {"schema_version": 1, "read_only": True, "label": LABEL,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "capabilities": {"investigate": False, "rehearse": False, "export": False, "live_model": False},
            "defaults": {"incident_id": default["incident_id"], "source": "recorded", "recording_id": default["id"]},
            "api_get": api_get, "artifacts": artifacts, "evaluation": evaluation}
    encoded = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    if len(encoded) > MAX_DATA_BYTES:
        raise ValueError("Public demo data exceeds the 8 MB limit; do not publish a partial dataset.")
    public = root / "public"
    public.mkdir()
    (public / "demo-data.json").write_bytes(encoded)
    manifest = {"schema_version": 1, "read_only": True, "label": LABEL, "recordings": len(details),
                "outcomes": evaluation["outcomes"], "cases": len(cases), "bytes": len(encoded),
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "public_files": ["demo-data.json"],
                "warning": "Publish only public/. private-build/ contains local databases and is excluded."}
    (root / "export-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest
