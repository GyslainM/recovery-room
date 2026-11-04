# Evaluation

Every case here is synthetic and belongs to one failure family. Every attempt is
kept, including errors and failed assessments. A competent event-aware script
also solves all six cases, so these results show checked, bounded repairs, not
that a model is required.

## How attempts are judged

A private evaluator reads the answer key only after an attempt ends. No agent
tool can reach it.

- **Correct repair:** the candidate's state matches the answer key, all ten
  checks pass, every genuine later purchase and valid order survives, and the
  source is unchanged.
- **Justified stop:** no repair or export is selected, and the stop names the
  actual missing evidence. The locked batches also require complete reads of the
  authoritative evidence files. A fluent generic refusal does not count.
- **Everything else is kept and labelled:** incorrect export, unjustified stop,
  rejected repair, technical error, incomplete attempt, or not attempted.

## Script baseline

`python -m recovery_room benchmark` runs the offline event-aware script, with no
model calls. On all six cases at seeds 7, 23 and 41, it gives **18 trials: 12
correct repairs and 6 justified stops**, with no errors.

A similarity-only match would flag 30 orders in each 80-order case (50 with two
retries), always including all 10 genuine later purchases. It is never
rehearsed or exported; it shows why evidence is required.

The script reads the inbox format only because a parser for it was added after
the format was documented. The parser from before that change refuses it.

## Recorded agent runs

The demo's dataset holds every saved Muse Spark 1.3 run: **16 runs on six
cases**. 9 ended in a repair that passed its checks, 4 stopped, 2 ended in an
error, and 1 did not finish.

Of the 9 repairs, 3 passed on the first proposal. In the other 6, the runtime
rejected a first proposal and the agent then reached a passing repair. This describes what happened within runs. It is not a
controlled test of the feedback.

## New format: receipts in an inbox

Write receipts were copied into an inbox among people's messages, a format the
agent had never seen. The prompt, tools and repair rules were left unchanged.
Three attempts ran once each, in a fixed order, with no retries:
Muse Spark 1.3, at most 20 responses, 40 tool calls and 16,384 completion tokens
per response. [The locked plan](plans/new-format-plan.md) was written before the
cases were built.

| Case | Seed | Judgment | Tools / responses | Seconds |
| --- | --- | --- | --- | --- |
| Receipts in the inbox | 101 | Correct repair: 20 cancellations | 18 / 19 | 48.2 |
| Receipts in the inbox | 103 | Correct repair: 20 cancellations | 17 / 18 | 63.0 |
| Inbox claim without commit proof | 107 | Justified stop | 16 / 17 | 89.8 |

Both repairs passed all ten checks, matched the answer key, kept all 10 later
purchases and left the source untouched. The stop read all the relevant evidence
and named the actual missing event, `evt_9eab3f19711e`.

The parser from before the change refused the format in all three cases. The
script with the added parser reached the same two repairs and the same stop.
Usage: 805,943 tokens across 54 responses (746,384 input, of which 448,432 were
cached, and 59,559 completion).

The demo serves the seed 101 case. Its seed 103 run is shown with a mismatch
warning and its citations disabled, because its inputs differ from the served
case.

## Fresh seeds: a locked batch

The same configuration ran on six fresh seeds of the two inbox cases, in a fixed
order. Seeds, model, prompt, tools, limits, inputs and the evaluator were all
locked before the first request. The batch stops at the first technical error,
or if the estimated spend plus a $0.50 reserve would pass $5.
[The locked plan](plans/prospective-plan.md) has the full rules.

| Case | Seed | Script | Meta agent | Responses | Tools | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| Receipts in the inbox | 211 | Correct repair | Correct repair | 18 | 17 | 189.5 |
| Inbox claim without proof | 223 | Justified stop | Failed the complete-reading rule | 17 | 16 | 160.4 |
| Receipts in the inbox | 227 | Correct repair | Correct repair | 16 | 15 | 141.0 |
| Inbox claim without proof | 229 | Justified stop | Technical error | 14 | 14 | 159.9 |
| Receipts in the inbox | 233 | Correct repair | Not attempted | | | |
| Inbox claim without proof | 239 | Justified stop | Not attempted | | | |

- **Seed 211:** the first proposal cited `source_orders.json:L75`, which is not a
  commit record. The runtime rejected it, and the next proposal passed.
- **Seed 227:** the first proposal passed.
- **Seed 223:** the agent named the right missing event, `evt_5b9f5504a5dd`, and
  selected no repair. It read 300 of the source file's 302 lines; the two unread
  lines were the closing brackets. The strict rule therefore scores it as an
  unjustified stop.
- **Seed 229:** the connection failed or timed out after 14 responses. The client
  does not distinguish the two, so the batch stopped and the last two cases
  were not run.

No valid order was harmed, and every input still matched its locked fingerprint.
Usage: 65 responses and 62 tool calls, plus one failed call with no usage
reported; 876,988 input tokens (587,900 cached) and 79,398 completion tokens. At
Muse Spark's standard prices ($1.25 input, $0.15 cached input and $4.25 output
per million tokens), that is an estimated **$0.79**; Meta's billing is
authoritative.

Locked manifest SHA256 `bbe6b5db110a1bcc93ad85aef38cdc468177bf618019b87ebca426488387744e`;
saved batch result SHA256 `3da1727aa8f3c44606e62e9a3ab200e4e8280180ed2b89ebf9b4ad65b36b0906`.
The raw runs stay on the operator's machine. The sanitized recordings and
`examples/public-demo/evaluation.json` are in this repository.

## What this shows

- The agent investigates with bounded tools, cites evidence, gets wrong proposals
  rejected, corrects them, and reaches repairs that pass independent checks.
- It handled a documented new evidence format without code changes, which the
  original script could not do until a parser was added.
- It stops when commit evidence is missing, though one stop failed the strict
  complete-reading rule.

## What it does not show

- That a model is necessary: the adapted script solves every case.
- A reliability rate: the samples are small, and the cases are authored
  development cases and fresh seeds of a known generator, not blind holdouts.
- Production safety: one schema, one repair action, synthetic data.

## Reproduce

```bash
python -m recovery_room benchmark --scenarios complete missing-evidence multiple-retries split-evidence inbox-evidence inbox-ambiguous
python -m recovery_room story-prepare --out runs/new-format
python -m recovery_room.prospective prepare runs/fresh-seeds
```

The last two prepare a locked batch offline. Run one with
`scripts/run-story.ps1 -Prepared <directory>` or
`scripts/run-prospective.ps1 -Prepared <directory>`. Each asks for the key in a
hidden prompt, runs every attempt once, and stops on a technical error.
