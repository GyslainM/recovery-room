"""CLI-only evaluation of observed runs, after the offline controller has acted.

This module may read fixture truth. It is never imported by the workbench or
registered as an agent/browser tool. Development fixtures are not blind holdouts.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import sqlite3
import time

from .checks import check_state, evaluate_fixture
from .baselines import similarity_only_candidates
from .db import snapshot
from .fixtures import evidence_index
from .workbench import CASES, CASE_CATALOG, MODE, Workbench


JUDGMENTS = ("correct_repair", "justified_stop", "incorrect_export", "unjustified_stop",
             "rejected_repair", "technical_error", "incomplete")
SCOPE = ("Public synthetic development fixtures from one import/retry family. "
         "The optional split-evidence case varies file formats, not repair authority or failure family. "
         "Seeds vary identifiers, not failure families. No held-out reliability estimate or AI advantage is established.")


def assess_trial(root: Path, record: dict, before: dict, candidate: Path | None, exported: bool) -> dict:
    """Score actual state and a structured stop reason, never model/script prose alone."""
    truth = json.loads((root / "evaluation" / "ground_truth.json").read_text(encoding="utf-8"))
    incident = root / "incident"
    source_unchanged = snapshot(incident / "orders.db") == before
    after = snapshot(candidate) if candidate is not None else before
    original = {row["id"]: row for row in before["orders"]}
    current = {row["id"]: row for row in after["orders"]}
    expected_active = set(truth["active_order_ids"])
    expected_duplicates = set(truth["duplicate_order_ids"])
    active = {row["id"] for row in after["orders"] if row["status"] == "active"}
    harmed_later = sorted(key for key in truth["legitimate_later_order_ids"] if current.get(key) != original[key])
    harmed_valid = sorted(key for key in expected_active if current.get(key) != original[key])
    plan = record.get("plan")
    targets = {action["order_id"] for action in plan["cancellations"]} if plan else set()
    plan_matches = targets == expected_duplicates
    status = record["status"]
    observed = "repair" if status == "ready_for_review" else "stop" if status == "stopped" else status
    fixture = evaluate_fixture(root, candidate, observed)
    groups, _ = evidence_index(incident)
    source_events = {row["event_id"] for row in json.loads(
        (incident / "evidence" / "source_orders.json").read_text(encoding="utf-8"))}
    missing = sorted(source_events - groups.keys())
    stop_supported = (
        truth["expected_outcome"] == "stop" and observed == "stop"
        and record.get("stop_reason") == "missing_commit_mappings"
        and bool(missing) and sorted(record.get("missing_event_ids", [])) == missing
        and plan is None and candidate is None and not exported and source_unchanged
    )
    review = record.get("review") or {}
    operational = review.get("checks", [])
    candidate_checks = check_state(incident, candidate, before, targets) if candidate is not None else []
    naive = similarity_only_candidates(incident)
    correct_repair = (
        truth["expected_outcome"] == "repair" and observed == "repair" and candidate is not None
        and fixture["passed"] and plan_matches and not harmed_valid and source_unchanged
        and review.get("passed") is True and bool(operational) and all(c["passed"] for c in operational)
        and bool(candidate_checks) and all(c["passed"] for c in candidate_checks)
    )
    if exported:
        judgment = "correct_repair" if correct_repair else "incorrect_export"
    elif status == "error":
        judgment = "technical_error"
    elif observed == "stop":
        judgment = "justified_stop" if stop_supported else "unjustified_stop"
    elif status in ("blocked", "failed_checks"):
        judgment = "rejected_repair"
    else:
        judgment = "incomplete"
    return {
        "judgment": judgment, "expected_outcome": truth["expected_outcome"],
        "observed_outcome": observed, "exported_for_review": exported,
        "source_unchanged": source_unchanged, "fixture_evaluation": fixture,
        "plan_targets_match_truth": plan_matches if plan else None,
        "stop_evidence_gap_matches": stop_supported if observed == "stop" else None,
        "before_active": sum(row["status"] == "active" for row in before["orders"]),
        "after_active": len(active), "proposed_cancellations": len(targets),
        "cancelled_duplicates": sum(current.get(key, {}).get("status") == "cancelled" for key in expected_duplicates),
        "duplicates_left_active": sorted(expected_duplicates & active),
        "unexpected_cancellations": sorted((set(original) - active) - expected_duplicates),
        "valid_orders_harmed": harmed_valid, "later_orders_harmed": harmed_later,
        "later_orders_preserved": len(truth["legitimate_later_order_ids"]) - len(harmed_later),
        "stock_matches_truth": {row["sku"]: row["on_hand"] for row in after["products"]} == truth["stock"],
        "operational_checks_passed": sum(c["passed"] for c in operational),
        "operational_checks_total": len(operational),
        "candidate_checks_at_evaluation": candidate_checks,
        "similarity_baseline": {
            "candidate_order_ids": naive, "candidates": len(naive),
            "later_purchase_ids_at_risk": sorted(set(naive) & set(truth["legitimate_later_order_ids"])),
            "later_purchases_at_risk": len(set(naive) & set(truth["legitimate_later_order_ids"])),
            "targets_match_truth": set(naive) == expected_duplicates,
            "rehearsed": False, "exported": False,
        },
    }


def run_benchmark(root: Path, seeds: list[int], scenarios: list[str] | None = None) -> dict:
    if (not isinstance(seeds, list) or not 1 <= len(seeds) <= 10
            or any(type(seed) is not int or not 0 <= seed <= 2**32 - 1 for seed in seeds)
            or len(set(seeds)) != len(seeds)):
        raise ValueError("Choose 1 to 10 distinct integer seeds from 0 to 4294967295.")
    by_scenario = {scenario: key for key, (_, scenario) in CASE_CATALOG.items()}
    selected = [scenario for _, scenario in CASES.values()] if scenarios is None else scenarios
    if (not isinstance(selected, list) or not selected
            or any(not isinstance(s, str) or s not in by_scenario for s in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError("Choose distinct built-in scenario names.")
    identifiers = tuple(by_scenario[s] for s in selected)
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    trials = []
    for seed in seeds:
        app = Workbench(root / f"seed-{seed}", seed=seed, case_ids=identifiers)
        for identifier, (_, scenario) in app.catalog.items():
            started = time.monotonic()
            record = None
            before = None
            candidate = None
            exported = False
            error = None
            case_root = app.incident(identifier).parent
            try:
                before = snapshot(app.incident(identifier) / "orders.db")
                record = app.investigate(identifier)
                if record["status"] == "proposed":
                    record = app.rehearse(record["id"])
                result = app.results.get(record["id"])
                candidate = Path(result["candidate_path"]) if result else None
                if record["status"] == "ready_for_review":
                    # Exercise the actual freshness-gated download path, not just a label.
                    for filename in record["downloads"]:
                        app.download(record["id"], filename)
                    exported = "repair.sql" in record["downloads"]
                # Ground truth is read only after the controller's decision/rehearsal.
                assessment = assess_trial(case_root, record, before, candidate, exported)
            except (ValueError, OSError, KeyError, TypeError, sqlite3.Error) as exc:
                error = f"{type(exc).__name__}: {exc}"
                source_unchanged = None
                if before is not None:
                    try:
                        source_unchanged = snapshot(app.incident(identifier) / "orders.db") == before
                    except (OSError, sqlite3.Error):
                        source_unchanged = False
                assessment = {"judgment": "technical_error", "observed_outcome": "error",
                              "exported_for_review": exported,
                              "source_unchanged": source_unchanged}
            run_folder = root / f"seed-{seed}" / "investigations" / record["id"] if record else None
            trial = {
                "id": f"{scenario}-seed-{seed}", "scenario": scenario, "seed": seed,
                "approach": "event_aware_script", "mode": MODE, "model_calls": 0,
                "summary": record["summary"] if record else error,
                "elapsed_seconds": round(time.monotonic() - started, 6),
                "investigation_read_calls": len(record["trace"]) if record else 0,
                "rehearsals": int(record is not None and record["id"] in app.results),
                "incident_path": str(app.incident(identifier).relative_to(root).as_posix()),
                "investigation_path": str((run_folder / "investigation.json").relative_to(root).as_posix()) if run_folder else None,
                "candidate_path": str(candidate.relative_to(root).as_posix()) if candidate else None,
                "repair_report": str((candidate.parent / "report.html").relative_to(root).as_posix()) if exported and candidate else None,
                "error": error, **assessment,
            }
            trials.append(trial)
            # Save each outcome promptly, including failures, before the next case.
            (root / "trials").mkdir(exist_ok=True)
            (root / "trials" / (trial["id"] + ".json")).write_text(json.dumps(trial, indent=2), encoding="utf-8")
    counts = Counter(trial["judgment"] for trial in trials)
    report = {
        "mode": MODE, "approach": "event_aware_script", "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": SCOPE, "seeds": seeds, "scenarios": selected,
        "trials_total": len(trials), "scenario_variants": len(selected),
        "incident_families": 1, "live_model_runs": 0,
        "judgments": {name: counts[name] for name in JUDGMENTS},
        "passed": all(trial["judgment"] in ("correct_repair", "justified_stop") for trial in trials),
        "html_report": str(root / "report.html"), "json_report": str(root / "report.json"),
        "trials": trials,
    }
    (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (root / "report.html").write_text(render_report(report), encoding="utf-8")
    return report


def render_report(report: dict) -> str:
    escape = lambda value: html.escape(str(value))
    rows = []
    for trial in report["trials"]:
        state = f"{trial.get('before_active', '—')} → {trial.get('after_active', '—')}"
        preserved = trial.get("later_orders_preserved", "—")
        artifacts = []
        for key, label in (("investigation_path", "Script trace"), ("repair_report", "Repair review")):
            if trial.get(key):
                artifacts.append(f'<a href="{escape(trial[key])}">{label}</a>')
        stock = "yes" if trial.get("stock_matches_truth") else "no" if "stock_matches_truth" in trial else "—"
        source = "yes" if trial.get("source_unchanged") else "NO" if trial.get("source_unchanged") is False else "—"
        naive = trial.get("similarity_baseline", {})
        rows.append(
            "<tr>" + "".join(f"<td>{cell}</td>" for cell in (
                escape(trial["scenario"]), escape(trial["seed"]),
                escape(trial["judgment"].replace("_", " ")), escape(state), escape(preserved),
                stock, source, escape(naive.get("candidates", "—")), escape(naive.get("later_purchases_at_risk", "—")),
                escape(trial["investigation_read_calls"]), escape(trial["rehearsals"]),
                escape(trial["elapsed_seconds"]), " · ".join(artifacts) or "—",
            )) + "</tr>"
        )
    summaries = "".join(f"<li><strong>{count}</strong> {escape(name.replace('_', ' '))}</li>"
                        for name, count in report["judgments"].items())
    details = "".join(f"<details><summary>{escape(t['id'])} · {escape(t['judgment'].replace('_',' '))}</summary>"
                      f"<p>{escape(t['summary'])}</p><pre>{escape(json.dumps(t, indent=2))}</pre></details>"
                      for t in report["trials"])
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Recovery Room · Offline baseline evaluation</title>
<style>body{{margin:0;background:#f6f5ef;color:#20322e;font:15px/1.6 system-ui,sans-serif}}
main{{max-width:1450px;margin:40px auto;padding:0 25px 60px}}h1{{font-size:36px;line-height:1.2}}
.label{{font:12px ui-monospace,monospace;color:#9b4c2e}}.scope{{padding:18px;border-left:4px solid #a77642;background:#f1e9db}}
.scroll{{overflow:auto}}table{{border-collapse:collapse;width:100%;font-size:12px;background:#fffefa;white-space:nowrap}}
th,td{{padding:11px;text-align:left;border-bottom:1px solid #dce0d6;vertical-align:top}}th{{background:#eaf0e3}}
ul{{display:flex;flex-wrap:wrap;gap:12px 25px;padding:0;list-style:none}}li strong{{font-size:22px;color:#2e6551}}
a{{color:#2e6551}}details{{border-bottom:1px solid #dce0d6;padding:14px 0}}summary{{cursor:pointer}}
pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#fffefa;padding:16px;font-size:12px}}
</style></head><body><main><p class="label">OFFLINE DETERMINISTIC SCRIPT · SYNTHETIC DATA · NO MODEL RUNS</p>
<h1>Offline baseline evaluation</h1><p>{report['trials_total']} trials · {report['scenario_variants']} scenario variants ·
{report['incident_families']} incident family · {report['live_model_runs']} live model runs</p>
<p class="scope">{escape(report['scope'])}</p><ul>{summaries}</ul>
<p>The event-aware script is the competent baseline. Meta has not been measured here.
No model comparison or general reliability percentage is claimed. All trial outcomes, including failures, are retained.</p>
<p>The competent event-aware script also parses the optional CSV receipt archive; it is not limited to the original JSONL format.
Similarity-only figures are candidate flags and later purchases at risk, scored after the decision using fixture truth.
That weak baseline was not rehearsed or exported; these figures do not claim that the runtime accepted those cancellations.</p>
<h2>Observed outcomes</h2><div class="scroll"><table><thead><tr><th>Scenario</th><th>Seed</th><th>Judgment</th>
<th>Active records</th><th>Later preserved / 10</th><th>Stock correct</th><th>Source unchanged</th>
<th>Similarity flags</th><th>Later purchases at risk</th>
<th>Read calls</th><th>Rehearsals</th><th>Seconds</th><th>Artifacts</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<p>Stock is compared with the repaired fixture truth. A justified stop leaves stock and records unchanged;
it is expected to show unrepaired stock. Elapsed time includes local investigation, rehearsal, export and scoring.
Read-call counts describe the script’s fixed sequence, not model tool use.</p>
<h2>How judgments are made</h2><p>Repairs require exact expected active IDs and stock, preservation of valid order records,
matching targets, passing operational checks, an unchanged source, and a real freshness-gated export.
Stops require the expected stop outcome and the exact observed evidence gap, a matching structured reason,
no plan, no candidate, no export and an unchanged source. The stop label or fluent explanation alone is insufficient.</p>
<p>Fixture truth is read by this CLI-only evaluator after the controller acts; it is not exposed by browser or agent tools.
These development cases and their answers are public and are not blind holdouts.</p>
<h2>Every trial</h2>{details}<p><a href="report.json">Full evaluation JSON</a></p></main></body></html>"""
