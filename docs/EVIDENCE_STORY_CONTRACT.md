# Evidence story experiment — frozen before fixture construction

Base: 7543e3a. Scope: an opt-in synthetic receipt-inbox format and an ambiguous
variant, a locked three-attempt Meta evaluation, and read-only demo data export.
No production writes, refunds, image evidence, live browser endpoint or public
mutable workbench. Claude owns presentation and replay on a separate UI branch.

## Freeze

The unchanged baseline passed 140 Python tests (one existing skip) and all 43
frontend tests before implementation. The model-facing prompt, tool schemas and
repair grammar remain unchanged. Frozen hashes:

- PROMPT_VERSION: budget-aware-v1
- INSTRUCTIONS SHA256: 662ae310a5d387228df40cb9a6f451f41992cbe47941383586c65c21a2d3e650
- TOOLS (sorted JSON) SHA256: 7646c01db964cc2a5cb32aad17be6d12aa644ea48d8d84682d6458513a468ce2
- Pre-experiment fixtures.py SHA256: 7f0edd79feeb1cf2e89af457658a91b02e89dd8a96ac047ed80dc3178b71a317
- Pre-experiment baselines.py SHA256: 26026d75542ed2398b2a2fb326e631833c0925211b8d83b889be38389bc1eafb

Live batch: inbox-evidence seeds 101 and 103, then inbox-ambiguous seed 107.
Exactly three planned attempts, Muse Spark 1.3, at most 20 responses, 40 local
tool calls and 16384 completion tokens per response. No automatic retries or
prompt tuning after seeing results. A technical/provider error stops the batch;
unattempted trials remain unattempted. Every attempt, usage record and failure
is retained. Tokens bound execution; they are not a guaranteed dollar cap.

These are authored synthetic format-generalization experiments, not blind
holdouts or a general reliability estimate. Freezing a prompt alone does not
make a fixture a blind holdout.

## Evidence authority

The new files contain an operator thread, support mail, a processor-style CSV
and an inbox containing copied service write receipts. Only complete receipts
under the exact RR-COMMIT v1 marker are admissible committed-write evidence.
Each marker carries the same bounded event/order/movement/attempt fields and
unique positive commit sequence as the existing sequenced receipt format.
Narrative text, customer complaints, amounts, receipt IDs and similarity never
authorize a cancellation. The runtime must corroborate both orders, source
content, sale movements and retained first write exactly as before.

An explicit JSONL declaration pins the inbox format, fixed filename and receipt
count. No declaration means no new receipt authority. Duplicate/conflicting
receipts, undeclared files, bad sequences and malformed markers fail closed.
The ambiguous variant withholds both commit records for one source event; a
story or complaint cannot fill that gap. The correct result is stop.

## Baselines and interpretation

Compare (1) the pre-experiment JSONL/CSV parser frozen at 7543e3a, (2) the
competent parser adapted to the newly documented inbox format, and (3) the
unchanged Meta agent. Do not deliberately cripple or replace the adapted
baseline. If it solves the case, publish that result. A frozen parser stopping
on an unsupported format is a coverage limitation, not proof of AI necessity.
Both baselines have the same current database and public evidence; the private
fixture evaluator is used only after an attempt, never by the agent/runtime.

## Stop/go gate

First prove the evidence validator, original four-case compatibility, adapted
baseline and ambiguity refusal offline. Then run the locked batch with the key
entered into a hidden local PowerShell prompt. Never put keys in a file, CLI
argument, browser, transcript or public bundle. No AI advantage is claimed
unless the saved observations support it. The already verified October 28
recordings remain the demo fallback.
