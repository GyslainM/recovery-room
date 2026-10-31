"""JSONL/CSV evidence parser frozen at 7543e3a, before receipt-inbox construction.

Coverage control only. The adapted event-aware parser is a separate competent
baseline; a stop here never establishes that a model is necessary.
"""
import csv
import json
from .fixtures import _artifact_path, artifact_names, RECEIPT_FIELDS
from pathlib import Path

def frozen_evidence_index(incident: Path) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    groups: dict[str, list[dict]] = {}
    refs: dict[str, dict] = {}
    archives = []
    commits = []

    def validate_ids(event):
        if any(not isinstance(event.get(field), str) or not 1 <= len(event[field]) <= 80
               for field in ("event_id", "order_id", "movement_id", "attempt")):
            raise ValueError("Committed-write identifiers must be nonempty strings of at most 80 characters.")

    for number, line in enumerate(_artifact_path(incident, "events.jsonl").read_text(encoding="utf-8").splitlines(), 1):
        event = json.loads(line)
        if not isinstance(event, dict):
            raise ValueError("Event log lines must be JSON objects.")
        ref = f"events.jsonl:L{number}"
        refs[ref] = event
        if event.get("type") == "receipt_archive":
            archives.append(event)
        if event.get("type") == "write_committed":
            validate_ids(event)
            commits.append({**event, "ref": ref})
    has_archive = "commit_receipts.csv" in artifact_names(incident)
    if has_archive or archives:
        if not has_archive or len(archives) != 1:
            raise ValueError("Exactly one declared commit receipt archive is required.")
        archive = archives[0]
        if (set(archive) != {"type", "name", "count", "format"}
                or archive["name"] != "commit_receipts.csv" or archive["format"] != "commit-receipts-v1"
                or type(archive["count"]) is not int or not 1 <= archive["count"] <= 200):
            raise ValueError("Unsupported commit receipt archive declaration.")
        lines = _artifact_path(incident, "commit_receipts.csv").read_text(encoding="utf-8").splitlines()
        try:
            if not lines or next(csv.reader([lines[0]], strict=True)) != list(RECEIPT_FIELDS):
                raise ValueError("Commit receipt CSV header does not match its declared format.")
            if len(lines) - 1 != archive["count"]:
                raise ValueError("Commit receipt archive row count does not match its declaration.")
            for number, line in enumerate(lines[1:], 2):
                cells = next(csv.reader([line], strict=True))
                if len(cells) != len(RECEIPT_FIELDS):
                    raise ValueError("Each CSV receipt must occupy one complete file line.")
                event = dict(zip(RECEIPT_FIELDS, cells))
                if event["type"] != "write_committed" or not event["commit_seq"].isascii() or not event["commit_seq"].isdigit():
                    raise ValueError("CSV receipts require a committed write and numeric commit sequence.")
                event["commit_seq"] = int(event["commit_seq"])
                validate_ids(event)
                ref = f"commit_receipts.csv:L{number}"
                refs[ref] = event
                commits.append({**event, "ref": ref})
        except (csv.Error, StopIteration) as exc:
            raise ValueError("Commit receipt CSV must contain complete single-line records.") from exc
        sequences, order_ids, movement_ids = set(), set(), set()
        for event in commits:
            seq = event.get("commit_seq")
            if type(seq) is not int or not 1 <= seq <= 10_000 or seq in sequences:
                raise ValueError("Split evidence requires unique positive commit sequences on every write.")
            if event.get("order_id") in order_ids or event.get("movement_id") in movement_ids:
                raise ValueError("Split evidence repeats an order or movement receipt; reconcile the evidence first.")
            sequences.add(seq)
            order_ids.add(event.get("order_id"))
            movement_ids.add(event.get("movement_id"))
        commits.sort(key=lambda event: event["commit_seq"])
    elif any("commit_seq" in event for event in commits):
        raise ValueError("Sequenced split evidence requires its declared commit receipt archive.")
    for event in commits:
        groups.setdefault(event["event_id"], []).append(event)
    return groups, refs

