"""Small CLI: offline engine demonstration, fixture creation, and opt-in live agent."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

from .agent import MetaClient, run_agent
from .baselines import event_aware_plan, similarity_only_candidates
from .checks import evaluate_fixture
from .fixtures import SCENARIOS, create_incident
from .repairs import finalize_report, rehearse


def default_output(prefix: str) -> Path:
    return Path("runs") / (prefix + "-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f"))


def offline_demo(root: Path, seed: int) -> dict:
    incident = create_incident(root, "complete", seed)
    truth = json.loads((root / "evaluation" / "ground_truth.json").read_text(encoding="utf-8"))
    naive = similarity_only_candidates(incident)
    legitimate = set(truth["legitimate_later_order_ids"])
    plan = event_aware_plan(incident)
    result = rehearse(incident, plan, root / "rehearsals")
    report = finalize_report(incident, result)
    evaluation = evaluate_fixture(root, Path(result["candidate_path"]), "repair")
    summary = {
        "mode": "offline_deterministic_engine_demo_NOT_a_model_run",
        "incident": str(incident.resolve()),
        "before_active": report["totals"]["before_active"],
        "after_active": report["totals"]["after_active"],
        "duplicate_orders_cancelled": report["totals"]["cancellations"],
        "legitimate_later_orders_preserved": len(legitimate),
        "similarity_baseline": {
            "candidates": len(naive), "legitimate_orders_it_would_cancel": len(set(naive) & legitimate),
        },
        "event_aware_script_baseline": {
            "passed": evaluation["passed"],
            "finding": "The structured starter incident is solvable by a competent script. No AI advantage has been established.",
        },
        "operational_checks_passed": sum(check["passed"] for check in result["checks"]),
        "operational_checks_total": len(result["checks"]),
        "fixture_evaluation": evaluation,
        "report": str(Path(result["folder"]) / "report.html"),
        "repair_script": str(Path(result["folder"]) / "repair.sql"),
    }
    (root / "demo-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Recovery Room: investigate, rehearse on a copy, verify, review.")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="Run an explicitly deterministic offline demonstration; no API calls.")
    demo.add_argument("--out", type=Path)
    demo.add_argument("--seed", type=int, default=7)
    fixture = sub.add_parser("fixture", help="Create a synthetic incident and a separate private evaluator.")
    fixture.add_argument("--out", type=Path, required=True)
    fixture.add_argument("--scenario", choices=SCENARIOS, default="complete")
    fixture.add_argument("--seed", type=int, default=7)
    agent = sub.add_parser("agent", help="Run the live Meta agent. This sends the selected incident evidence to Meta.")
    agent.add_argument("--incident", type=Path, required=True)
    agent.add_argument("--out", type=Path, default=Path("runs"))
    agent.add_argument("--model")
    agent.add_argument("--max-rounds", type=int, default=16)
    agent.add_argument("--max-completion-tokens", type=int, default=4096,
                       help="1024 to 16384 tokens per response, including reasoning (default: 4096); not a dollar cap.")
    repair = sub.add_parser("rehearse", help="Rehearse a user-supplied bounded plan on a fresh copy.")
    repair.add_argument("--incident", type=Path, required=True)
    repair.add_argument("--plan", type=Path, required=True)
    repair.add_argument("--out", type=Path, default=Path("runs"))
    evaluate = sub.add_parser("evaluate", help="Use private fixture truth after a run; never available as an agent tool.")
    evaluate.add_argument("--root", type=Path, required=True)
    evaluate.add_argument("--candidate", type=Path)
    evaluate.add_argument("--outcome", choices=("repair", "stop"), required=True)
    local = sub.add_parser("serve", help="Open a local offline investigation/review workbench; no API calls.")
    local.add_argument("--out", type=Path, help="Fresh session directory; existing runs are never overwritten.")
    local.add_argument("--port", type=int, default=8765)
    benchmark = sub.add_parser("benchmark", help="Evaluate the offline event-aware script on development fixtures; no API calls.")
    benchmark.add_argument("--out", type=Path, help="New output directory; previous evaluations are preserved.")
    benchmark.add_argument("--seeds", type=int, nargs="+", default=[7, 23, 41], help="1 to 10 distinct seeds (default: 7 23 41). Seeds vary IDs, not failure families.")
    benchmark.add_argument("--scenarios", choices=SCENARIOS, nargs="+",
                           help="Opt into selected format/incident variants; defaults to the original three cases.")
    args = parser.parse_args(argv)
    try:
        if args.command == "benchmark":
            from .evaluation import run_benchmark
            benchmark_result = run_benchmark(args.out or default_output("benchmark"), args.seeds, args.scenarios)
            value = {key: value for key, value in benchmark_result.items() if key != "trials"}
        elif args.command == "serve":
            from .workbench import serve
            serve(args.out or default_output("workbench"), args.port)
            return 0
        elif args.command == "demo":
            value = offline_demo(args.out or default_output("demo"), args.seed)
        elif args.command == "fixture":
            incident = create_incident(args.out, args.scenario, args.seed)
            value = {"incident": str(incident.resolve()), "scenario": args.scenario, "agent_has_no_access_to_evaluation_directory": True}
        elif args.command == "agent":
            client = MetaClient(args.model, max_completion_tokens=args.max_completion_tokens)
            value = run_agent(args.incident.resolve(), args.out, client, max_rounds=args.max_rounds)
            print(json.dumps(value, indent=2))
            return 0 if value["final"]["outcome"] in ("repair", "stop") else 1
        elif args.command == "rehearse":
            plan = json.loads(args.plan.read_text(encoding="utf-8"))
            result = rehearse(args.incident, plan, args.out)
            value = finalize_report(args.incident, result) if result["passed"] else {
                key: value for key, value in result.items() if key not in ("before", "after")
            }
        else:
            value = evaluate_fixture(args.root, args.candidate, args.outcome)
        print(json.dumps(value, indent=2))
        return 0 if value.get("passed", True) else 1
    except (ValueError, OSError, KeyError) as exc:
        print(f"Recovery Room: {exc}", file=sys.stderr)
        return 2
