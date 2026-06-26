# Pre-flight Strategy Critic — Design

**Date:** 2026-06-26
**Status:** Approved (brainstorming)

## Context

When a user describes a strategy in chat (e.g. *"шорт после пампа от 10% за 20 минут"*), the text is
usually under-specified — no regime filter, no invalidation condition, no liquidity / BTC-dependence
caveats. Today that raw text goes straight into `strategy.onboard` → `analyst.analyze` → profile →
research cycle, and the vagueness is "fixed" expensively, one hypothesis at a time.

This slice inserts a **pre-flight strategy critic**: before the analyst sees the text, an LLM step (a
hardened "ruthless market opponent") critiques the idea and returns an **improved strategy text** that
already accounts for the obvious nuances. The improved text is what the analyst turns into a profile,
so the research cycle starts from a stronger baseline and spends hypotheses on fine-tuning rather than
on repairing the obvious.

Intended outcome: better initial profiles, fewer wasted research cycles, and a stored, human-visible
critique for every new strategy.

## Decisions

- **Contract (stable):** the port returns `StrategyRefinement = { <6-section human critique>,
  improvedStrategyText }`. The improved text feeds the analyst. Downstream code is agnostic to how
  many LLM calls produced it.
- **Pluggable mode** behind `STRATEGY_CRITIC_MODE = 'single' | 'two_stage'` (default `two_stage`):
  - `two_stage` — a pure critic agent (the user's prompt **verbatim**, critique-only) → a refiner
    agent that applies the critique to the original text. Clean role separation; 2 LLM calls.
  - `single` — one combined agent (reworked prompt) emits critique **and** improved text. 1 call.

  Both modes ship now so the single-vs-two-LLM question is decided by data later (see *Comparison &
  future eval*), not guessed. Default `two_stage` preserves the user's prompt fidelity until the eval
  settles it.
- **Mode of operation:** automatic + transparent, **non-blocking**. The critique runs for every new
  strategy, the improved text flows to the analyst, the critique is stored + surfaced — but a critic
  failure never blocks onboarding (fail-soft: fall back to the original text).
- **Trigger:** all source kinds of a *new* strategy (`strategy.onboard`), not only chat.
- **Eval:** deferred to a later slice — wire default models behind flags (mirrors analyst/critic).
- **Default OFF** behind `STRATEGY_PREFLIGHT_CRITIQUE` → zero behavior change until explicitly enabled.

## Architecture

New module namespace **`strategy-critic`**, deliberately distinct from the existing post-hypothesis
`critic` (`CriticPort`, which reviews a `HypothesisProposalDraft`). The new critic critiques the **raw
strategy source text**. It mirrors the existing analyst/critic seams end-to-end.

### 1. Domain — `src/domain/strategy-critic.ts`

- `StrategyCriticInputSchema` = reuse the `StrategyAnalystInput` shape `{ kind, content, uri?, title? }`
  (the critic sees exactly what the analyst would).
- `StrategyCritiqueSchema` (zod) — the 6-section human-facing critique, mirroring the user's prompt:
  - `vulnerabilities: string[]` — weak points of the thesis (5–10)
  - `selfDeception: string[]` — fact-vs-interpretation, FOMO, already-priced-in catalyst, unconfirmed
    conviction
  - `risks: { market, timing, news, liquidity, btcRegime, exhaustion: string }`
  - `earlyBreakSigns: string[]` — ≤3 earliest signs the idea is breaking
  - `preEntryChecks: string[]` — ≤5 things to verify before entry
  - `verdict: { mainVulnerability: string; severity: 'low'|'medium'|'high';
    badIdeaOrBadTiming: 'bad_idea'|'bad_timing'|'neither'; whatWouldStrengthen: string }`
- `StrategyRefinementSchema = StrategyCritiqueSchema + { improvedStrategyText: string;
  changeLog?: string[] }` — the **port's return type**; `improvedStrategyText` is what the analyst
  receives.

### 2. Port — `src/ports/strategy-critic.port.ts`

```ts
interface StrategyCriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly mode: 'single' | 'two_stage';
  readonly model: string;
  refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement>;
}
```

Reuses `AgentCallOpts` / `onUsage` (`src/ports/agent-call-opts.ts`). In `two_stage`, **both**
`generate` calls invoke `onUsage`, so token/cost accrual sums across stages.

### 3. Adapters — `src/adapters/strategy-critic/` (all implement `StrategyCriticPort`)

- `fake-strategy-critic.ts` — deterministic: echoes input as `improvedStrategyText` + canned critique
  (tests + default-fake wiring). Accepts a `mode` for shape parity.
- `single-stage-strategy-critic.ts` (mastra) — one combined agent:
  `agent.generate(buildPrompt(input), { structuredOutput: { schema: StrategyRefinementSchema } })`
  → `onUsage` → parse. Returns the full refinement directly.
- `two-stage-strategy-critic.ts` (mastra) — critic agent → refiner agent:
  1. `critic.generate(buildCritiquePrompt(input), { schema: StrategyCritiqueSchema })` → `onUsage`
  2. `refiner.generate(buildRefinePrompt(input, critique), { schema: { improvedStrategyText, changeLog } })`
     → `onUsage`
  3. assemble `StrategyRefinement = { ...critique, improvedStrategyText, changeLog }`.

### 4. Mastra agents — `src/mastra/agents/`

- `strategy-critic.agent.ts` — `STRATEGY_CRITIC_AGENT_ID = 'strategy-critic'`,
  `createStrategyCriticAgent(model)`. INSTRUCTIONS = a faithful **English** rendering of the user's
  "ruthless market opponent" prompt, **critique-only** (no rewrite): only attack the idea, find 5–10
  weak points, separate fact from interpretation, categorize risk (market / timing / news / liquidity
  / BTC-regime / exhaustion), name the earliest break signs, list pre-entry checks, give a terse
  verdict; no trade advice, no invented facts, explicitly flag missing data. Used by `two_stage`.
- `strategy-refiner.agent.ts` — `STRATEGY_REFINER_AGENT_ID = 'strategy-refiner'`,
  `createStrategyRefinerAgent(model)`. INSTRUCTIONS: given the original strategy text + the critic's
  findings, rewrite the strategy *description* to address the findings (add regime filters,
  invalidation, caveats), in the **same language as the input**, keeping execution / risk-sizing
  runner-owned; emit `improvedStrategyText` + a short `changeLog`. Used by `two_stage`.
- `strategy-critic-combined.agent.ts` — `STRATEGY_CRITIC_COMBINED_AGENT_ID`,
  `createStrategyCriticCombinedAgent(model)`. INSTRUCTIONS: the critic persona **plus** the refinement
  task, emitting the full `StrategyRefinement`. Used by `single`. (This is the "reworked / blended"
  prompt — the trade-off the user flagged where the deconstructive persona is diluted by a
  constructive task.)

### 5. Composition / env

- `compose-mastra.ts`: register all three agents into `MastraRuntime.agents` (`strategyCritic`,
  `strategyRefiner`, `strategyCriticCombined`); extend `MastraCompositionEnv` with
  `STRATEGY_CRITIC_ADAPTER: 'fake'|'mastra'`, `STRATEGY_CRITIC_MODE: 'single'|'two_stage'`,
  `STRATEGY_CRITIC_MODEL`, `STRATEGY_REFINER_MODEL` (two_stage refiner; defaults to the critic model
  when unset).
- `config/env.ts`: add `STRATEGY_CRITIC_ADAPTER` (default `'fake'`), `STRATEGY_CRITIC_MODE` (default
  `'two_stage'`), `STRATEGY_CRITIC_MODEL` + `STRATEGY_REFINER_MODEL` (sensible default model ids), and
  the runtime gate `STRATEGY_PREFLIGHT_CRITIQUE: boolean` (default `false`). Add to `.env.example` +
  docker-compose ingress/worker passthrough (mirror `PHOENIX_*` / `OPERATOR_*`).
- `composition.ts`: `buildStrategyCritic(env, rt): StrategyCriticPort | null` — returns `null` when
  `STRATEGY_PREFLIGHT_CRITIQUE` is false (the handler then skips entirely); otherwise builds the
  fake / single-stage / two-stage adapter per `STRATEGY_CRITIC_ADAPTER` + `STRATEGY_CRITIC_MODE`. Add
  `strategyCritic?: StrategyCriticPort` to `AppServices` and thread it in.

### 6. Handler — `src/orchestrator/handlers/strategy-onboard.handler.ts`

Insert between the source-artifact `put` and `analyst.analyze`:

```ts
let analyzeInput = input;
if (services.strategyCritic) {
  emit strategy_critic.started { mode, model }
  try {
    const refinement = await services.strategyCritic.refine(input, makeOnUsage(task, services));
    const critiqueRef = await services.artifacts.put(JSON.stringify(refinement), { kind: 'strategy_critique', ... });
    emit strategy_critic.completed { mode, severity, badIdeaOrBadTiming, mainVulnerability, critiqueRef }
    analyzeInput = { ...input, content: refinement.improvedStrategyText };
  } catch (err) {
    emit strategy_critic.failed { error }   // fail-soft
    analyzeInput = input;
  }
}
output = await services.analyst.analyze(analyzeInput);
```

**Idempotency / provenance preserved:** `fingerprint` and the `strategy_source` artifact stay on the
**original** `input.content` (resubmitting the same raw text still dedups; the source of record is what
the user wrote). The improved text is an intermediate captured in the `strategy_critique` artifact +
the `strategy_critic.completed` event.

### 7. Cost accrual + `makeOnUsage` extraction

Extract the ~13-line `onUsage` callback — currently duplicated ×3 in the research-run-cycle /
hypothesis-build handlers (price lookup → `tokenUsage.addCost`, null price → `research.cost_unpriced`
event, plus `tokenUsage.add` for tokens) — into `makeOnUsage(task, services)`; reuse it for the critic
call (and refactor the existing call sites onto it). This was already a logged follow-up from the
cost-accounting slice. In `two_stage` the helper is invoked per stage, so both calls accrue.

### 8. Read surface — `src/read-api/completion-summary.ts`

Extend `OnboardCompletionSummary` with optional
`critique?: { severity; badIdeaOrBadTiming; mainVulnerability }`, read from the
`strategy_critic.completed` event via the existing `agentEvents` reader (graceful-degradation path).
Transparent surfacing without a DB migration.

## Comparison & future eval (recorded now, built later)

This slice ships **both** modes (`single`, `two_stage`) behind `STRATEGY_CRITIC_MODE` so the
single-vs-two-LLM question is answered by data, not guessed. The separate **strategy-critic eval
slice** (mirrors the analyst / researcher harnesses) will: run a corpus of vague strategies through
both modes, score the `improvedStrategyText` (deterministic checks — did it add a regime filter, an
invalidation condition, liquidity / BTC caveats; does the refined text still round-trip through the
analyst into a valid profile), and use an **opus-4.8 LLM-as-judge** to pick the better refinement per
case → choose the default mode + models (and, separately, the cheap critic model). Nothing here
pre-commits that outcome; the seam makes it a config flip.

## Out of scope (later slices)

- Strategy-critic **eval harness** / opus-4.8 judge / cheap-model selection (the comparison above).
- **Human-in-the-loop** confirm/edit of the critique before analysis (the operator two-turn flow).
- Rich **office UI** rendering of the full 6-section critique (this slice exposes only the verdict
  triple in the completion-summary).
- No DB schema change / migration (the critique lives in artifacts + events).

## Testing / verification

- **Unit:** schema round-trip; `FakeStrategyCritic`; `SingleStageStrategyCritic` +
  `TwoStageStrategyCritic` (mirror `mastra-strategy-analyst.test.ts`; assert two_stage calls BOTH
  agents, accrues `onUsage` twice, and assembles `StrategyRefinement` from the two outputs).
- **Handler:** (a) flag off → critic `null` → analyst sees original text, no critic events;
  (b) flag on → critic runs → analyst sees `improvedStrategyText`, `strategy_critic.completed`
  emitted, critique artifact stored; (c) critic throws → `strategy_critic.failed` + analyst sees the
  original text (fail-soft); (d) dedup short-circuit still skips the critic (fingerprint on original).
- **env:** defaults (`STRATEGY_PREFLIGHT_CRITIQUE=false`, `STRATEGY_CRITIC_ADAPTER='fake'`,
  `STRATEGY_CRITIC_MODE='two_stage'`).
- **completion-summary:** onboard summary includes the `critique` triple when the event exists;
  degrades gracefully when absent.
- **Regression:** the `makeOnUsage` extraction is behavior-preserving for the existing 2 handlers
  (their cost/token tests stay green).
- **Gates:** `pnpm typecheck` + `pnpm test` (full suite green); `make config` (compose validates).
- **Manual (optional, later):** docker demo stack with `STRATEGY_PREFLIGHT_CRITIQUE=true` +
  `STRATEGY_CRITIC_ADAPTER=mastra` + a real model; onboard a vague strategy from chat and confirm the
  stored critique + the refined text the analyst received.
