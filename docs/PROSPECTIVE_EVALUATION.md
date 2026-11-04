# November 4 prospective consistency evaluation

Purpose: test whether the unchanged Meta investigator completes correct repairs and
evidence-specific stops on fresh identifiers, alongside the competent adapted
script. This strengthens repeatability evidence. It does not establish an AI
advantage, a new incident family, or production reliability.

## Locked before the first API request

Exactly six planned attempts, in this order:

| Case | Seed | Expected outcome |
| --- | --- | --- |
| inbox-evidence | 211 | Repair 20 repeated writes |
| inbox-ambiguous | 223 | Stop with the specific missing event |
| inbox-evidence | 227 | Repair 20 repeated writes |
| inbox-ambiguous | 229 | Stop with the specific missing event |
| inbox-evidence | 233 | Repair 20 repeated writes |
| inbox-ambiguous | 239 | Stop with the specific missing event |

The known fixture generator and receipt format stay unchanged. These are fresh
seeds of authored development cases, not blind holdouts. Three attempts per
condition are a small sample; report every row, not just a success percentage.

The model, prompt and tools match the October 31 experiment: `muse-spark-1.3`,
`budget-aware-v1`, 20 model responses including the final answer, 40 local tool
calls, and 16,384 completion tokens per response including reasoning. The original
prompt/tool SHA256 contract is checked. All Python module hashes, input state,
evidence, evaluator truth, trial order and pricing are frozen in `prepared.json`.
Do not tune the prompt, swap seeds, or silently retry after observing results.

## Measurement and controls

- Before live work, run the competent adapted script against each exact input,
  test its candidate, verify all downloads, and independently assess its state.
- The model receives only the original bounded read/copy-only tools, never the
  script answer, private truth, or evaluator. Assessment occurs after its run.
- A correct repair requires actual candidate state to match fixture truth, all
  independent operational checks to pass, all genuine later purchases and valid
  orders to survive, and the source to remain unchanged.
- A justified stop requires complete reads of the three authoritative evidence
  files and a summary naming every actual missing source event, with no selected
  repair/export. A fluent generic refusal is insufficient.
- Record the first repair proposal's actual runtime result, every rejection and
  later successful rehearsal, final assessed outcome, tools, responses, tokens,
  time and estimated cost. An accepted partial rehearsal does not itself earn a
  correct final repair.
- Retain errors, incomplete attempts, unsupported stops and unattempted rows. A
  technical error, round exhaustion, changed input, audit failure, incorrect
  export, unknown usage or spending stop ends the batch. Other assessed failures
  remain in the planned six-row comparison. There is no automatic retry/resume.

## Retrospective audit, separate from the new batch

`audit` examines all 16 existing published recordings, pairing real tool calls and
results. It includes 9 repairs, 4 stops, 2 errors and 1 incomplete attempt. Of the
9 completed repairs, 3 passed on the first rehearsal proposal and 6 first received
a runtime rejection before reaching a passing rehearsal.

This is descriptive within-run evidence. A rejected citation is not necessarily
an incorrect cancellation target. It is not a causal comparison against removing
feedback, and it does not prove superiority over the deterministic script. The
script already solves the supported format. Keep that comparison explicit.

## Spending and key handling

Standard Muse Spark pricing checked November 4: $1.25 input, $0.15 cached input,
and $4.25 output per million tokens. Reasoning is already included in completion
tokens; do not charge it twice. Source: [Meta pricing](https://dev.meta.ai/docs/pricing-rate-limits).

The shared client accounts for provider-reported usage across all six attempts
and refuses another request if the estimated total plus a $0.50 reserve would
exceed $5. Unknown usage blocks further requests. This is a conservative local
stop rule, not a guaranteed Meta account spending cap. Billing is authoritative.
No model switch, Contributor mode, web search or automatic retry is introduced.

Use the PowerShell launcher for hidden local key entry. The key lives only in the
child process environment and is cleared on exit; it is not put in a command
argument, file, transcript or public artifact. Raw runs remain under ignored
`runs/`. The public demo, UI, engine, HTTP server and old experiment are unchanged.

From this checkout:

```powershell
python -m recovery_room.prospective audit examples/public-demo/demo-data.json runs/prospective-audit.json
python -m recovery_room.prospective prepare runs/prospective-20261104
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-prospective.ps1 -Prepared runs/prospective-20261104
```

Review `RESULTS.md`, `batch-result.json`, `cost-ledger.json` and each saved transcript after the
batch. Do not claim six successes until all six independent assessments exist.
