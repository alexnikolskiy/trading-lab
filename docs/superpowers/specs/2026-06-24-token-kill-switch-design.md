# Token Kill-Switch for the Research Cycle — Design

**Date:** 2026-06-24
**Status:** Approved (design); ready for implementation plan
**Roadmap:** `docs/conversational-operator-roadmap.md` → Tech debt "Token/cost kill-switch"

## Goal

Bound the cumulative **token** spend of a research chain so a looping
research→build→backtest cycle cannot run away. Today we cap *time* (retrieval
soft/hard deadlines, reranker timeout) and *depth* (`MAX_CYCLE_DEPTH = 2`), but not
*tokens* per research task. This adds a cumulative token budget keyed by the research
chain's `correlationId`, enforced as a **between-cycles gate** that mirrors the existing
depth cap. Phoenix/Mastra provide the usage *numbers*; the *enforcement* (stop) is ours.

## Scope decisions (settled with user, 2026-06-24)

1. **Scope:** the research cycle (cross-cycle, cumulative per research chain / `correlationId`).
2. **Dimension:** **tokens** (`result.usage.totalTokens`). Cost in $ (price table) is out of scope.
3. **Gate granularity:** **between cycles** — checked before `enqueueResearchRetry`; the
   current cycle always completes, only the *next* retry is suppressed. The first cycle is
   never blocked.
4. **Default:** **ON** with a generous cap. `RESEARCH_TASK_TOKEN_BUDGET` defaults to
   `200000`; `0` = unlimited (disabled).

## Architecture

### Gate point — `backtestCompletedHandler`

The existing depth cap lives in `src/orchestrator/handlers/backtest-completed.handler.ts`,
in the `FAIL` / `MODIFY` branches: if `cycleDepth < MAX_CYCLE_DEPTH` it calls
`enqueueResearchRetry(...)` and emits `research.retry_enqueued`; otherwise it emits
`research.retry_budget_exhausted` and stops. The token gate sits **right beside it**. The
retry decision becomes:

```
willRetry = cycleDepth < MAX_CYCLE_DEPTH && withinTokenBudget(cumulativeTokens, budget)
```

- Within budget → unchanged behavior (`enqueueResearchRetry` + `research.retry_enqueued`).
- Over budget → no retry; emit a new event **`research.token_budget_exhausted`** carrying
  `{ strategyProfileId, cumulativeTokens, budgetTokens }`.

Depth-cap and token-cap are independent stop reasons; both produce a clean terminal "no
further retry" with their own event. The first cycle is never gated (cost is unknowable
before it runs), exactly like the depth cap which also only bounds retries.

### Usage capture — optional `onUsage` callback on the three cycle ports

The three adapters that run inside the cycle — **researcher** (`ResearcherPort.propose`),
**builder** (`BuilderPort.build`), **critic** (`CriticPort.review`, nullable) — currently
call `agent.generate(...)` and discard `result.usage`. Each port method gains an optional
final argument:

```ts
propose(input: ResearcherInput, opts?: { onUsage?: (totalTokens: number) => void }): Promise<ResearcherOutput>;
build(input: BuilderInput,       opts?: { onUsage?: (totalTokens: number) => void }): Promise<BuilderOutput>;
review(input: CriticInput,       opts?: { onUsage?: (totalTokens: number) => void }): Promise<CriticOutput>;
```

The Mastra adapters call `opts?.onUsage?.(result.usage?.totalTokens ?? 0)` after `generate`
(AI SDK v6 `LanguageModelUsage.totalTokens`, which may be `undefined` → coerce to 0). Fake
adapters ignore `opts`. **Rationale for a callback rather than a field on the domain output:**
the output types (`ResearcherOutput` / `BuilderOutput` / `CriticOutput`) flow into validation,
persistence, and the eval harnesses (`real-{researcher,builder,analyst}-factory`); an optional
trailing callback param leaves every existing call site, fake, and eval test compiling
unchanged, and keeps token-accounting out of the domain types.

The cycle handlers pass `{ onUsage: (t) => services.tokenUsage.add(task.correlationId, t) }`:
- `research-run-cycle.handler` → wraps the `services.researcher.propose` call and the
  guarded `services.critic.review` call (critic is nullable).
- `hypothesis-build.handler` → wraps the `services.builder.build` call.

`turn-interpreter` and `analyst` are out of scope (not in the research retry loop).

### Persistence — `TokenUsageRepository` keyed by `correlationId`

Retries are separate worker jobs that share one `correlationId`, so the counter is
persisted, not in-process. New port + adapters following the existing repository pattern
(drizzle + in-memory):

```ts
interface TokenUsageRepository {
  add(correlationId: string, tokens: number): Promise<void>; // cumulative upsert-increment
  get(correlationId: string): Promise<number>;               // 0 when absent
}
```

Migration (additive, next sequential number): table
`research_token_usage (correlation_id text primary key, cumulative_tokens bigint not null default 0, updated_at timestamptz not null default now())`.
`add` is an upsert: `insert ... on conflict (correlation_id) do update set cumulative_tokens = research_token_usage.cumulative_tokens + excluded.cumulative_tokens, updated_at = now()`.

`backtestCompletedHandler` reads `await services.tokenUsage.get(task.correlationId)` before
the gate.

### Budget primitive

A pure function (the honest "budget" unit — a persisted counter + a pure check, **not** an
in-process abortable object like `RetrievalBudget`, because token totals are only known
after each call and the cycle spans jobs):

```ts
export function withinTokenBudget(cumulativeTokens: number, budgetTokens: number): boolean {
  return budgetTokens <= 0 || cumulativeTokens < budgetTokens; // 0 (or negative) = unlimited
}
```

### Configuration

`RESEARCH_TASK_TOKEN_BUDGET` added to `src/config/env.ts`: default `200000`, `0` = unlimited.
Parsed permissively (non-negative integer; invalid → default; `0` allowed). Threaded into
`services` so `backtestCompletedHandler` reads it (alongside `tokenUsage`).

### Observability / completion summary

`research.token_budget_exhausted` joins the event taxonomy. `src/read-api/completion-summary.ts`
(which already mirrors `MAX_CYCLE_DEPTH` / `willRetry` for `research.run_cycle`) reflects the
token-exhausted stop so the user sees "stopped: token budget exhausted" rather than a silent
halt. Consistent with the privacy invariant — the event carries only ids/counts, never raw text.

## Testing (TDD)

- `withinTokenBudget` — pure unit cases: under limit → true; at/over limit → false;
  `budget = 0` → always true (unlimited); negative → unlimited.
- `TokenUsageRepository` (in-memory) — `get` of an absent key is 0; `add` accumulates;
  per-`correlationId` isolation.
- `backtestCompletedHandler`:
  - `FAIL` with `cumulative >= budget` (and `cycleDepth < MAX_CYCLE_DEPTH`) → **no**
    `enqueueResearchRetry`, emits `research.token_budget_exhausted`.
  - `FAIL` with `cumulative < budget` → retry enqueued as before.
  - `budget = 0` → token gate never fires (depth cap still applies).
  - same matrix for `MODIFY`.
- Cycle handlers record usage: with a fake agent reporting a known `usage.totalTokens`, the
  Mastra adapter invokes `onUsage` with that value; the handler calls `tokenUsage.add` with
  `correlationId`. Fake adapters never call `onUsage`.
- `completion-summary` reflects `research.token_budget_exhausted` (willRetry false + reason).

## Out of scope (future)

- Cost ($) accounting / per-model price table.
- An in-process abortable `TokenBudget` primitive for future agentic loops (Reflexion,
  agentic-RAG) — wire when such a loop exists.
- Per-step gating *within* a cycle (only between-cycles here).
- Gating the first cycle, or budgeting the per-chat-turn interpreter.

## Done criteria

1. A research chain whose cumulative tokens reach `RESEARCH_TASK_TOKEN_BUDGET` stops
   retrying on the next `FAIL`/`MODIFY` with a `research.token_budget_exhausted` event,
   independent of `MAX_CYCLE_DEPTH`.
2. `RESEARCH_TASK_TOKEN_BUDGET=0` → behavior identical to today (no token gating).
3. Usage is accumulated per `correlationId` across cycles via the `onUsage` callback; fakes
   contribute 0; existing call sites / eval harnesses compile unchanged.
4. Completion summary surfaces the token-budget stop. Full suite green; migration additive.
