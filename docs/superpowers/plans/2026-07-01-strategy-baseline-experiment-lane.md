# Strategy Baseline ExperimentService Lane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `ExperimentService` to validate a standalone strategy bundle (`engine:'strategy'`) as the first experiment branch — real submit → real trades → absolute-metrics verdict — persisted in a new `strategy_backtest_run` table, with the strategy `bundle_hash` fixed as the anchor for future overlays/sweeps.

**Architecture:** A parallel "strategy lane" beside PR #119's overlay lane. Same holdout/train/holdout orchestration (reused verbatim), but a **strategy-specific** executor (`engine:'strategy'`, no `baselineRef`), **typed** request/result (no overlay-invariant relaxation), an **absolute-metrics** evaluator (strategy runs have no `comparison`), a **separate** persistence table (Approach 2 — the shipped `backtest_run_idem_uq` stays intact), and an engine-agnostic `pollResearchRun` so a comparison-less strategy run is not misclassified `rejected`. The overlay path is behaviourally zero-diff.

**Tech Stack:** TypeScript (node `--experimental-strip-types`), Vitest, Drizzle ORM (Postgres), Hono (read-API), `@trading-backtester/sdk`, Mastra (LLM agents).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-01-strategy-baseline-experimentservice-lane-design.md` — this plan implements it in build-order §13.
- **No TS parameter-properties.** Constructors are `constructor(deps){ this.d = deps }`. Enforced by `src/strip-types-no-param-properties.test.ts`.
- **Import specifiers keep the `.ts`/`.mts` extension** (strip-types runtime), e.g. `from '../domain/foo.ts'`.
- **Domain types use ISO-string timestamps + string-literal unions;** `null → undefined` at the repo boundary; jsonb via `.notNull().$type<T>()`; app-generated **text** ids (no serial/uuid columns), **no** FKs, **no** PG enums.
- **Overlay path behavioural zero-diff:** do not change the behaviour of `runNewStrategyValidation`, `BacktesterExperimentRunExecutor`, `backtest_run`, or `mapPlatformComparison`. The only overlay-touching change is refactoring `pollOverlayRun` to delegate to `pollResearchRun` (Task 8) — existing overlay tests must stay green.
- **Gates before any task is "done":** `pnpm typecheck` (explicitly — Vitest passes while `noUncheckedIndexedAccess` fails; `tsc` covers `src/` only), then `pnpm test` green. `.mts` scripts are outside tsconfig — typecheck them the way the existing scripts document (manual `tsc` invocation).
- **Do NOT run `pnpm db:migrate`** without a live Postgres; generate the migration with `pnpm db:generate` (drizzle-kit) and do not hand-edit `meta/_journal.json`.
- **Member XOR invariant:** an `experiment_run_member` references exactly one run — `backtestRunId` xor `strategyBacktestRunId`.

---

## File Structure

**New files:**
- `src/domain/strategy-backtest-run.ts` — `StrategyBacktestRun`, `StrategyBacktestCompletion`, `RUN_KIND` types.
- `src/ports/strategy-backtest-run.repository.ts` — `StrategyBacktestRunRepository` port.
- `src/adapters/repository/in-memory-strategy-backtest-run.repository.ts` — in-memory adapter.
- `src/adapters/repository/drizzle-strategy-backtest-run.repository.ts` — drizzle adapter.
- `src/research/strategy-run-identity.ts` — `computeStrategyParamsHash`, `computeStrategyExperimentKey`.
- `src/domain/strategy-metrics.ts` — `mapStrategyMetrics`.
- `src/validation/strategy-baseline-evaluator.ts` — `evaluateStrategyBaseline`, `STRATEGY_BASELINE_EVALUATOR_VERSION`, `STRATEGY_BASELINE_THRESHOLDS`.
- `src/research/strategy-experiment-run-executor.ts` — `StrategyExperimentRunExecutor` port + `StrategyExperimentRunRequest`/`Result` types.
- `src/research/backtester-strategy-experiment-run-executor.ts` — `BacktesterStrategyExperimentRunExecutor` impl.
- `scripts/seed-long-oi-profile.mts` — real onboard seed.
- `scripts/run-strategy-baseline.mts` — one-shot trigger.
- `docs/superpowers/notes/2026-07-01-strategy-baseline-runbook.md` — real-engine runbook + captured run.

**Modified files:**
- `src/research/run-backtest.ts` — extract `pollResearchRun`; `pollOverlayRun` delegates.
- `src/db/schema.ts` — `strategyBacktestRun` table + `experimentRunMember.strategyBacktestRunId` column.
- `migrations/0014_*.sql` (+ `meta/`) — generated.
- `src/domain/research-experiment.ts` — `experimentType` union += `'strategy_baseline_validation'`; `ExperimentRunMember.strategyBacktestRunId?`.
- `src/ports/research-platform.port.ts` — `submitStrategyResearchRun` on `ResearchPlatformPort`.
- `src/adapters/platform/http-backtester.adapter.ts` — `submitStrategyResearchRun` impl.
- `src/adapters/platform/mock-research-platform.adapter.ts` — `submitStrategyResearchRun` impl.
- `src/research/experiment-service.ts` — add `runStrategyBaselineValidation` + `runStrategyMember`; extend `ExperimentServiceDeps` with `strategyRunExecutor`.
- `src/read-api/dto.ts` + `mappers.ts` — `ExperimentRunMemberDto.strategyBacktestRunId`.
- `src/orchestrator/app-services.ts` + `src/composition.ts` — wire `strategyBuilder`, `strategyBacktests`, `strategyRunExecutor`.
- `src/adapters/platform/http-backtester.adapter.ts` (verify only) — `getRunTrades` `contentHash`/`page`.

---

## Phase 1 — Persistence

### Task 1: `StrategyBacktestRun` domain type

**Files:**
- Create: `src/domain/strategy-backtest-run.ts`
- Test: `src/domain/strategy-backtest-run.test.ts`

**Interfaces:**
- Consumes: `BacktestRunStatus`, `BacktestMetricBlock` from `./backtest-run.ts` / `../ports/platform-gateway.port.ts` (reuse — do not redefine).
- Produces: `StrategyBacktestRun`, `StrategyBacktestCompletion`, `STRATEGY_RUN_KIND`.

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/strategy-backtest-run.test.ts
import { describe, it, expect } from 'vitest';
import { STRATEGY_RUN_KIND, type StrategyBacktestRun } from './strategy-backtest-run.ts';

describe('StrategyBacktestRun', () => {
  it('STRATEGY_RUN_KIND is the baseline literal', () => {
    expect(STRATEGY_RUN_KIND).toBe('strategy_baseline');
  });
  it('a run row omits every hypothesis/overlay field', () => {
    const run: StrategyBacktestRun = {
      id: 'sbr_1', strategyProfileId: 'p1', strategyBundleId: 'mod_long_oi', bundleHash: 'sha256:abc',
      paramsHash: 'ph1', runKind: STRATEGY_RUN_KIND, platformRunId: 'run_1', correlationId: 'sanity',
      params: {}, status: 'submitted', metrics: null, platformRun: null, artifactRefs: [],
      platformContractVersion: 'pending', sdkContractVersion: 'builder-sdk-v0', backend: 'research_platform',
      submittedAt: 't', finishedAt: null, createdAt: 't', updatedAt: 't',
    };
    // @ts-expect-error hypothesisId does not exist on a strategy baseline run
    run.hypothesisId;
    expect(run.strategyBundleId).toBe('mod_long_oi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test src/domain/strategy-backtest-run.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the type**

```ts
// src/domain/strategy-backtest-run.ts
import type { BacktestRunStatus } from './backtest-run.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';

export const STRATEGY_RUN_KIND = 'strategy_baseline' as const;
export type StrategyRunKind = typeof STRATEGY_RUN_KIND;

export interface StrategyBacktestRun {
  id: string;
  strategyProfileId: string;
  strategyBundleId: string;          // the strategy bundle's own manifest module id (identity anchor)
  bundleHash: string;
  paramsHash: string;
  runKind: StrategyRunKind;
  platformRunId: string;
  correlationId: string;
  taskId?: string;
  resumeToken?: string;
  params: Record<string, unknown>;
  status: BacktestRunStatus;
  metrics: BacktestMetricBlock | null;   // absolute strategy metrics; null until completed
  platformRun: PlatformRunConfig | null;
  artifactRefs: string[];
  platformContractVersion: string;
  sdkContractVersion: string;
  backend: 'research_platform';
  submittedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyBacktestCompletion {
  metrics: BacktestMetricBlock;
  artifactRefs: string[];
  platformContractVersion: string;
  finishedAt: string;
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm test src/domain/strategy-backtest-run.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/strategy-backtest-run.ts src/domain/strategy-backtest-run.test.ts
git commit -m "feat(research): StrategyBacktestRun domain type (strategy baseline lane)"
```

### Task 2: `strategy_backtest_run` table + member column + migration

**Files:**
- Modify: `src/db/schema.ts` (add `strategyBacktestRun` table; add `strategyBacktestRunId` to `experimentRunMember`)
- Create: `migrations/0014_*.sql` (+ `migrations/meta/*`) via drizzle-kit

**Interfaces:**
- Produces: drizzle table `strategyBacktestRun` with `uniqueIndex('strategy_backtest_run_idem_uq').on(strategyBundleId, paramsHash, bundleHash)`; `experimentRunMember.strategyBacktestRunId` (nullable text).

- [ ] **Step 1: Add the table to `src/db/schema.ts`** — mirror the existing `backtestRun` block's conventions (`text(...).$type<...>()`, `jsonb(...).$type<...>()`, `timestamp(..., { withTimezone: true }).defaultNow().notNull()`), dropping all hypothesis/overlay columns. Reuse the file's existing `pgTable, text, jsonb, timestamp, uniqueIndex, index` imports.

```ts
export const strategyBacktestRun = pgTable('strategy_backtest_run', {
  id: text('id').primaryKey(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  strategyBundleId: text('strategy_bundle_id').notNull(),
  bundleHash: text('bundle_hash').notNull(),
  paramsHash: text('params_hash').notNull(),
  runKind: text('run_kind').$type<'strategy_baseline'>().notNull(),
  platformRunId: text('platform_run_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  taskId: text('task_id'),
  resumeToken: text('resume_token'),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  status: text('status').$type<BacktestRunStatus>().notNull(),
  metrics: jsonb('metrics').$type<BacktestMetricBlock>(),
  platformRun: jsonb('platform_run').$type<PlatformRunConfig>(),
  artifactRefs: jsonb('artifact_refs').$type<string[]>().notNull(),
  platformContractVersion: text('platform_contract_version').notNull(),
  sdkContractVersion: text('sdk_contract_version').notNull(),
  backend: text('backend').$type<'research_platform'>().notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  idemUq: uniqueIndex('strategy_backtest_run_idem_uq').on(t.strategyBundleId, t.paramsHash, t.bundleHash),
  profileIdx: index('strategy_backtest_run_profile_idx').on(t.strategyProfileId),
}));
```

Import the `BacktestRunStatus` / `BacktestMetricBlock` / `PlatformRunConfig` types at the top of `schema.ts` if not already imported (match how `backtestRun` imports its `$type` unions).

- [ ] **Step 2: Add the member column** — in the existing `experimentRunMember` table add:

```ts
  strategyBacktestRunId: text('strategy_backtest_run_id'),
```

(nullable; sits beside the existing nullable `backtestRunId`).

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `migrations/0014_*.sql` creating `strategy_backtest_run` (+ its indexes) and `ALTER TABLE experiment_run_member ADD COLUMN strategy_backtest_run_id text;`, plus updated `migrations/meta/`. Do **not** hand-edit `_journal.json`.

- [ ] **Step 4: Verify the generated SQL** — open `0014_*.sql`; confirm the unique index is `(strategy_bundle_id, params_hash, bundle_hash)` and the member column is additive/nullable. Run `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts migrations/
git commit -m "feat(research): strategy_backtest_run table + experiment_run_member.strategy_backtest_run_id (migration 0014)"
```

### Task 3: `StrategyBacktestRunRepository` port + adapters

**Files:**
- Create: `src/ports/strategy-backtest-run.repository.ts`
- Create: `src/adapters/repository/in-memory-strategy-backtest-run.repository.ts`
- Create: `src/adapters/repository/drizzle-strategy-backtest-run.repository.ts`
- Test: `src/adapters/repository/in-memory-strategy-backtest-run.repository.test.ts`

**Interfaces:**
- Consumes: `StrategyBacktestRun`, `StrategyBacktestCompletion` (Task 1).
- Produces: `StrategyBacktestRunRepository` with `createSubmitted`, `markCompleted`, `markRejected`, `markFailed`, `findById`, `findByPlatformRunId`, `findByIdentity(strategyBundleId, paramsHash, bundleHash)`.

- [ ] **Step 1: Write the port**

```ts
// src/ports/strategy-backtest-run.repository.ts
import type { StrategyBacktestRun, StrategyBacktestCompletion } from '../domain/strategy-backtest-run.ts';

export interface StrategyBacktestRunRepository {
  createSubmitted(run: StrategyBacktestRun): Promise<void>;
  markCompleted(id: string, completion: StrategyBacktestCompletion): Promise<void>;
  markRejected(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  findById(id: string): Promise<StrategyBacktestRun | null>;
  findByPlatformRunId(platformRunId: string): Promise<StrategyBacktestRun | null>;
  findByIdentity(strategyBundleId: string, paramsHash: string, bundleHash: string): Promise<StrategyBacktestRun | null>;
}
```

- [ ] **Step 2: Write the failing in-memory test**

```ts
// src/adapters/repository/in-memory-strategy-backtest-run.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryStrategyBacktestRunRepository } from './in-memory-strategy-backtest-run.repository.ts';
import { STRATEGY_RUN_KIND, type StrategyBacktestRun } from '../../domain/strategy-backtest-run.ts';

const base = (over: Partial<StrategyBacktestRun> = {}): StrategyBacktestRun => ({
  id: 'sbr_1', strategyProfileId: 'p1', strategyBundleId: 'mod_x', bundleHash: 'sha256:h', paramsHash: 'ph',
  runKind: STRATEGY_RUN_KIND, platformRunId: 'run_1', correlationId: 'sanity', params: {}, status: 'submitted',
  metrics: null, platformRun: null, artifactRefs: [], platformContractVersion: 'pending',
  sdkContractVersion: 'builder-sdk-v0', backend: 'research_platform', submittedAt: 't', finishedAt: null,
  createdAt: 't', updatedAt: 't', ...over,
});

describe('InMemoryStrategyBacktestRunRepository', () => {
  it('round-trips + resolves by identity + platformRunId', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    await repo.createSubmitted(base());
    expect((await repo.findById('sbr_1'))?.bundleHash).toBe('sha256:h');
    expect((await repo.findByPlatformRunId('run_1'))?.id).toBe('sbr_1');
    expect((await repo.findByIdentity('mod_x', 'ph', 'sha256:h'))?.id).toBe('sbr_1');
  });
  it('markCompleted writes metrics + completed status', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    await repo.createSubmitted(base());
    await repo.markCompleted('sbr_1', {
      metrics: { netPnlUsd: 10, netPnlPct: 1, totalTrades: 3, winRate: 0.66, profitFactor: 1.5,
        maxDrawdownPct: 5, expectancyUsd: 3, sharpe: 0.9, topTradeContributionPct: 40 },
      artifactRefs: ['a1'], platformContractVersion: 'v1', finishedAt: 't2',
    });
    const r = await repo.findById('sbr_1');
    expect(r?.status).toBe('completed');
    expect(r?.metrics?.totalTrades).toBe(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `pnpm test src/adapters/repository/in-memory-strategy-backtest-run.repository.test.ts` → FAIL.

- [ ] **Step 4: Write the in-memory adapter**

```ts
// src/adapters/repository/in-memory-strategy-backtest-run.repository.ts
import type { StrategyBacktestRunRepository } from '../../ports/strategy-backtest-run.repository.ts';
import type { StrategyBacktestRun, StrategyBacktestCompletion } from '../../domain/strategy-backtest-run.ts';

export class InMemoryStrategyBacktestRunRepository implements StrategyBacktestRunRepository {
  private readonly rows = new Map<string, StrategyBacktestRun>();
  async createSubmitted(run: StrategyBacktestRun): Promise<void> { this.rows.set(run.id, { ...run }); }
  async markCompleted(id: string, c: StrategyBacktestCompletion): Promise<void> {
    const r = this.rows.get(id); if (!r) return;
    this.rows.set(id, { ...r, status: 'completed', metrics: c.metrics, artifactRefs: [...c.artifactRefs],
      platformContractVersion: c.platformContractVersion, finishedAt: c.finishedAt, updatedAt: c.finishedAt });
  }
  async markRejected(id: string): Promise<void> { const r = this.rows.get(id); if (r) this.rows.set(id, { ...r, status: 'rejected' }); }
  async markFailed(id: string): Promise<void> { const r = this.rows.get(id); if (r) this.rows.set(id, { ...r, status: 'failed' }); }
  async findById(id: string): Promise<StrategyBacktestRun | null> { return this.rows.get(id) ?? null; }
  async findByPlatformRunId(pid: string): Promise<StrategyBacktestRun | null> {
    for (const r of this.rows.values()) if (r.platformRunId === pid) return r; return null;
  }
  async findByIdentity(bundleId: string, ph: string, bh: string): Promise<StrategyBacktestRun | null> {
    for (const r of this.rows.values()) if (r.strategyBundleId === bundleId && r.paramsHash === ph && r.bundleHash === bh) return r;
    return null;
  }
}
```

(Confirm `'failed'`/`'rejected'`/`'completed'` are members of `BacktestRunStatus` in `src/domain/backtest-run.ts`; reuse those exact literals.)

- [ ] **Step 5: Run test to verify it passes** — `pnpm test src/adapters/repository/in-memory-strategy-backtest-run.repository.test.ts` → PASS.

- [ ] **Step 6: Write the drizzle adapter** — mirror `src/adapters/repository/drizzle-backtest-run.repository.ts` method-for-method against the `strategyBacktestRun` table: `createSubmitted` inserts (Date-wrap `submittedAt`/`createdAt`/`updatedAt`); `markCompleted` sets `status:'completed'`, `metrics`, `artifactRefs`, `platformContractVersion`, `finishedAt`, `updatedAt`; `markRejected`/`markFailed` set status; `findById`/`findByPlatformRunId`/`findByIdentity` select + a `toDomain` that maps null→undefined for optionals and Date→ISO string. No DB test here (DB-gated); parity is covered by the in-memory test + typecheck.

- [ ] **Step 7: Run gates** — `pnpm typecheck` → PASS; `pnpm test` → green.

- [ ] **Step 8: Commit**

```bash
git add src/ports/strategy-backtest-run.repository.ts src/adapters/repository/*strategy-backtest-run*
git commit -m "feat(research): StrategyBacktestRunRepository port + in-memory + drizzle adapters"
```

### Task 4: experiment-type union + member domain field + read DTO + XOR

**Files:**
- Modify: `src/domain/research-experiment.ts` (union value + `ExperimentRunMember.strategyBacktestRunId?`)
- Modify: `src/read-api/dto.ts` (`ExperimentRunMemberDto.strategyBacktestRunId`)
- Modify: `src/read-api/mappers.ts` (`toExperimentRunMemberDto` copies the field, null-preserving)
- Test: `src/read-api/mappers.test.ts` (extend), `src/domain/research-experiment.test.ts` (or a new xor test)

**Interfaces:**
- Produces: `ExperimentType` includes `'strategy_baseline_validation'`; `ExperimentRunMember.strategyBacktestRunId?: string`; DTO surfaces it.

- [ ] **Step 1: Extend the union + member type** — in `src/domain/research-experiment.ts` add `'strategy_baseline_validation'` to the `ExperimentType` union, and add `strategyBacktestRunId?: string;` to `ExperimentRunMember` (beside `backtestRunId?`).

- [ ] **Step 2: Write the failing XOR + DTO test**

```ts
// add to src/read-api/mappers.test.ts
import { toExperimentRunMemberDto } from './mappers.ts';
it('maps strategyBacktestRunId null-preserving', () => {
  const dto = toExperimentRunMemberDto({
    id: 'm1', experimentId: 'e1', role: 'sanity', periodFrom: 'a', periodTo: 'b',
    symbols: ['S'], paramsHash: '', bundleHash: 'h', createdAt: 't',
    strategyBacktestRunId: 'sbr_1',
  } as any);
  expect(dto.strategyBacktestRunId).toBe('sbr_1');
  expect(dto.backtestRunId ?? null).toBeNull();
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm test src/read-api/mappers.test.ts` → FAIL (property missing).

- [ ] **Step 4: Add the DTO field + mapper line** — `ExperimentRunMemberDto` gains `strategyBacktestRunId: string | null`; `toExperimentRunMemberDto` maps `m.strategyBacktestRunId ?? null` (mirror how `backtestRunId` is mapped).

- [ ] **Step 5: Run to verify it passes** — `pnpm test src/read-api/mappers.test.ts` → PASS. `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/research-experiment.ts src/read-api/dto.ts src/read-api/mappers.ts src/read-api/mappers.test.ts
git commit -m "feat(research): experiment strategy_baseline_validation type + member strategyBacktestRunId DTO"
```

---

## Phase 2 — Submit + map

### Task 5: `computeStrategyParamsHash` + `computeStrategyExperimentKey`

**Files:**
- Create: `src/research/strategy-run-identity.ts`
- Test: `src/research/strategy-run-identity.test.ts`

**Interfaces:**
- Consumes: `PlatformRunConfig` from `../ports/research-platform.port.ts`; the existing `stableStringify` from `../orchestrator/handlers/backtest-support.ts` (reuse — do not reimplement).
- Produces: `computeStrategyParamsHash({ bundleHash, platformRun, params })`, `computeStrategyExperimentKey({ strategyProfileId, strategyBundleId, bundleHash, datasetScope, holdoutPolicy })`.

- [ ] **Step 1: Write the failing test**

```ts
// src/research/strategy-run-identity.test.ts
import { describe, it, expect } from 'vitest';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';

const run = { datasetId: 'd', symbols: ['B', 'A'], timeframe: '1h', period: { from: 'x', to: 'y' }, seed: 42 };

describe('computeStrategyParamsHash', () => {
  it('is deterministic and symbol-order-independent', () => {
    const h1 = computeStrategyParamsHash({ bundleHash: 'sha256:h', platformRun: run, params: {} });
    const h2 = computeStrategyParamsHash({ bundleHash: 'sha256:h', platformRun: { ...run, symbols: ['A', 'B'] }, params: {} });
    expect(h1).toBe(h2);
  });
  it('differs on bundleHash / params / period', () => {
    const base = { bundleHash: 'sha256:h', platformRun: run, params: {} };
    expect(computeStrategyParamsHash(base)).not.toBe(computeStrategyParamsHash({ ...base, bundleHash: 'sha256:g' }));
    expect(computeStrategyParamsHash(base)).not.toBe(computeStrategyParamsHash({ ...base, params: { k: 1 } }));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/research/strategy-run-identity.ts
import { createHash } from 'node:crypto';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { DatasetScope, HoldoutPolicy } from '../domain/research-experiment.ts';
import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function computeStrategyParamsHash(input: {
  bundleHash: string; platformRun: PlatformRunConfig; params: Record<string, unknown>;
}): string {
  const pr = input.platformRun;
  const canonical = {
    v: 1, bundleHash: input.bundleHash,
    platformRun: { datasetId: pr.datasetId, symbols: [...pr.symbols].sort(), timeframe: pr.timeframe, period: pr.period, seed: pr.seed },
    params: input.params,
  };
  return sha(stableStringify(canonical));
}

export function computeStrategyExperimentKey(input: {
  strategyProfileId: string; strategyBundleId: string; bundleHash: string; datasetScope: DatasetScope; holdoutPolicy: HoldoutPolicy;
}): string {
  return sha(stableStringify({
    v: 1, kind: 'strategy_baseline', strategyProfileId: input.strategyProfileId,
    strategyBundleId: input.strategyBundleId, bundleHash: input.bundleHash,
    datasetScope: input.datasetScope, holdoutPolicy: input.holdoutPolicy,
  }));
}
```

(Confirm `stableStringify` is exported from `backtest-support.ts`; the holdout-investigation note shows it is imported there. If it is not exported, export it — that is behaviour-neutral.)

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/strategy-run-identity.ts src/research/strategy-run-identity.test.ts
git commit -m "feat(research): computeStrategyParamsHash + computeStrategyExperimentKey (no baselineRef)"
```

### Task 6: `submitStrategyResearchRun` port + adapters

**Files:**
- Modify: `src/ports/research-platform.port.ts`
- Modify: `src/adapters/platform/mock-research-platform.adapter.ts`
- Modify: `src/adapters/platform/http-backtester.adapter.ts`
- Test: `src/adapters/platform/mock-research-platform.adapter.test.ts` (extend or create)

**Interfaces:**
- Consumes: `StrategyBundle` (from `../../domain/strategy-bundle.ts` — the `assembleStrategyBundle` output type), `PlatformRunConfig`, `RunJobHandle` (existing on the port).
- Produces: `ResearchPlatformPort.submitStrategyResearchRun(bundle, opts): Promise<RunJobHandle>` where `opts = { run: PlatformRunConfig; correlationId: string; resumeToken?: string; workflowId?: string; callbackUrl?: string; metrics: string[] }`.

- [ ] **Step 1: Add the port method** — in `src/ports/research-platform.port.ts` add to `ResearchPlatformPort`:

```ts
  submitStrategyResearchRun(bundle: StrategyBundle, opts: SubmitStrategyResearchRunOptions): Promise<RunJobHandle>;
```

and export:

```ts
export interface SubmitStrategyResearchRunOptions {
  run: PlatformRunConfig;
  correlationId: string;
  metrics: string[];               // non-empty subset of the overlay metric catalog
  resumeToken?: string;
  workflowId?: string;
  callbackUrl?: string;
}
```

Import `StrategyBundle` from `../domain/strategy-bundle.ts`.

- [ ] **Step 2: Write the failing mock-adapter test**

```ts
// src/adapters/platform/mock-research-platform.adapter.test.ts (extend)
it('submitStrategyResearchRun returns a pollable handle', async () => {
  const adapter = new MockResearchPlatformAdapter(/* existing ctor args */);
  const handle = await adapter.submitStrategyResearchRun(
    { bytes: new Uint8Array(), source: '', manifest: { id: 'mod_x', version: 1, kind: 'strategy' } as any, bundleHash: 'sha256:h' } as any,
    { run: { datasetId: 'mock-ds-1', symbols: ['ESPORTSUSDT'], timeframe: '1h', period: { from: '2026-06-12', to: '2026-06-18' }, seed: 42 },
      correlationId: 'sanity', metrics: ['netPnlUsd'] },
  );
  expect(handle.runId).toBeTruthy();
  const view = await adapter.getRunStatus(handle.runId);
  expect(['completed', 'running', 'submitted']).toContain(view.status);
});
```

- [ ] **Step 3: Run to verify it fails** — FAIL (method missing).

- [ ] **Step 4: Implement the mock adapter method** — mirror `MockResearchPlatformAdapter.submitOverlayRun`: register a canned run (a deterministic `runId`, a `completed` status, and a `RunResultSummary` carrying `metrics` — reuse the mock's existing canned-metrics shape — and an empty/`available` trades artifact if the mock models one). It must be resolvable by the mock's `getRunStatus`/`getRunResult`. Keep it minimal — this drives offline tests only.

- [ ] **Step 5: Implement the HTTP adapter method** — in `HttpBacktesterAdapter` add `submitStrategyResearchRun`, modelled on the existing equivalence-probe `submitStrategyRun` for wire-bundle construction but returning a `RunJobHandle` from `submitRun`:

```ts
async submitStrategyResearchRun(bundle: StrategyBundle, opts: SubmitStrategyResearchRunOptions): Promise<RunJobHandle> {
  const moduleBundle = createModuleBundle({
    manifest: bundle.manifest, entry: 'index.js',
    files: { 'index.js': new TextDecoder().decode(bundle.bytes) },
  });
  const res = await this.client.submitRun({
    engine: 'strategy',
    moduleRef: { id: bundle.manifest.id, version: bundle.manifest.version },
    moduleBundle,
    datasetRef: opts.run.datasetId,
    symbols: [...opts.run.symbols],
    timeframe: opts.run.timeframe,
    period: opts.run.period,
    seed: opts.run.seed,
    mode: 'research',
    metrics: opts.metrics,
    ...(opts.callbackUrl !== undefined ? { callbackUrl: opts.callbackUrl } : {}),
  });
  return { runId: res.runId };
}
```

Match the exact field names of `RunSubmitRequest` / the return of `client.submitRun` against the SDK (`@trading-backtester/sdk`); reuse the same `createModuleBundle` import + `client` handle the probe uses. The `metrics` list is threaded from the caller (Task 10).

- [ ] **Step 6: Run to verify it passes** — `pnpm test src/adapters/platform/mock-research-platform.adapter.test.ts` → PASS; `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ports/research-platform.port.ts src/adapters/platform/*research-platform* src/adapters/platform/http-backtester.adapter.ts
git commit -m "feat(research): submitStrategyResearchRun (engine:'strategy', metrics run) on port + adapters"
```

### Task 7: `mapStrategyMetrics`

**Files:**
- Create: `src/domain/strategy-metrics.ts`
- Test: `src/domain/strategy-metrics.test.ts`

**Interfaces:**
- Consumes: `RunResultSummary` (`../ports/research-platform.port.ts`), `BacktestMetricBlock` (`../ports/platform-gateway.port.ts`), `resolveProfitFactors`/`NO_LOSS_PROFIT_FACTOR` (`./platform-comparison.ts` — reuse).
- Produces: `mapStrategyMetrics(summary): BacktestMetricBlock` (throws a clear error if `summary.metrics` is absent).

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/strategy-metrics.test.ts
import { describe, it, expect } from 'vitest';
import { mapStrategyMetrics } from './strategy-metrics.ts';

describe('mapStrategyMetrics', () => {
  it('maps a variant-only metrics summary (no comparison)', () => {
    const m = mapStrategyMetrics({ status: 'completed', metrics: {
      netPnlUsd: 12, netPnlPct: 1.2, totalTrades: 4, winRate: 0.75, profitFactor: 1.8,
      maxDrawdownPct: 6, expectancyUsd: 3, sharpe: 1.1, topTradeContributionPct: 35 },
      artifactRefs: [] } as any);
    expect(m.totalTrades).toBe(4);
    expect(m.profitFactor).toBe(1.8);
  });
  it('throws when metrics are absent', () => {
    expect(() => mapStrategyMetrics({ status: 'completed', artifactRefs: [] } as any)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** — read `mapPlatformComparison` + `resolveProfitFactors` in `src/domain/platform-comparison.ts` first, then map the raw `summary.metrics` fields into a `BacktestMetricBlock`, applying `resolveProfitFactors`/`NO_LOSS_PROFIT_FACTOR` for the profit-factor edge (win_rate===1 → NO_LOSS). Throw `new Error('strategy run summary has no metrics')` when absent. (The exact raw metric field names come from the SDK `RunResultSummary.metrics` — match them; the target `BacktestMetricBlock` fields are `netPnlUsd, netPnlPct, totalTrades, winRate, profitFactor, maxDrawdownPct, expectancyUsd, sharpe, topTradeContributionPct`.)

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/strategy-metrics.ts src/domain/strategy-metrics.test.ts
git commit -m "feat(research): mapStrategyMetrics (variant-only, no comparison)"
```

### Task 8: `pollResearchRun` extraction (blocker fix)

**Files:**
- Modify: `src/research/run-backtest.ts`
- Test: `src/research/run-backtest.test.ts` (extend or create)

**Interfaces:**
- Produces: `pollResearchRun(platform, runId, poll): Promise<PlatformRunOutcome>` (completed on `summary.status === 'completed'`, no comparison gate). `pollOverlayRun` keeps its signature + today's exact behaviour by delegating.

- [ ] **Step 1: Write the failing test**

```ts
// src/research/run-backtest.test.ts
import { describe, it, expect } from 'vitest';
import { pollResearchRun, pollOverlayRun } from './run-backtest.ts';

const platformWith = (summary: any) => ({
  getRunStatus: async () => ({ status: 'completed' }),
  getRunResult: async () => ({ kind: 'summary', summary }),
} as any);
const poll = { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} };

describe('poll boundary', () => {
  it('pollResearchRun returns completed for a comparison-less summary', async () => {
    const out = await pollResearchRun(platformWith({ status: 'completed', artifactRefs: [] }), 'r1', poll);
    expect(out.status).toBe('completed');
  });
  it('pollOverlayRun still rejects a comparison-less summary (overlay unchanged)', async () => {
    const out = await pollOverlayRun(platformWith({ status: 'completed', artifactRefs: [] }), 'r1', poll);
    expect(out.status).toBe('rejected');
  });
  it('pollOverlayRun completes when comparison is present', async () => {
    const out = await pollOverlayRun(platformWith({ status: 'completed', comparison: {}, artifactRefs: [] }), 'r1', poll);
    expect(out.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`pollResearchRun` not exported).

- [ ] **Step 3: Refactor `run-backtest.ts`** — extract the terminal-wait + completed-summary logic into `pollResearchRun` (no `comparison` check); make `pollOverlayRun` delegate then downgrade:

```ts
export async function pollResearchRun(platform: ResearchPlatformPort, runId: string, poll: PollOptions): Promise<PlatformRunOutcome> {
  const sleep = poll.sleep ?? realSleep;
  let terminal = false;
  for (let i = 0; i < poll.maxPolls; i += 1) {
    const view = await platform.getRunStatus(runId);
    if (isTerminal(view.status)) { terminal = true; break; }
    if (i < poll.maxPolls - 1) await sleep(poll.pollDelayMs);
  }
  if (!terminal) return { status: 'pending', runId };
  const res = await platform.getRunResult(runId);
  if (res.kind === 'summary' && res.summary.status === 'completed') {
    return { status: 'completed', runId, summary: res.summary, artifactIds: res.summary.artifactRefs.map((r) => r.artifactId) };
  }
  const terminalCode = res.kind === 'status' ? res.view.terminalCode : undefined;
  return { status: 'rejected', runId, ...(terminalCode !== undefined ? { terminalCode } : {}) };
}

export async function pollOverlayRun(platform: ResearchPlatformPort, runId: string, poll: PollOptions): Promise<PlatformRunOutcome> {
  const outcome = await pollResearchRun(platform, runId, poll);
  if (outcome.status === 'completed' && outcome.summary.comparison === undefined) {
    return { status: 'rejected', runId };  // overlay requires a comparison — preserve prior behaviour
  }
  return outcome;
}
```

- [ ] **Step 4: Run to verify it passes** — `pnpm test src/research/run-backtest.test.ts` → PASS. Then `pnpm test` (full) → the existing overlay/executor tests stay green (behavioural zero-diff).

- [ ] **Step 5: Commit**

```bash
git add src/research/run-backtest.ts src/research/run-backtest.test.ts
git commit -m "fix(research): extract pollResearchRun; pollOverlayRun delegates (comparison-less strategy run no longer misclassified rejected)"
```

### Task 9: Trades-artifact adapter verification

**Files:**
- Verify (fix only if wrong): `src/adapters/platform/http-backtester.adapter.ts` (`getRunTrades`)
- Test: `src/adapters/platform/http-backtester.adapter.test.ts` (extend if a fix is made)

- [ ] **Step 1: Read `HttpBacktesterRunTradesAdapter.getRunTrades`** — confirm it (a) reads `descriptor.contentHash` (NOT `descriptor.artifactId`) when picking the trades descriptor and passing it to `readArtifact`, and (b) reads page rows from `ArtifactPage.page` (NOT `.rows`), matching `artifactType === 'trades' && availability === 'available'`. Reference: `docs/superpowers/notes/2026-07-01-holdout-investigation.md` §0.2.

- [ ] **Step 2: If correct** — record "verified, no change" in the runbook (Task 16) and skip to Task 10. **If it reads `artifactId`/`.rows`** — write a failing unit test feeding a manifest whose descriptor uses `contentHash` + a page under `page`, then fix the field reads, then confirm PASS.

- [ ] **Step 3: Commit (only if changed)**

```bash
git add src/adapters/platform/http-backtester.adapter.ts src/adapters/platform/http-backtester.adapter.test.ts
git commit -m "fix(research): getRunTrades reads descriptor.contentHash + ArtifactPage.page"
```

---

## Phase 3 — Executor + service + evaluator

### Task 10: `StrategyExperimentRunExecutor` port + impl

**Files:**
- Create: `src/research/strategy-experiment-run-executor.ts` (port + request/result types)
- Create: `src/research/backtester-strategy-experiment-run-executor.ts` (impl)
- Test: `src/research/backtester-strategy-experiment-run-executor.test.ts`

**Interfaces:**
- Consumes: `StrategyBundle`, `PlatformRunConfig`, `MemberRole`, `ResearchPlatformPort.submitStrategyResearchRun` (Task 6), `StrategyBacktestRunRepository` (Task 3), `pollResearchRun` (Task 8), `mapStrategyMetrics` (Task 7), `computeStrategyParamsHash` (Task 5), `BacktestMetricBlock`.
- Produces:

```ts
export interface StrategyExperimentRunRequest {
  experimentId: string; role: MemberRole; strategyBundle: StrategyBundle; strategyProfileId: string;
  run: PlatformRunConfig; params: Record<string, unknown>; metrics: string[];
}
export interface StrategyExperimentRunResult {
  status: 'completed' | 'pending' | 'rejected';
  runId: string; platformRunId: string; metrics?: BacktestMetricBlock; totalTrades?: number;
}
export interface StrategyExperimentRunExecutor { execute(req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult>; }
```

- [ ] **Step 1: Write the port + types file** (the three interfaces above), importing the referenced types.

- [ ] **Step 2: Write the failing impl test**

```ts
// src/research/backtester-strategy-experiment-run-executor.test.ts
import { describe, it, expect } from 'vitest';
import { BacktesterStrategyExperimentRunExecutor } from './backtester-strategy-experiment-run-executor.ts';
import { InMemoryStrategyBacktestRunRepository } from '../adapters/repository/in-memory-strategy-backtest-run.repository.ts';

const bundle = { bytes: new Uint8Array(), source: '', manifest: { id: 'mod_x', version: 1, kind: 'strategy' }, bundleHash: 'sha256:h' } as any;
const run = { datasetId: 'd', symbols: ['S'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 42 };

const fakePlatform = (summary: any) => ({
  submitStrategyResearchRun: async () => ({ runId: 'pr_1' }),
  getRunStatus: async () => ({ status: 'completed' }),
  getRunResult: async () => ({ kind: 'summary', summary }),
} as any);

describe('BacktesterStrategyExperimentRunExecutor', () => {
  it('submits, persists, polls, maps metrics on completed', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: fakePlatform({ status: 'completed', artifactRefs: [], metrics: {
        netPnlUsd: 5, netPnlPct: 1, totalTrades: 3, winRate: 0.6, profitFactor: 1.4,
        maxDrawdownPct: 4, expectancyUsd: 2, sharpe: 0.8, topTradeContributionPct: 30 } }),
      strategyBacktests: repo, poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} }, now: () => 't',
    });
    const out = await exec.execute({ experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'] });
    expect(out.status).toBe('completed');
    expect(out.totalTrades).toBe(3);
    expect((await repo.findById(out.runId))?.status).toBe('completed');
  });
  it('marks rejected on a rejected outcome', async () => {
    const repo = new InMemoryStrategyBacktestRunRepository();
    const exec = new BacktesterStrategyExperimentRunExecutor({
      platform: { submitStrategyResearchRun: async () => ({ runId: 'pr_2' }),
        getRunStatus: async () => ({ status: 'rejected', terminalCode: 'x' }), getRunResult: async () => ({ kind: 'status', view: { status: 'rejected', terminalCode: 'x' } }) } as any,
      strategyBacktests: repo, poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} }, now: () => 't',
    });
    const out = await exec.execute({ experimentId: 'e1', role: 'sanity', strategyBundle: bundle,
      strategyProfileId: 'p1', run, params: {}, metrics: ['netPnlUsd'] });
    expect(out.status).toBe('rejected');
  });
});
```

- [ ] **Step 3: Run to verify it fails** — FAIL.

- [ ] **Step 4: Write the impl** (mirror `BacktesterExperimentRunExecutor`, strategy-flavored — persist a `StrategyBacktestRun`, no `baselineRef`/hypothesis, `pollResearchRun` + `mapStrategyMetrics`):

```ts
// src/research/backtester-strategy-experiment-run-executor.ts
import { randomUUID, createHash } from 'node:crypto';
import type { ResearchPlatformPort } from '../ports/research-platform.port.ts';
import type { StrategyBacktestRunRepository } from '../ports/strategy-backtest-run.repository.ts';
import type { StrategyBacktestRun } from '../domain/strategy-backtest-run.ts';
import { STRATEGY_RUN_KIND } from '../domain/strategy-backtest-run.ts';
import { pollResearchRun, type PollOptions } from './run-backtest.ts';
import { mapStrategyMetrics } from '../domain/strategy-metrics.ts';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';
import { SDK_CONTRACT_VERSION } from '../domain/module-bundle.ts';
import type { StrategyExperimentRunExecutor, StrategyExperimentRunRequest, StrategyExperimentRunResult } from './strategy-experiment-run-executor.ts';

export interface BacktesterStrategyExperimentRunExecutorDeps {
  platform: ResearchPlatformPort;
  strategyBacktests: StrategyBacktestRunRepository;
  poll: PollOptions;
  callbackUrl?: string;
  now: () => string;
}

export class BacktesterStrategyExperimentRunExecutor implements StrategyExperimentRunExecutor {
  private readonly d: BacktesterStrategyExperimentRunExecutorDeps;
  constructor(deps: BacktesterStrategyExperimentRunExecutorDeps) { this.d = deps; }

  async execute(req: StrategyExperimentRunRequest): Promise<StrategyExperimentRunResult> {
    const paramsHash = computeStrategyParamsHash({ bundleHash: req.strategyBundle.bundleHash, platformRun: req.run, params: req.params });
    const resumeToken = createHash('sha256')
      .update(JSON.stringify({ v: 1, experimentId: req.experimentId, role: req.role, paramsHash, bundleHash: req.strategyBundle.bundleHash }))
      .digest('hex');

    const handle = await this.d.platform.submitStrategyResearchRun(req.strategyBundle, {
      run: req.run, correlationId: req.role, metrics: req.metrics, resumeToken, workflowId: req.experimentId,
      ...(this.d.callbackUrl !== undefined ? { callbackUrl: this.d.callbackUrl } : {}),
    });
    const labRunId = randomUUID();

    const row: StrategyBacktestRun = {
      id: labRunId, strategyProfileId: req.strategyProfileId, strategyBundleId: req.strategyBundle.manifest.id,
      bundleHash: req.strategyBundle.bundleHash, paramsHash, runKind: STRATEGY_RUN_KIND, platformRunId: handle.runId,
      correlationId: req.role, taskId: req.experimentId, resumeToken, params: req.params, status: 'submitted',
      metrics: null, platformRun: req.run, artifactRefs: [], platformContractVersion: 'pending',
      sdkContractVersion: SDK_CONTRACT_VERSION, backend: 'research_platform', submittedAt: this.d.now(),
      finishedAt: null, createdAt: this.d.now(), updatedAt: this.d.now(),
    };
    await this.d.strategyBacktests.createSubmitted(row);

    const outcome = await pollResearchRun(this.d.platform, handle.runId, this.d.poll);
    if (outcome.status === 'rejected') { await this.d.strategyBacktests.markRejected(labRunId); return { status: 'rejected', runId: labRunId, platformRunId: handle.runId }; }
    if (outcome.status === 'pending') { return { status: 'pending', runId: labRunId, platformRunId: handle.runId }; }

    let metrics;
    try { metrics = mapStrategyMetrics(outcome.summary); }
    catch { await this.d.strategyBacktests.markFailed(labRunId); return { status: 'rejected', runId: labRunId, platformRunId: handle.runId }; }

    await this.d.strategyBacktests.markCompleted(labRunId, {
      metrics, artifactRefs: [...outcome.artifactIds],
      platformContractVersion: outcome.summary.platformContractVersion ?? 'unknown', finishedAt: this.d.now(),
    });
    return { status: 'completed', runId: labRunId, platformRunId: handle.runId, metrics, totalTrades: metrics.totalTrades };
  }
}
```

(Confirm `req.strategyBundle.manifest.id` is the correct field on the `assembleStrategyBundle` manifest; and `outcome.summary.platformContractVersion` — adjust the fallback if the field differs.)

- [ ] **Step 5: Run to verify it passes** — PASS. `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/research/strategy-experiment-run-executor.ts src/research/backtester-strategy-experiment-run-executor.ts src/research/backtester-strategy-experiment-run-executor.test.ts
git commit -m "feat(research): StrategyExperimentRunExecutor (engine:'strategy', typed request/result)"
```

### Task 11: `evaluateStrategyBaseline`

**Files:**
- Create: `src/validation/strategy-baseline-evaluator.ts`
- Test: `src/validation/strategy-baseline-evaluator.test.ts`

**Interfaces:**
- Consumes: `BacktestMetricBlock`, `HoldoutBoundary`, `ExperimentFlags` (`../domain/research-experiment.ts`).
- Produces: `evaluateStrategyBaseline({ holdout, boundary }): { verdict; verdictReason?; rawScores; flags }`, `STRATEGY_BASELINE_EVALUATOR_VERSION`, `STRATEGY_BASELINE_THRESHOLDS`.

- [ ] **Step 1: Write the failing test**

```ts
// src/validation/strategy-baseline-evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateStrategyBaseline } from './strategy-baseline-evaluator.ts';

const good = { netPnlUsd: 10, netPnlPct: 1, totalTrades: 40, winRate: 0.6, profitFactor: 1.6, maxDrawdownPct: 8, expectancyUsd: 2, sharpe: 1.2, topTradeContributionPct: 20 };
const bad = { ...good, profitFactor: 0.7, sharpe: -0.3 };
const viableBoundary = { mode: 'trade_based' as const, t: 'T', trainTrades: 60, holdoutTrades: 35, lowConfidence: false, reason: 'ok' as const };
const lowConf = { ...viableBoundary, holdoutTrades: 18, lowConfidence: true };

describe('evaluateStrategyBaseline', () => {
  it('viable survived holdout → PAPER_CANDIDATE', () => {
    expect(evaluateStrategyBaseline({ holdout: good, boundary: viableBoundary }).verdict).toBe('PAPER_CANDIDATE');
  });
  it('below-floor holdout → FAIL', () => {
    const r = evaluateStrategyBaseline({ holdout: bad, boundary: viableBoundary });
    expect(r.verdict).toBe('FAIL');
  });
  it('low-confidence holdout → INCONCLUSIVE even if metrics pass', () => {
    const r = evaluateStrategyBaseline({ holdout: good, boundary: lowConf });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.flags.lowConfidenceHoldout).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```ts
// src/validation/strategy-baseline-evaluator.ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { HoldoutBoundary, ExperimentFlags, ExperimentVerdict } from '../domain/research-experiment.ts';

export const STRATEGY_BASELINE_EVALUATOR_VERSION = 'strategy-baseline-v1';
export const STRATEGY_BASELINE_THRESHOLDS = { minSharpe: 0, minProfitFactor: 1, minTrades: 1 } as const;

export interface StrategyBaselineEvaluation {
  verdict: ExperimentVerdict; verdictReason?: string; rawScores: Record<string, unknown>; flags: ExperimentFlags;
}

export function evaluateStrategyBaseline(input: { holdout: BacktestMetricBlock; boundary: HoldoutBoundary }): StrategyBaselineEvaluation {
  const t = STRATEGY_BASELINE_THRESHOLDS;
  const flags: ExperimentFlags = { lowConfidenceHoldout: input.boundary.lowConfidence, overfit: false, fragility: [], coverageWarnings: [] };
  const rawScores = { thresholds: t, holdout: input.holdout, holdoutTrades: input.boundary.holdoutTrades };
  if (input.boundary.lowConfidence) return { verdict: 'INCONCLUSIVE', verdictReason: 'low_confidence', rawScores, flags };
  const viable = input.holdout.totalTrades >= t.minTrades && input.holdout.profitFactor >= t.minProfitFactor && input.holdout.sharpe > t.minSharpe;
  if (viable) return { verdict: 'PAPER_CANDIDATE', rawScores, flags };
  return { verdict: 'FAIL', verdictReason: 'baseline_below_floor', rawScores, flags };
}
```

(Confirm `ExperimentFlags` shape in `research-experiment.ts` — mirror the fields the PR #119 evaluator uses.)

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validation/strategy-baseline-evaluator.ts src/validation/strategy-baseline-evaluator.test.ts
git commit -m "feat(research): evaluateStrategyBaseline (absolute-metrics; sanity-only capped in the service)"
```

### Task 12: `ExperimentService.runStrategyBaselineValidation`

**Files:**
- Modify: `src/research/experiment-service.ts`
- Test: `src/research/experiment-service.strategy.test.ts`

**Interfaces:**
- Consumes: `StrategyExperimentRunExecutor` (Task 10), `computeStrategyExperimentKey` (Task 5), `evaluateStrategyBaseline` (Task 11), `StrategyBundle`, existing `resolveHoldoutBoundary`/`encodeTrainPeriod`/`encodeHoldoutPeriod`.
- Produces: `ExperimentServiceDeps.strategyRunExecutor: StrategyExperimentRunExecutor`; `ExperimentService.runStrategyBaselineValidation(input): Promise<{ experimentId; verdict }>` with `input = { strategyProfileId, strategyBundle: StrategyBundle, datasetScope, runConfig: Omit<PlatformRunConfig,'period'>, metrics: string[], holdoutPolicy?, objective?, taskId }`.

- [ ] **Step 1: Write the failing flow test** — two cases with a fake strategy executor + `FakeRunTradesAdapter`:

```ts
// src/research/experiment-service.strategy.test.ts  (skeleton — fill exec/repo/events fakes mirroring new-strategy-holdout.integration.test.ts)
import { describe, it, expect } from 'vitest';
import { ExperimentService } from './experiment-service.ts';
// ... construct InMemoryResearchExperimentRepository, a fake AgentEventRepository, a FakeRunTradesAdapter, and a
//     fake StrategyExperimentRunExecutor whose execute() returns completed metrics with a controllable totalTrades.

describe('runStrategyBaselineValidation', () => {
  it('few trades over a short slice → INCONCLUSIVE, no train/holdout runs (demo path)', async () => {
    // runTrades returns e.g. 4 trades over a 6-day period → resolveHoldoutBoundary → mode 'none'
    // expect verdict === 'INCONCLUSIVE'; the executor is called exactly once (sanity)
  });
  it('synthetic ≥30-trade path with a surviving holdout → PAPER_CANDIDATE', async () => {
    // runTrades returns ≥ minTradesTrain+minTradesHoldout timestamped trades; executor returns viable metrics for train+holdout
    // expect verdict === 'PAPER_CANDIDATE'; executor called 3× (sanity/train/holdout)
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`runStrategyBaselineValidation` missing).

- [ ] **Step 3: Add the dep + method + private `runStrategyMember`** — mirror `runNewStrategyValidation`, substituting the strategy executor, `computeStrategyExperimentKey`, `experimentType: 'strategy_baseline_validation'`, `evaluateStrategyBaseline`, and the member's `strategyBacktestRunId` (backtestRunId stays undefined — XOR). Key structural notes:
  - `ExperimentServiceDeps` gains `strategyRunExecutor: StrategyExperimentRunExecutor`.
  - `ResearchExperiment` is created with `hypothesisId`/`buildId`/`baselineRef` **undefined**, `bundleHash = input.strategyBundle.bundleHash`, `strategyProfileId` set.
  - After `sanity`/boundary: `if (boundary.mode === 'none' || !boundary.t) return fail('INCONCLUSIVE', boundary.reason ?? 'insufficient')` — this is the **sanity-only cap** (§6): a full-period-only baseline never reaches PAPER_CANDIDATE.
  - Emit the same event types as the overlay method: `experiment.started`, `experiment.member.completed` (per member, from `runStrategyMember`), `experiment.completed` — each payload carries `experimentType: 'strategy_baseline_validation'`.
  - Evaluate with the **holdout** metrics: `evaluateStrategyBaseline({ holdout: holdout.metrics, boundary })` (only reached when a viable holdout ran).

```ts
// added to ExperimentService
async runStrategyBaselineValidation(input: RunStrategyBaselineValidationInput): Promise<{ experimentId: string; verdict: ExperimentVerdict }> {
  const policy = input.holdoutPolicy ?? DEFAULT_HOLDOUT_POLICY;
  const strategyBundleId = input.strategyBundle.manifest.id;
  const experimentKey = computeStrategyExperimentKey({
    strategyProfileId: input.strategyProfileId, strategyBundleId, bundleHash: input.strategyBundle.bundleHash,
    datasetScope: input.datasetScope, holdoutPolicy: policy,
  });
  const existing = await this.d.experiments.findByKey(experimentKey);
  if (existing && existing.status === 'completed') return { experimentId: existing.id, verdict: existing.verdict ?? 'INCONCLUSIVE' };
  // ... create experiment(experimentType:'strategy_baseline_validation', bundleHash, no hypothesis/build), emit experiment.started
  // ... sanity = runStrategyMember('sanity', fullPeriod); pending→INCONCLUSIVE/run_pending; rejected/0-trades→FAIL/sanity_failed
  // ... boundary = resolveHoldoutBoundary(getRunTrades(sanity.platformRunId), fullPeriod, policy); persist boundary
  // ... boundary none → fail('INCONCLUSIVE', reason)   [sanity-only cap]
  // ... train = runStrategyMember('train', encodeTrainPeriod(...)); pending/!completed→INCONCLUSIVE
  // ... holdout = runStrategyMember('holdout', encodeHoldoutPeriod(...))
  // ... result = evaluateStrategyBaseline({ holdout: holdout.metrics!, boundary }); addEvaluation; updateExperiment(completed, verdict); emit experiment.completed
}

private async runStrategyMember(experimentId: string, role: MemberRole, input: RunStrategyBaselineValidationInput, run: PlatformRunConfig): Promise<StrategyExperimentRunResult> {
  const memberId = this.d.newId('mem');
  await this.d.experiments.addMember({ id: memberId, experimentId, role, periodFrom: run.period.from, periodTo: run.period.to,
    symbols: [...run.symbols], paramsHash: '', bundleHash: input.strategyBundle.bundleHash, createdAt: this.d.now() });
  const outcome = await this.d.strategyRunExecutor.execute({ experimentId, role, strategyBundle: input.strategyBundle,
    strategyProfileId: input.strategyProfileId, run, params: {}, metrics: input.metrics });
  await this.d.experiments.updateMember(memberId, { strategyBacktestRunId: outcome.runId, tradeCount: outcome.totalTrades,
    resultSummary: { totalTrades: outcome.totalTrades } });
  await this.d.events.append({ id: this.d.newId('evt'), taskId: input.taskId, type: 'experiment.member.completed',
    payload: { experimentId, role, status: outcome.status, tradeCount: outcome.totalTrades, strategyBacktestRunId: outcome.runId, experimentType: 'strategy_baseline_validation' },
    createdAt: this.d.now() });
  return outcome;
}
```

Add `RunStrategyBaselineValidationInput` to the file (fields listed in Interfaces). Confirm `updateMember` accepts `strategyBacktestRunId` (add it to the member update type in `ResearchExperimentRepository` + both adapters if missing — additive).

- [ ] **Step 4: Run to verify it passes** — `pnpm test src/research/experiment-service.strategy.test.ts` → PASS; full `pnpm test` green (overlay tests untouched); `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/experiment-service.ts src/research/experiment-service.strategy.test.ts src/ports/research-experiment.repository.ts src/adapters/repository/*research-experiment*
git commit -m "feat(research): ExperimentService.runStrategyBaselineValidation (strategy lane, XOR member, sanity-only capped)"
```

### Task 13: Composition wiring

**Files:**
- Modify: `src/orchestrator/app-services.ts`
- Modify: `src/composition.ts`

**Interfaces:**
- Produces: `AppServices.strategyBuilder`, `AppServices.strategyBacktests`, and the `ExperimentService` constructed with `strategyRunExecutor`.

- [ ] **Step 1: Extend `AppServices`** — add `strategyBuilder: StrategyBuilder`, `strategyBacktests: StrategyBacktestRunRepository` (types from Task 3 + `src/ports/strategy-builder.port.ts`).

- [ ] **Step 2: Wire in `composeRuntime`** — mirror the existing overlay wiring:
  - `strategyBacktests = new DrizzleStrategyBacktestRunRepository(db)`.
  - Build the strategy builder like the roundtrip script: `const strategyBuilderAgent = createStrategyBuilderAgent({ model: <resolved builder model>, authoringDoc: getAuthoringDoc('strategy') }); const strategyBuilder = new MastraStrategyBuilder(strategyBuilderAgent, <label>);` (reuse the existing builder-model resolution already in `composeRuntime`).
  - `const strategyRunExecutor = new BacktesterStrategyExperimentRunExecutor({ platform: researchPlatform, strategyBacktests, poll: <existing poll opts>, now });`
  - Pass `strategyRunExecutor` into the existing `new ExperimentService({ ..., strategyRunExecutor })`.

- [ ] **Step 3: Run gates** — `pnpm typecheck` → PASS; `pnpm test` → green (composition/e2e tests still pass).

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/app-services.ts src/composition.ts
git commit -m "feat(research): wire strategyBuilder + strategyBacktests + StrategyExperimentRunExecutor into composition"
```

---

## Phase 4 — Seed + trigger + runbook

### Task 14: Seed the `long_oi` profile via real onboard

**Files:**
- Create: `scripts/seed-long-oi-profile.mts`

- [ ] **Step 1: Write the seed script** — compose the runtime (or the onboard handler with real services), read the vendored long_oi code, and run the real `strategy.onboard` path so the analyst produces + persists a `StrategyProfile`; print the id. Mirror `scripts/code-analyst-roundtrip.mts` for reading code (`readCodeDir` + `buildCodeSource`, kind `bot_code`) and `scripts/regen-from-code.mts` for env; but here **persist** via the onboard handler / `strategyProfiles.create` (idempotent by `sourceFingerprint`). Print `strategyProfileId`.

Header comment must document: required env (DB `DATABASE_URL`, `MODEL_PROVIDER` + key, `STRATEGY_ANALYST_MODEL`), the vendored code dir, and the manual `tsc` typecheck invocation (mirror the roundtrip script's header).

- [ ] **Step 2: Typecheck the script** — run the manual `tsc --noEmit ... scripts/seed-long-oi-profile.mts` invocation from its header → PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-long-oi-profile.mts
git commit -m "feat(research): seed-long-oi-profile script (real onboard → persisted StrategyProfile)"
```

### Task 15: One-shot baseline trigger

**Files:**
- Create: `scripts/run-strategy-baseline.mts`

- [ ] **Step 1: Write the trigger script** — compose the runtime, load the seeded profile (`strategyProfiles.findById` / a lookup by fingerprint or a `STRATEGY_PROFILE_ID` env), build the strategy bundle (`strategyBuilder.build({ spec:{description:'long oi baseline'}, authoringDoc: getAuthoringDoc('strategy'), profile })` → `assembleStrategyBundle`), `artifacts.put(...)`, then call `experimentService.runStrategyBaselineValidation({ strategyProfileId, strategyBundle, datasetScope, runConfig, metrics: <catalog subset>, taskId })` with the `datasetScope`/`runConfig` from the default platform run (`ESPORTSUSDT:1h`, `2026-06-12..19`, seed 42). Print `{ experimentId, verdict, sanity metrics, totalTrades }`.

Header comment documents env: `BACKTESTER_API_URL=http://127.0.0.1:8080`, `integration='backtester'`, run-trades adapter = `backtester`, builder model provider/key, DB.

- [ ] **Step 2: Typecheck the script** — manual `tsc` invocation → PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/run-strategy-baseline.mts
git commit -m "feat(research): run-strategy-baseline one-shot trigger"
```

### Task 16: Runbook + captured real run

**Files:**
- Create: `docs/superpowers/notes/2026-07-01-strategy-baseline-runbook.md`

- [ ] **Step 1: Write the runbook** — the exact real-engine bring-up:
  1. mock-platform up (serving `/historical/rows` over the committed ~6-day fixture) — the command used.
  2. `docker pull node:24-alpine`.
  3. `trading-backtester` host process: `cd trading-backtester/apps/backtester && pnpm install && BACKTESTER_ENABLE_OVERLAY_ENGINE=true BACKTESTER_DATA_SOURCE=mock BACKTESTER_MOCK_PLATFORM_URL=<url> BACKTESTER_AUTH_TOKEN=<tok> pnpm start` — **and** the resolved answer to the spec §15 open item: whether `engine:'strategy'` needs its own flag (check `apps/backtester/src/jobs/submit.ts`; document what you set).
  4. lab env: `BACKTESTER_API_URL`, `integration`, run-trades adapter; DB up + migrated.
  5. `pnpm tsx scripts/seed-long-oi-profile.mts` → capture `strategyProfileId`.
  6. `pnpm tsx scripts/run-strategy-baseline.mts` → capture `{ experimentId, verdict, metrics, totalTrades }`.

- [ ] **Step 2: Run it for real** — execute steps 1-6 against the host backtester. Record: the seeded `strategyProfileId`, the strategy `bundleHash`, the captured verdict + sanity metrics + `totalTrades`. **Acceptance:** `totalTrades > 0` (real engine produced real trades) — proving submit → engine → trades artifact → persist. Verdict is expected `INCONCLUSIVE` on the ~6-day slice (§11) — that is a pass, not a failure. Also record the Task-9 verdict (getRunTrades field names verified / fixed).

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-07-01-strategy-baseline-runbook.md
git commit -m "docs(research): strategy-baseline real-engine runbook + captured baseline run"
```

---

## Self-Review

**Spec coverage:** §2 persistence Approach 2 → Tasks 1-4. §5 submit → Task 6. §6 map/eval → Tasks 7, 11. §7 executor + §7.2 hash + §7.3 poll → Tasks 5, 8, 10. §8 service → Task 12. §9 trades verify → Task 9. §10 wiring/seed/trigger/runbook → Tasks 13-16. §3.1 events → emitted in Task 12 (`experiment.started` / `experiment.member.completed` / `experiment.completed` — spec §3.1 was synced to this exact 3-event contract). §4.2 XOR → Tasks 4, 12. §11 data-reality (INCONCLUSIVE) → Tasks 12, 16. §12 testing/§13 build order → task structure.

**Placeholder scan:** the deliberately-descriptive steps (drizzle adapter Task 3 Step 6, mock adapter Task 6 Step 4, `mapStrategyMetrics` Task 7 Step 3, service body Task 12 Step 3, both scripts, runbook) point at an **exact sibling to mirror** + the concrete field/column list — actionable, not "TODO". The executing worker reads the named sibling; that is the intended pattern for mirror-tasks. No `TBD`/`implement later`.

**Type consistency:** `StrategyBundle` (from `assembleStrategyBundle`) fields used = `{ bytes, source, manifest:{id,version,kind}, bundleHash }` (Tasks 6, 10, 12, 15) — **verify against `src/domain/strategy-bundle.ts` in Task 10 Step 4** (flagged inline). `BacktestMetricBlock` field names identical across Tasks 3/7/10/11. `pollResearchRun`/`pollOverlayRun` names consistent (Tasks 8, 10). `computeStrategyParamsHash`/`computeStrategyExperimentKey` consistent (Tasks 5, 10, 12). `strategyRunExecutor` dep name consistent (Tasks 12, 13).

**Known verify-in-task points (not gaps):** exact SDK `RunSubmitRequest`/`submitRun` return shape (Task 6), `RunResultSummary.metrics` raw field names (Task 7), `strategyBundle.manifest.id` (Task 10), `ExperimentFlags` shape + `updateMember` accepting `strategyBacktestRunId` (Tasks 11-12), `stableStringify` export (Task 5), `engine:'strategy'` flag (Task 16). Each is called out in its task.
