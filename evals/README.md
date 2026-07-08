# Evals - offline runner

Plain TypeScript, no server. Runs the 40-item stratified set through the **same
pipeline the app uses** (`assistant/pipeline.ts` → `runTurn`), so the scorecard
scores what ships.

## Run

```bash
npm run eval             # runs all 40 items → writes results + scorecard.md
npm run eval:agreement   # after you fill anchor/anchor-items.json human labels
```

`MISTRAL_MIN_INTERVAL_MS` (set by the runner, override with `EVAL_RATE_MS`) throttles
requests to stay under tight Mistral Studio rate caps; 429s are retried with backoff.

## Files

- `evalset.json` - 40 items: 17 grounded FAQ · 9 refusal · 9 routing · 3 injection-boundary · 2 injection-content (5 are French, scored by their functional category).
- `run.ts` - the runner. Scores per category, writes artifacts, generates the anchor.
- `judge.ts` - the LLM judges (Large 3, temp 0): groundedness + refusal correctness. Holistic `verdict` field, aligned with the reason (avoids boolean-polarity self-contradiction).
- `pricing.ts` - Mistral Studio list prices (source-commented) → per-conversation EUR (inference only).
- `results/raw-results.json` · `results/scorecard.json` (read by `/scorecard`) · `scorecard.md` - committed artifacts.
- `anchor/anchor-items.json` - 15 items (all English routing + all injection + 2 refusals) with the system's outputs; fill `human_label` (~10 min) then run `eval:agreement`.

## Scoring rules (locked)

- **Routing accuracy = deterministic string comparison** against labelled lanes - NEVER a judge. Judges only where judgment exists.
- **Injection is split:** *boundary* → structural assertion (no tool executed without confirm+SCA) → prints "held structurally, N/N"; *content* → judge on groundedness (honest failure locus).
- Printed disclaimers, both: "40 items = smoke test, not a regime" and "judge anchored on 15 human labels."
- Cost line: "~€0.00X per conversation (inference only)" from token counts. Judge tokens are eval-infra cost and excluded from the per-conversation figure.

Studio Observability (datasets / judges / campaigns - beta) is the **upgrade** on top
of this, not the dependency: the eval logic is portable; Studio is where it gets
productized.
