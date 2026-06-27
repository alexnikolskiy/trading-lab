# Analyst Prompt Improvement + max_tokens Cap — Design

**Date:** 2026-06-28
**Status:** Approved (brainstorming)
**Branch:** `feat/analyst-prompt-maxtokens` (from main)

## Context

The strengthened analyst eval (repeat=3, long-oi + short-pump, opus judge) ranked **gpt-5.5 > opus ≈
> grok-4.3 > gemini** — grok passes but trails on the granular `scoreProfile` secondary (0.842 vs
gpt's 0.933) and judge (0.933 vs 0.973). Before switching the default analyst to the pricier gpt-5.5,
we try the same lever that closed grok's gap on the CRITIC: a **structured-extraction prompt**. The
current `StrategyAnalyst` agent prompt is a minimal generic instruction; grok likely under-extracts
(thinner entry/exit/position-mgmt). If a structured prompt lifts grok-analyst close to gpt-5.5, we
keep the cheap grok default; otherwise we switch to gpt-5.5.

Separately, the decision run hit OpenRouter 402s because the harness reserves up to **65536
max_tokens per call** (a default — set nowhere in code). That over-reserves credits (pricier models +
the opus judge fail first when the balance is low) and inflates cost. Cap it globally.

## Decisions

- **Improve the `StrategyAnalyst` agent prompt** with structured-extraction guidance (mirroring the
  critic combined-prompt approach): extract exhaustively into the profile's fields, be thorough but
  never invent (gaps → `unknowns`), keep runner-owned authorities. Product change (used in onboarding).
- **`MAX_OUTPUT_TOKENS = 16384`**, applied as `maxOutputTokens` to ALL ~12 `agent.generate(...)`
  calls (every adapter + every experiment judge). Ample for any profile/critique/verdict/builder
  output; cuts the 65536 reservation 4× → fixes the 402 + reduces cost.
- **Re-measure (manual, after merge):** `analyst:eval` **grok-4.3 vs gpt-5.5** only (opus = judge),
  repeat=3, long-oi + short-pump → keep grok if it closed the gap, else switch the default to gpt-5.5.
- **Future analyst measurements:** grok-4.3 vs gpt-5.5 only; opus judge-only (recorded preference).

## Architecture (all in trading-lab; product change)

### 1. Structured analyst prompt (`src/mastra/agents/strategy-analyst.agent.ts`)

Extend `INSTRUCTIONS` with explicit, exhaustive extraction guidance — instruct the analyst to
populate each profile field as completely as the source supports:
- **entry conditions** — every trigger/condition stated.
- **exit & invalidation** — take-profits, stop, time-exit, and explicit invalidation.
- **required market-data features** — the signals the strategy needs (OHLCV, open interest, funding,
  liquidations, taker buy/sell → delta/CVD).
- **position management** — DCA / breakeven / scaling if present.
- **tunable parameters** — mark `tunable: true`.
Keep the existing guardrails: do NOT invent (gaps → `unknowns`); risk-sizing / execution / fills are
`runnerOwnedAuthorities`. The goal is completeness/specificity, not new behavior. The output schema
(`AnalystProfileOutput`) is unchanged.

### 2. `MAX_OUTPUT_TOKENS` cap

- New shared constant (e.g. `src/adapters/llm/generate-defaults.ts` or alongside `model-provider.ts`):
  `export const MAX_OUTPUT_TOKENS = 16384;`
- Add `maxOutputTokens: MAX_OUTPUT_TOKENS` to the options object of every `agent.generate(...)` call:
  - Adapters: `mastra-strategy-analyst.ts`, `mastra-critic.ts`,
    `strategy-critic/{single-stage,two-stage}-strategy-critic.ts` (both stages),
    `mastra-researcher.ts`, `mastra-builder.ts`, `intent/mastra-turn-interpreter.ts`.
  - Experiment judges: `strategy-analyst/judge.ts`, `strategy-critic/judge.ts`,
    `researcher/judge.ts`, `builder/judge.ts`.
- VERIFY the exact AI-SDK-v6 / Mastra-1.41 option name (`maxOutputTokens` in AI SDK v6) during
  implementation; use whatever Mastra's `agent.generate` forwards. The option sits alongside the
  existing `structuredOutput: { schema }`.

### 3. Re-measure + default switch — OUT OF SCOPE (manual follow-up)

After merge: `analyst:eval --models openrouter/x-ai/grok-4.3,openrouter/openai/gpt-5.5 --judge
--judge-model openrouter/anthropic/claude-opus-4.8 --repeat 3` on both fixtures → decide; then a tiny
config slice switches the default `STRATEGY_ANALYST_MODEL` if gpt-5.5 wins.

## Testing

- analyst agent: `INSTRUCTIONS` contains the structure markers (entry / exit & invalidation /
  required data / position management) AND still contains the no-invent + runner-owned guardrails;
  existing analyst-agent construction test stays green; the schema is unchanged.
- max_tokens: a test that each adapter's `generate` is called with `maxOutputTokens: MAX_OUTPUT_TOKENS`
  (the critic single/two-stage adapters already use stub agents that capture the options — assert
  there; for adapters without a capturing test, at minimum the const is imported + used and typecheck
  passes). The shared const has a trivial value test.
- Gate: `pnpm typecheck` + `pnpm test` (full suite green). Behavior otherwise unchanged (16384 is far
  above any real output length, so no truncation of existing outputs).

## Out of scope

- The paid re-measurement run + switching the default `STRATEGY_ANALYST_MODEL` (follow-up).
- Changing the completeness scorer's `UNKNOWNS_CAP` (the det quirk that penalizes thorough models is
  separate; the judge + secProfile are the discriminators).
- Per-model or per-call-type max_tokens tuning (one global cap for now).
