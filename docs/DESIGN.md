# Design

Recovery Room repairs one kind of incident: an import that was retried after a
partial failure and left repeated orders behind. The goal is to identify the
repeats from evidence, rehearse a compensating repair on a copy, preserve every
valid purchase, and give a person a checked artifact to review. The model can
propose; only the application can decide that a repair passed.

## Components and authority

| Component | Reads | Writes |
| --- | --- | --- |
| Fixture generator | Seed and case selection | Synthetic incident, evidence, separate answer key |
| Agent's SQL tool | Allowlisted original tables | Nothing |
| Agent's evidence tool | Allowlisted evidence files | Nothing |
| Rehearsal engine | Snapshot, cited evidence, source import, opening stock | A fresh candidate copy |
| Operational checks | Before/after states and declared evidence | Check results |
| Exporter | A passed rehearsal and current source/evidence fingerprints | SQL, plan, HTML and JSON report |
| Private evaluator | The answer key and the observed outcome | An evaluation result |

The model can call five tools: read the schema, list evidence files, read
evidence with line numbers, run bounded read-only SQL, and rehearse a repair on a
new copy. It has no shell, file system, SQL write, network, evaluator or
check-editing tool. Its final message never decides whether a repair passed.

## The incident

A source file defines 50 purchases. The first import writes 20, then loses its
connection. The retry inserts all 50 again, because the legacy importer neither
stored nor enforced an idempotency key. Ten genuine web purchases arrive
afterwards. The database rows carry no source reference, but the importer's log
records which committed write belongs to which source event.

The later purchases deliberately repeat earlier customer, product and quantity
combinations, so similarity cannot tell repeats from real orders. A
similarity-only match flags 30 orders in the 80-order cases (50 with two
retries), always including all 10 genuine purchases.

Six synthetic cases share this schema and repair action:

| Case | What changes | Correct result |
| --- | --- | --- |
| Import retried after timeout | Complete JSONL event log | Cancel 20 repeats: 80 → 60 active |
| Commit evidence missing | Commit records for some events withheld | Stop and name the missing events |
| Two retries after partial imports | 20 + 20 + 50 writes, then 10 purchases | Cancel 40 repeats: 100 → 60 active |
| Archived commits across CSV and JSONL | First-attempt receipts in a CSV archive; both files out of order | Cancel 20 repeats: 80 → 60 active |
| The receipts are in the inbox | First-attempt receipts copied into an inbox among people's messages | Cancel 20 repeats: 80 → 60 active |
| An inbox claim without commit proof | Both commit records for one event withheld | Stop and name the missing event |

These are variations of one failure family, not distinct incident types.

## Evidence rules

- Evidence comes only from allowlisted files, read in pages of at most 200
  lines from files of at most 1 MB. There is no glob, directory reader or
  general file tool, and paths and symlinks are checked.
- Optional formats must be declared. The event log declares the exact archive or
  inbox file name, format and receipt count; a missing, conflicting or
  undeclared file is rejected.
- In the CSV archive, every receipt is one line under a fixed header. In the
  inbox, only complete lines carrying the `RR-COMMIT v1` marker count as commit
  evidence. Narrative text, complaints, amounts, receipt IDs and similarity never
  authorize a cancellation.
- Sequenced writes carry unique positive sequence numbers up to 10,000. The first
  recorded write is decided by sequence, not by position in a file.
- Citations are exact file lines, such as `events.jsonl:L32`. Reports quote the
  original line text.
- Every evidence file, optional ones included, is part of the evidence
  fingerprint. Changing, adding or removing one invalidates a prepared export.

Malformed or conflicting evidence is a validation error with no export, never a
stop that earns credit.

## The repair grammar

Each cancellation names a repeated order, the order to keep, and at least two
exact evidence lines tying both to the same source event. The runtime checks
that both rows match the source purchase and that the kept order is the first
recorded write for that event. It rejects cancellation chains, unknown IDs,
forged citations and ambiguous sale movements. One repair has at most 40
cancellations.

A cancellation sets the repeated order's status to cancelled, appends one
compensating stock movement, and adjusts that product's inventory. Original
orders and sale movements stay as history. A unique reversal link prevents double
compensation, so running the same repair twice changes nothing.

This grammar is deliberately narrower than generated SQL. Other incident types
would need their own design.

## Checks

Ten checks run on every rehearsal:

1. Database integrity, including foreign keys.
2. Every untargeted order matches its original record exactly.
3. Corrections keep the original order identities, quantities and customers.
4. Original stock movements stay intact; corrections are compensating entries.
5. Opening stock plus all recorded movements equals current stock.
6. Stock reconciles with all active purchases, later purchases included.
7. Every source event has an observable committed write.
8. Exactly one order stays active per imported source event.
9. The source database is unchanged by the rehearsal.
10. The evidence files are unchanged by the rehearsal.

A changed source or evidence file also blocks export later. The private evaluator compares the
result with the answer key afterwards. No agent tool can reach it.

The checks are application rules, not a formal proof. Wrong rules, unmodelled
side effects or a different schema would weaken them. Shipments, payments and
refunds are out of scope.

## Export

The exported SQLite script opens a write transaction and compares the full
contents of the supported tables with the rehearsed before-state, or the exact
after-state. Any mismatch fails an assertion and rolls back before a single
repair write. Applying the same script twice is a no-op.

These guards are deliberately strict: even an unrelated new purchase makes a
prepared script stale. The application never applies a script to the original
database. A person reviews it; "ready for review" never means "approved".

## The agent loop

The client uses Meta's Chat Completions tool protocol over the standard-library
HTTP client and a fixed endpoint. Each run has explicit bounds: 1 to 24 model
responses, 1 to 48 local tool calls, 1,024 to 16,384 completion tokens per
response, and a context-size limit. There are no automatic retries or background
calls.

- Every response is validated before use. A malformed tool-call batch is rejected
  whole, before any of its calls run, and tool-call IDs must be unique.
- A well-formed call with bad JSON arguments or an unknown tool name gets local
  error feedback, so the model can correct itself.
- The final answer has exactly three fields: `outcome`, `summary` and
  `rehearsal_id`, which must be null for a stop. A claimed repair must name a
  real passed rehearsal and still pass the freshness-gated export.
- A response cut off by the token limit is an error, and none of its tool calls
  run. Running out of rounds is an incomplete attempt, never a stop or a repair.
- Each run saves `transcript.json`, `responses.json` and `result.json`, including
  rejected responses. API keys and authorization headers are never saved.

## Workbench and public demo

The local workbench binds to `127.0.0.1` and serves the bundled interface. Routes
take case and run IDs and allowlisted artifact names only. There are no endpoints
for arbitrary paths, uploads, SQL, candidate databases, the evaluator or
credentials. Host and Origin checks reject cross-site requests,
and the few actions accept only a small empty JSON body. It is a local
development tool, not an authenticated service.

Started with `--live` and `MODEL_API_KEY` in the server's own environment, the
workbench offers **Investigate with Muse Spark**. The browser can only start a
run for the case on screen and read its progress: the server holds the key,
runs the agent in a background thread with the evaluation batches' limits, and
reports each step as the agent takes it. One run per case can be active. When it
ends, the run is saved through the same export as any recording and opens in
the usual review. Without `--live` or a key, the workbench makes no model calls.

**Script investigation** runs the offline event-aware script, labelled as such. Downloads repeat every freshness check. With `--recordings`,
the workbench also shows saved agent runs read-only. Each recording's input
fingerprints are compared with the served case, and its citations are disabled
on a mismatch.

The public demo is a static package of fixed files with an inert dataset. It
replays saved runs and has no model, repair or export endpoint.
