# Recovery Room

Repair the damage from a failed, retried import without touching anything else.
A Meta Muse Spark agent investigates the evidence and proposes a repair. The
runtime tests it on a disposable copy, checks it independently, and hands a
person a guarded repair script to review.

**[Open the recorded demo](https://gyslainm.github.io/recovery-room/)**: saved
agent runs, no key or sign-in needed.

## The problem

An import times out after writing 20 of 50 orders. The retry writes all 50
again, so 20 orders now exist twice and stock is wrong. Then ten genuine
purchases arrive, and they look almost identical to earlier ones. Cancelling by
similarity would remove those real purchases too. The repair has to prove from
the evidence which writes were repeats, and leave every other order alone.

## How it works

1. **Investigate.** The agent gets five tools: read the database schema, list
   the evidence files, read evidence with exact line numbers, run read-only SQL
   on the original database, and test a repair on a new disposable copy. It has
   no shell, no file access, no write access and no view of the answer key.
2. **Propose.** Each cancellation must cite the evidence lines that tie the
   repeated order and the kept order to the same source event. The runtime
   rejects wrong or invented citations and tells the agent why.
3. **Test and check.** The repair runs on a fresh copy, then ten independent
   checks run: database integrity, untouched orders preserved, history retained,
   stock matching its ledger, one active purchase per source event, and more.
   The agent's own words never decide whether a repair passed.
4. **Review.** The result is a SQL script, plan and report for a person to
   review. The script refuses to run if the data has changed since the test.
   Nothing is ever applied to the original database.

When the evidence is incomplete, the right answer is to stop and name what is
missing. The [design notes](docs/DESIGN.md) cover the authority model, checks
and export guards.

## Results

All cases are synthetic. A competent event-aware script also solves them, so
these results show safe, checked repairs, not that AI is required.

- **16 recorded Muse Spark runs on 6 cases:** 9 repairs that passed every check,
  4 stops, 2 errors and 1 that did not finish. In 6 of the 9 repairs, the
  runtime rejected a first proposal and the agent corrected it.
- **A format the agent had never seen.** Write receipts were copied into an
  inbox among people's messages. The original script refused the format in all
  three cases. The unchanged agent made two correct repairs and one justified
  stop. A script adapted to the format reached the same outcomes.
  [Contract](docs/EVIDENCE_STORY_CONTRACT.md) · [results](docs/EVIDENCE_STORY_RESULTS.md)
- **A locked batch on fresh cases:** two correct repairs, one stop that failed
  the strict complete-reading rule, and one connection error; the last two cases
  were not run. The script passed all six.
  [Plan](docs/PROSPECTIVE_EVALUATION.md) · [results](docs/PROSPECTIVE_RESULTS.md)

Every attempt is kept, including failures. The demo shows all 16 recorded runs
under **How we evaluated**.

## Try it

Python 3.11 or newer, with no third-party dependencies. On Windows, use
`py -3` in place of `python`.

### Recorded demo

```bash
python -m recovery_room demo-package --data examples/public-demo/demo-data.json --out dist/recorded-demo
cd dist/recorded-demo
python public_server.py
```

Open `http://127.0.0.1:8080`. The page replays saved runs and never calls a
model.

### Local workbench

```bash
python -m recovery_room serve
```

Open `http://127.0.0.1:8765`. Choose a case, click **Investigate incident**,
then **Test repair on a copy**, and review **Changes**, **Checks** and **SQL**.
Downloads check again that nothing changed since the test. In the workbench,
investigations use the offline event-aware script and are labelled
**Offline demo · No model**. Add `--recordings <library>` to show saved agent
runs, and `--cases` to choose from the six built-in cases.

### Run the agent live

The agent sends the selected case's records and evidence to Meta. Use the
synthetic cases.

```powershell
python -m recovery_room fixture --out runs/live-case --seed 23
$secret = Read-Host "Meta API key" -AsSecureString
$env:MODEL_API_KEY = [System.Net.NetworkCredential]::new("", $secret).Password
python -m recovery_room agent --incident runs/live-case/incident --out runs/live-case/agent-runs --max-completion-tokens 8192 --max-rounds 24
```

On macOS or Linux, set the key with `read -r -s -p "Meta API key: " MODEL_API_KEY`
and `export MODEL_API_KEY`. The key is read from the environment only and never
logged. The default model is `muse-spark-1.3`; choose another with `--model`.
Add `--scenario missing-evidence` to the fixture to test stopping. Score a run
against the private answer key afterwards:

```bash
python -m recovery_room evaluate --root runs/live-case --candidate PATH_TO_CANDIDATE_DB --outcome repair
```

### Script baseline and tests

```bash
python -m recovery_room benchmark
python -m unittest discover -s tests
node --test tests/test_workbench_ui.cjs
```

Node is needed only for the frontend tests.

## Limits

- One schema and one repair action: cancelling repeated imported orders with
  compensating stock entries.
- Synthetic data only. It is not general incident response, and it does not
  refund payments, reverse shipments or connect to a real store.
- The checks are application rules, not a formal proof of safety.
- Export guards are deliberately strict: any change to the data, even an
  unrelated new purchase, makes a prepared repair stale.
- A person must review every repair before it is applied anywhere.

## Project layout

- `recovery_room/agent.py`: Meta client and the bounded tool loop
- `recovery_room/db.py`: read-only investigation boundary
- `recovery_room/repairs.py`: evidence checks, rehearsal, export and report
- `recovery_room/checks.py`: operational checks and the separate evaluator
- `recovery_room/fixtures.py`: synthetic cases and evidence
- `recovery_room/baselines.py`: the deterministic script baselines
- `recovery_room/workbench.py` and `recovery_room/web/`: local workbench and UI
- `tests/`: Python and frontend tests

## Credits

Built by **Gyslain Mucyo** for the Meta Global AI Developer Hackathon, with
development assistance from **OpenAI Codex** and **Claude Code**. **Meta Muse
Spark 1.3** is the model inside the product. See
[contributors](docs/CONTRIBUTIONS.md).

Source under the [MIT licence](LICENSE). Bundled fonts and icons keep their
[third-party notices](THIRD_PARTY_NOTICES.md).

## References

- [Meta tool calling](https://dev.meta.ai/docs/tool-calling)
- [Meta models](https://dev.meta.ai/docs/models)
- [Meta Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions)
- [Compensating transactions](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
