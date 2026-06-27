# Strategy-Critic Round-Trip Eval — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming)
**Branch:** extends `feat/strategy-critic-eval` (PR #89)

## Context

The strategy-critic eval harness (PR #89) compares critic modes/models by the quality of the
*critique + refinement*. A live paid run surfaced a second-order effect: the refined text then
goes to the **StrategyAnalyst** (default `x-ai/grok-4.3`) to become a JSON `StrategyProfile`, and
the analyst's output quality tracks the *richness* of the refined text. Telegraphic refinements
(grok-4.3) produced profiles with **empty `exitConditions` and more `unknowns`**; verbose ones
(gpt-5.5) produced complete profiles — even though the critique-judge scored the models nearly
equally. The critique-only metric is blind to this downstream cost.

This slice adds a **round-trip** evaluation: improved text → analyst → profile → score, with the
**judge also seeing the resulting profile**, so model selection reflects the whole chain. It also
improves the single-mode (combined) agent's prompt to emit **structured** refined text (explicit
entry/exit/invalidation blocks) so the cheap model (grok) can feed the analyst a complete profile —
trying hard to keep grok viable before escalating to a pricier model.

A separate confirmed finding from the same run drives scope: **the two-model (`two_stage`) path is
not worth it** — the best `two_stage` (grok→gpt-5.5, judge 0.935) barely edges the best `single`
(gpt-5.5, 0.93) at 5× the latency, and single-grok (0.91) beats most two_stage pairs. So the eval
focus going forward is **`single` only**; `two_stage` stays in the codebase, untouched, but is not
the subject of further tuning.

## Decisions

- **`--round-trip` flag** (default off) + **`--analyst-model <id>`** (default
  `openrouter/x-ai/grok-4.3`, the product default).
- Round-trip contributes to the verdict **two ways**: (1) the **judge** receives the resulting
  profile and factors its completeness into its score; (2) a **deterministic profile score**
  (reusing the analyst experiment's `scoreProfile`) appears as its own ranking column — both a
  subjective and an objective signal.
- **Improve the combined (single) agent prompt** to structure `improvedStrategyText` into explicit
  blocks (Entry / Exit & invalidation / Required data signals / Caveats), so the downstream analyst
  extracts complete profiles. Grounding (`PLATFORM_DATA_CAPABILITIES`) and runner-owned boundaries
  preserved. The critique-only `strategy-critic` agent stays verbatim.
- **Scope = single.** `two_stage` is untouched; round-trip works for any mode but the measured runs
  are single.
- Default-off / paid-gated, mirroring the existing harness: round-trip adds analyst calls only
  under `--run`; dry-run accounts for them and never constructs the analyst.

## Architecture

### 1. Flags + CLI (`scripts/strategy-critic-eval.ts`)

- `--round-trip` (boolean, default false), `--analyst-model` (string, default
  `openrouter/x-ai/grok-4.3`). When `--round-trip` is set, `--analyst-model` is required to resolve
  (defaulted, so always present).
- `parseCli` threads `roundTrip` + `analystModel` into the run input.

### 2. runOnce round-trip stage (`src/experiments/strategy-critic/eval-harness.ts`)

When `input.roundTrip`:
1. `refine()` as today → `refinement`.
2. `analystFor(analystModel).analyze({ kind: 'manual_description', content:
   refinement.improvedStrategyText })` → `profile`.
3. `profileScore = scoreProfile(profile, { threshold })` (reuse
   `src/experiments/strategy-analyst/scoring.ts`).
4. If judge enabled: `judge({ originalText, refinement, profile })`.
- `CandidateResult` gains `profile: AnalystProfileOutput | null` and `profileScore: ScoreResult |
  null` (both null when round-trip off, or on analyst failure).
- **Fail-soft:** if `analyze()` throws, record the error context, `profile`/`profileScore` = null,
  and still run the judge on `{ originalText, refinement }` (no profile) — the critique verdict is
  unaffected. The analyst is injected via a new `RunEvalDeps.analystFor?: (modelId) =>
  StrategyAnalystPort` (optional; only used when round-trip on).

### 3. Judge sees the profile (`src/experiments/strategy-critic/judge.ts` + judge agent)

- `JudgeInput` gains `profile?: AnalystProfileOutput`. `buildJudgePrompt` appends a
  `--- RESULTING ANALYST PROFILE (JSON) ---` block when `profile` is present.
- `strategy-critic-judge.agent.ts` INSTRUCTIONS add: "If a resulting analyst profile is provided,
  also assess how completely it captures the strategy — entry conditions, exit & invalidation,
  required data signals — and penalize empty exits or many unknowns." `JudgeVerdictSchema`
  unchanged (the `dimensions` array already absorbs new criteria).

### 4. Aggregation / ranking (`src/experiments/strategy-critic/aggregate.ts`)

- `ModelAggregate` gains optional `profile?: Stats` (mean/std of `profileScore.score` across
  ok runs). `aggregateRuns` computes it when round-trip data is present.
- `rankAggregates` sort key becomes judge-mean → **profileMean** → det-mean (profileMean only
  when round-trip). The rendered ranking row shows a `profileMean` column when round-trip is on.

### 5. Analyst wiring (`src/experiments/strategy-critic/real-critic-factory.ts`)

- Reuse `buildRealAnalystFor(baseEnv)` from `src/experiments/strategy-analyst/real-analyst-factory.ts`
  to build the analyst on `--analyst-model`. Imported only under `--run` (paid-gate intact).
- `planDryRun` adds `analystCalls` (= candidates × cases × repeat when round-trip) and includes the
  analyst model's provider key in `missingKeys`.

### 6. Combined-agent prompt improvement (`src/mastra/agents/strategy-critic-combined.agent.ts`)

Add an instruction that `improvedStrategyText` MUST be organised into explicit, labelled sections:
**Entry conditions**, **Exit & invalidation**, **Required data signals**, **Caveats** — so the
downstream analyst can extract entry/exit cleanly (fixes grok's empty-`exitConditions` /
high-`unknowns` profiles). Keep the data-capabilities grounding and the runner-owned boundary.
(Product change; still default-off behind `STRATEGY_PREFLIGHT_CRITIQUE`.) The
`strategy-critic.agent.ts` (critique-only) and `strategy-refiner.agent.ts` are NOT changed in this
slice.

## Testing (offline-deterministic)

- `scoreProfile` reuse: a small test that the imported scorer runs on a canned `AnalystProfileOutput`
  and yields a `ScoreResult` (sanity of the cross-experiment import).
- `judge.ts`: `buildJudgePrompt` includes the profile block when `profile` is present, omits it when
  absent.
- `eval-harness.ts`: round-trip stage with a fake `analystFor` (returns a canned profile) →
  `CandidateResult.profile`/`profileScore` populated, judge receives the profile; analyst-throw →
  fail-soft (profile null, critique verdict intact); round-trip off → no analyst call, profile null.
- `aggregate.ts`: `profile` Stats computed + ranking uses profileMean tiebreak when present.
- CLI dry-run: `planDryRun` with `--round-trip` reports `analystCalls` + analyst key in
  `missingKeys`, constructs nothing.
- combined agent: INSTRUCTIONS contain the structure markers (Entry / Exit & invalidation /
  Required data signals / Caveats) and still contain the capability + runner-owned markers; the
  critique-only and refiner agents are unchanged.
- Gate: `pnpm typecheck` + `pnpm test` (full suite green).

## Out of scope (later / manual)

- The paid measured run (`--round-trip --analyst-model x-ai/grok-4.3` single across grok/gemini/
  gpt) and the resulting default-config decision — manual, after merge.
- Removing `two_stage` (kept as-is).
- A round-trip variant that also backtests the profile (way out of scope).
- Auto-selecting / enabling the chosen critic model+mode in the product (a separate follow-up).
