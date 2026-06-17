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
pnpm intent:eval --models openrouter/openai/gpt-5.4-nano-20260317,openrouter/google/gemini-3.1-flash-lite-preview

# PAID RUN: --run is the SOLE trigger for real calls.
pnpm intent:eval --run --models openrouter/openai/gpt-5.4-nano-20260317 --repeat 1

# With the optional batch LLM judge (1 call per model per repeat):
pnpm intent:eval --run --models openrouter/openai/gpt-5.4-nano-20260317 --judge --judge-model openrouter/anthropic/claude-haiku-4.5
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
dry-run first; keep a paid round at **≤ 40 calls** as the baseline discipline. The final model
selection took several **explicitly confirmed** rounds above that limit (60–80 calls, i.e. 3–4
models × 20 cases), each approved individually before running — the ≤40 ceiling is the default, not
a hard cap, and is only raised with explicit confirmation.

## Candidate models (cheap class)

Pass via `--models`; **verify the exact slugs at dry-run** before paying. `parseRoleModel` only
treats the first path segment as a provider override when it is `anthropic` / `openai` /
`openrouter` — so `x-ai/*`, `google/*`, `qwen/*` **must** carry the `openrouter/` prefix or routing
breaks.

| Slug | Notes |
|------|-------|
| `openrouter/openai/gpt-5.4-nano-20260317` | **winner** — best price/quality ($0.20 in / $1.25 out) |
| `openrouter/anthropic/claude-haiku-4.5` | fallback — max accuracy (0 mislabels) but ~4× pricier out ($1.00 / $5.00) |
| `openrouter/google/gemini-3.1-flash-lite-preview` | cheapest solid option ($0.25 / $1.50); low latency |

See **Results (June 2026)** below for the full ranking and the models that were eliminated.

## Results (June 2026)

Final standings after the OpenAI strict-mode schema fix (see below) and three paid rounds over the
20-case `chat-intents-v1` dataset.

### Winner — `openrouter/openai/gpt-5.4-nano-20260317`

intentAccuracy **0.95** · schemaValidRate **1.00** · payloadAccuracy **1.00** · latency ~34s ·
$0.20 in / $1.25 out. **Best price/quality balance** — the pick for chat intent classification. Its
only mislabel was `results.trading → needs_clarification` on *«какой pnl по моей торговле за
сегодня»*, a genuinely borderline phrasing, not a bug.

### Fallback — `openrouter/anthropic/claude-haiku-4.5`

The only model with **zero mislabels** (intentAccuracy **1.00**, schemaValidRate **1.00**,
payloadAccuracy **1.00**), but ~4× pricier on output ($1.00 in / $5.00 out) and slower (~49s).
Choose it when maximum accuracy matters more than cost.

### Prior cheap champion — `openrouter/google/gemini-3.1-flash-lite-preview`

intentAccuracy **0.95** · schemaValidRate **1.00** · payloadAccuracy **0.917** ($0.25 / $1.50).
Stable, but chronically mislabels the `strategy-onboard-ru` case (onboarding read as
`hypothesis.build` / `results.trading`); lost to nano on payload accuracy and price.

### Eliminated

- `openrouter/google/gemini-2.5-flash-lite` — intentAccuracy 0.85, 19/20 schema-valid; confuses research ↔ strategy.
- `openrouter/deepseek/deepseek-v4-flash` — intentAccuracy 0.80 and ~111s latency.
- `openrouter/qwen/qwen3.6-flash` — 0/20 schemaValidRate; invents its own intent labels.
- `openrouter/x-ai/grok-4.1-fast` — 0/20 schemaValidRate; the fast variant immediately refuses structured output through the current path.

**Expensive flagships were deliberately not tested in prod** (Gemini 3.1 Pro $2/$12, GPT-5.4 full
$2.50/$15): ~10–12× nano's cost with no justified gain on a 9-intent classification task.

Note that **intentAccuracy and schemaValidRate are measured separately**: a model can recognize the
right intent (counts toward intentAccuracy) while still emitting an object that fails `.strict()`
(0 schemaValidRate). The eliminated `qwen`/`grok` models failed on schema validity — and a 0%
schema-valid model is unusable in prod, where the guard re-validates against `ChatIntentSchema`.

## OpenAI strict-mode schema fix

OpenAI structured outputs require the JSON-Schema `required` array to include **every** key in
`properties`, expressing optionality via nullable (`type: [..., "null"]`) — not by omitting the key.
Zod's `.optional()` drops fields from `required`, which Google/DeepSeek tolerate but OpenAI rejects
at validation time: a 400 `Invalid schema for response_format: 'required' is required to be ...
Missing 'strategyText'` — an instant reject, 0/20, before any classification happens.

Fixed **eval-only**, prod untouched (commit `a011ade`):

- `openai-eval-schema.ts` — `ChatIntentEvalSchema`, derived from `ChatIntentSchema.shape` by turning
  each `.optional()` field into a required-but-`.nullable()` one (`.strict()` preserved). Deriving
  from the prod shape means it can't drift.
- The adapter's eval (`raw`) branch sends this variant via its `requestSchema` option; the prod
  (`strict`) branch still sends `ChatIntentSchema` verbatim — the production request is byte-identical.
- `scoring.ts` normalizes null-valued keys away before the `ChatIntentSchema` gate, so OpenAI's
  `null` (= "absent") is treated as missing rather than rejected.

Production `ChatIntentSchema`, the guard, and the intent-classifier agent are **not** touched; the
contract stays optional-by-semantics, only the wire schema handed to OpenAI-compatible providers changes.

## Files

`types.ts` (contracts) · `fixtures.ts` + `__fixtures__/*.json` (labelled dataset) · `scoring.ts`
(deterministic scorer) · `aggregate.ts` (stats + ranking) · `plan.ts` (dry-run / paid-call plan) ·
`judge.ts` (optional batch judge) · `artifacts.ts` (output writer) · `eval-harness.ts` (DI
orchestrator) · `real-classifier-factory.ts` (the **only** composeMastra importer; loaded under
`--run` only) · `imports.guard.test.ts` (boundary guard).
