# Token Kill-Switch for the Research Cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the cumulative token spend of a research chain (keyed by `correlationId`) so a looping research→build→backtest cycle stops retrying once it exceeds `RESEARCH_TASK_TOKEN_BUDGET`, enforced as a between-cycles gate beside the existing `MAX_CYCLE_DEPTH` cap.

**Architecture:** A pure `withinTokenBudget` check + a persisted `TokenUsageRepository` (keyed by `correlationId`) accumulate `result.usage.totalTokens` reported by the three cycle adapters (researcher/builder/critic) via an optional `onUsage` callback; `backtestCompletedHandler` reads the cumulative total and suppresses the next retry (emitting `research.token_budget_exhausted`) when over budget. Default budget 200000 tokens; `0` = unlimited.

**Tech Stack:** TypeScript (`node --experimental-strip-types`), Vitest, drizzle-orm + drizzle-kit (Postgres), Mastra agents over AI SDK v6.

**Spec:** `docs/superpowers/specs/2026-06-24-token-kill-switch-design.md`

## Global Constraints

- Runtime is `node --experimental-strip-types`: **no TypeScript parameter properties** (use explicit field declarations + assignment). `src/strip-types-no-param-properties.test.ts` must stay green.
- Budget unit is **tokens** (`result.usage.totalTokens`, AI SDK v6 — may be `undefined`, coerce to `0`). No cost/$ accounting.
- `RESEARCH_TASK_TOKEN_BUDGET` default **200000**; **`0` (or negative) = unlimited**.
- Gate is **between cycles** only (before `enqueueResearchRetry`); the current cycle always completes; the **first cycle is never gated**.
- Budget is cumulative per **`correlationId`** (retries are separate jobs sharing one correlationId), persisted — not in-process.
- `onUsage` is an **optional trailing callback** on the cycle ports; existing call sites, fake adapters, and eval harnesses must compile unchanged.
- Migrations are drizzle-kit generated: edit `src/db/schema.ts`, then `pnpm db:generate` (additive).
- Gate after each code task: `pnpm typecheck` and `pnpm test` green.

---

### Task 1: `withinTokenBudget` primitive + `RESEARCH_TASK_TOKEN_BUDGET` env

**Files:**
- Create: `src/orchestrator/token-budget.ts`
- Create test: `src/orchestrator/token-budget.test.ts`
- Modify: `src/config/env.ts` (add `parseNonNegativeInt` + the `Env` field + the parse line)
- Test: `src/config/env.test.ts`

**Interfaces:**
- Produces: `withinTokenBudget(cumulativeTokens: number, budgetTokens: number): boolean` (true when under budget OR budget ≤ 0); `Env.RESEARCH_TASK_TOKEN_BUDGET: number` (default 200000, 0 = unlimited).

- [ ] **Step 1: Write the failing primitive test**

Create `src/orchestrator/token-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withinTokenBudget } from './token-budget.ts';

describe('withinTokenBudget', () => {
  it('is within budget below the limit', () => {
    expect(withinTokenBudget(100, 200)).toBe(true);
  });
  it('is over budget at or above the limit', () => {
    expect(withinTokenBudget(200, 200)).toBe(false);
    expect(withinTokenBudget(201, 200)).toBe(false);
  });
  it('treats budget 0 (or negative) as unlimited', () => {
    expect(withinTokenBudget(1_000_000, 0)).toBe(true);
    expect(withinTokenBudget(1_000_000, -5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test -- src/orchestrator/token-budget.test.ts`
Expected: FAIL — cannot find module `./token-budget.ts`.

- [ ] **Step 3: Implement the primitive**

Create `src/orchestrator/token-budget.ts`:

```ts
// A persisted-counter budget check (NOT an in-process abortable budget): token totals are
// only known after each LLM call and the research cycle spans jobs. budget <= 0 = unlimited.
export function withinTokenBudget(cumulativeTokens: number, budgetTokens: number): boolean {
  return budgetTokens <= 0 || cumulativeTokens < budgetTokens;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm test -- src/orchestrator/token-budget.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Write the failing env test**

Add to `src/config/env.test.ts` (after the `Phoenix observability env` describe block, or at end):

```ts
describe('research task token budget env', () => {
  it('defaults RESEARCH_TASK_TOKEN_BUDGET to 200000', () => {
    expect(loadEnv({} as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(200000);
  });
  it('reads an override and allows 0 (unlimited)', () => {
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: '50000' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(50000);
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: '0' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(0);
  });
  it('falls back to default on an invalid value', () => {
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: 'abc' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(200000);
    expect(loadEnv({ RESEARCH_TASK_TOKEN_BUDGET: '-3' } as unknown as NodeJS.ProcessEnv).RESEARCH_TASK_TOKEN_BUDGET).toBe(200000);
  });
});
```

- [ ] **Step 6: Run it — verify it fails**

Run: `pnpm test -- src/config/env.test.ts`
Expected: FAIL — `RESEARCH_TASK_TOKEN_BUDGET` is `undefined`.

- [ ] **Step 7: Add the env field + parser**

In `src/config/env.ts`:

(a) In the `Env` interface, after the `PHOENIX_PROJECT_NAME: string;` line add:

```ts
  /** Cumulative token budget per research chain (correlationId). Default 200000; 0 = unlimited. */
  RESEARCH_TASK_TOKEN_BUDGET: number;
```

(b) After the existing `parsePositiveInt` function add a non-negative variant (note `parsePositiveInt` rejects 0, which we must allow):

```ts
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
```

(c) In the object returned by `loadEnv`, immediately before the `...loadRagEnv(source),` line add:

```ts
    RESEARCH_TASK_TOKEN_BUDGET: parseNonNegativeInt(source.RESEARCH_TASK_TOKEN_BUDGET, 200000),
```

- [ ] **Step 8: Run env test + typecheck**

Run: `pnpm test -- src/config/env.test.ts` → PASS.
Run: `pnpm typecheck` → clean.

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator/token-budget.ts src/orchestrator/token-budget.test.ts src/config/env.ts src/config/env.test.ts
git commit -m "feat(token-budget): withinTokenBudget primitive + RESEARCH_TASK_TOKEN_BUDGET env"
```

---

### Task 2: `TokenUsageRepository` — port, in-memory, schema table, drizzle, migration

**Files:**
- Create: `src/ports/token-usage.repository.ts`
- Create: `src/adapters/repository/in-memory-token-usage.repository.ts`
- Create test: `src/adapters/repository/in-memory-token-usage.repository.test.ts`
- Create: `src/adapters/repository/drizzle-token-usage.repository.ts`
- Modify: `src/db/schema.ts` (add `researchTokenUsage` table + `integer` import already present)
- Generate: `migrations/0011_*.sql` via `pnpm db:generate`

**Interfaces:**
- Produces: `interface TokenUsageRepository { add(correlationId: string, tokens: number): Promise<void>; get(correlationId: string): Promise<number>; }`; `InMemoryTokenUsageRepository`; `DrizzleTokenUsageRepository`; drizzle table `researchTokenUsage`.

- [ ] **Step 1: Write the failing in-memory repo test**

Create `src/adapters/repository/in-memory-token-usage.repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryTokenUsageRepository } from './in-memory-token-usage.repository.ts';

describe('InMemoryTokenUsageRepository', () => {
  it('returns 0 for an unknown correlationId', async () => {
    const repo = new InMemoryTokenUsageRepository();
    expect(await repo.get('c1')).toBe(0);
  });
  it('accumulates added tokens per correlationId', async () => {
    const repo = new InMemoryTokenUsageRepository();
    await repo.add('c1', 100);
    await repo.add('c1', 50);
    await repo.add('c2', 7);
    expect(await repo.get('c1')).toBe(150);
    expect(await repo.get('c2')).toBe(7);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test -- src/adapters/repository/in-memory-token-usage.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the port**

Create `src/ports/token-usage.repository.ts`:

```ts
/**
 * Cumulative LLM token usage per research chain (correlationId). Retries run as separate
 * worker jobs sharing one correlationId, so the counter is persisted, not in-process.
 */
export interface TokenUsageRepository {
  /** Add tokens to the chain's cumulative total (creates the row on first call). */
  add(correlationId: string, tokens: number): Promise<void>;
  /** Cumulative tokens for the chain; 0 when no usage has been recorded yet. */
  get(correlationId: string): Promise<number>;
}
```

- [ ] **Step 4: Create the in-memory adapter**

Create `src/adapters/repository/in-memory-token-usage.repository.ts`:

```ts
import type { TokenUsageRepository } from '../../ports/token-usage.repository.ts';

export class InMemoryTokenUsageRepository implements TokenUsageRepository {
  readonly #totals = new Map<string, number>();

  async add(correlationId: string, tokens: number): Promise<void> {
    this.#totals.set(correlationId, (this.#totals.get(correlationId) ?? 0) + tokens);
  }

  async get(correlationId: string): Promise<number> {
    return this.#totals.get(correlationId) ?? 0;
  }
}
```

- [ ] **Step 5: Run the in-memory test — verify it passes**

Run: `pnpm test -- src/adapters/repository/in-memory-token-usage.repository.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 6: Add the schema table**

In `src/db/schema.ts`, after the `researchTask` table block (before `agentEvent`), add (`integer`, `text`, `timestamp` are already imported on line 1):

```ts
export const researchTokenUsage = pgTable('research_token_usage', {
  correlationId: text('correlation_id').primaryKey(),
  cumulativeTokens: integer('cumulative_tokens').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 7: Create the drizzle adapter**

Create `src/adapters/repository/drizzle-token-usage.repository.ts` (mirrors `DrizzleResearchTaskRepository`; uses an upsert-increment):

```ts
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchTokenUsage } from '../../db/schema.ts';
import type { TokenUsageRepository } from '../../ports/token-usage.repository.ts';

export class DrizzleTokenUsageRepository implements TokenUsageRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async add(correlationId: string, tokens: number): Promise<void> {
    await this.db
      .insert(researchTokenUsage)
      .values({ correlationId, cumulativeTokens: tokens, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: researchTokenUsage.correlationId,
        set: {
          cumulativeTokens: sql`${researchTokenUsage.cumulativeTokens} + ${tokens}`,
          updatedAt: new Date(),
        },
      });
  }

  async get(correlationId: string): Promise<number> {
    const rows = await this.db
      .select({ total: researchTokenUsage.cumulativeTokens })
      .from(researchTokenUsage)
      .where(eq(researchTokenUsage.correlationId, correlationId))
      .limit(1);
    return rows[0]?.total ?? 0;
  }
}
```

- [ ] **Step 8: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `migrations/0011_*.sql` is created containing `CREATE TABLE "research_token_usage"` with the three columns. Verify it is additive (only the new table — no DROP/ALTER of existing tables):

Run: `git status --short migrations/` and inspect the new file.

- [ ] **Step 9: Typecheck + the repo test**

Run: `pnpm typecheck` → clean.
Run: `pnpm test -- src/adapters/repository/in-memory-token-usage.repository.test.ts` → PASS.

> The drizzle adapter is integration code (real Postgres); it is covered by typecheck here, consistent with how other Drizzle repositories ship. No live-DB unit test is added in this task.

- [ ] **Step 10: Commit**

```bash
git add src/ports/token-usage.repository.ts src/adapters/repository/in-memory-token-usage.repository.ts src/adapters/repository/in-memory-token-usage.repository.test.ts src/adapters/repository/drizzle-token-usage.repository.ts src/db/schema.ts migrations/
git commit -m "feat(token-budget): TokenUsageRepository (port + in-memory + drizzle) + research_token_usage migration"
```

---

### Task 3: `onUsage` callback on the three cycle ports + Mastra adapters

**Files:**
- Modify: `src/ports/researcher.port.ts`, `src/ports/builder.port.ts`, `src/ports/critic.port.ts`
- Modify: `src/adapters/researcher/mastra-researcher.ts`, `src/adapters/builder/mastra-builder.ts`, `src/adapters/critic/mastra-critic.ts`
- Test: `src/adapters/builder/mastra-builder.usage.test.ts`, `src/adapters/researcher/mastra-researcher.usage.test.ts`, `src/adapters/critic/mastra-critic.usage.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: each port method gains an optional final arg `opts?: AgentCallOpts` where `interface AgentCallOpts { onUsage?: (totalTokens: number) => void | Promise<void> }`; the Mastra adapters invoke `await opts?.onUsage?.(result.usage?.totalTokens ?? 0)` immediately after `generate` (before schema parsing, so usage is recorded even if parsing later throws — the tokens were already spent).

- [ ] **Step 1: Add the shared `AgentCallOpts` type to each port**

In each of `src/ports/researcher.port.ts`, `src/ports/builder.port.ts`, `src/ports/critic.port.ts`, add near the top (after imports):

```ts
/** Optional per-call hooks. onUsage reports the LLM token usage of this call (0 when unknown). */
export interface AgentCallOpts {
  onUsage?: (totalTokens: number) => void | Promise<void>;
}
```

Then widen each method signature:
- `researcher.port.ts`: `propose(input: ResearcherInput, opts?: AgentCallOpts): Promise<ResearcherOutput>;`
- `builder.port.ts`: `build(input: BuilderInput, opts?: AgentCallOpts): Promise<BuilderOutput>;`
- `critic.port.ts`: `review(input: CriticInput, opts?: AgentCallOpts): Promise<CriticOutput>;`

(Fake adapters implementing these need no change — TypeScript allows implementing an interface method with fewer parameters.)

- [ ] **Step 2: Write the failing adapter usage tests**

Create `src/adapters/builder/mastra-builder.usage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraBuilder } from './mastra-builder.ts';

// A fake Agent whose generate returns a usage block; the object is irrelevant because
// onUsage must fire before (failing) schema parsing.
function fakeAgent(totalTokens: number): Agent {
  return { generate: async () => ({ object: {}, usage: { totalTokens } }) } as unknown as Agent;
}

describe('MastraBuilder onUsage', () => {
  it('reports result.usage.totalTokens before parsing', async () => {
    let recorded = -1;
    const adapter = new MastraBuilder(fakeAgent(123), 'm');
    await adapter.build({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(123);
  });
  it('coerces missing usage to 0', async () => {
    let recorded = -1;
    const agent = { generate: async () => ({ object: {} }) } as unknown as Agent;
    const adapter = new MastraBuilder(agent, 'm');
    await adapter.build({} as never, { onUsage: (t) => { recorded = t; } }).catch(() => {});
    expect(recorded).toBe(0);
  });
});
```

Create the analogous `src/adapters/researcher/mastra-researcher.usage.test.ts` and `src/adapters/critic/mastra-critic.usage.test.ts`, importing `MastraResearcher` / `MastraCritic` and calling `.propose({} as never, { onUsage })` / `.review({} as never, { onUsage })` respectively (same `fakeAgent` helper + `.catch(() => {})`).

- [ ] **Step 3: Run them — verify they fail**

Run: `pnpm test -- src/adapters/builder/mastra-builder.usage.test.ts src/adapters/researcher/mastra-researcher.usage.test.ts src/adapters/critic/mastra-critic.usage.test.ts`
Expected: FAIL — `recorded` stays `-1` (onUsage not invoked yet) / signature has no `opts`.

- [ ] **Step 4: Implement in the Mastra adapters**

In each adapter, import the opts type and call `onUsage` right after `generate`, before parsing. For `src/adapters/builder/mastra-builder.ts`:

```ts
import type { BuilderInput, BuilderOutput, BuilderPort, AgentCallOpts } from '../../ports/builder.port.ts';
```
and rewrite `build`:
```ts
  async build(input: BuilderInput, opts?: AgentCallOpts): Promise<BuilderOutput> {
    const result = await this.agent.generate(buildPromptFor(input), {
      structuredOutput: { schema: LlmBuilderOutputSchema },
    });
    await opts?.onUsage?.(result.usage?.totalTokens ?? 0);
    const raw = LlmBuilderOutputSchema.parse(result.object);
    return llmOutputToDomain(raw);
  }
```

Apply the same shape to `MastraResearcher.propose` and `MastraCritic.review`: add `opts?: AgentCallOpts`, and insert `await opts?.onUsage?.(result.usage?.totalTokens ?? 0);` on the line immediately after their `await this.agent.generate(...)` call and before the `…Schema.parse(result.object)` line. Import `AgentCallOpts` from the matching port.

- [ ] **Step 5: Run the adapter tests — verify they pass**

Run: `pnpm test -- src/adapters/builder/mastra-builder.usage.test.ts src/adapters/researcher/mastra-researcher.usage.test.ts src/adapters/critic/mastra-critic.usage.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 6: Full suite + typecheck + boundary guard**

Run: `pnpm typecheck` → clean.
Run: `pnpm test` → green (existing adapter/eval tests unchanged — the new param is optional).
Run: `pnpm test -- src/mastra/mastra-import-boundary.guard.test.ts` → green.

- [ ] **Step 7: Commit**

```bash
git add src/ports/researcher.port.ts src/ports/builder.port.ts src/ports/critic.port.ts src/adapters/researcher/mastra-researcher.ts src/adapters/builder/mastra-builder.ts src/adapters/critic/mastra-critic.ts src/adapters/builder/mastra-builder.usage.test.ts src/adapters/researcher/mastra-researcher.usage.test.ts src/adapters/critic/mastra-critic.usage.test.ts
git commit -m "feat(token-budget): surface per-call token usage via optional onUsage on cycle ports"
```

---

### Task 4: Wire `tokenUsage` + budget into services; record usage in the cycle handlers

**Files:**
- Modify: `src/orchestrator/app-services.ts` (add two fields)
- Modify: `src/composition.ts` (instantiate repo + budget scalar)
- Modify: `test/support/make-services.ts` (in-memory repo + budget default 0)
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (onUsage on researcher + critic)
- Modify: `src/orchestrator/handlers/hypothesis-build.handler.ts` (onUsage on builder)
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (usage recorded)

**Interfaces:**
- Consumes: `TokenUsageRepository` (Task 2); `AgentCallOpts.onUsage` (Task 3).
- Produces: `AppServices.tokenUsage: TokenUsageRepository` and `AppServices.researchTaskTokenBudget: number`; cycle handlers record `result.usage.totalTokens` into `tokenUsage` keyed by `task.correlationId`.

- [ ] **Step 1: Add the fields to `AppServices`**

In `src/orchestrator/app-services.ts`, add the import:
```ts
import type { TokenUsageRepository } from '../ports/token-usage.repository.ts';
```
and inside `interface AppServices`, after the `maxHypothesesPerCycle: number;` line, add:
```ts
  tokenUsage: TokenUsageRepository;
  /** Cumulative token budget per research chain; 0 = unlimited. */
  researchTaskTokenBudget: number;
```

- [ ] **Step 2: Wire the production composition**

In `src/composition.ts`, add the import near the other repository imports:
```ts
import { DrizzleTokenUsageRepository } from './adapters/repository/drizzle-token-usage.repository.ts';
```
and in the assembled services object (where `researchTasks: new DrizzleResearchTaskRepository(db),` and `maxHypothesesPerCycle: env.MAX_HYPOTHESES_PER_CYCLE,` are set), add:
```ts
    tokenUsage: new DrizzleTokenUsageRepository(db),
    researchTaskTokenBudget: env.RESEARCH_TASK_TOKEN_BUDGET,
```

- [ ] **Step 3: Wire the test services factory**

In `test/support/make-services.ts`, add the import:
```ts
import { InMemoryTokenUsageRepository } from '../../src/adapters/repository/in-memory-token-usage.repository.ts';
```
and in the returned services object (next to `maxHypothesesPerCycle: 5,`), add:
```ts
    tokenUsage: new InMemoryTokenUsageRepository(),
    researchTaskTokenBudget: 0, // unlimited by default in tests; budget-gate tests override
```

- [ ] **Step 4: Typecheck — verify wiring compiles**

Run: `pnpm typecheck`
Expected: clean (every `AppServices` constructor now supplies the two fields).

- [ ] **Step 5: Write the failing usage-recording test**

Add to `src/orchestrator/handlers/research-run-cycle.handler.test.ts` a test using a researcher fake that reports usage through `onUsage`:

```ts
import { InMemoryTokenUsageRepository } from '../../adapters/repository/in-memory-token-usage.repository.ts';
import type { ResearcherPort, AgentCallOpts } from '../../ports/researcher.port.ts';

it('records researcher token usage against the task correlationId', async () => {
  const tokenUsage = new InMemoryTokenUsageRepository();
  const reportingResearcher: ResearcherPort = {
    adapter: 'fake', model: 'test',
    async propose(_input, opts?: AgentCallOpts) {
      await opts?.onUsage?.(777);
      return { researchSummary: 's', hypotheses: [] };
    },
  };
  const services = makeServices({ tokenUsage, researcher: reportingResearcher });
  const task = makeRunCycleTask(); // existing helper in this test file; correlationId is on the task
  await researchRunCycleHandler(task, services);
  expect(await tokenUsage.get(task.correlationId)).toBe(777);
});
```

(Use the test file's existing `makeServices` override helper and its run-cycle task builder; the researcher returning `{ researchSummary, hypotheses: [] }` short-circuits the cycle with zero hypotheses, which is sufficient to exercise the recording call.)

- [ ] **Step 6: Run it — verify it fails**

Run: `pnpm test -- src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: FAIL — `tokenUsage.get` returns 0 (handler does not yet pass `onUsage`).

- [ ] **Step 7: Record usage in `research-run-cycle.handler.ts`**

Add the `onUsage` option to the researcher call (around line 120):

```ts
    output = await services.researcher.propose({
      // …existing input fields unchanged…
    }, { onUsage: (t) => services.tokenUsage.add(task.correlationId, t) });
```

And to the guarded critic call (around line 197):

```ts
        const review = await services.critic.review(
          { proposal: draft, profile },
          { onUsage: (t) => services.tokenUsage.add(task.correlationId, t) },
        );
```

(The arrow `(t) => services.tokenUsage.add(...)` returns the `add` Promise; the adapter `await`s it, so usage is persisted before the call returns.)

- [ ] **Step 8: Record usage in `hypothesis-build.handler.ts`**

Add the `onUsage` option to the builder call (around line 70):

```ts
    out = await services.builder.build(
      { hypothesis, profile, sdkDoc: BUILDER_SDK_DOC },
      { onUsage: (t) => services.tokenUsage.add(task.correlationId, t) },
    );
```

- [ ] **Step 9: Run the test + full suite + typecheck**

Run: `pnpm test -- src/orchestrator/handlers/research-run-cycle.handler.test.ts` → PASS.
Run: `pnpm typecheck && pnpm test` → green.

- [ ] **Step 10: Commit**

```bash
git add src/orchestrator/app-services.ts src/composition.ts test/support/make-services.ts src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/hypothesis-build.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(token-budget): record cycle-agent token usage per correlationId via services.tokenUsage"
```

---

### Task 5: Enforce the budget gate in `backtestCompletedHandler`

**Files:**
- Modify: `src/orchestrator/handlers/backtest-completed.handler.ts`
- Test: `src/orchestrator/handlers/backtest-completed.handler.test.ts`

**Interfaces:**
- Consumes: `withinTokenBudget` (Task 1); `services.tokenUsage.get` + `services.researchTaskTokenBudget` (Tasks 2/4).
- Produces: a new event type `research.token_budget_exhausted` with payload `{ strategyProfileId, cumulativeTokens, budgetTokens }`; `willRetry` now also requires being within budget.

- [ ] **Step 1: Write the failing gate tests**

Add to `src/orchestrator/handlers/backtest-completed.handler.test.ts`:

```ts
import { InMemoryTokenUsageRepository } from '../../adapters/repository/in-memory-token-usage.repository.ts';

it('FAIL over the token budget does NOT retry and emits research.token_budget_exhausted', async () => {
  const tokenUsage = new InMemoryTokenUsageRepository();
  const task = makeBacktestCompletedTask({ decision: 'FAIL', cycleDepth: 0 }); // correlationId on task
  await tokenUsage.add(task.correlationId, 5000);
  const services = makeServices({ tokenUsage, researchTaskTokenBudget: 1000 });
  await backtestCompletedHandler(task, services);
  const types = (await services.events.list({ taskId: task.id, limit: 50 })).map((e) => e.type);
  expect(types).toContain('research.token_budget_exhausted');
  expect(types).not.toContain('research.retry_enqueued');
});

it('FAIL under the token budget retries as before', async () => {
  const tokenUsage = new InMemoryTokenUsageRepository();
  const task = makeBacktestCompletedTask({ decision: 'FAIL', cycleDepth: 0 });
  await tokenUsage.add(task.correlationId, 100);
  const services = makeServices({ tokenUsage, researchTaskTokenBudget: 1000 });
  await backtestCompletedHandler(task, services);
  const types = (await services.events.list({ taskId: task.id, limit: 50 })).map((e) => e.type);
  expect(types).toContain('research.retry_enqueued');
  expect(types).not.toContain('research.token_budget_exhausted');
});

it('budget 0 (unlimited) never token-gates', async () => {
  const tokenUsage = new InMemoryTokenUsageRepository();
  const task = makeBacktestCompletedTask({ decision: 'MODIFY', cycleDepth: 0 });
  await tokenUsage.add(task.correlationId, 9_999_999);
  const services = makeServices({ tokenUsage, researchTaskTokenBudget: 0 });
  await backtestCompletedHandler(task, services);
  const types = (await services.events.list({ taskId: task.id, limit: 50 })).map((e) => e.type);
  expect(types).toContain('research.retry_enqueued');
  expect(types).not.toContain('research.token_budget_exhausted');
});
```

(Use the test file's existing backtest-completed task builder + `makeServices` override helper. If a helper named differently exists, reuse it; the key inputs are `decision`, `cycleDepth`, and the task's `correlationId`.)

- [ ] **Step 2: Run them — verify they fail**

Run: `pnpm test -- src/orchestrator/handlers/backtest-completed.handler.test.ts`
Expected: FAIL — no `research.token_budget_exhausted` event; over-budget FAIL still retries.

- [ ] **Step 3: Add the gate to the handler**

In `src/orchestrator/handlers/backtest-completed.handler.ts`:

(a) Add the import:
```ts
import { withinTokenBudget } from '../token-budget.ts';
```

(b) Inside `backtestCompletedHandler`, after destructuring `parsed.data`, compute the budget verdict once:
```ts
  const cumulativeTokens = await services.tokenUsage.get(task.correlationId);
  const withinBudget = withinTokenBudget(cumulativeTokens, services.researchTaskTokenBudget);
```

(c) In BOTH the `FAIL` and `MODIFY` branches, change the retry decision. Replace the existing
`willRetry: cycleDepth < MAX_CYCLE_DEPTH,` in the `hypothesis.failed` / `hypothesis.modify_required` event with:
```ts
        willRetry: cycleDepth < MAX_CYCLE_DEPTH && withinBudget,
```
and replace the `if (cycleDepth < MAX_CYCLE_DEPTH) { …enqueue… } else { …retry_budget_exhausted… }` block with:
```ts
      if (cycleDepth < MAX_CYCLE_DEPTH && withinBudget) {
        await enqueueResearchRetry(task, services, strategyProfileId,
          { hypothesisId, decision, reasons }, cycleDepth + 1);
        await services.events.append(event(task.id, 'research.retry_enqueued', {
          strategyProfileId, cycleDepth: cycleDepth + 1, trigger: decision,
        }));
      } else if (!withinBudget) {
        await services.events.append(event(task.id, 'research.token_budget_exhausted', {
          strategyProfileId, cumulativeTokens, budgetTokens: services.researchTaskTokenBudget,
        }));
      } else {
        await services.events.append(event(task.id, 'research.retry_budget_exhausted', {
          strategyProfileId, cycleDepth, maxCycleDepth: MAX_CYCLE_DEPTH,
        }));
      }
```

Apply this identical block in both the `FAIL` and `MODIFY` cases (each already has its own copy; the only prior difference was the hard-coded `trigger: 'FAIL'` / `'MODIFY'` — using `trigger: decision` preserves that since `decision` is `'FAIL'`/`'MODIFY'` in these branches).

- [ ] **Step 4: Run the gate tests — verify they pass**

Run: `pnpm test -- src/orchestrator/handlers/backtest-completed.handler.test.ts`
Expected: PASS (new cases + existing cases still green — existing tests use `researchTaskTokenBudget: 0` from make-services default, so `withinBudget` is always true and behavior is unchanged).

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm typecheck && pnpm test` → green.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/backtest-completed.handler.ts src/orchestrator/handlers/backtest-completed.handler.test.ts
git commit -m "feat(token-budget): gate research retries on the cumulative token budget"
```

---

### Task 6: Reflect the token-budget stop in the completion summary

**Files:**
- Modify: `src/read-api/completion-summary.ts`
- Test: `src/read-api/completion-summary.test.ts`

**Interfaces:**
- Consumes: the `research.token_budget_exhausted` event (Task 5).
- Produces: `buildBacktestCompleted` sets `willRetry: false` and appends `'token_budget_exhausted'` to `reasons` when that event exists for the task.

- [ ] **Step 1: Write the failing test**

Add to `src/read-api/completion-summary.test.ts` (reuse the file's existing deps/builder helpers; the key is an `agentEvents.list` stub that returns a `research.token_budget_exhausted` event for the task):

```ts
it('marks willRetry false and surfaces the reason when the token budget was exhausted', async () => {
  const task = { id: 't1', taskType: 'backtest.completed', status: 'completed', correlationId: 'c1',
    payload: { decision: 'FAIL', cycleDepth: 0, strategyProfileId: 'p1', reasons: ['profit factor low'] } };
  const deps = makeCompletionDeps({
    task,
    agentEvents: { list: async ({ type }: { type?: string }) =>
      type === 'research.token_budget_exhausted'
        ? [{ payload: { cumulativeTokens: 5000, budgetTokens: 1000 } }]
        : [] },
  });
  const summary = await buildCompletionSummary(deps, 't1');
  expect(summary?.kind).toBe('backtest.completed');
  expect((summary as { willRetry: boolean }).willRetry).toBe(false);
  expect((summary as { reasons: string[] }).reasons).toContain('token_budget_exhausted');
});
```

(Adapt to the test file's actual deps factory; the essential stub is `agentEvents.list` returning one event for `type: 'research.token_budget_exhausted'`. Without that helper, build the `deps` object inline mirroring `CompletionSummaryDeps`.)

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm test -- src/read-api/completion-summary.test.ts`
Expected: FAIL — `willRetry` is `true` (only depth-gated) and `reasons` lacks `token_budget_exhausted`.

- [ ] **Step 3: Implement the reflection**

In `src/read-api/completion-summary.ts`, in `buildBacktestCompleted`, before the `return {`, query for the stop event and adjust:

```ts
  const tokenStop = (await safe('events_read_failed', () =>
    deps.agentEvents.list({ taskId: task.id, type: 'research.token_budget_exhausted', limit: 1 }))) ?? [];
  const tokenBudgetExhausted = tokenStop.length > 0;
  const finalReasons = tokenBudgetExhausted ? [...reasons, 'token_budget_exhausted'] : reasons;
```

Then in the returned object change the `reasons` and `willRetry` fields to:
```ts
    decision, metrics: toKeyMetrics(run?.metrics ?? null), reasons: finalReasons,
    willRetry: (decision === 'FAIL' || decision === 'MODIFY') && cycleDepth < MAX_CYCLE_DEPTH && !tokenBudgetExhausted,
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm test -- src/read-api/completion-summary.test.ts`
Expected: PASS (new case + existing cases green — when no stop event exists, `tokenBudgetExhausted` is false and behavior is unchanged).

- [ ] **Step 5: Full suite + typecheck**

Run: `pnpm typecheck && pnpm test` → green.

- [ ] **Step 6: Commit**

```bash
git add src/read-api/completion-summary.ts src/read-api/completion-summary.test.ts
git commit -m "feat(token-budget): surface the token-budget stop in the completion summary"
```

---

## Self-Review

**1. Spec coverage:**
- §Gate point (backtestCompletedHandler, `willRetry = depth && withinBudget`, `research.token_budget_exhausted`) → Task 5.
- §Usage capture (onUsage on researcher/builder/critic; mastra reports `result.usage?.totalTokens ?? 0`; fakes unchanged) → Task 3 + recording wired in Task 4.
- §Persistence (`TokenUsageRepository` keyed by correlationId, drizzle upsert, additive migration) → Task 2.
- §Budget primitive (`withinTokenBudget`, 0 = unlimited) → Task 1.
- §Configuration (`RESEARCH_TASK_TOKEN_BUDGET` default 200000, 0 = unlimited, permissive parse) → Task 1.
- §Observability / completion summary (`research.token_budget_exhausted` reflected) → Task 6.
- §Testing matrix (primitive, repo, handler gate FAIL/MODIFY/over/under/0, adapter onUsage, summary) → Tasks 1–6.
- §Out of scope (cost/$, in-process primitive, per-step gate, first-cycle gate, interpreter budget) → none implemented.
- §Done criteria 1–4 → Tasks 5 (gate independent of depth), 1+4 (budget 0 = today), 3+4 (onUsage + fakes 0 + eval unchanged), 6 (summary) + migration additive (Task 2).

**2. Placeholder scan:** No TBD/“handle errors”/“similar to”. Each code step shows the literal code. The few “use the test file’s existing helper” notes name the exact helper role and give a concrete inline fallback — not a placeholder.

**3. Type consistency:** `withinTokenBudget(cumulativeTokens, budgetTokens)` identical in Task 1 def, Task 5 use. `TokenUsageRepository.add/get` identical across Tasks 2, 4, 5. `AgentCallOpts.onUsage: (totalTokens: number) => void | Promise<void>` identical across Tasks 3, 4. `AppServices.tokenUsage` / `researchTaskTokenBudget` identical across Tasks 4, 5. Event name `research.token_budget_exhausted` identical across Tasks 5, 6. Env `RESEARCH_TASK_TOKEN_BUDGET` identical across Tasks 1, 4.
