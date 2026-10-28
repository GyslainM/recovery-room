# Recovery Room

Investigate a failed import, rehearse an evidence-supported correction on a copy,
and give a developer a checked repair package to review.

**Status: local investigation/review workbench, not a finished hackathon submission.**
The offline engine and tool boundaries are tested. A live Meta model run still
needs your own API access. No model success rate or production-safety claim is made.

## Start here

Python 3.11 or newer. No third-party runtime dependencies.
Open a terminal inside the extracted **recovery-room** directory.

~~~bash
python -m recovery_room demo
python -m unittest discover -s tests -v
~~~

On Windows, use **py -3** instead of **python** if needed.
The demo prints a path to **report.html**. Open that file in a browser to inspect
the before/after inventory, checks, proposed corrections, and exact evidence lines.
It also writes a guarded **repair.sql**, **plan.json**, and **report.json**.
All generated runs stay under **runs/** and are excluded from Git.

Contributors can also run the dependency-free frontend regression checks:

~~~cmd
node --test tests/test_workbench_ui.cjs
~~~

Node is needed only for these frontend tests, not to run the Python workbench.

### Local investigation and review while credits are pending

From CMD on this Windows checkout:

~~~cmd
cd /d "C:\Users\mucyo\projects\recovery-room\recovery-room"
py -3 -m recovery_room serve
~~~

Open [the local workbench](http://127.0.0.1:8765). Stop it with **Ctrl+C**.
Use **--port 8766** if the default port is busy. No frontend installation, model
key, external fonts or API access is required. The server binds only to loopback.

1. Choose a supplied synthetic case and inspect its records and paginated evidence.
2. Start an **offline script** investigation. The timeline records actual function
   calls and results, including evidence pagination; it is not model reasoning.
3. Inspect the bounded proposal and click citations to open exact evidence lines.
4. Rehearse on a disposable copy, then choose **Review repair**. Follow changes,
   checks and SQL; select a record or citation to open its closable Details panel.
5. Download guarded SQL, the plan, and HTML/JSON reports for human review. Each
   download checks source, evidence and candidate freshness again.

The missing-evidence case stops with the missing event IDs and a specific request
for commit records. It produces no candidate or repair export. This demonstrates
the deterministic workflow's stopping behavior, not model refusal quality.

**CASE 03 — Two retries after partial imports** exercises the same schema and
repair action at the existing limit. The first two attempts each write 20 rows;
the final retry writes all 50. With 10 later checkout purchases, that produces
100 active records. A supported plan cancels 40 repeated writes, retains each
event's first write, and leaves 60 purchases. This is another variation of the
same import/retry family, not a new failure family or a held-out benchmark.

Each server launch creates a fresh **runs/workbench-.../** session with its own
fixtures and persisted **investigations/run-.../investigation.json** records.
Existing runs are preserved. **--out** selects a new session directory and refuses
an existing one. The sidebar restores recorded runs from the current server
session after a reload. Start times come from the server; selecting an older
run never implies its export is fresh. Saved artifacts remain on disk.
This local server is for curated fixtures, not deployment or arbitrary uploads.

The approved backend contracts now support current-session history through
`GET /api/runs?incident=<id>`: `{"runs": [...]}`, newest first, with `id`,
`incident_id`, `status`, `summary`, `mode` and server-owned UTC `created_at`.
Run records retain that creation time across rehearsal and blocked exports.
Non-null reviews include `checkout_order_ids` for the server-classified later
purchases. The UI consumes both contracts. These routes do not load previous
server sessions or revalidate exports. Restart an already
running server after updating Python code to load the new routes.

The header keeps one **Offline demo · No model** indicator and a source/copy
status. Run details hold the full ID and supporting explanations. Export
freshness starts at **Passed at rehearsal · Recheck required**; **Recheck for
export** calls the existing guarded artifact route. A passed observation includes
its time, and each later export is checked again. A browser reload requires a
new freshness observation even when the recorded rehearsal passed.

### What the offline demo proves

For the opt-in harder CSV/JSONL evidence variation and its honest script
comparison, see [the split-evidence case](docs/EVIDENCE_CASE.md). Run it offline:

~~~cmd
py -3 -m recovery_room benchmark --scenarios complete split-evidence --seeds 7 23 41
~~~

The competent script handles both formats. This adds a development comparison,
without claiming model advantage or changing the browser's three default cases.

- A 50-order import stops after writing 20 orders.
- Retrying the full file leaves 70 imported records, including 20 repeats.
- Ten genuine purchases arrive afterward. They intentionally resemble earlier purchases.
- The incident contains 80 active order records; the correct result has 60.
- The deterministic event-aware baseline cancels the 20 repeated records, adds
  compensating stock movements, preserves all 10 later purchases, and leaves
  the original database untouched.
- A similarity-only baseline would also cancel all 10 genuine later purchases.

**Important finding:** the competent event-aware script also solves this first
structured case. It is included deliberately. The starter does not establish
that an AI agent outperforms a script or a general coding assistant.
Changing a random seed does not create a new failure type or a held-out benchmark.

## Run the live Meta agent

Create an incident once:

~~~bash
python -m recovery_room fixture --out runs/live-case --seed 23
~~~

Set **MODEL_API_KEY** locally. Do not put a key in source control or chat.
The application reads the process environment; it does not load **.env** files.

PowerShell:

~~~powershell
$secret = Read-Host "Meta API key" -AsSecureString
$env:MODEL_API_KEY = [System.Net.NetworkCredential]::new("", $secret).Password
py -3 -m recovery_room agent --incident runs/live-case/incident --out runs/live-case/agent-runs
~~~

macOS/Linux:

~~~bash
read -r -s -p "Meta API key: " MODEL_API_KEY
export MODEL_API_KEY
python -m recovery_room agent --incident runs/live-case/incident --out runs/live-case/agent-runs
~~~

The live command sends the selected incident's records and evidence to Meta.
Use the supplied synthetic fixtures for this first test.
No network call is made by the offline demo, tests, fixture creation, or rehearsal command.

Default model: **muse-spark-1.3**. Select another enabled model with
**--model** or the **RECOVERY_ROOM_MODEL** environment variable.
Availability must be checked in your account. The client uses the documented
Meta Chat Completions tool protocol, the standard-library HTTP client, and the
fixed official endpoint. A first live development pass with Muse Spark 1.3 on
October 28, 2026 produced one independently verified repair, one verified stop,
and two output-token-limit errors across four public fixture variants. This
establishes live integration, not general reliability or an AI advantage.
Subsequent **budget-aware-v1** runs with 24 rounds and 8192 completion tokens
independently verified both previously failed repairs: split evidence **80 → 60**
and multiple retries **100 → 60**, preserving all 10 later purchases in each.
Across those first seven actual attempts, four completed correctly and three earlier
attempts failed or remained incomplete. The earlier attempts remain retained;
these development observations do not establish a general model pass rate.
A subsequent frozen-configuration check and fixed repeat pass produced **six
correct outcomes**, giving **eight observed correct outcomes under budget-aware-v1**
(two per supported case, identical public seed-23 inputs). Every repair passed
independent evaluation and SQL replay; stops were separately reviewed. One stop
summary had an order-count wording imprecision, preserved in the review notes.
All **13** actual attempts are retained: **10** correct completed outcomes and
**3** earlier unsuccessful attempts across configurations. These small development
observations are not a general reliability estimate. See **VALIDATION.md**.
It caps model rounds, local function calls, context bytes, and completion tokens.
These are execution bounds, not a currency-denominated spend limit.
There are no automatic network retries or background calls.

The default completion budget remains **4096 tokens per response**, including
reasoning. Choose an explicit budget from **1024 to 16384** with
**--max-completion-tokens**. For example, a separately labelled retry can use:

~~~bash
python -m recovery_room agent --incident runs/live-case/incident --out runs/live-case/agent-runs --max-completion-tokens 8192 --max-rounds 24
~~~

Each **result.json** records **configuration** (rounds, local tool calls and
completion tokens, plus **prompt_version**) and **last_finish_reason**. The
budget-aware prompt states the actual round/tool limits, encourages efficient
bounded reads and reserves room for rehearsal/finalization. It supplies no
fixture answers. Exhausting the rounds remains an **incomplete** outcome with
**error_code: model_round_limit**, not a justified stop or a successful repair.
A provider **length** finish is
an error with **error_code: completion_token_limit**; no tool calls from that
partial response are executed, and no repair is exported on the strength of
an incomplete response. Raw responses and usage remain saved, with no automatic
retry. Increasing the ceiling does not guarantee completion. Preserve failed
attempts and report changed-budget runs separately. The browser remains an
explicitly offline demonstration; recorded-model API proposal C is deferred.

The agent can inspect the schema, issue read-only queries, read allowlisted evidence
with line citations, and request a narrowly structured repair rehearsal. It cannot
execute arbitrary SQL writes, run a shell, edit the checks, read arbitrary files,
access the fixture answer key, or mutate a production service.

A claimed successful repair produces an export only if it names an actual
successful rehearsal and the original data and evidence remain unchanged.
The output is a proposal for human review, not automatic production approval.
The investigation transcript and provider-reported token usage are recorded in
the agent session directory. The API key and authorization headers are not logged.
The controller also saves **responses.json**, containing response objects received
from the transport, including rejected response shapes. Invalid envelopes or
tool-call structures produce a saved error result; the entire tool-call batch is
validated before dispatch. Bad argument JSON and unsupported tool names still
return local tool feedback so the investigation can continue. Final answers must
contain exactly **outcome**, **summary**, and **rehearsal_id**, with a null ID for
a stop. These protocol checks do not establish whether a stop is justified.

### Test appropriate stopping

~~~bash
python -m recovery_room fixture --out runs/unknown-case --scenario missing-evidence
python -m recovery_room agent --incident runs/unknown-case/incident --out runs/unknown-case/agent-runs
~~~

Here the commit evidence needed to identify some repeated writes is absent.
The correct outcome is to stop and request that evidence. An agent saying
"stop" is not itself proof of good judgment; evaluate it against the fixture truth.

## Independent evaluation

The fixture generator writes **evaluation/ground_truth.json** outside the agent's
allowlisted evidence directory. The model receives no tool that can read it.
After a live run, copy its reported candidate path into:

~~~bash
python -m recovery_room evaluate --root runs/live-case --candidate PATH_TO_CANDIDATE_DB --outcome repair
python -m recovery_room evaluate --root runs/unknown-case --outcome stop
~~~

Operational checks run during rehearsal and use declared business rules plus
supplied evidence. The separate fixture evaluator checks exact expected active
orders, stock, and preservation of all later legitimate purchases.
Tests that exercise a scripted model transport are explicitly labelled test
transports; they are not real Meta calls.

### Repeatable offline baseline evaluation

~~~cmd
py -3 -m recovery_room benchmark
~~~

The default runs all three scenario variants with seeds **7, 23, 41**: nine
development trials from **one incident family**. For a shorter run:

~~~cmd
py -3 -m recovery_room benchmark --seeds 23
~~~

The command prints the new **runs/benchmark-.../report.html** and **report.json**
paths. The HTML table links to actual script traces and repair reviews. Each
trial also has a separate JSON record. Previous runs are never overwritten;
**--out** requires a new directory. A nonzero exit indicates at least one
incorrect, rejected, incomplete or technically failed trial, retained in the report.

Scoring happens after the controller acts. Repairs require exact fixture state,
correct target IDs, preserved valid records, freshly recomputed operational
checks, unchanged source data and actual freshness-gated exports. Stops require
the exact observed evidence gap and a matching structured reason, with no plan,
candidate or export. A stop label alone does not pass this evaluation. This
stronger stop assessment applies to this offline controller; the existing
**evaluate --outcome stop** command still primarily checks the fixture outcome
label and does not establish model refusal quality.

Results distinguish correct repairs, justified stops, incorrect exports,
unjustified stops, rejected repairs, technical errors and incomplete attempts.
The report keeps unfavorable outcomes and includes elapsed time, read-call and
rehearsal counts. No model is called, compared, or assigned a success rate here.
Repeated seeds do not establish general reliability. These public development
fixtures and answers are not blind holdouts. Once API access is available, use
the generated incident directories for real Meta runs and inspect their actual
traces before claiming an AI contribution.

## What is implemented

- A reproducible SQLite orders-and-inventory incident with opaque seeded IDs.
- Complete-evidence and missing-evidence variants.
- Read-only SQL protected by SQLite authorization, a function allowlist, row
  limits, statement limits, and an execution deadline.
- Evidence-linked cancellation of duplicate imported orders; original records
  remain as history and inventory corrections are compensating entries.
- Fresh-copy rehearsal and independently written operational checks.
- An HTML review report and readable SQLite repair script.
- Full-state preconditions under a write transaction in the exported script:
  a newer order or other changed state causes rollback. Applying the exact same
  script twice produces no extra stock correction.
- A bounded Meta tool loop with an explicit repair/stop result and local transcript.
- Deterministic baselines and a private fixture evaluator.

## Boundaries

This version supports one fixture schema and one repair action. It does not
repair arbitrary databases, provide general incident response, refund charges,
reverse shipments, or connect to a real store. The first-recorded-write rule is
explicit for this fixture; it is not a universal duplicate-resolution rule.
Passing the declared checks is not a general proof that a repair is safe.
The original database stays untouched by application commands.
Exported scripts are intentionally conservative: any changed table state makes
the prepared repair stale and requires a new rehearsal.

## Next milestone

1. Run the actual Meta agent on both evidence variants and inspect the transcripts.
2. Record correct repairs, incorrect repairs, appropriate stops, time, and usage.
3. Add genuinely different failure patterns, then freeze some incidents before
   tuning the agent; randomized identifiers alone are not held-out evaluation.
4. Compare with the event-aware script and a general coding assistant using
   the same evidence. Keep unfavorable results.
5. Extend the local workbench with actual model traces once live integration is verified.

Do not present the deterministic baseline as AI investigation in the demo.
Use the actual model trace when claiming model behavior.

## Project files

- **recovery_room/fixtures.py** — incident and evidence generation.
- **recovery_room/db.py** — read-only investigation boundary.
- **recovery_room/repairs.py** — evidence checks, rehearsal, export and report.
- **recovery_room/checks.py** — operational rules and separate fixture evaluation.
- **recovery_room/baselines.py** — honest deterministic comparisons.
- **recovery_room/agent.py** — Meta HTTP client and bounded local tool dispatcher.
- **recovery_room/cli.py** — commands.
- **recovery_room/workbench.py** and **recovery_room/web/** — local offline HTTP adapter and UI.
- **recovery_room/evaluation.py** — CLI-only baseline evaluation and reports; no browser/agent access.
- **tests/** — data integrity, evidence, stale state and agent-boundary tests.
- **docs/DESIGN.md** — the trust model and architecture.
- **docs/BUILD_LOG.md** — work origin and outstanding validation.
- **docs/UI_HANDOFF.md** — Claude's UI handoff and the subsequent integration review.
- **docs/PARALLEL_WORK.md** — frontend/backend ownership and the API contract.

## Technical references

- [Meta tool calling](https://dev.meta.ai/docs/tool-calling)
- [Meta models](https://dev.meta.ai/docs/models)
- [Meta Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions)
- [Microsoft: compensating transactions](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)

## Attribution

Starter implementation generated with OpenAI Codex assistance for Gyslain Mucyo.
The earlier ambiguous-write study informed the problem choice; its report,
experiment harness, and trial data are not reused or represented as new work here.
See the build log for this starter's creation and validation status.
