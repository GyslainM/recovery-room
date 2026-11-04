# Design

## Goal

Identify repeated imported writes from existing evidence, rehearse supported
compensation on a new database copy, preserve all valid subsequent purchases,
and produce a reviewable artifact with checks that the model cannot edit.

## Components and authority

| Component | Reads | Writes |
| --- | --- | --- |
| Fixture generator | Seed and scenario selection | Synthetic incident, evidence, separate evaluation truth |
| Agent's SQL tool | Allowlisted original tables | Nothing |
| Agent's artifact tool | Allowlisted evidence files | Nothing |
| Rehearsal engine | Snapshot, cited logs, source import and opening stock | Fresh candidate copy |
| Operational checks | Before/after states and declared evidence | Check results |
| Exporter | Successful rehearsal and current source/evidence fingerprints | SQL, JSON and HTML artifacts |
| Private evaluator | Expected fixture truth and observed outcome | Evaluation result |

The model can request tools. It receives no shell, arbitrary filesystem, raw SQL
write, network mutation, evaluator, or checker-editing tool.
The application, not the model's final prose, determines whether a repair has
actually passed rehearsal.

## Fixture mechanics

The source file defines 50 purchases. The first attempt writes 20 and loses its
connection. Retrying all 50 inserts another 50 because the legacy import did not
persist or enforce an idempotency key. Ten legitimate web purchases then arrive.
The importer omitted source references in database rows but wrote event-to-order
relationships to its log. Those relationships support the complete-evidence case.

Later legitimate purchases deliberately match earlier customer/SKU/quantity
triples. Similarity is therefore insufficient to identify repeat writes.
The complete fixture is nevertheless easy for a competent structured-log script;
it is an engine-validation fixture, not evidence of a model advantage.

The missing-evidence variant withholds the committed-write mappings for the
affected source events. The model must not infer those missing identities.
A separate evaluator expects it to stop rather than export a guessed repair.

## Supported correction

Each cancellation names a repeated order, the canonical order to retain, and at
least two exact log references connecting them to the same known source event.
The runtime verifies that both rows match the source purchase and the retained
order is the first recorded write for that event. It rejects cancellation chains,
unknown IDs, forged citations, and ambiguous sale movements.

The engine changes the repeated order's status to cancelled, appends one
compensating stock movement, and adjusts that product's inventory. Original
orders and sale movements are retained. A unique reversal relationship prevents
double compensation. Repeated execution has no further effect.

This is a bounded repair grammar. It is intentionally less general than arbitrary
generated SQL and will need separate design work to support other incident types.

## Checks

Checks cover SQLite integrity, foreign keys, exact preservation of untargeted
orders, retained order history, immutable original movements, stock/ledger
agreement, stock/active-order agreement, evidence coverage, and exactly one
active recorded purchase per imported source event.

The source database and all allowlisted evidence files are fingerprinted around
rehearsal. A changed input invalidates export.
The private evaluator independently compares the result to fixture generation
truth. The evaluator's exact order IDs and answer key are never returned by an
agent tool.

Operational checks are application rules, not a formal proof. Incorrect rules,
missing real-world side effects, or a different schema can invalidate their value.
External shipments, payments and refunds are outside this project's scope.

## Export and changing state

The exported SQLite script starts a write transaction and compares the full
supported table contents with the rehearsed before-state or exact after-state.
Mismatch causes an INSERT OR ROLLBACK assertion to fail before any repair writes.
The transaction prevents concurrent SQLite writers between the precondition
check and the changes. A second exact application is a no-op.

Full-state guards are conservative: an unrelated new purchase also makes the
script stale. This is deliberate for the first version. Finer-grained read/write
sets would need additional concurrency reasoning and tests.

The application never applies the export to the original. Human review remains
required; "ready for review" must not be displayed as "production approved."

## Evidence limits

One incident family, a few evidence formats and several seeds do not measure
general agent reliability. Mock transport tests establish no model outcome. The
README lists the actual model attempts, failures included, beside the competent
event-aware baseline. A stronger evaluation would use failure patterns withheld
during development.

## Local workbench

The standard-library HTTP adapter binds to **127.0.0.1** and serves bundled
HTML/CSS/JavaScript. It creates curated synthetic cases (three by default;
**--cases** selects from six) in a new session directory. Routes accept case/run identifiers and allowlisted artifact names;
there are no browser endpoints for arbitrary paths, database uploads, SQL,
candidate databases, the fixture evaluator, model credentials or live calls.
Host and Origin checks reject cross-site requests and DNS-rebinding hosts;
mutations accept a bounded empty JSON object. This is a local development tool,
not an authenticated public service or an operating-system sandbox.

The offline controller records actual schema, evidence and bounded SQL reads,
checks source-event evidence coverage, then invokes the existing event-aware
baseline. Missing mappings cause a specific stop with no candidate. It never
reads evaluation truth. The trace is explicitly script observations, not model
reasoning. Its fixed read sequence is not evidence of adaptive AI investigation.

Rehearsal delegates to **repairs.rehearse**. The UI derives before/after views
from its actual snapshots; original checks remain unchanged. Export delegates
to **finalize_report** after checking investigation fingerprints and the exact
candidate snapshot. Every download repeats these checks, including when a
previous export already exists. A changed input blocks the run; the next step
is a fresh investigation and rehearsal. Downloads include only SQL, plan and
HTML/JSON reports, never a browser action that applies SQL to the source.

Run registries live for one server process; persisted investigation JSON and
engine artifacts survive shutdown. Browser case-switching retains current runs
in page memory. The browser never calls a model: the agent runs from the command
line, and **--recordings** shows its saved runs read-only. No frontend dependency or separate implementation of repair rules is used.

## Multiple retries and offline evaluation

The multiple-retries case adds a second partial attempt before the final full retry: 20 + 20 + 50 imported
writes, then 10 later purchases. Forty repeated writes can be cancelled using
the existing grammar. No schema, repair authority, 40-action limit or operational
checker was extended. Existing complete/missing-evidence generation remains
identical at the same seed. This is a variation of the same failure family.

The **benchmark** CLI creates new fixtures for each selected seed and invokes
the same offline workbench controller, including actual rehearsal and download
freshness checks. Only after each decision does its separate evaluator read
fixture truth. The workbench, baseline and agent have no route to that evaluator.
The evaluator compares exact active IDs, stock, target IDs and preserved valid
records, and recomputes candidate operational checks rather than trusting cached
pass flags. A stopped trial must identify the exact observable commit-evidence
gap with the structured **missing_commit_mappings** reason and produce no plan,
candidate or export. This is stronger than the original CLI stop-label check;
it does not by itself evaluate a live model's free-text explanation.

Reports retain per-trial artifacts and failures, with separate judgments for
correct repairs, justified stops, incorrect exports, unjustified stops, rejected
repairs, technical errors and incomplete attempts. A rejection is not counted as
a correct repair. Elapsed time includes scoring; script read/rehearsal counts
are not model tool-use measurements. No model results are generated or inferred.
The default nine trials are three development scenario variants at three seeds
within one incident family, not nine distinct failure types or blind holdouts.

## Provider-response validation

The controller validates response, choice, message, tool-call, usage and finish
metadata containers before using them. A malformed tool-call batch is rejected
in full before any of its tools run, even if its first request is a valid
copy-only rehearsal. Tool call IDs must be unique throughout the investigation.
Validly structured calls with bad JSON arguments or unsupported tool names keep
the existing local error-feedback behavior so a model can revise its request.

The final result must use the three declared fields: outcome, summary and
rehearsal_id. Stops require a null ID. Repairs still require an actual successful
run-local rehearsal and the existing freshness-gated export. These checks do not
assess the quality of a model's explanation or justify its decision to stop.

Response objects received by the controller are retained in **responses.json**
alongside **transcript.json** and **result.json**. This preserves rejected
structures for debugging without putting invalid envelopes into the next model
request. API keys and authorization headers are not part of these response
objects. Transport failures retain the responses and observations already seen.
HTTP request format, execution budgets, registered tools, engine/checker authority
and the source database are unchanged. Validation uses offline transports;
account-level Meta compatibility still requires a real authorized smoke test.
