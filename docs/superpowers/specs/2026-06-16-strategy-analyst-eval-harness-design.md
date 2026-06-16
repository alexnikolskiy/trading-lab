# StrategyAnalyst Model Evaluation Harness — design / spec

- **Slice tag:** `analyst-eval` (experimental harness; **not** part of SP-7).
- **Date:** 2026-06-16
- **Status:** design approved (with corrections), pending spec review → plan.md.
- **Owner:** Alexander Nikolskiy

---

## 0. Goal and problem

Run the **existing** `StrategyAnalyst` over a fixture across N candidate LLM models,
persist each structured `AnalystProfileOutput`, and score it **offline** against a
deterministic rubric — so we can compare model quality on the strategy-extraction task
**without** running the backtester, writing to the DB, or persisting a `StrategyProfile`.

This is an **experimental harness**, not a production workflow. It must not couple to
the orchestrator chain, the queue, the platform integration, or the DB.

Primary fixture: a short Russian user-style description of a long-only strategy
(`docs/fixtures/strategies/long-oi-strategy-source.md`). The detailed
`long-oi-strategy-research-notes.md` is a **verification reference only** (it declares
itself non-input in its own header), used by the optional judge and by humans — never
fed to the analyst as `StrategyAnalystInput.content`.

---

## 1. Reuse path (no prompt duplication)

The harness imports production code and constructs **none** of its own analyst
prompt / agent / schema. Reuse, in order of preference:

**Recommended — reuse `composeMastra`, but only under `--run`.** Per candidate model,
build a minimal `MastraCompositionEnv` where `STRATEGY_ANALYST_ADAPTER='mastra'`,
`STRATEGY_ANALYST_MODEL=<candidate>`, and every other adapter `'fake'`
(`RESEARCHER_ADAPTER`, `CRITIC_ADAPTER`, `BUILDER_ADAPTER`, `INTENT_CLASSIFIER_ADAPTER`
= `'fake'`, `ENABLE_CRITIC_AGENT=false`). `composeMastra` then builds **only** the
analyst agent (the other `build()` calls are gated on `=== 'mastra'`). Take
`runtime.agents.analyst`, wrap it with the production **`MastraStrategyAnalyst`**
adapter, and call `.analyze(input)`. This reuses the exact production composition:
`parseRoleModel` provider-override parsing, `createStrategyAnalystAgent` + agent
`INSTRUCTIONS`, `buildPrompt()`, and the `AnalystProfileOutputSchema` enforcement
(`structuredOutput` + re-parse).

> ⚠️ **Critical:** `composeMastra` calls `resolveLanguageModel`, which **instantiates a
> real provider SDK client** (`createAnthropic`/`createOpenAI`/`createOpenRouter`).
> Therefore `composeMastra` is invoked **only in `--run` mode**, never in dry-run.
> See §5.

**Alternative considered (rejected):** direct
`resolveLanguageModel → createStrategyAnalystAgent → MastraStrategyAnalyst`. Reuses the
same factory but re-implements ~5 lines of `composeMastra`'s build/register/`getAgent`
dance. Rejected to keep a single composition source of truth.

**Injectable analyst factory.** The harness depends on a factory, not on `composeMastra`
directly:

```ts
type AnalystFor = (modelId: string) => StrategyAnalystPort;
```

- **CLI `--run`** passes a real factory backed by `composeMastra` (constructs real models).
- **CLI dry-run** passes a **fake** factory (`FakeStrategyAnalyst`-style canned output) **or
  none**. The harness never constructs or calls a **real, provider-backed** analyst in
  dry-run; an optional wiring check (§5.2 step 5) may exercise the **fake** `.analyze`,
  which costs nothing.
- **Tests** pass a fake factory → zero paid calls.

Fixture input wiring:

```ts
{ kind: 'manual_description', content: <fixture text>, title: 'long-oi' }
```

(`manual_description` is the correct `SourceKind` for a short user description.)

---

## 2. Module layout

Thin CLI trigger + testable harness, mirroring the `platform:*` script house style
(`node --experimental-strip-types`, env-driven, JSON to stdout, exit codes).

```
scripts/strategy-analyst-eval.ts        # thin trigger (arg/env parse, gate, orchestrate, write, exit)
src/experiments/strategy-analyst/
  scoring.ts        # PURE scoreProfile(profile) -> ScoreResult  (no LLM/fs/clock)
  eval-harness.ts   # runEval({ mode, models, fixture, analystFor, judge? }) -> EvalRunResult  (no fs/clock inside)
  artifacts.ts      # writeRunArtifacts(outDir, result) -> on-disk layout + manifest
  fixtures.ts       # resolveFixture('long-oi') -> { id, sourcePath, notesPath, rubricPath }
  judge.ts          # opt-in judge orchestration (uses judge-agent + JudgeVerdictSchema)
  judge-agent.ts    # createStrategyAnalystJudgeAgent(model)  (experimental prompt; NOT in src/mastra/agents/)
  types.ts          # ScoreResult, CandidateResult, EvalRunResult, JudgeVerdictSchema, etc.
docs/fixtures/strategies/long-oi-strategy-rubric.md   # checked-in judge rubric
```

**Constraints (repo-specific):**
- No TS parameter properties anywhere (`node --experimental-strip-types` strips types at
  runtime; `constructor(private x)` breaks at runtime though it passes `tsc`/Vitest).
- `import type` for type-only imports.
- The harness imports **only**: `composeMastra`, `MastraStrategyAnalyst`, the domain
  schemas (`AnalystProfileOutputSchema`, `StrategyAnalystInputSchema`), `model-provider`
  types/`parseRoleModel`, and Node `fs`/`path`. It imports **no** repository, queue,
  builder, hypothesis, backtest, or DB module (see §7 boundaries + guard test).

---

## 3. Deterministic scoring (approved)

`scoreProfile` is pure: input is the candidate's raw analyst output; output is a
`ScoreResult`. No LLM, no fs, no clock.

### 3.1 Hard gates (any fail ⇒ verdict `FAIL`, regardless of score)

1. `AnalystProfileOutputSchema.safeParse(raw)` succeeds.
2. `profile.direction === 'long'`.

Gate-failure semantics:
- If **gate 1 (schema parse) fails**, the weighted checks are **not** run (the fields are
  untrustworthy/malformed): `score = 0`, `verdict = FAIL`, and the raw object is recorded
  for diagnostics.
- If **gate 1 passes but gate 2 (direction) fails**, the weighted checks **are** computed
  and recorded for diagnostics, but `verdict = FAIL` regardless of score.

### 3.2 Weighted checks → `score ∈ [0,1]`

Concept-bucket matching, **case-insensitive**, with **EN + RU synonyms** (the fixture is
Russian; models may answer in either language). Each positive check contributes
`(bucketsHit / bucketCount) × weight` (partial credit). Weights sum to 1.00.

| # | Check | Buckets (EN / RU synonyms, non-exhaustive) | Weight |
|---|---|---|---|
| 1 | `requiredMarketFeatures` cover the data needs | `ohlcv`(candle/price/свеч); `oi`(open interest/open_interest); `liquidation`(liq/ликвидац) | 0.20 |
| 2 | `entryConditions` mention the trigger logic | `dump`(drop/sell-off/пролив/падение); `bounce`(rebound/reversal/отскок/разворот); `oi`(open interest); `liquidation`(liq/ликвидац) | 0.20 |
| 3 | `exitConditions` mention the exit ladder | `tp1`(+3.5/take profit 1/первый тейк); `tp2`(+5/take profit 2); `sl`(stop/hard stop/−12/стоп); `time`(180/time exit/по времени/timeout) | 0.20 |
| 4 | `positionManagementSummary` captures in-position logic | `dca`(averaging/add to position/усреднение/доливк); `breakeven`(be/break-even/безубыток) | 0.15 |
| 5 | `riskManagementSummary` invents **no** exact sizing/leverage (**negative** check) | full credit when **clean**; 0 if it asserts a fabricated `Nx` leverage, `$`/`% equity/account/balance` base size, or a specific fee/exchange the source never states | 0.15 |
| 6 | `unknowns` flag missing detail | `sizing`(size/leverage/плеч); `fee`(commission/комисс); `exchange`(venue/бирж); `universe`(symbols/instruments/pairs/which coins/инструмент) | 0.10 |

**Field-scoping & fallback (approved):** each **capture** check (1,2,3,4,6) reads its
named field first; if that field is empty/`null`, it falls back to a haystack of
`summary` + `coreIdea`. The **negative** check (5) reads **only** `riskManagementSummary`
+ `parameters` (where a fabrication would live) — no fallback. The exact field set per
check is fixed in code and unit-tested.

> Rationale for check 5 targets: the source never states leverage, base order size,
> fees, exchange, or universe — research-notes §11/§14 confirm these are host-owned and
> must not be invented. The DCA `sizeMultipliers` (1.2/1.5) are sizing *hints*; stating
> them as hints is allowed, so check 5 targets only leverage / base-size / equity-fraction
> claims, not DCA hint multipliers.

### 3.3 Verdict

```
PASS  iff  (gate1 && gate2) && score >= THRESHOLD
FAIL  otherwise
```

`THRESHOLD` default **0.8**, overridable via `--threshold`.

`ScoreResult` shape (recorded per candidate):

```ts
interface ScoreResult {
  gates: { schemaValid: boolean; directionLong: boolean };
  checks: Array<{ id: string; weight: number; bucketsHit: number; bucketCount: number; contribution: number; matched: string[] }>;
  score: number;          // 0..1
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}
```

---

## 4. Artifacts

```
.artifacts/experiments/strategy-analyst/long-oi/<timestamp>/
  manifest.json              # run summary
  <model-slug>.json          # per candidate
  <model-slug>.judge.json    # only when --judge
```

- `<model-slug>` = fs-safe slug of the model id (`/` and `:` → `_`).
- `<timestamp>` = compact ISO, e.g. `20260616T1530Z` (real clock — fine in a CLI; the
  `Date.now` restriction is workflow-script-only).
- `.artifacts/` is already gitignored → no accidental commits.

**`<model-slug>.json`:**

```jsonc
{
  "model": "openai/gpt-5",
  "provider": "openai",
  "modelId": "gpt-5",
  "latencyMs": 4213,
  "schemaValid": true,
  "score": { /* ScoreResult from §3 */ },
  "verdict": "PASS",
  "rawOutput": { /* the candidate AnalystProfileOutput verbatim, or the raw object if schema-invalid */ },
  "error": null
}
```

**`manifest.json`:**

```jsonc
{
  "timestamp": "20260616T1530Z",
  "gitSha": "db6eb06",
  "harnessVersion": "analyst-eval-v1",
  "contractVersion": "strategy-profile-v1",
  "mode": "run",                      // always "run" in v1 (manifest is only written under --run); field kept for forward-compat
  "fixture": { "id": "long-oi", "fingerprint": "sha256:…" },
  "threshold": 0.8,
  "judgeEnabled": false,
  "models": ["anthropic/claude-opus-4-8", "openai/gpt-5", "openrouter/…"],
  "perModel": [ { "model": "openai/gpt-5", "verdict": "PASS", "score": 0.86 } ],
  "overallSuccess": true              // >=1 PASS
}
```

**Dry-run artifacts:** by default dry-run writes **nothing** paid. It prints the plan to
stdout. (A future opt-in dry-run manifest is explicitly out of scope for v1.)

---

## 5. CLI contract & the paid-call gate

```
pnpm analyst:eval \
  --fixture long-oi \
  --models anthropic/claude-opus-4-8,openai/gpt-5,openrouter/x-ai/grok-… \
  [--run] [--threshold 0.8] [--judge --judge-model anthropic/claude-opus-4-8]
```

npm script:

```json
"analyst:eval": "node --experimental-strip-types scripts/strategy-analyst-eval.ts"
```

### 5.1 Paid-call gate (corrected — strict)

**`--run` is the sole human trigger for spend.** Default (no `--run`) is dry-run and
**must never construct or call a real provider model.**

| Condition | Behavior |
|---|---|
| no `--run` | **dry-run only.** No real model construction, **no `composeMastra` call**, no `.analyze` calls, no paid artifacts. |
| `--run` | paid calls allowed **iff** the required provider API keys are present. |
| `ALLOW_PAID_LLM=1` **alone** (no `--run`) | **not sufficient** — still dry-run. |
| `ALLOW_PAID_LLM=1` **+ `--run`** | allowed; `ALLOW_PAID_LLM` is an *optional additional* CI/automation confirmation, never the only trigger. |

> Why: `.env` is sticky and easy to forget, so an env var alone must never authorize
> spend. The explicit per-invocation `--run` flag is required every time.

**Optional CI hardening (design-level knob, default off):** a `--require-env-confirm`
flag (or config) MAY additionally require `ALLOW_PAID_LLM=1` on top of `--run` for
automated contexts. It can never *replace* `--run`.

### 5.2 Dry-run behavior (corrected)

Dry-run does exactly this, all without instantiating any provider SDK:

1. Parse `--models` (CSV).
2. Compute candidate `{ provider, modelId }` for each via **`parseRoleModel`** (pure
   string parsing — **no model construction**).
3. Report **required vs missing** provider API keys per candidate
   (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`).
4. Print the planned paid-call count (`models × 1 fixture`, `+ judge` if `--judge`).
5. Optionally validate harness wiring with the **fake** analyst (still no real calls).
6. Write **no** paid artifacts.
7. **Never** call `composeMastra` in a way that constructs real provider models.

### 5.3 Exit codes

| Mode | Outcome | Exit |
|---|---|---|
| dry-run | always | `0` |
| `--run` | ≥1 model `PASS` | `0` |
| `--run` | ran, **no** model passed | `3` |
| any | infra/config error (missing key under `--run`, bad args, fixture not found) | `1` |

---

## 6. Optional judge (in scope, opt-in)

- Enabled **only** with `--judge` **and** an explicit `--judge-model <provider/model>`
  (no default model — must be passed).
- A judge call is a paid call → **gated by `--run`** (in dry-run, `--judge` only adds
  `+1` to the planned-call count, constructs nothing).
- New **experimental** judge agent (`createStrategyAnalystJudgeAgent`) with its own
  prompt and a `JudgeVerdictSchema` — lives in `src/experiments/strategy-analyst/`,
  **not** in `src/mastra/agents/` (it is not production).
- **Inputs:** the candidate `AnalystProfileOutput` + `long-oi-strategy-rubric.md` + the
  research-notes (`long-oi-strategy-research-notes.md`).
- **Output:** `<model-slug>.judge.json` (separate file).
- **Never affects the deterministic PASS/FAIL.** Deterministic scoring is independent and
  always runs.

`JudgeVerdictSchema` (experimental):

```ts
z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
  overallScore: z.number().min(0).max(1),
  hallucinations: z.array(z.string()),     // claims not supported by the source/notes
  missingFromProfile: z.array(z.string()), // rubric items the profile omitted
  notes: z.string(),
});
```

---

## 7. Success criteria & boundaries

### 7.1 Success

A run is successful when:
- ≥1 real Anthropic/OpenAI/OpenRouter model produces a **schema-valid**,
  `direction:'long'` profile scoring **≥ threshold** (verdict `PASS`);
- artifacts are written under `.artifacts/experiments/strategy-analyst/long-oi/<timestamp>/`;
- **no DB writes, no backtester, no hypothesis generation, no builder, no persisted
  `StrategyProfile`.**

### 7.2 Boundaries (hard — experimental)

- No DB writes.
- No persisted `StrategyProfile`.
- No hypothesis generation.
- No builder.
- No backtester.
- No mock-platform integration.
- No SP-7 callback / queue / CAS continuation.
- Do not change `AnalystProfileOutputSchema` / `StrategyProfile` schema.
- Do not change the production analyst prompt (`INSTRUCTIONS` / `buildPrompt`).
- Imports restricted to the list in §2 — enforced by a guard test that asserts the
  harness module graph references no repository/queue/builder/backtest/DB module.

---

## 8. Testing (TDD)

`scoring.ts` carries the bulk (pure, deterministic):
- a hand-built "good" profile (mirroring research-notes §4–13) → `PASS`;
- a `direction:'short'` profile → gate FAIL (verdict FAIL even if score high);
- a schema-invalid raw object → gate FAIL (`schemaValid:false`);
- a profile whose `riskManagementSummary` fabricates `leverage: 10x` / `$100 base` →
  check 5 contributes 0;
- a profile missing TP2 in `exitConditions` → check 3 partial credit (0.15 of 0.20);
- a profile that put DCA/BE in `summary` (empty `positionManagementSummary`) → check 4
  hits via fallback;
- RU-only and EN-only phrasings → both match synonym buckets.

Harness / CLI:
- `runEval` with a **fake** `analystFor` → zero paid calls; asserts scoring + result shape.
- **dry-run** path: asserts `.analyze` is **never** called and `composeMastra` is **never**
  invoked (inject a spy factory; assert no provider construction).
- `parseRoleModel`-based key-report: asserts missing-key reporting per provider.
- `artifacts.ts`: writes to a tmp dir (or `.artifacts-test/`) and re-reads the manifest.
- judge: tested with a **fake** judge agent (canned `JudgeVerdictSchema` object);
  asserts judge output never alters the deterministic verdict.
- guard test: harness imports contain no forbidden modules (§7.2).

---

## 9. Open knobs (defaults chosen; adjust at review)

- `THRESHOLD = 0.8`.
- Exit code `3` for "ran, none passed".
- `--models` CSV is the primary model-list mechanism.
- Judge model must be passed explicitly (no default).
- Capture-checks fall back to `summary` + `coreIdea`; negative check (5) does not.
- Synonym buckets are the v1 lexicon (extendable); kept in `scoring.ts` and unit-tested.

---

## 10. Out of scope (explicitly deferred)

- Multi-fixture batch runs / fixture matrix (v1 is single-fixture `long-oi`).
- Aggregated cross-run leaderboards / historical trend reports.
- Persisting any result to the DB or as a `StrategyProfile`.
- Feeding scores back into model selection / production config.
- Opt-in dry-run manifest artifact.
