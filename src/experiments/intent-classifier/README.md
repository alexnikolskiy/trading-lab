# IntentClassifier eval-harness

Offline-first model evaluation for the chat **IntentClassifier** role. Symmetrical to
`src/experiments/strategy-analyst/` — the second concrete vertical slice. Goal: pick a **cheap**
model for chat intent classification (top-tier reasoning is not needed here).

The harness reads the classifier *as a role only*. It does **not** touch the production prompt,
adapter, guard, or `planChatAction`; it does not run `planChatAction` or apply the guard's
`minConfidence` gate. The single trust boundary is `ChatIntentSchema` — exactly what the guard
re-validates — so a classifier output is parsed before any field is read.

## What it measures

A run sends every dataset message through the classifier and scores:

- **Primary — intent accuracy**: fraction of messages whose `intent` matches the gold label. This
  is the gated headline (`score` == `intentAccuracy`), `verdict = PASS` when `score >= threshold`.
- **Secondary — payload accuracy**: correctness of key payload fields where the case declares an
  expectation (`requestedOutcome`, `entityRef`, `hasStrategyText`, `hasHypothesisText`). Reported
  separately and used as a ranking tiebreaker.

`--repeat N` runs the whole dataset N times per model to measure run-to-run variance (a
deterministic classifier → std 0). `passRate` (fraction of runs meeting threshold) mirrors the
analyst harness.

## Usage

```bash
# DRY RUN (default): no models built, no network, no paid calls. Prints the paid-call plan.
pnpm intent:eval --models openrouter/x-ai/grok-4.1-fast,openrouter/qwen/qwen3.5-flash

# PAID RUN: --run is the SOLE trigger for real calls.
pnpm intent:eval --run --models openrouter/qwen/qwen3.5-flash --repeat 1

# With the optional batch LLM judge (1 call per model per repeat):
pnpm intent:eval --run --models openrouter/qwen/qwen3.5-flash --judge --judge-model openrouter/x-ai/grok-4.3
```

Flags: `--dataset` (default `chat-intents-v1`), `--models` (CSV, **required**), `--run`,
`--threshold` (default `0.7`), `--judge` + `--judge-model`, `--repeat` (1–20).

Artifacts: `.artifacts/experiments/intent-classifier/<dataset>/<timestamp>/` — `<slug>.run<k>.json`,
`<slug>.run<k>.judge.json` (only with `--judge`), `<slug>.aggregate.json`, `manifest.json`.

## Paid-call budget — read before `--run`

`classify()` is invoked **once per message**, so:

```
classifyCalls = models × repeat × caseCount
judgeCalls    = (judge ? models : 0) × repeat
```

With the shipped 20-case dataset, 2 models at `--repeat 1` = **40 classify calls**. Always run the
dry-run first; keep a paid round at **≤ 40 calls** unless explicitly confirmed.

## Candidate models (cheap class)

Pass via `--models`; **verify the exact slugs at dry-run** before paying. `parseRoleModel` only
treats the first path segment as a provider override when it is `anthropic` / `openai` /
`openrouter` — so `x-ai/*`, `google/*`, `qwen/*` **must** carry the `openrouter/` prefix or routing
breaks.

| Slug | Notes |
|------|-------|
| `openrouter/google/gemini-3.1-flash-lite-preview` | cheap default, low latency, response schema |
| `openrouter/x-ai/grok-4.1-fast` | cheapest entry, fast variant |
| `openrouter/qwen/qwen3.5-flash` | lowest price anchor |
| `openrouter/x-ai/grok-4.3` | quality ceiling (current StrategyAnalyst default) |
| `openrouter/google/gemini-3.5-flash` | quality ceiling (#1 OpenRouter intelligence) |

## Files

`types.ts` (contracts) · `fixtures.ts` + `__fixtures__/*.json` (labelled dataset) · `scoring.ts`
(deterministic scorer) · `aggregate.ts` (stats + ranking) · `plan.ts` (dry-run / paid-call plan) ·
`judge.ts` (optional batch judge) · `artifacts.ts` (output writer) · `eval-harness.ts` (DI
orchestrator) · `real-classifier-factory.ts` (the **only** composeMastra importer; loaded under
`--run` only) · `imports.guard.test.ts` (boundary guard).
