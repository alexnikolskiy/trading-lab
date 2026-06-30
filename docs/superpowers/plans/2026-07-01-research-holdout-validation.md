# Research Holdout Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Experiment Registry/ledger + a trade-based single-split Holdout policy + a 1-fold Train/Holdout validation flow so no new strategy reaches `PAPER_CANDIDATE` without surviving an out-of-sample holdout it was never evaluated on.

**Architecture:** Three new tables (`research_experiment`, `experiment_run_member`, `experiment_evaluation`) with hexagonal repos + read adapters; a pure `HoldoutBoundaryResolver` that computes the split boundary `T` from real trade timestamps fetched via a new `RunTradesPort`; and a plain-TS `ExperimentService` that orchestrates sanity → resolve T → train `[from,T)` → holdout `[T,to]` and renders a verdict via a new composite `evaluateExperiment`. No Mastra workflow. Single-backtest primitives are unchanged; the flow drives runs through the lower-level `runOverlayBacktest` helper.

**Tech Stack:** TypeScript run via `node --experimental-strip-types`, Drizzle ORM + Postgres, drizzle-kit migrations, Hono read API, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-01-research-holdout-validation-design.md` (read it before starting).

## Global Constraints

- **No TS parameter-properties.** Constructors must be `constructor(deps) { this.x = deps.x }` — `constructor(private x)` breaks under `node --experimental-strip-types`. Enforced by `src/strip-types-no-param-properties.test.ts`.
- **Domain ↔ DB boundary:** domain timestamps are ISO `string`; DB stores `Date`. `toDomain` does `row.x.toISOString()`; writes do `new Date(domain.x)`. DB `null` → domain `undefined` (`?? undefined`); writes do `?? null`.
- **IDs are application-generated `text`** (no uuid/serial). **No foreign keys.** **No PG enums** — use `text(...).$type<Union>()`.
- **Migrations:** edit `src/db/schema.ts`, then `pnpm db:generate` (offline; emits `migrations/0013_*.sql` + updates `migrations/meta/`). Do NOT hand-edit `migrations/meta/_journal.json`. Do NOT run `pnpm db:migrate` (needs live Postgres) — tests gate DB work on `DATABASE_URL`.
- **Verification gate before any task is "done":** `pnpm typecheck` (Vitest can pass while `noUncheckedIndexedAccess` fails; `tsc` covers only `src/`) AND `pnpm test` green.
- **Read-API list envelope:** `{ data, page: { nextCursor, limit } }`. Detail = bare DTO. Error = `{ error: { code, message } }`. Mappers are null-preserving.
- **Do not modify** `src/validation/evaluator.ts` (`evaluateBacktest`), `src/orchestrator/handlers/backtest-support.ts` (`finalizeBacktestCompletion`), or `src/orchestrator/handlers/run-platform-backtest.ts` behaviour. The single-backtest flow stays zero-diff.
- **Branch:** all work on `feat/research-holdout-validation` (already created). Commit after every passing step.

---

## Task 0: Investigation (pin the three unknowns)

No production code. Record findings in a scratch note and in this plan's relevant tasks before implementing them. Use gortex tools (`get_symbol_source`, `read_file`, `search_symbols`).

- [ ] **0.1 — Backtester `period.to` inclusivity.** In the **trading-backtester** repo, find the engine window filter that selects bars for a run from `period.{from,to}` (search `period`, `from`, `to`, bar filtering in `apps/backtester/src/engine/`). Determine whether `to` is inclusive or exclusive at bar granularity. Record the answer; it drives `encodeTrainPeriod` (Task 9). Expected outputs: a one-line verdict "`period.to` is inclusive|exclusive" + the file:line of the filter.

- [ ] **0.2 — SDK artifact paging contract.** In **trading-backtester** `packages/sdk/src/client/client.ts`, confirm the exact signatures of `getArtifactManifest(runId)` and `readArtifact(runId, artifactId, {offset?, limit?})`, and the `ArtifactManifest` descriptor shape (`{ artifactType, contentHash, availability, approxItemCount }`) + `ArtifactPage` shape (`{ artifactId, artifactType, page: unknown[], total, offset, nextCursor? }`) in `packages/sdk/src/artifacts/types.ts`. Confirm the concrete client injected in lab (`src/adapters/platform/select-research-platform.ts`, `new BacktesterClient({...})`) is this class. Record exact signatures; they drive Task 8.

- [ ] **0.3 — `runOverlayBacktest` signature + new-strategy call site.** In **trading-lab**: (a) read `src/research/run-backtest.ts` and record the exact signature + return type of `runOverlayBacktest` and `pollOverlayRun`, and the `PlatformRunOutcome` union (`completed | pending | rejected`) with the fields available on the `completed` branch (`runId`, `summary`/`comparison`). (b) Read `src/orchestrator/handlers/hypothesis-build.handler.ts` and identify the discriminator that distinguishes an **initial new-strategy validation** build from a hypothesis-retry / Cycle-2 build (e.g. `attempt === 1`, absence of a prior hypothesis, a `taskType`/payload field). Record the exact field used; it drives Task 13's reroute. Record the exact `backtests` repository method names/signatures (`createSubmitted`, `markCompleted`, `markEvaluated`, `findById`) from `src/ports/backtest-run.repository.ts`.

- [ ] **0.4 — Commit the investigation note.**
```bash
mkdir -p docs/superpowers/notes
git add docs/superpowers/notes/2026-07-01-holdout-investigation.md
git commit -m "docs(research): record holdout-flow investigation findings (period.to, SDK paging, call site)"
```
Write the three findings into `docs/superpowers/notes/2026-07-01-holdout-investigation.md`.

---

# Phase 1 — Experiment Registry / ledger

## Task 1: Domain types

**Files:**
- Create: `src/domain/research-experiment.ts`
- Test: `src/domain/research-experiment.test.ts`

**Interfaces:**
- Produces: `ExperimentType`, `ExperimentStatus`, `MemberRole`, `ExperimentVerdict`, `DatasetScope`, `HoldoutPolicy`, `HoldoutBoundary`, `TradeRecord`, `ExperimentFlags`, `MemberResultSummary`, `ResearchExperiment`, `ExperimentRunMember`, `ExperimentEvaluation`, and `DEFAULT_HOLDOUT_POLICY`.

- [ ] **Step 1: Write the file** (`src/domain/research-experiment.ts`)

```ts
export type ExperimentType =
  | 'new_strategy_validation'
  | 'paper_improvement'
  | 'walk_forward'
  | 'walk_forward_optimization'
  | 'robustness_suite'
  | 'regression_suite';

export type ExperimentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type MemberRole = 'sanity' | 'train' | 'holdout' | 'targeted' | 'regression';
export type ExperimentVerdict = 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface DatasetScope {
  datasetId: string;
  symbols: string[];
  timeframe: string;
  period: { from: string; to: string }; // ISO
}

export interface HoldoutPolicy {
  mode: 'none' | 'time_based' | 'trade_based';
  minTradesTrain: number;
  minTradesHoldout: number;
  lowConfidenceThreshold: number;
  minHistoryDays: number;
}

export const DEFAULT_HOLDOUT_POLICY: HoldoutPolicy = {
  mode: 'trade_based',
  minTradesTrain: 50,
  minTradesHoldout: 30,
  lowConfidenceThreshold: 15,
  minHistoryDays: 30,
};

export interface HoldoutBoundary {
  mode: 'none' | 'trade_based';
  t?: string; // ISO; the fixed split boundary; absent when mode='none'
  trainTrades?: number;
  holdoutTrades?: number;
  lowConfidence: boolean;
  reason?: 'insufficient_trades' | 'insufficient_history' | 'ok';
}

export interface TradeRecord {
  entryTs: number; // epoch ms
  exitTs: number;
  side: 'long' | 'short';
  realizedPnl: number;
}

export interface ExperimentFlags {
  lowConfidenceHoldout: boolean;
  overfit: boolean;
  fragility: string[];
  coverageWarnings: string[];
}

export interface MemberResultSummary {
  decision?: ExperimentVerdict;
  totalTrades?: number;
  netPnlUsd?: number;
  maxDrawdownPct?: number;
  sharpe?: number;
}

export interface ResearchExperiment {
  id: string;
  experimentKey: string;
  experimentType: ExperimentType;
  strategyProfileId: string;
  hypothesisId?: string;
  buildId?: string;
  bundleHash?: string;
  objective?: string;
  datasetScope: DatasetScope;
  holdoutPolicy: HoldoutPolicy;
  holdoutBoundary?: HoldoutBoundary;
  status: ExperimentStatus;
  verdict?: ExperimentVerdict;
  verdictReason?: string;
  aggregateMetrics?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExperimentRunMember {
  id: string;
  experimentId: string;
  backtestRunId?: string;
  role: MemberRole;
  foldId?: number;
  periodFrom: string;
  periodTo: string;
  symbols: string[];
  paramsHash: string;
  bundleHash: string;
  tradeCount?: number;
  resultSummary?: MemberResultSummary;
  createdAt: string;
}

export interface ExperimentEvaluation {
  id: string;
  experimentId: string;
  evaluatorVersion: string;
  rawScores: Record<string, unknown>;
  flags: ExperimentFlags;
  verdict: ExperimentVerdict;
  verdictReason?: string;
  createdAt: string;
}
```

- [ ] **Step 2: Write a guard test** (`src/domain/research-experiment.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_HOLDOUT_POLICY } from './research-experiment.ts';

describe('DEFAULT_HOLDOUT_POLICY', () => {
  it('uses the spec defaults', () => {
    expect(DEFAULT_HOLDOUT_POLICY).toEqual({
      mode: 'trade_based',
      minTradesTrain: 50,
      minTradesHoldout: 30,
      lowConfidenceThreshold: 15,
      minHistoryDays: 30,
    });
  });
});
```

- [ ] **Step 3: Run** — `pnpm test src/domain/research-experiment.test.ts` → PASS. `pnpm typecheck` → clean.
- [ ] **Step 4: Commit** — `git add src/domain/research-experiment.ts src/domain/research-experiment.test.ts && git commit -m "feat(research): experiment domain types + default holdout policy"`

---

## Task 2: Schema tables + migration 0013

**Files:**
- Modify: `src/db/schema.ts` (append three `pgTable` defs)
- Generated: `migrations/0013_*.sql` + `migrations/meta/*`

**Interfaces:**
- Produces: `researchExperiment`, `experimentRunMember`, `experimentEvaluation` tables; row types via `$inferSelect`.

- [ ] **Step 1: Append tables to `src/db/schema.ts`.** Ensure the import line includes `boolean` and `integer` (it already imports `pgTable, text, jsonb, timestamp, index, uniqueIndex, integer, boolean`). Add at the end:

```ts
export const researchExperiment = pgTable('research_experiment', {
  id: text('id').primaryKey(),
  experimentKey: text('experiment_key').notNull(),
  experimentType: text('experiment_type').notNull().$type<import('../domain/research-experiment.ts').ExperimentType>(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  hypothesisId: text('hypothesis_id'),
  buildId: text('build_id'),
  bundleHash: text('bundle_hash'),
  objective: text('objective'),
  datasetScope: jsonb('dataset_scope').notNull().$type<import('../domain/research-experiment.ts').DatasetScope>(),
  holdoutPolicy: jsonb('holdout_policy').notNull().$type<import('../domain/research-experiment.ts').HoldoutPolicy>(),
  holdoutBoundary: jsonb('holdout_boundary').$type<import('../domain/research-experiment.ts').HoldoutBoundary>(),
  parameterGrid: jsonb('parameter_grid'),
  status: text('status').notNull().$type<import('../domain/research-experiment.ts').ExperimentStatus>(),
  verdict: text('verdict').$type<import('../domain/research-experiment.ts').ExperimentVerdict>(),
  verdictReason: text('verdict_reason'),
  aggregateMetrics: jsonb('aggregate_metrics'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  keyUq: uniqueIndex('research_experiment_key_uq').on(t.experimentKey),
  profileIdx: index('research_experiment_profile_idx').on(t.strategyProfileId),
  statusIdx: index('research_experiment_status_idx').on(t.status),
}));

export const experimentRunMember = pgTable('experiment_run_member', {
  id: text('id').primaryKey(),
  experimentId: text('experiment_id').notNull(),
  backtestRunId: text('backtest_run_id'),
  role: text('role').notNull().$type<import('../domain/research-experiment.ts').MemberRole>(),
  foldId: integer('fold_id'),
  periodFrom: timestamp('period_from', { withTimezone: true }).notNull(),
  periodTo: timestamp('period_to', { withTimezone: true }).notNull(),
  symbols: jsonb('symbols').notNull().$type<string[]>(),
  paramsHash: text('params_hash').notNull(),
  bundleHash: text('bundle_hash').notNull(),
  params: jsonb('params'),
  oos: boolean('oos'),
  tradeCount: integer('trade_count'),
  resultSummary: jsonb('result_summary').$type<import('../domain/research-experiment.ts').MemberResultSummary>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  experimentIdx: index('experiment_run_member_experiment_idx').on(t.experimentId),
}));

export const experimentEvaluation = pgTable('experiment_evaluation', {
  id: text('id').primaryKey(),
  experimentId: text('experiment_id').notNull(),
  evaluatorVersion: text('evaluator_version').notNull(),
  rawScores: jsonb('raw_scores').notNull(),
  flags: jsonb('flags').notNull().$type<import('../domain/research-experiment.ts').ExperimentFlags>(),
  verdict: text('verdict').notNull().$type<import('../domain/research-experiment.ts').ExperimentVerdict>(),
  verdictReason: text('verdict_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  experimentIdx: index('experiment_evaluation_experiment_idx').on(t.experimentId),
}));
```

> If inline `import('...')` type syntax conflicts with the file's existing style, add named `import type { ... } from '../domain/research-experiment.ts'` at the top instead and use the bare names.

- [ ] **Step 2: Generate the migration** — `pnpm db:generate`. Expected: a new `migrations/0013_*.sql` containing three `CREATE TABLE IF NOT EXISTS` + the indexes, and updated `migrations/meta/_journal.json` (idx 13). Do not hand-edit meta.
- [ ] **Step 3: Verify** — `pnpm typecheck` clean; open `migrations/0013_*.sql` and confirm the three tables + `research_experiment_key_uq` unique index are present.
- [ ] **Step 4: Commit** — `git add src/db/schema.ts migrations/ && git commit -m "feat(research): experiment registry tables + migration 0013"`

---

## Task 3: Write repository (port + drizzle + in-memory)

**Files:**
- Create: `src/ports/research-experiment.repository.ts`
- Create: `src/adapters/repository/drizzle-research-experiment.repository.ts`
- Create: `src/adapters/repository/in-memory-research-experiment.repository.ts`
- Test: `src/adapters/repository/in-memory-research-experiment.repository.test.ts`

**Interfaces:**
- Consumes: domain types from Task 1; `researchExperiment`/`experimentRunMember`/`experimentEvaluation` tables from Task 2; `Db` from `src/db/client.ts`.
- Produces: `ResearchExperimentRepository` with:
  - `createExperiment(e: ResearchExperiment): Promise<void>`
  - `findById(id: string): Promise<ResearchExperiment | null>`
  - `findByKey(experimentKey: string): Promise<ResearchExperiment | null>`
  - `updateExperiment(id, patch: Partial<Pick<ResearchExperiment,'status'|'verdict'|'verdictReason'|'holdoutBoundary'|'aggregateMetrics'|'completedAt'|'updatedAt'>>): Promise<void>`
  - `addMember(m: ExperimentRunMember): Promise<void>`
  - `updateMember(id, patch: Partial<Pick<ExperimentRunMember,'backtestRunId'|'tradeCount'|'resultSummary'>>): Promise<void>`
  - `listMembers(experimentId: string): Promise<ExperimentRunMember[]>`
  - `addEvaluation(ev: ExperimentEvaluation): Promise<void>`

- [ ] **Step 1: Port** (`src/ports/research-experiment.repository.ts`)

```ts
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation,
} from '../domain/research-experiment.ts';

export interface ResearchExperimentRepository {
  createExperiment(e: ResearchExperiment): Promise<void>;
  findById(id: string): Promise<ResearchExperiment | null>;
  findByKey(experimentKey: string): Promise<ResearchExperiment | null>;
  updateExperiment(id: string, patch: Partial<Pick<ResearchExperiment,
    'status' | 'verdict' | 'verdictReason' | 'holdoutBoundary' | 'aggregateMetrics' | 'completedAt' | 'updatedAt'>>): Promise<void>;
  addMember(m: ExperimentRunMember): Promise<void>;
  updateMember(id: string, patch: Partial<Pick<ExperimentRunMember,
    'backtestRunId' | 'tradeCount' | 'resultSummary'>>): Promise<void>;
  listMembers(experimentId: string): Promise<ExperimentRunMember[]>;
  addEvaluation(ev: ExperimentEvaluation): Promise<void>;
}
```

- [ ] **Step 2: In-memory adapter** (`src/adapters/repository/in-memory-research-experiment.repository.ts`)

```ts
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation,
} from '../../domain/research-experiment.ts';
import type { ResearchExperimentRepository } from '../../ports/research-experiment.repository.ts';

export class InMemoryResearchExperimentRepository implements ResearchExperimentRepository {
  private readonly experiments = new Map<string, ResearchExperiment>();
  private readonly members = new Map<string, ExperimentRunMember>();
  private readonly evaluations: ExperimentEvaluation[] = [];

  async createExperiment(e: ResearchExperiment): Promise<void> { this.experiments.set(e.id, { ...e }); }
  async findById(id: string): Promise<ResearchExperiment | null> { return this.experiments.get(id) ?? null; }
  async findByKey(key: string): Promise<ResearchExperiment | null> {
    for (const e of this.experiments.values()) if (e.experimentKey === key) return e;
    return null;
  }
  async updateExperiment(id: string, patch: Partial<ResearchExperiment>): Promise<void> {
    const cur = this.experiments.get(id);
    if (cur) this.experiments.set(id, { ...cur, ...patch });
  }
  async addMember(m: ExperimentRunMember): Promise<void> { this.members.set(m.id, { ...m }); }
  async updateMember(id: string, patch: Partial<ExperimentRunMember>): Promise<void> {
    const cur = this.members.get(id);
    if (cur) this.members.set(id, { ...cur, ...patch });
  }
  async listMembers(experimentId: string): Promise<ExperimentRunMember[]> {
    return [...this.members.values()]
      .filter((m) => m.experimentId === experimentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addEvaluation(ev: ExperimentEvaluation): Promise<void> { this.evaluations.push({ ...ev }); }
}
```

- [ ] **Step 3: Failing test** (`src/adapters/repository/in-memory-research-experiment.repository.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryResearchExperimentRepository } from './in-memory-research-experiment.repository.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment, type ExperimentRunMember } from '../../domain/research-experiment.ts';

function experiment(over: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id: 'exp1', experimentKey: 'k1', experimentType: 'new_strategy_validation',
    strategyProfileId: 'p1', datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}
function member(over: Partial<ExperimentRunMember> = {}): ExperimentRunMember {
  return {
    id: 'm1', experimentId: 'exp1', role: 'sanity', periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2026-02-01T00:00:00.000Z', symbols: ['BTC'], paramsHash: 'ph', bundleHash: 'bh',
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

describe('InMemoryResearchExperimentRepository', () => {
  it('finds by id and key', async () => {
    const r = new InMemoryResearchExperimentRepository();
    await r.createExperiment(experiment());
    expect((await r.findById('exp1'))?.experimentKey).toBe('k1');
    expect((await r.findByKey('k1'))?.id).toBe('exp1');
    expect(await r.findByKey('nope')).toBeNull();
  });
  it('patches experiment and members, lists members in order', async () => {
    const r = new InMemoryResearchExperimentRepository();
    await r.createExperiment(experiment());
    await r.addMember(member({ id: 'm1', createdAt: '2026-01-01T00:00:01.000Z' }));
    await r.addMember(member({ id: 'm2', role: 'train', createdAt: '2026-01-01T00:00:02.000Z' }));
    await r.updateMember('m1', { backtestRunId: 'run1', tradeCount: 80 });
    await r.updateExperiment('exp1', { status: 'completed', verdict: 'PAPER_CANDIDATE' });
    const members = await r.listMembers('exp1');
    expect(members.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(members[0]?.tradeCount).toBe(80);
    expect((await r.findById('exp1'))?.verdict).toBe('PAPER_CANDIDATE');
  });
});
```

- [ ] **Step 4: Run** — `pnpm test src/adapters/repository/in-memory-research-experiment.repository.test.ts` → PASS.
- [ ] **Step 5: Drizzle adapter** (`src/adapters/repository/drizzle-research-experiment.repository.ts`). Mirror the conventions from `drizzle-research-task.repository.ts` (module-level `toDomain`, `constructor(db: Db){ this.db = db }`, Date↔ISO, null↔undefined).

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchExperiment, experimentRunMember, experimentEvaluation } from '../../db/schema.ts';
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation,
} from '../../domain/research-experiment.ts';
import type { ResearchExperimentRepository } from '../../ports/research-experiment.repository.ts';

export type ExpRow = typeof researchExperiment.$inferSelect;
export type MemRow = typeof experimentRunMember.$inferSelect;

// Exported so the read adapter (Task 4) reuses the SAME mappers — single source of truth.
export function expToDomain(r: ExpRow): ResearchExperiment {
  return {
    id: r.id, experimentKey: r.experimentKey, experimentType: r.experimentType,
    strategyProfileId: r.strategyProfileId,
    hypothesisId: r.hypothesisId ?? undefined, buildId: r.buildId ?? undefined,
    bundleHash: r.bundleHash ?? undefined, objective: r.objective ?? undefined,
    datasetScope: r.datasetScope, holdoutPolicy: r.holdoutPolicy,
    holdoutBoundary: r.holdoutBoundary ?? undefined,
    status: r.status, verdict: r.verdict ?? undefined, verdictReason: r.verdictReason ?? undefined,
    aggregateMetrics: (r.aggregateMetrics as Record<string, unknown> | null) ?? undefined,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : undefined,
  };
}
export function memToDomain(r: MemRow): ExperimentRunMember {
  return {
    id: r.id, experimentId: r.experimentId, backtestRunId: r.backtestRunId ?? undefined,
    role: r.role, foldId: r.foldId ?? undefined,
    periodFrom: r.periodFrom.toISOString(), periodTo: r.periodTo.toISOString(),
    symbols: r.symbols, paramsHash: r.paramsHash, bundleHash: r.bundleHash,
    tradeCount: r.tradeCount ?? undefined, resultSummary: r.resultSummary ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

export class DrizzleResearchExperimentRepository implements ResearchExperimentRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createExperiment(e: ResearchExperiment): Promise<void> {
    await this.db.insert(researchExperiment).values({
      id: e.id, experimentKey: e.experimentKey, experimentType: e.experimentType,
      strategyProfileId: e.strategyProfileId, hypothesisId: e.hypothesisId ?? null,
      buildId: e.buildId ?? null, bundleHash: e.bundleHash ?? null, objective: e.objective ?? null,
      datasetScope: e.datasetScope, holdoutPolicy: e.holdoutPolicy,
      holdoutBoundary: e.holdoutBoundary ?? null, status: e.status,
      verdict: e.verdict ?? null, verdictReason: e.verdictReason ?? null,
      aggregateMetrics: e.aggregateMetrics ?? null,
      createdAt: new Date(e.createdAt), updatedAt: new Date(e.updatedAt),
      completedAt: e.completedAt ? new Date(e.completedAt) : null,
    });
  }
  async findById(id: string): Promise<ResearchExperiment | null> {
    const rows = await this.db.select().from(researchExperiment).where(eq(researchExperiment.id, id)).limit(1);
    return rows[0] ? expToDomain(rows[0]) : null;
  }
  async findByKey(key: string): Promise<ResearchExperiment | null> {
    const rows = await this.db.select().from(researchExperiment).where(eq(researchExperiment.experimentKey, key)).limit(1);
    return rows[0] ? expToDomain(rows[0]) : null;
  }
  async updateExperiment(id: string, patch: Partial<ResearchExperiment>): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date(patch.updatedAt ?? new Date().toISOString()) };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.verdict !== undefined) set.verdict = patch.verdict;
    if (patch.verdictReason !== undefined) set.verdictReason = patch.verdictReason;
    if (patch.holdoutBoundary !== undefined) set.holdoutBoundary = patch.holdoutBoundary;
    if (patch.aggregateMetrics !== undefined) set.aggregateMetrics = patch.aggregateMetrics;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;
    await this.db.update(researchExperiment).set(set).where(eq(researchExperiment.id, id));
  }
  async addMember(m: ExperimentRunMember): Promise<void> {
    await this.db.insert(experimentRunMember).values({
      id: m.id, experimentId: m.experimentId, backtestRunId: m.backtestRunId ?? null,
      role: m.role, foldId: m.foldId ?? null,
      periodFrom: new Date(m.periodFrom), periodTo: new Date(m.periodTo),
      symbols: m.symbols, paramsHash: m.paramsHash, bundleHash: m.bundleHash,
      tradeCount: m.tradeCount ?? null, resultSummary: m.resultSummary ?? null,
      createdAt: new Date(m.createdAt),
    });
  }
  async updateMember(id: string, patch: Partial<ExperimentRunMember>): Promise<void> {
    const set: Record<string, unknown> = {};
    if (patch.backtestRunId !== undefined) set.backtestRunId = patch.backtestRunId;
    if (patch.tradeCount !== undefined) set.tradeCount = patch.tradeCount;
    if (patch.resultSummary !== undefined) set.resultSummary = patch.resultSummary;
    await this.db.update(experimentRunMember).set(set).where(eq(experimentRunMember.id, id));
  }
  async listMembers(experimentId: string): Promise<ExperimentRunMember[]> {
    const rows = await this.db.select().from(experimentRunMember).where(eq(experimentRunMember.experimentId, experimentId));
    return rows.map(memToDomain).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addEvaluation(ev: ExperimentEvaluation): Promise<void> {
    await this.db.insert(experimentEvaluation).values({
      id: ev.id, experimentId: ev.experimentId, evaluatorVersion: ev.evaluatorVersion,
      rawScores: ev.rawScores, flags: ev.flags, verdict: ev.verdict,
      verdictReason: ev.verdictReason ?? null, createdAt: new Date(ev.createdAt),
    });
  }
}
```

- [ ] **Step 6: Run** — `pnpm typecheck` clean; `pnpm test src/adapters/repository/in-memory-research-experiment.repository.test.ts` → PASS.
- [ ] **Step 7: Commit** — `git add src/ports/research-experiment.repository.ts src/adapters/repository/*research-experiment* && git commit -m "feat(research): experiment repository (port + drizzle + in-memory)"`

---

## Task 4: Read port + read adapters

**Files:**
- Create: `src/ports/experiment-read.port.ts`
- Create: `src/adapters/read/drizzle-experiment-read.adapter.ts`
- Create: `src/adapters/read/in-memory-experiment-read.adapter.ts`
- Test: `src/adapters/read/in-memory-experiment-read.adapter.test.ts`

**Interfaces:**
- Produces: `ExperimentReadPort`:
  - `list(q: ExperimentListQuery): Promise<ResearchExperiment[]>`
  - `getById(id: string): Promise<ResearchExperiment | null>`
  - `listRuns(experimentId: string): Promise<ExperimentRunMember[]>`
  - `ExperimentListQuery = { strategyProfileId?: string; status?: ExperimentStatus; limit: number; after?: { t: string; id: string } }`

- [ ] **Step 1: Port** (`src/ports/experiment-read.port.ts`). Mirror `src/ports/backtest-read.port.ts` cursor shape.

```ts
import type { ResearchExperiment, ExperimentRunMember, ExperimentStatus } from '../domain/research-experiment.ts';

export interface ExperimentListQuery {
  strategyProfileId?: string;
  status?: ExperimentStatus;
  limit: number;
  after?: { t: string; id: string };
}

export interface ExperimentReadPort {
  list(q: ExperimentListQuery): Promise<ResearchExperiment[]>;
  getById(id: string): Promise<ResearchExperiment | null>;
  listRuns(experimentId: string): Promise<ExperimentRunMember[]>;
}
```

- [ ] **Step 2: In-memory adapter** (`src/adapters/read/in-memory-experiment-read.adapter.ts`)

```ts
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { ExperimentListQuery, ExperimentReadPort } from '../../ports/experiment-read.port.ts';

export class InMemoryExperimentReadAdapter implements ExperimentReadPort {
  private readonly experiments: ResearchExperiment[];
  private readonly members: ExperimentRunMember[];
  constructor(seed: { experiments?: ResearchExperiment[]; members?: ExperimentRunMember[] } = {}) {
    this.experiments = seed.experiments ?? [];
    this.members = seed.members ?? [];
  }
  async list(q: ExperimentListQuery): Promise<ResearchExperiment[]> {
    let rows = [...this.experiments]
      .filter((e) => (q.strategyProfileId ? e.strategyProfileId === q.strategyProfileId : true))
      .filter((e) => (q.status ? e.status === q.status : true))
      .sort((a, b) => (b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
    if (q.after) {
      rows = rows.filter((e) =>
        e.createdAt < q.after!.t || (e.createdAt === q.after!.t && e.id < q.after!.id));
    }
    return rows.slice(0, q.limit);
  }
  async getById(id: string): Promise<ResearchExperiment | null> {
    return this.experiments.find((e) => e.id === id) ?? null;
  }
  async listRuns(experimentId: string): Promise<ExperimentRunMember[]> {
    return this.members.filter((m) => m.experimentId === experimentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
```

- [ ] **Step 3: Failing test** (`src/adapters/read/in-memory-experiment-read.adapter.test.ts`) — cover filter + cursor pagination + listRuns. (Use the same `experiment()`/`member()` factories as Task 3; inline them here.)

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryExperimentReadAdapter } from './in-memory-experiment-read.adapter.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment } from '../../domain/research-experiment.ts';

function exp(id: string, createdAt: string, over: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id, experimentKey: `key-${id}`, experimentType: 'new_strategy_validation', strategyProfileId: 'p1',
    datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, status: 'completed', createdAt, updatedAt: createdAt, ...over,
  };
}

describe('InMemoryExperimentReadAdapter', () => {
  it('lists newest-first, filters by status, paginates by cursor', async () => {
    const a = exp('a', '2026-01-01T00:00:00.000Z', { status: 'running' });
    const b = exp('b', '2026-01-02T00:00:00.000Z');
    const c = exp('c', '2026-01-03T00:00:00.000Z');
    const r = new InMemoryExperimentReadAdapter({ experiments: [a, b, c] });
    expect((await r.list({ limit: 2 })).map((e) => e.id)).toEqual(['c', 'b']);
    expect((await r.list({ limit: 10, status: 'completed' })).map((e) => e.id)).toEqual(['c', 'b']);
    expect((await r.list({ limit: 10, after: { t: b.createdAt, id: 'b' } })).map((e) => e.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 4: Run** — `pnpm test src/adapters/read/in-memory-experiment-read.adapter.test.ts` → PASS.
- [ ] **Step 5: Drizzle read adapter** (`src/adapters/read/drizzle-experiment-read.adapter.ts`). Mirror `drizzle-backtest-read.adapter.ts`. **Import the exported mappers** from Task 3: `import { expToDomain, memToDomain } from '../repository/drizzle-research-experiment.repository.ts'` (single source of truth — do not redefine them). Implement `list` with `and(...)` filters, `desc(createdAt)` + `desc(id)` ordering, cursor via `or(lt(createdAt, t), and(eq(createdAt, t), lt(id, id)))`, `.limit(q.limit)`. `getById` via `eq(id)`. `listRuns` via `eq(experimentId)` ordered by `createdAt`.

> Drizzle imports needed: `and, or, eq, lt, desc` from `drizzle-orm`.

- [ ] **Step 6: Run** — `pnpm typecheck` clean.
- [ ] **Step 7: Commit** — `git add src/ports/experiment-read.port.ts src/adapters/read/*experiment* && git commit -m "feat(research): experiment read port + adapters"`

---

## Task 5: Read-API routes, DTOs, mappers, wiring into deps

**Files:**
- Create: `src/read-api/routes/experiments.ts`
- Modify: `src/read-api/dto.ts` (add `ExperimentDto`, `ExperimentRunMemberDto`, `ExperimentListQuerySchema`)
- Modify: `src/read-api/mappers.ts` (add `toExperimentDto`, `toExperimentRunMemberDto`)
- Modify: `src/read-api/deps.ts` (add `experiments: ExperimentReadPort`)
- Modify: `src/read-api/read-app.ts` (register routes + extend `V1_PATHS`)
- Test: `src/read-api/routes/experiments.test.ts`

**Interfaces:**
- Consumes: `ExperimentReadPort` (Task 4), `decodeCursor`/`encodeCursor` from `src/read-api/pagination.ts`, `readAuthMiddleware` (already applied to `/v1`).
- Produces: `GET /v1/experiments`, `GET /v1/experiments/:id`, `GET /v1/experiments/:id/runs`.

- [ ] **Step 1: DTOs + query schema** — append to `src/read-api/dto.ts`. Reuse the shared `limit` + `cursor` schema used by `BacktestListQuerySchema` (read it first to copy the exact `z` helpers).

```ts
// add imports if missing: import { z } from 'zod';
export const ExperimentListQuerySchema = z.object({
  strategyProfileId: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export interface ExperimentDto {
  id: string;
  experimentType: string;
  strategyProfileId: string;
  hypothesisId: string | null;
  buildId: string | null;
  bundleHash: string | null;
  status: string;
  verdict: string | null;
  verdictReason: string | null;
  datasetScope: unknown;
  holdoutPolicy: unknown;
  holdoutBoundary: unknown | null;
  aggregateMetrics: unknown | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ExperimentRunMemberDto {
  id: string;
  experimentId: string;
  backtestRunId: string | null;
  role: string;
  foldId: number | null;
  periodFrom: string;
  periodTo: string;
  symbols: string[];
  tradeCount: number | null;
  resultSummary: unknown | null;
  createdAt: string;
}
```

- [ ] **Step 2: Mappers** — append to `src/read-api/mappers.ts` (null-preserving):

```ts
import type { ResearchExperiment, ExperimentRunMember } from '../domain/research-experiment.ts';
import type { ExperimentDto, ExperimentRunMemberDto } from './dto.ts';

export function toExperimentDto(e: ResearchExperiment): ExperimentDto {
  return {
    id: e.id, experimentType: e.experimentType, strategyProfileId: e.strategyProfileId,
    hypothesisId: e.hypothesisId ?? null, buildId: e.buildId ?? null, bundleHash: e.bundleHash ?? null,
    status: e.status, verdict: e.verdict ?? null, verdictReason: e.verdictReason ?? null,
    datasetScope: e.datasetScope, holdoutPolicy: e.holdoutPolicy, holdoutBoundary: e.holdoutBoundary ?? null,
    aggregateMetrics: e.aggregateMetrics ?? null,
    createdAt: e.createdAt, updatedAt: e.updatedAt, completedAt: e.completedAt ?? null,
  };
}

export function toExperimentRunMemberDto(m: ExperimentRunMember): ExperimentRunMemberDto {
  return {
    id: m.id, experimentId: m.experimentId, backtestRunId: m.backtestRunId ?? null,
    role: m.role, foldId: m.foldId ?? null, periodFrom: m.periodFrom, periodTo: m.periodTo,
    symbols: m.symbols, tradeCount: m.tradeCount ?? null, resultSummary: m.resultSummary ?? null,
    createdAt: m.createdAt,
  };
}
```

- [ ] **Step 3: deps** — add to `ReadApiDeps` in `src/read-api/deps.ts`:

```ts
import type { ExperimentReadPort } from '../ports/experiment-read.port.ts';
// inside interface ReadApiDeps:
  experiments: ExperimentReadPort;
```

- [ ] **Step 4: Routes** (`src/read-api/routes/experiments.ts`). Mirror `routes/backtests.ts`.

```ts
import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { ExperimentListQuerySchema } from '../dto.ts';
import { toExperimentDto, toExperimentRunMemberDto } from '../mappers.ts';
import { decodeCursor, encodeCursor } from '../pagination.ts';

export function registerExperimentRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/experiments', async (c) => {
    const parsed = ExperimentListQuerySchema.safeParse({
      strategyProfileId: c.req.query('strategyProfileId'),
      status: c.req.query('status'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    });
    if (!parsed.success) return c.json({ error: { code: 'bad_request', message: 'invalid query' } }, 400);
    const { strategyProfileId, status, limit, cursor } = parsed.data;
    const after = cursor ? decodeCursor(cursor) : undefined;
    const items = await deps.experiments.list({ strategyProfileId, status, limit, after });
    const data = items.map(toExperimentDto);
    const last = items[items.length - 1];
    const nextCursor = items.length === limit && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null;
    return c.json({ data, page: { nextCursor, limit } });
  });

  app.get('/experiments/:id', async (c) => {
    const e = await deps.experiments.getById(c.req.param('id'));
    if (!e) return c.json({ error: { code: 'not_found', message: 'experiment not found' } }, 404);
    return c.json(toExperimentDto(e));
  });

  app.get('/experiments/:id/runs', async (c) => {
    const e = await deps.experiments.getById(c.req.param('id'));
    if (!e) return c.json({ error: { code: 'not_found', message: 'experiment not found' } }, 404);
    const runs = await deps.experiments.listRuns(c.req.param('id'));
    return c.json({ data: runs.map(toExperimentRunMemberDto) });
  });
}
```

- [ ] **Step 5: Register** in `src/read-api/read-app.ts`: import `registerExperimentRoutes`, call `registerExperimentRoutes(v1, deps)` after `registerBacktestRoutes(v1, deps)`, and add `'/experiments', '/experiments/:id', '/experiments/:id/runs'` to `V1_PATHS`.

- [ ] **Step 6: Failing test** (`src/read-api/routes/experiments.test.ts`). Copy the verbatim `deps()` factory from `src/read-api/read-app.test.ts` and add the new `experiments` default (it is now a required `ReadApiDeps` field, so it must be in the base object, not only the override). Assert: 200 list envelope, 200 detail, 404 unknown id, 200 `/runs`, 401 without bearer. The headers form for `app.request` is a flat object (`{ authorization }`), matching the existing harness.

```ts
import { describe, it, expect } from 'vitest';
import { createReadApp } from '../read-app.ts';
import type { ReadApiDeps } from '../deps.ts';
import { InMemoryHypothesisReadAdapter } from '../../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../../adapters/read/in-memory-agent-event-read.adapter.ts';
import { AgentActivityProjection } from '../projection.ts';
import { InMemoryAgentEventStream } from '../../adapters/read/in-memory-agent-event-stream.ts';
import { InMemoryExperimentReadAdapter } from '../../adapters/read/in-memory-experiment-read.adapter.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment } from '../../domain/research-experiment.ts';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function exp(id: string): ResearchExperiment {
  return {
    id, experimentKey: `k-${id}`, experimentType: 'new_strategy_validation', strategyProfileId: 'p1',
    datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY, status: 'completed', verdict: 'PAPER_CANDIDATE',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deps(over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    projection: new AgentActivityProjection(50),
    agentStream: new InMemoryAgentEventStream(),
    streamHeartbeatMs: 60_000,
    checkReadiness: async () => true,
    token: TOKEN,
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    tokenUsage: { getCost: async () => 0 },
    phoenixTraces: { getAgentTraces: async (agentId: string) => ({ agentId, reasonCode: 'tracing-disabled' as const, traces: [] }) },
    experiments: new InMemoryExperimentReadAdapter({ experiments: [exp('a')] }),
    ...over,
  };
}

describe('experiments read routes', () => {
  it('lists / details / 404 / runs / 401', async () => {
    const app = createReadApp(deps());
    expect((await app.request('/v1/experiments', { headers: AUTH })).status).toBe(200);
    const list = await (await app.request('/v1/experiments', { headers: AUTH })).json();
    expect(list).toEqual({ data: [expect.objectContaining({ id: 'a' })], page: { nextCursor: null, limit: 20 } });
    expect((await app.request('/v1/experiments/a', { headers: AUTH })).status).toBe(200);
    expect((await app.request('/v1/experiments/zzz', { headers: AUTH })).status).toBe(404);
    expect((await app.request('/v1/experiments/a/runs', { headers: AUTH })).status).toBe(200);
    expect((await app.request('/v1/experiments')).status).toBe(401);
  });
});
```

> Confirm the exact `app.request` header form against `read-app.test.ts` (some Hono harnesses pass `{ headers: {...} }`, others a flat init). Mirror whatever that file uses.

- [ ] **Step 7: Run** — `pnpm test src/read-api/routes/experiments.test.ts` → PASS; `pnpm typecheck` clean.
- [ ] **Step 8: Commit** — `git add src/read-api/ && git commit -m "feat(research): GET /v1/experiments[/:id][/runs] read API"`

---

## Task 6: Wire registry into composition (no behaviour change yet)

**Files:**
- Modify: `src/orchestrator/app-services.ts` (add `experiments: ResearchExperimentRepository`)
- Modify: `src/composition.ts` (`composeRuntime`: instantiate repo + read adapter)

**Interfaces:**
- Consumes: `DrizzleResearchExperimentRepository` (Task 3), `DrizzleExperimentReadAdapter` (Task 4).
- Produces: `services.experiments`, `read.experiments` available app-wide.

- [ ] **Step 1: AppServices field** — in `src/orchestrator/app-services.ts` add:
```ts
import type { ResearchExperimentRepository } from '../ports/research-experiment.repository.ts';
// inside interface AppServices:
  experiments: ResearchExperimentRepository;
```
- [ ] **Step 2: composeRuntime** — in `src/composition.ts`: import the drizzle repo + read adapter; in the `services` object add `experiments: new DrizzleResearchExperimentRepository(db),`; in the `read` object add `experiments: new DrizzleExperimentReadAdapter(db),`.
- [ ] **Step 3: Run** — `pnpm typecheck` clean; `pnpm test` full suite green (nothing else changed).
- [ ] **Step 4: Commit** — `git add src/orchestrator/app-services.ts src/composition.ts && git commit -m "feat(research): wire experiment registry into composition"`

**Phase 1 checkpoint:** registry persists + read API works; zero behaviour change to existing flows.

---

# Phase 2 — Holdout policy & boundary

## Task 7: `HoldoutBoundaryResolver` (pure)

**Files:**
- Create: `src/research/holdout-boundary-resolver.ts`
- Test: `src/research/holdout-boundary-resolver.test.ts`

**Interfaces:**
- Consumes: `TradeRecord`, `HoldoutPolicy`, `HoldoutBoundary` from `src/domain/research-experiment.ts`.
- Produces: `resolveHoldoutBoundary(trades: TradeRecord[], period: { from: string; to: string }, policy: HoldoutPolicy): HoldoutBoundary`.

- [ ] **Step 1: Failing test** (`src/research/holdout-boundary-resolver.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { resolveHoldoutBoundary } from './holdout-boundary-resolver.ts';
import { DEFAULT_HOLDOUT_POLICY, type TradeRecord } from '../domain/research-experiment.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const period = { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }; // ~90 days

// helper: n trades, one per `gapDays`, entryTs increasing from START
function trades(n: number, gapDays = 1): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    entryTs: START + i * gapDays * DAY, exitTs: START + i * gapDays * DAY + 3_600_000,
    side: 'long' as const, realizedPnl: 1,
  }));
}

describe('resolveHoldoutBoundary', () => {
  it('trade_based: 90 trades → 60 train / 30 holdout, T = 61st trade entry', () => {
    const b = resolveHoldoutBoundary(trades(90), period, DEFAULT_HOLDOUT_POLICY);
    expect(b.mode).toBe('trade_based');
    expect(b.lowConfidence).toBe(false);
    expect(b.trainTrades).toBe(60);
    expect(b.holdoutTrades).toBe(30);
    expect(b.t).toBe(new Date(START + 60 * DAY).toISOString());
  });

  it('low_confidence band: 70 trades (50 train + 20 holdout < 30 but ≥ 15) → lowConfidence', () => {
    const b = resolveHoldoutBoundary(trades(70), period, DEFAULT_HOLDOUT_POLICY);
    expect(b.mode).toBe('trade_based');
    expect(b.lowConfidence).toBe(true);
    expect(b.trainTrades).toBe(50);
    expect(b.holdoutTrades).toBe(20);
  });

  it('none/insufficient_trades: 60 trades cannot give 50 train + ≥15 holdout', () => {
    const b = resolveHoldoutBoundary(trades(60), period, DEFAULT_HOLDOUT_POLICY);
    // 60 - 15 = 45 train < 50 → cannot honour both minimums
    expect(b.mode).toBe('none');
    expect(b.reason).toBe('insufficient_trades');
  });

  it('none/insufficient_history: period under minHistoryDays', () => {
    const short = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-20T00:00:00.000Z' }; // 19 days
    const b = resolveHoldoutBoundary(trades(200), short, DEFAULT_HOLDOUT_POLICY);
    expect(b.mode).toBe('none');
    expect(b.reason).toBe('insufficient_history');
  });

  it('ties at boundary counted from chosen T (holdoutTrades may exceed minimum)', () => {
    // 59 unique-day trades + 2 extra sharing the 30-from-end entryTs
    const base = trades(90);
    const tIndex = 60; // 61st
    base[tIndex + 1] = { ...base[tIndex + 1]!, entryTs: base[tIndex]!.entryTs };
    const b = resolveHoldoutBoundary(base, period, DEFAULT_HOLDOUT_POLICY);
    const T = Date.parse(b.t!);
    const holdout = base.filter((t) => t.entryTs >= T).length;
    expect(b.holdoutTrades).toBe(holdout); // recomputed from T, not the index
    expect(holdout).toBeGreaterThanOrEqual(30);
  });

  it('n=0 → none', () => {
    expect(resolveHoldoutBoundary([], period, DEFAULT_HOLDOUT_POLICY).mode).toBe('none');
  });
});
```

- [ ] **Step 2: Run** — `pnpm test src/research/holdout-boundary-resolver.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`src/research/holdout-boundary-resolver.ts`)

```ts
import type { TradeRecord, HoldoutPolicy, HoldoutBoundary } from '../domain/research-experiment.ts';

const DAY_MS = 86_400_000;

export function resolveHoldoutBoundary(
  trades: TradeRecord[],
  period: { from: string; to: string },
  policy: HoldoutPolicy,
): HoldoutBoundary {
  const spanDays = (Date.parse(period.to) - Date.parse(period.from)) / DAY_MS;
  if (spanDays < policy.minHistoryDays) {
    return { mode: 'none', lowConfidence: false, reason: 'insufficient_history' };
  }

  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  const n = sorted.length;

  // choose the largest holdout count h such that train (n - h) >= minTradesTrain,
  // preferring h >= minTradesHoldout (full confidence), else h in [lowConfidenceThreshold, minTradesHoldout).
  const pick = (h: number): HoldoutBoundary | null => {
    if (h < 1 || h > n) return null;
    const trainCount = n - h;
    if (trainCount < policy.minTradesTrain) return null;
    const tMs = sorted[n - h]!.entryTs;
    const holdoutTrades = sorted.filter((t) => t.entryTs >= tMs).length; // recount from chosen T (ties)
    const trainTrades = n - holdoutTrades;
    if (trainTrades < policy.minTradesTrain) return null;
    return {
      mode: 'trade_based',
      t: new Date(tMs).toISOString(),
      trainTrades,
      holdoutTrades,
      lowConfidence: holdoutTrades < policy.minTradesHoldout,
      reason: 'ok',
    };
  };

  const full = pick(policy.minTradesHoldout);
  if (full && !full.lowConfidence) return full;

  // largest low-confidence holdout in [lowConfidenceThreshold, minTradesHoldout)
  for (let h = policy.minTradesHoldout - 1; h >= policy.lowConfidenceThreshold; h--) {
    const lc = pick(h);
    if (lc) return lc;
  }

  return { mode: 'none', lowConfidence: false, reason: 'insufficient_trades' };
}
```

- [ ] **Step 4: Run** — `pnpm test src/research/holdout-boundary-resolver.test.ts` → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/research/holdout-boundary-resolver* && git commit -m "feat(research): trade-based holdout boundary resolver (single split)"`

---

## Task 8: `RunTradesPort` + adapters (SDK seam extension)

**Files:**
- Create: `src/ports/run-trades.port.ts`
- Modify: `src/adapters/platform/http-backtester.adapter.ts` (extend `BacktesterClientLike` seam; add a trades-fetch method/adapter)
- Create: `src/adapters/platform/mock-run-trades.adapter.ts`
- Create: `src/adapters/platform/fake-run-trades.adapter.ts` (test helper)
- Create: `src/adapters/platform/select-run-trades.ts`
- Test: `src/adapters/platform/http-backtester-run-trades.test.ts`

**Interfaces:**
- Consumes: `TradeRecord`; the backtester SDK `getArtifactManifest(runId)` + `readArtifact(runId, artifactId, {offset, limit})` (signatures from Task 0.2).
- Produces: `RunTradesPort { getRunTrades(runId: string): Promise<TradeRecord[]> }`.

- [ ] **Step 1: Port** (`src/ports/run-trades.port.ts`)

```ts
import type { TradeRecord } from '../domain/research-experiment.ts';

export interface RunTradesPort {
  /** Fetch the per-trade records for a completed backtest run (paged + parsed). */
  getRunTrades(runId: string): Promise<TradeRecord[]>;
}
```

- [ ] **Step 2: Extend the SDK seam.** In `src/adapters/platform/http-backtester.adapter.ts`, locate `interface BacktesterClientLike` and add the two methods (use the exact signatures recorded in Task 0.2):

```ts
  getArtifactManifest(runId: string): Promise<{
    descriptors: readonly { artifactType: string; contentHash: string; availability: string; approxItemCount?: number }[];
  }>;
  readArtifact(runId: string, artifactId: string, opts?: { offset?: number; limit?: number }): Promise<{
    page: readonly unknown[]; total: number; offset: number; nextCursor?: string;
  }>;
```

> The concrete `BacktesterClient` injected by `select-research-platform.ts` already implements both — this only widens the seam type. If `availability` is an object in the real type (`{ status }`), match it exactly per Task 0.2.

- [ ] **Step 3: HTTP trades adapter.** Add to the same file (or a sibling `http-backtester-run-trades.adapter.ts` that takes the same client) an adapter implementing `RunTradesPort`:

```ts
import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';

function parseTrade(row: unknown): TradeRecord {
  const r = row as Record<string, unknown>;
  if (typeof r.entryTs !== 'number' || typeof r.exitTs !== 'number') {
    throw new Error('trades artifact row missing entryTs/exitTs');
  }
  return {
    entryTs: r.entryTs, exitTs: r.exitTs,
    side: r.side === 'short' ? 'short' : 'long',
    realizedPnl: typeof r.realizedPnl === 'number' ? r.realizedPnl : 0,
  };
}

export class HttpBacktesterRunTradesAdapter implements RunTradesPort {
  private readonly client: BacktesterClientLike;
  constructor(client: BacktesterClientLike) { this.client = client; }

  async getRunTrades(runId: string): Promise<TradeRecord[]> {
    const manifest = await this.client.getArtifactManifest(runId);
    const trades = manifest.descriptors.find(
      (d) => d.artifactType === 'trades' && (d.availability === 'available' || (d.availability as { status?: string })?.status === 'available'),
    );
    if (!trades) return [];
    const out: TradeRecord[] = [];
    let offset = 0;
    const limit = 500;
    for (;;) {
      const pageRes = await this.client.readArtifact(runId, trades.contentHash, { offset, limit });
      for (const row of pageRes.page) out.push(parseTrade(row));
      const consumed = offset + pageRes.page.length;
      if (pageRes.page.length === 0 || consumed >= pageRes.total) break;
      offset = consumed;
    }
    return out;
  }
}
```

- [ ] **Step 4: Mock + fake adapters.**

`src/adapters/platform/mock-run-trades.adapter.ts`:
```ts
import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';
// Demo default: the mock backtester does not run the engine over the fixture → no trades artifact.
export class MockRunTradesAdapter implements RunTradesPort {
  async getRunTrades(): Promise<TradeRecord[]> { return []; }
}
```

`src/adapters/platform/fake-run-trades.adapter.ts`:
```ts
import type { RunTradesPort } from '../../ports/run-trades.port.ts';
import type { TradeRecord } from '../../domain/research-experiment.ts';
export class FakeRunTradesAdapter implements RunTradesPort {
  private readonly byRun: Map<string, TradeRecord[]>;
  constructor(byRun: Record<string, TradeRecord[]> = {}) { this.byRun = new Map(Object.entries(byRun)); }
  async getRunTrades(runId: string): Promise<TradeRecord[]> { return this.byRun.get(runId) ?? []; }
}
```

- [ ] **Step 5: Selector** (`src/adapters/platform/select-run-trades.ts`). Mirror `select-research-platform.ts`: when the research integration is `backtester` (http), build `new HttpBacktesterRunTradesAdapter(client)`; otherwise `new MockRunTradesAdapter()`. First read `select-research-platform.ts` to see how the `BacktesterClient` is constructed. **Do not assume a shared instance:** if the client is currently built inline inside `selectResearchPlatform`, either (a) extract a small `buildBacktesterClient(env)` factory and call it from both selectors (preferred — one client config), or (b) construct a second `BacktesterClient` here with the same config (acceptable — the client is stateless HTTP). Pick one explicitly and note it; do not write "reuse the same instance" unless you actually thread one through.

- [ ] **Step 6: Failing test** (`src/adapters/platform/http-backtester-run-trades.test.ts`) — drive `HttpBacktesterRunTradesAdapter` with a fake client that returns a 2-page manifest/artifact:

```ts
import { describe, it, expect } from 'vitest';
import { HttpBacktesterRunTradesAdapter } from './http-backtester.adapter.ts'; // or the sibling file you created

function fakeClient() {
  return {
    getArtifactManifest: async () => ({ descriptors: [{ artifactType: 'trades', contentHash: 'h1', availability: 'available', approxItemCount: 3 }] }),
    readArtifact: async (_r: string, _a: string, opts?: { offset?: number; limit?: number }) => {
      const all = [
        { entryTs: 1, exitTs: 2, side: 'long', realizedPnl: 5 },
        { entryTs: 3, exitTs: 4, side: 'short', realizedPnl: -1 },
        { entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 2 },
      ];
      const offset = opts?.offset ?? 0; const limit = opts?.limit ?? 2;
      return { page: all.slice(offset, offset + limit), total: all.length, offset };
    },
  } as never;
}

describe('HttpBacktesterRunTradesAdapter', () => {
  it('pages and parses all trades', async () => {
    const a = new HttpBacktesterRunTradesAdapter(fakeClient());
    const trades = await a.getRunTrades('run1');
    expect(trades).toHaveLength(3);
    expect(trades[2]).toEqual({ entryTs: 5, exitTs: 6, side: 'long', realizedPnl: 2 });
  });
  it('returns [] when no trades descriptor', async () => {
    const client = { getArtifactManifest: async () => ({ descriptors: [] }), readArtifact: async () => ({ page: [], total: 0, offset: 0 }) } as never;
    expect(await new HttpBacktesterRunTradesAdapter(client).getRunTrades('r')).toEqual([]);
  });
});
```

- [ ] **Step 7: Run** — `pnpm test src/adapters/platform/http-backtester-run-trades.test.ts` → PASS; `pnpm typecheck` clean.
- [ ] **Step 8: Wire** — add `runTrades: RunTradesPort` to `AppServices` (`src/orchestrator/app-services.ts`) and instantiate via `selectRunTrades(...)` in `composeRuntime`. `pnpm test` full suite green.
- [ ] **Step 9: Commit** — `git add src/ports/run-trades.port.ts src/adapters/platform/*run-trades* src/adapters/platform/http-backtester.adapter.ts src/orchestrator/app-services.ts src/composition.ts && git commit -m "feat(research): RunTradesPort + backtester artifact trades fetch"`

---

## Task 9: `encodeTrainPeriod` (no-leakage boundary encoding)

**Files:**
- Create: `src/research/period-encoding.ts`
- Test: `src/research/period-encoding.test.ts`

**Interfaces:**
- Produces: `encodeTrainPeriod(from: string, t: string, timeframe: string): { from: string; to: string }` and `encodeHoldoutPeriod(t: string, to: string): { from: string; to: string }`.

> Use the Task 0.1 finding. If `period.to` is **exclusive**, `encodeTrainPeriod` returns `{ from, to: t }`. If **inclusive**, it returns `{ from, to: <t minus one timeframe unit, ISO> }`. The test below assumes **exclusive** (the common case); if Task 0.1 found inclusive, change the expected `to` to `t - timeframeMs` and update the implementation's default branch.

- [ ] **Step 1: Failing test** (`src/research/period-encoding.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { encodeTrainPeriod, encodeHoldoutPeriod } from './period-encoding.ts';

describe('period encoding (half-open [from,T) / [T,to])', () => {
  const from = '2026-01-01T00:00:00.000Z';
  const t = '2026-02-01T00:00:00.000Z';
  const to = '2026-03-01T00:00:00.000Z';
  it('holdout starts exactly at T', () => {
    expect(encodeHoldoutPeriod(t, to)).toEqual({ from: t, to });
  });
  it('train ends at T (exclusive-to convention)', () => {
    expect(encodeTrainPeriod(from, t, '1m')).toEqual({ from, to: t });
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`src/research/period-encoding.ts`)

```ts
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

// Set to true ONLY if Task 0.1 found the backtester treats period.to as inclusive.
const PERIOD_TO_INCLUSIVE = false;

export function encodeTrainPeriod(from: string, t: string, timeframe: string): { from: string; to: string } {
  if (!PERIOD_TO_INCLUSIVE) return { from, to: t };
  const step = TIMEFRAME_MS[timeframe] ?? 60_000;
  return { from, to: new Date(Date.parse(t) - step).toISOString() };
}

export function encodeHoldoutPeriod(t: string, to: string): { from: string; to: string } {
  return { from: t, to };
}
```

- [ ] **Step 4: Run** → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/research/period-encoding* && git commit -m "feat(research): half-open train/holdout period encoding"`

**Phase 2 checkpoint:** boundary resolution + trade fetch + period encoding all unit-tested and pure.

---

# Phase 3 — Train/Holdout flow

## Task 10: Composite `evaluateExperiment`

**Files:**
- Create: `src/validation/experiment-evaluator.ts`
- Test: `src/validation/experiment-evaluator.test.ts`

**Interfaces:**
- Consumes: the typed `ComparisonSummary` from `src/ports/platform-gateway.port.ts` (read it for the exact `BacktestMetricBlock` fields: `netPnlUsd, totalTrades, winRate, profitFactor, maxDrawdownPct, sharpe, topTradeContributionPct`, plus `deltas`); `evaluateBacktest` + `DEFAULT_EVALUATOR_THRESHOLDS` + `EvaluationDecision` from `src/validation/evaluator.ts`; `HoldoutBoundary`, `ExperimentFlags`, `ExperimentVerdict` from the domain.
- Produces: `evaluateExperiment(input): ExperimentEvaluationResult`:
  - `input = { train: ComparisonSummary; holdout?: ComparisonSummary; boundary: HoldoutBoundary; thresholds?: EvaluatorThresholds }`
  - returns `{ verdict: ExperimentVerdict; verdictReason?: string; flags: ExperimentFlags; rawScores: Record<string, unknown> }`
  - `EXPERIMENT_EVALUATOR_VERSION = 'exp-eval.1'`

Decision rules (from spec §6.1):
- `boundary.mode === 'none'` → `INCONCLUSIVE` (reason from boundary). (The flow usually short-circuits earlier, but handle defensively.)
- train decision (`evaluateBacktest(train)`) is `FAIL` or `MODIFY` → that verdict, reason `train_<reason>`; no holdout consulted.
- holdout missing → `INCONCLUSIVE` reason `holdout_not_run`.
- `boundary.lowConfidence === true` → `INCONCLUSIVE`, `flags.lowConfidenceHoldout = true` (never PAPER_CANDIDATE), regardless of holdout pass.
- holdout decision `FAIL`/`MODIFY` → `FAIL`, reason `holdout_failed`, `flags.overfit = true`.
- holdout decision PASS-class (`PASS` or `PAPER_CANDIDATE`) and not lowConfidence → `PAPER_CANDIDATE`.

- [ ] **Step 1a: Shared test fixture** (`src/validation/__fixtures__/comparison-summary.ts`). Concrete builder matching the verbatim `ComparisonSummary`/`BacktestMetricBlock` from `platform-gateway.port.ts` (there is **no `deltas` field** — the evaluator computes deltas inline from `variant - baseline`). Tuned to the real `DEFAULT_EVALUATOR_THRESHOLDS` ladder.

```ts
import type { ComparisonSummary, BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';

function block(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return {
    netPnlUsd: 0, netPnlPct: 0, totalTrades: 40, winRate: 0.5, profitFactor: 1.6,
    maxDrawdownPct: 5, expectancyUsd: 1, sharpe: 1, topTradeContributionPct: 10, ...over,
  };
}

// kind → evaluateBacktest decision (DEFAULT_EVALUATOR_THRESHOLDS):
//  'strong'    → PAPER_CANDIDATE (delta 200 ≥ 100, pf 1.6 ≥ 1.5, winRate 0.6 ≥ baseline 0.5)
//  'pass'      → PASS            (delta 30 > 0 but not strong)
//  'fail'      → FAIL            (delta -50 ≤ 0)
//  'lowsample' → INCONCLUSIVE    (variant.totalTrades 5 < 20)
export function comparisonSummary(kind: 'strong' | 'pass' | 'fail' | 'lowsample'): ComparisonSummary {
  const baseline = block();
  const variant =
    kind === 'strong' ? block({ netPnlUsd: 200, winRate: 0.6 })
    : kind === 'pass' ? block({ netPnlUsd: 30 })
    : kind === 'fail' ? block({ netPnlUsd: -50 })
    : block({ netPnlUsd: 200, totalTrades: 5 });
  return {
    baseline, variant,
    sampleSize: { baselineTrades: baseline.totalTrades, variantTrades: variant.totalTrades },
    platformContractVersion: 'test.1',
  };
}
```

- [ ] **Step 1: Failing test** (`src/validation/experiment-evaluator.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { evaluateExperiment } from './experiment-evaluator.ts';
import { comparisonSummary } from './__fixtures__/comparison-summary.ts';
import type { HoldoutBoundary } from '../domain/research-experiment.ts';

const fullBoundary: HoldoutBoundary = { mode: 'trade_based', t: '2026-02-01T00:00:00.000Z', trainTrades: 60, holdoutTrades: 30, lowConfidence: false, reason: 'ok' };
const lowConf: HoldoutBoundary = { ...fullBoundary, holdoutTrades: 20, lowConfidence: true };

describe('evaluateExperiment', () => {
  it('train pass + holdout fail → FAIL holdout_failed + overfit', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), holdout: comparisonSummary('fail'), boundary: fullBoundary });
    expect(r.verdict).toBe('FAIL');
    expect(r.verdictReason).toBe('holdout_failed');
    expect(r.flags.overfit).toBe(true);
  });
  it('train pass + holdout strong → PAPER_CANDIDATE', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), holdout: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('PAPER_CANDIDATE');
  });
  it('lowConfidence holdout → INCONCLUSIVE + flag even if holdout passes', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), holdout: comparisonSummary('strong'), boundary: lowConf });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.flags.lowConfidenceHoldout).toBe(true);
  });
  it('train fail → short-circuit FAIL, reason train_*', () => {
    const r = evaluateExperiment({ train: comparisonSummary('fail'), holdout: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('FAIL');
    expect(r.verdictReason?.startsWith('train_')).toBe(true);
  });
  it('train low sample → INCONCLUSIVE train_*', () => {
    const r = evaluateExperiment({ train: comparisonSummary('lowsample'), holdout: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.verdictReason?.startsWith('train_')).toBe(true);
  });
  it('holdout missing → INCONCLUSIVE', () => {
    const r = evaluateExperiment({ train: comparisonSummary('strong'), boundary: fullBoundary });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.verdictReason).toBe('holdout_not_run');
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`src/validation/experiment-evaluator.ts`). Reuse `evaluateBacktest` per summary; do NOT modify it.

```ts
import { evaluateBacktest, DEFAULT_EVALUATOR_THRESHOLDS, type EvaluatorThresholds } from './evaluator.ts';
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { HoldoutBoundary, ExperimentFlags, ExperimentVerdict } from '../domain/research-experiment.ts';

export const EXPERIMENT_EVALUATOR_VERSION = 'exp-eval.1';

export interface ExperimentEvaluationInput {
  train: ComparisonSummary;
  holdout?: ComparisonSummary;
  boundary: HoldoutBoundary;
  thresholds?: EvaluatorThresholds;
}
export interface ExperimentEvaluationResult {
  verdict: ExperimentVerdict;
  verdictReason?: string;
  flags: ExperimentFlags;
  rawScores: Record<string, unknown>;
}

export function evaluateExperiment(input: ExperimentEvaluationInput): ExperimentEvaluationResult {
  const thresholds = input.thresholds ?? DEFAULT_EVALUATOR_THRESHOLDS;
  const flags: ExperimentFlags = { lowConfidenceHoldout: false, overfit: false, fragility: [], coverageWarnings: [] };

  if (input.boundary.mode === 'none') {
    return { verdict: 'INCONCLUSIVE', verdictReason: input.boundary.reason ?? 'insufficient', flags, rawScores: {} };
  }

  const train = evaluateBacktest(input.train, thresholds);
  const rawScores: Record<string, unknown> = { train: train.decision, trainReasons: train.reasons };

  // Only a PASS-class train proceeds to holdout. FAIL/MODIFY/INCONCLUSIVE short-circuit with a train_* reason.
  const trainPassClass = train.decision === 'PASS' || train.decision === 'PAPER_CANDIDATE';
  if (!trainPassClass) {
    const verdict: ExperimentVerdict = train.decision === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : train.decision;
    return { verdict, verdictReason: `train_${train.reasons[0] ?? 'failed'}`, flags, rawScores };
  }
  if (!input.holdout) {
    return { verdict: 'INCONCLUSIVE', verdictReason: 'holdout_not_run', flags, rawScores };
  }

  const holdout = evaluateBacktest(input.holdout, thresholds);
  rawScores.holdout = holdout.decision;
  rawScores.holdoutReasons = holdout.reasons;

  if (input.boundary.lowConfidence) {
    flags.lowConfidenceHoldout = true;
    return { verdict: 'INCONCLUSIVE', verdictReason: 'low_confidence_holdout', flags, rawScores };
  }
  if (holdout.decision === 'FAIL' || holdout.decision === 'MODIFY') {
    flags.overfit = true;
    return { verdict: 'FAIL', verdictReason: 'holdout_failed', flags, rawScores };
  }
  return { verdict: 'PAPER_CANDIDATE', verdictReason: 'holdout_passed', flags, rawScores };
}
```

> Confirmed exports from `evaluator.ts`: `evaluateBacktest(summary, t): EvaluationOutcome` where `EvaluationOutcome = { decision: EvaluationDecision; reasons: string[] }`; `EvaluatorThresholds` and `DEFAULT_EVALUATOR_THRESHOLDS` are exported. No adjustment needed.

- [ ] **Step 4: Run** → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/validation/experiment-evaluator* && git commit -m "feat(research): composite experiment evaluator (train+holdout verdict)"`

---

## Task 11: `experiment_key` + ids helper

**Files:**
- Create: `src/research/experiment-identity.ts`
- Test: `src/research/experiment-identity.test.ts`

**Interfaces:**
- Produces: `computeExperimentKey(input: { strategyProfileId; buildId?; bundleHash?; datasetScope; holdoutPolicy }): string` — `sha256({ v:1, strategyProfileId, buildId, bundleHash, datasetScopeHash, holdoutPolicyHash })`. Reuse the project's canonical-JSON + sha256 helper (find it — the same one `computeParamsHash`/`resumeToken` use, likely in `src/research/run-backtest.ts` or a `src/util/hash.ts`; read `backtest-support.ts`'s `computeParamsHash` for the canonical hash util).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeExperimentKey } from './experiment-identity.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../domain/research-experiment.ts';

const base = {
  strategyProfileId: 'p1', buildId: 'b1', bundleHash: 'h1',
  datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' } },
  holdoutPolicy: DEFAULT_HOLDOUT_POLICY,
};

describe('computeExperimentKey', () => {
  it('is deterministic for identical input', () => {
    expect(computeExperimentKey(base)).toBe(computeExperimentKey({ ...base }));
  });
  it('differs when scope or policy differs', () => {
    const otherScope = { ...base, datasetScope: { ...base.datasetScope, period: { from: 'a', to: 'c' } } };
    const otherPolicy = { ...base, holdoutPolicy: { ...DEFAULT_HOLDOUT_POLICY, minTradesHoldout: 40 } };
    expect(computeExperimentKey(otherScope)).not.toBe(computeExperimentKey(base));
    expect(computeExperimentKey(otherPolicy)).not.toBe(computeExperimentKey(base));
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (`src/research/experiment-identity.ts`). **Must use canonical (key-sorted) JSON** — plain `JSON.stringify` is key-order-sensitive and would make the key non-deterministic across object construction order. First check whether `computeParamsHash` (in `backtest-support.ts`) uses a project canonical serializer (e.g. a `canonicalJson`/`stableStringify` util); if so, import and reuse it. Otherwise include this local stable stringify:

```ts
import { createHash } from 'node:crypto';
import type { DatasetScope, HoldoutPolicy } from '../domain/research-experiment.ts';

// Deterministic, key-sorted JSON so the hash is independent of property insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function computeExperimentKey(input: {
  strategyProfileId: string; buildId?: string; bundleHash?: string;
  datasetScope: DatasetScope; holdoutPolicy: HoldoutPolicy;
}): string {
  return sha256Canonical({
    v: 1,
    strategyProfileId: input.strategyProfileId,
    buildId: input.buildId ?? null,
    bundleHash: input.bundleHash ?? null,
    datasetScopeHash: sha256Canonical(input.datasetScope),
    holdoutPolicyHash: sha256Canonical(input.holdoutPolicy),
  });
}
```

Add a third test asserting key-order independence: `computeExperimentKey({ ...base })` equals the key computed when `datasetScope` is rebuilt with its properties in a different declaration order (e.g. `{ timeframe, symbols, datasetId, period }`). This guards the canonical-JSON requirement.

- [ ] **Step 4: Run** → PASS; `pnpm typecheck` clean.
- [ ] **Step 5: Commit** — `git add src/research/experiment-identity* && git commit -m "feat(research): deterministic experiment_key"`

---

## Task 12: `ExperimentService` (orchestration)

**Files:**
- Create: `src/research/experiment-service.ts`
- Test: `src/research/experiment-service.test.ts`

**Interfaces:**
- Consumes: `ResearchExperimentRepository`, `RunTradesPort`, `resolveHoldoutBoundary`, `evaluateExperiment`, `computeExperimentKey`, `encodeTrainPeriod`/`encodeHoldoutPeriod`, and the new **`ExperimentRunExecutor`** port (production impl in Task 12b persists the `BacktestRun` rows per spec §5.0).
- Produces: the `ExperimentRunExecutor` port + request/result types (`src/research/experiment-run-executor.ts`); `ExperimentService.runNewStrategyValidation(input): Promise<{ experimentId: string; verdict: ExperimentVerdict }>`.

> **Run-execution boundary (resolves spec §5.0 + reviewer #1/#2).** `ExperimentService` never touches the platform/SDK or builds submit options. It delegates each run to an injected `ExperimentRunExecutor`, which (in production, Task 12b) builds `SubmitOverlayRunOptions`, calls `runOverlayBacktest`, **persists the `BacktestRun` via the `backtests` repository**, maps the comparison, and returns `{ status, runId (lab BacktestRun id), platformRunId, comparison?, totalTrades? }`. The executor needs the bundle + baselineRef + identity, so they ride on the request — this is why a bare `runRunner(args:{run,role})` was insufficient. In tests, a `FakeExecutor` returns canned results, isolating `ExperimentService` from the platform.
> **Trade fetch uses `platformRunId`, not the lab run id** — `RunTradesPort.getRunTrades` is run-scoped to the backtester (`getArtifactManifest(platformRunId)`). `experiment_run_member.backtestRunId` stores the **lab** `BacktestRun` id.

- [ ] **Step 1: Executor port + types** (`src/research/experiment-run-executor.ts`)

```ts
import type { Ref, PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { MemberRole } from '../domain/research-experiment.ts';

export interface ExperimentRunRequest {
  experimentId: string;
  role: MemberRole;
  bundle: ModuleBundle;
  baselineRef: Ref;
  strategyProfileId: string;
  hypothesisId?: string;
  buildId?: string;
  run: PlatformRunConfig;            // includes the already-encoded period
  params: Record<string, unknown>;
}

export interface ExperimentRunResult {
  status: 'completed' | 'pending' | 'rejected';
  runId: string;         // lab BacktestRun id (PK) — stored on the member
  platformRunId: string; // backtester run id — used for getRunTrades
  comparison?: ComparisonSummary;
  totalTrades?: number;
}

export interface ExperimentRunExecutor {
  execute(req: ExperimentRunRequest): Promise<ExperimentRunResult>;
}
```

- [ ] **Step 2: Service deps + class skeleton** (`src/research/experiment-service.ts`)

```ts
import type { Ref, PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation, ExperimentVerdict,
  MemberRole, DatasetScope, HoldoutPolicy,
} from '../domain/research-experiment.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../domain/research-experiment.ts';
import type { ResearchExperimentRepository } from '../ports/research-experiment.repository.ts';
import type { RunTradesPort } from '../ports/run-trades.port.ts';
import type { ExperimentRunExecutor, ExperimentRunResult } from './experiment-run-executor.ts';
import { resolveHoldoutBoundary } from './holdout-boundary-resolver.ts';
import { evaluateExperiment, EXPERIMENT_EVALUATOR_VERSION } from '../validation/experiment-evaluator.ts';
import { computeExperimentKey } from './experiment-identity.ts';
import { encodeTrainPeriod, encodeHoldoutPeriod } from './period-encoding.ts';

export interface ExperimentServiceDeps {
  experiments: ResearchExperimentRepository;
  runTrades: RunTradesPort;
  runExecutor: ExperimentRunExecutor;
  newId: (prefix: string) => string;
  now: () => string; // ISO
}

export interface RunNewStrategyValidationInput {
  strategyProfileId: string;
  hypothesisId?: string;
  buildId?: string;
  bundle: ModuleBundle;
  baselineRef: Ref;
  datasetScope: DatasetScope;
  holdoutPolicy?: HoldoutPolicy;
  objective?: string;
  runConfig: Omit<PlatformRunConfig, 'period'>; // datasetId, symbols, timeframe, seed
  params: Record<string, unknown>;              // request.params overlay ({} if none)
}

export class ExperimentService {
  private readonly d: ExperimentServiceDeps;
  constructor(deps: ExperimentServiceDeps) { this.d = deps; }

  async runNewStrategyValidation(input: RunNewStrategyValidationInput): Promise<{ experimentId: string; verdict: ExperimentVerdict }> {
    // implemented in Step 4
    return { experimentId: '', verdict: 'INCONCLUSIVE' };
  }
}
```

- [ ] **Step 3: Failing test** (`src/research/experiment-service.test.ts`) — full flow with fakes (`InMemoryResearchExperimentRepository`, `FakeRunTradesAdapter` keyed by **platformRunId**, a `FakeExecutor`). The `FakeExecutor` returns `platformRunId = 'plat-<role>'` so the sanity trade lookup is keyed `'plat-sanity'`.

```ts
import { describe, it, expect } from 'vitest';
import { ExperimentService } from './experiment-service.ts';
import type { ExperimentRunExecutor, ExperimentRunRequest, ExperimentRunResult } from './experiment-run-executor.ts';
import { InMemoryResearchExperimentRepository } from '../adapters/repository/in-memory-research-experiment.repository.ts';
import { FakeRunTradesAdapter } from '../adapters/platform/fake-run-trades.adapter.ts';
import { comparisonSummary } from '../validation/__fixtures__/comparison-summary.ts';
import { DEFAULT_HOLDOUT_POLICY, type MemberRole, type TradeRecord } from '../domain/research-experiment.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { Ref } from '../ports/research-platform.port.ts';

const DAY = 86_400_000; const START = Date.parse('2026-01-01T00:00:00.000Z');
function trades(n: number): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => ({ entryTs: START + i * DAY, exitTs: START + i * DAY + 3_600_000, side: 'long' as const, realizedPnl: 1 }));
}

// Minimal valid ModuleBundle / Ref — opaque pass-throughs for the orchestration test
// (the executor, faked here, is what actually consumes them). Confirm DIRECTIONS includes 'long'.
const bundle: ModuleBundle = {
  manifest: { moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['run'], capabilities: [], sdkContractVersion: '1' },
  files: {}, bundleHash: 'h1', bundleContractVersion: 'c1',
};
const baselineRef: Ref = { id: 'strategy:p1', version: 1 };

class FakeExecutor implements ExperimentRunExecutor {
  public readonly calls: ExperimentRunRequest[] = [];
  private readonly resultFor: (role: MemberRole) => ExperimentRunResult;
  constructor(resultFor: (role: MemberRole) => ExperimentRunResult) { this.resultFor = resultFor; }
  async execute(req: ExperimentRunRequest): Promise<ExperimentRunResult> { this.calls.push(req); return this.resultFor(req.role); }
}

function svc(resultFor: (role: MemberRole) => ExperimentRunResult, tradesByRun: Record<string, TradeRecord[]>) {
  const experiments = new InMemoryResearchExperimentRepository();
  const executor = new FakeExecutor(resultFor);
  let i = 0;
  const service = new ExperimentService({
    experiments, runTrades: new FakeRunTradesAdapter(tradesByRun), runExecutor: executor,
    newId: (p) => `${p}-${++i}`, now: () => '2026-01-01T00:00:00.000Z',
  });
  return { service, experiments, executor };
}

const input = {
  strategyProfileId: 'p1', buildId: 'b1', bundle, baselineRef,
  datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' } },
  runConfig: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', seed: 1 }, params: {},
};
const ok = (role: MemberRole, kind: 'strong' | 'fail', totalTrades: number): ExperimentRunResult =>
  ({ status: 'completed', runId: `lab-${role}`, platformRunId: `plat-${role}`, comparison: comparisonSummary(kind), totalTrades });

describe('ExperimentService.runNewStrategyValidation', () => {
  it('sanity rejected → FAIL/sanity_failed', async () => {
    const { service, experiments } = svc(() => ({ status: 'rejected', runId: 'lab-sanity', platformRunId: 'plat-sanity' }), {});
    const res = await service.runNewStrategyValidation(input);
    expect(res.verdict).toBe('FAIL');
    expect((await experiments.findById(res.experimentId))?.verdictReason).toBe('sanity_failed');
    expect((await experiments.listMembers(res.experimentId)).map((m) => m.role)).toEqual(['sanity']);
  });

  it('insufficient trades → INCONCLUSIVE, boundary none, no train/holdout', async () => {
    const { service, experiments } = svc((role) => ok(role, 'strong', 5), { 'plat-sanity': trades(5) });
    const res = await service.runNewStrategyValidation(input);
    expect(res.verdict).toBe('INCONCLUSIVE');
    expect((await experiments.findById(res.experimentId))?.holdoutBoundary?.mode).toBe('none');
    expect((await experiments.listMembers(res.experimentId)).map((m) => m.role)).toEqual(['sanity']);
  });

  it('train pass + holdout fail → FAIL/holdout_failed, not paper, member backtestRunId is the lab id', async () => {
    const { service, experiments } = svc((role) => ok(role, role === 'holdout' ? 'fail' : 'strong', role === 'holdout' ? 30 : 90), { 'plat-sanity': trades(90) });
    const res = await service.runNewStrategyValidation(input);
    expect(res.verdict).toBe('FAIL');
    const exp = await experiments.findById(res.experimentId);
    expect(exp?.verdictReason).toBe('holdout_failed');
    const members = await experiments.listMembers(res.experimentId);
    expect(members.map((m) => m.role)).toEqual(['sanity', 'train', 'holdout']);
    expect(members.find((m) => m.role === 'train')?.backtestRunId).toBe('lab-train');
  });

  it('holdout pass → PAPER_CANDIDATE', async () => {
    const { service } = svc((role) => ok(role, 'strong', 90), { 'plat-sanity': trades(90) });
    expect((await service.runNewStrategyValidation(input)).verdict).toBe('PAPER_CANDIDATE');
  });

  it('idempotent: same input → same experiment, executor not re-invoked', async () => {
    const { service, executor } = svc((role) => ok(role, 'strong', 90), { 'plat-sanity': trades(90) });
    const a = await service.runNewStrategyValidation(input);
    const before = executor.calls.length;
    const b = await service.runNewStrategyValidation(input);
    expect(b.experimentId).toBe(a.experimentId);
    expect(executor.calls.length).toBe(before);
  });
});
```

- [ ] **Step 4: Implement `runNewStrategyValidation` + `runMember`.**

```ts
  async runNewStrategyValidation(input: RunNewStrategyValidationInput): Promise<{ experimentId: string; verdict: ExperimentVerdict }> {
    const policy = input.holdoutPolicy ?? DEFAULT_HOLDOUT_POLICY;
    const experimentKey = computeExperimentKey({
      strategyProfileId: input.strategyProfileId, buildId: input.buildId,
      bundleHash: input.bundle.bundleHash, datasetScope: input.datasetScope, holdoutPolicy: policy,
    });
    const existing = await this.d.experiments.findByKey(experimentKey);
    if (existing && existing.status === 'completed') return { experimentId: existing.id, verdict: existing.verdict ?? 'INCONCLUSIVE' };

    const now = this.d.now();
    const experimentId = existing?.id ?? this.d.newId('exp');
    if (!existing) {
      const exp: ResearchExperiment = {
        id: experimentId, experimentKey, experimentType: 'new_strategy_validation',
        strategyProfileId: input.strategyProfileId, hypothesisId: input.hypothesisId,
        buildId: input.buildId, bundleHash: input.bundle.bundleHash, objective: input.objective,
        datasetScope: input.datasetScope, holdoutPolicy: policy, status: 'running',
        createdAt: now, updatedAt: now,
      };
      await this.d.experiments.createExperiment(exp);
    }

    const fullPeriod = input.datasetScope.period;
    const fail = async (verdict: ExperimentVerdict, reason: string) => {
      await this.d.experiments.updateExperiment(experimentId, { status: 'completed', verdict, verdictReason: reason, completedAt: this.d.now(), updatedAt: this.d.now() });
      return { experimentId, verdict };
    };

    // --- SANITY (gate + trade-distribution source; never the edge verdict) ---
    const sanity = await this.runMember(experimentId, 'sanity', input, { ...input.runConfig, period: fullPeriod });
    if (sanity.status !== 'completed') return fail('FAIL', 'sanity_failed');
    if ((sanity.totalTrades ?? 0) <= 0) return fail('FAIL', 'sanity_failed');

    // --- RESOLVE T (from REAL trades of the sanity run; uses platformRunId) ---
    const tradesData = await this.d.runTrades.getRunTrades(sanity.platformRunId);
    const boundary = resolveHoldoutBoundary(tradesData, fullPeriod, policy);
    await this.d.experiments.updateExperiment(experimentId, { holdoutBoundary: boundary, updatedAt: this.d.now() });
    if (boundary.mode === 'none' || !boundary.t) return fail('INCONCLUSIVE', boundary.reason ?? 'insufficient');

    // --- TRAIN [from, T) ---
    const trainPeriod = encodeTrainPeriod(fullPeriod.from, boundary.t, input.runConfig.timeframe);
    const train = await this.runMember(experimentId, 'train', input, { ...input.runConfig, period: trainPeriod });
    if (train.status !== 'completed' || !train.comparison) return fail('INCONCLUSIVE', 'train_not_run');

    // --- HOLDOUT [T, to] (period.from = T = no-leakage) ---
    const holdoutPeriod = encodeHoldoutPeriod(boundary.t, fullPeriod.to);
    const holdout = await this.runMember(experimentId, 'holdout', input, { ...input.runConfig, period: holdoutPeriod });
    const holdoutComparison = holdout.status === 'completed' ? holdout.comparison : undefined;

    // --- EVALUATE (composite; sanity excluded) ---
    const result = evaluateExperiment({ train: train.comparison, holdout: holdoutComparison, boundary });
    const evaluation: ExperimentEvaluation = {
      id: this.d.newId('expeval'), experimentId, evaluatorVersion: EXPERIMENT_EVALUATOR_VERSION,
      rawScores: result.rawScores, flags: result.flags, verdict: result.verdict,
      verdictReason: result.verdictReason, createdAt: this.d.now(),
    };
    await this.d.experiments.addEvaluation(evaluation);
    await this.d.experiments.updateExperiment(experimentId, {
      status: 'completed', verdict: result.verdict, verdictReason: result.verdictReason,
      aggregateMetrics: { trainTrades: boundary.trainTrades, holdoutTrades: boundary.holdoutTrades, flags: result.flags },
      completedAt: this.d.now(), updatedAt: this.d.now(),
    });
    return { experimentId, verdict: result.verdict };
  }

  private async runMember(experimentId: string, role: MemberRole, input: RunNewStrategyValidationInput, run: PlatformRunConfig): Promise<ExperimentRunResult> {
    // resume: skip if a member with this role already exists (avoid duplicate runs)
    const existingMember = (await this.d.experiments.listMembers(experimentId)).find((m) => m.role === role);
    const memberId = existingMember?.id ?? this.d.newId('mem');
    if (!existingMember) {
      const member: ExperimentRunMember = {
        id: memberId, experimentId, role, periodFrom: run.period.from, periodTo: run.period.to,
        symbols: [...run.symbols], paramsHash: '', bundleHash: input.bundle.bundleHash, createdAt: this.d.now(),
      };
      await this.d.experiments.addMember(member);
    }
    const outcome = await this.d.runExecutor.execute({
      experimentId, role, bundle: input.bundle, baselineRef: input.baselineRef,
      strategyProfileId: input.strategyProfileId, hypothesisId: input.hypothesisId, buildId: input.buildId,
      run, params: input.params,
    });
    await this.d.experiments.updateMember(memberId, {
      backtestRunId: outcome.runId, tradeCount: outcome.totalTrades,
      resultSummary: { totalTrades: outcome.totalTrades },
    });
    return outcome;
  }
```

> `member.paramsHash` is left `''` (the executor computes/persists the real run identity on the `BacktestRun`). If a member-level hash is wanted later, compute it from `run` with the same util as `computeParamsHash`. Not required for correctness.

- [ ] **Step 5: Run** — `pnpm test src/research/experiment-service.test.ts` → PASS; `pnpm typecheck` clean.
- [ ] **Step 6: Commit** — `git add src/research/experiment-service* src/research/experiment-run-executor.ts && git commit -m "feat(research): ExperimentService two-phase train/holdout flow over run executor"`

---

## Task 12b: `BacktesterExperimentRunExecutor` (production run executor — persists BacktestRun, spec §5.0)

**Files:**
- Create: `src/research/backtester-experiment-run-executor.ts`

**Interfaces:**
- Consumes: `ExperimentRunExecutor`/`ExperimentRunRequest`/`ExperimentRunResult` (Task 12 Step 1); `runOverlayBacktest` + `PollOptions` (`src/research/run-backtest.ts`); `mapPlatformComparison` (`src/domain/platform-comparison.ts`); `ResearchPlatformPort` + `SubmitOverlayRunOptions` (`src/ports/research-platform.port.ts`); `BacktestRunRepository` + `BacktestRun`/`BacktestCompletion` (`src/ports/backtest-run.repository.ts`, `src/domain/backtest-run.ts`).
- Produces: `BacktesterExperimentRunExecutor implements ExperimentRunExecutor`.

- [ ] **Step 1: Confirm exact field types.** Read `src/orchestrator/handlers/run-platform-backtest.ts` (the `BacktestRun` literal passed to `createSubmitted`), `src/orchestrator/handlers/backtest-support.ts` (the `BacktestCompletion` literal + `computeParamsHash` signature), `src/domain/backtest-run.ts` (`BacktestRun`/`BacktestCompletion` field types — esp. `artifactRefs`, the nullable fields), and locate `SDK_CONTRACT_VERSION`. Record: `computeParamsHash(...)` arg order, the `BacktestCompletion.artifactRefs` element type, and which fields are `null`-vs-`undefined`.

- [ ] **Step 2: Implement** (`src/research/backtester-experiment-run-executor.ts`). This is the **one place** the experiment flow persists a `BacktestRun`. Mirror the verbatim `createSubmitted` / `markCompleted` blocks from `run-platform-backtest.ts` / `backtest-support.ts`.

```ts
import { randomUUID, createHash } from 'node:crypto';
import type { ResearchPlatformPort, SubmitOverlayRunOptions } from '../ports/research-platform.port.ts';
import type { BacktestRun, BacktestCompletion } from '../domain/backtest-run.ts';
import type { BacktestRunRepository } from '../ports/backtest-run.repository.ts';
import { runOverlayBacktest, type PollOptions } from './run-backtest.ts';
import { mapPlatformComparison } from '../domain/platform-comparison.ts';
import { computeParamsHash } from '../orchestrator/handlers/backtest-support.ts'; // confirm export name/path in Step 1
// Import SDK_CONTRACT_VERSION from the SAME module run-platform-backtest.ts imports it from (resolve the import in Step 1).
import { SDK_CONTRACT_VERSION } from '../research/run-backtest.ts';
import type { ExperimentRunExecutor, ExperimentRunRequest, ExperimentRunResult } from './experiment-run-executor.ts';

export interface BacktesterExperimentRunExecutorDeps {
  platform: ResearchPlatformPort;
  backtests: BacktestRunRepository;
  researchIntegration: string;          // services.researchIntegration ('backtester' | ...)
  fragilityTopTradePct: number;         // services.evaluatorThresholds.fragilityTopTradePct
  poll: PollOptions;
  callbackUrl?: string;                 // services.backtestCallbackUrl
  now: () => string;
}

export class BacktesterExperimentRunExecutor implements ExperimentRunExecutor {
  private readonly d: BacktesterExperimentRunExecutorDeps;
  constructor(deps: BacktesterExperimentRunExecutorDeps) { this.d = deps; }

  async execute(req: ExperimentRunRequest): Promise<ExperimentRunResult> {
    const paramsHash = computeParamsHash(req.params, req.run); // confirm arg order in Step 1
    const resumeToken = createHash('sha256')
      .update(JSON.stringify({ v: 1, experimentId: req.experimentId, role: req.role, paramsHash, bundleHash: req.bundle.bundleHash }))
      .digest('hex');

    const opts: SubmitOverlayRunOptions = {
      target: this.d.researchIntegration === 'backtester'
        ? { kind: 'registry_preset' }
        : { kind: 'baseline_ref', moduleRef: req.baselineRef },
      run: req.run,
      correlationId: req.role,
      resumeToken,
      workflowId: req.experimentId,
      ...(this.d.callbackUrl !== undefined ? { callbackUrl: this.d.callbackUrl } : {}),
    };
    const outcome = await runOverlayBacktest(this.d.platform, req.bundle, opts, this.d.poll);

    const labRunId = randomUUID();
    const run: BacktestRun = {
      id: labRunId, hypothesisBuildId: req.buildId ?? null, hypothesisId: req.hypothesisId ?? null,
      strategyProfileId: req.strategyProfileId, platformRunId: outcome.runId, correlationId: req.role,
      params: req.params, paramsHash, bundleHash: req.bundle.bundleHash, status: 'submitted',
      baselineModuleId: req.baselineRef.id, variantModuleId: req.bundle.manifest.moduleId,
      metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
      artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: SDK_CONTRACT_VERSION,
      backend: 'research_platform', taskId: req.experimentId, resumeToken, platformRun: req.run,
      submittedAt: this.d.now(), finishedAt: null, createdAt: this.d.now(), updatedAt: this.d.now(),
    };
    await this.d.backtests.createSubmitted(run);

    if (outcome.status === 'rejected') {
      await this.d.backtests.markRejected(labRunId);
      return { status: 'rejected', runId: labRunId, platformRunId: outcome.runId };
    }
    if (outcome.status === 'pending') {
      return { status: 'pending', runId: labRunId, platformRunId: outcome.runId };
    }

    const c = mapPlatformComparison(outcome.summary);
    const completion: BacktestCompletion = {
      metrics: c.variant, baselineMetrics: c.baseline,
      deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
      deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
      isFragile: c.variant.topTradeContributionPct >= this.d.fragilityTopTradePct,
      artifactRefs: [], platformContractVersion: c.platformContractVersion, finishedAt: this.d.now(),
    };
    await this.d.backtests.markCompleted(labRunId, completion);
    return { status: 'completed', runId: labRunId, platformRunId: outcome.runId, comparison: c, totalTrades: c.variant.totalTrades };
  }
}
```

> Notes: (1) the executor does **not** create an `Evaluation` row or call `markEvaluated` — the per-run single-backtest `Evaluation` belongs to the old flow; the experiment verdict is the separate `experiment_evaluation`. (2) `BacktestCompletion.artifactRefs` element type from Step 1 — pass `outcome.artifactIds` mapped to that shape if it is `ArtifactReference[]`, else `[]`. (3) `mapPlatformComparison` throws `MetricMappingError` on a malformed summary — wrap in try/catch and return `{ status: 'rejected', ... }` if you want a completed-but-unmappable run treated as rejected (mirror `applyPlatformTerminalOutcome`'s `markFailed` handling; confirm in Step 1).

- [ ] **Step 3: Run** — `pnpm typecheck` clean. (Behavioural coverage is the Task 13 integration test against the composed/mock stack — a standalone unit test here would require a hand-built `RunResultSummary` fixture that `mapPlatformComparison` accepts; the integration test exercises the real mapping instead.)
- [ ] **Step 4: Commit** — `git add src/research/backtester-experiment-run-executor.ts && git commit -m "feat(research): production experiment run executor (persists BacktestRun)"`

---

## Task 13: Production wiring + reroute new-strategy path

**Files:**
- Modify: `src/orchestrator/app-services.ts` (add `experimentService: ExperimentService`)
- Modify: `src/composition.ts` (instantiate `BacktesterExperimentRunExecutor` + `ExperimentService`)
- Modify: the new-strategy call site identified in Task 0.3 (`src/orchestrator/handlers/hypothesis-build.handler.ts` or its router registration) to route **initial new-strategy validation** to `experimentService.runNewStrategyValidation(...)`, leaving hypothesis-retry / Cycle-2 on the existing single-backtest path.

**Interfaces:**
- Consumes: `BacktesterExperimentRunExecutor` (Task 12b), `ExperimentService` (Task 12), `RunTradesPort` (Task 8).

- [ ] **Step 1: Build the executor + service in `composeRuntime`.** No `runRunner` — the executor (Task 12b) owns submit/persist/map. Wire it from the already-composed collaborators:

```ts
const experimentRunExecutor = new BacktesterExperimentRunExecutor({
  platform: services.researchPlatform,
  backtests: services.backtests,
  researchIntegration: services.researchIntegration,
  fragilityTopTradePct: services.evaluatorThresholds.fragilityTopTradePct,
  poll: { maxPolls: /* same as run-platform-backtest.ts */, pollDelayMs: /* same */ },
  ...(services.backtestCallbackUrl !== undefined ? { callbackUrl: services.backtestCallbackUrl } : {}),
  now,
});
const experimentService = new ExperimentService({
  experiments: services.experiments,
  runTrades: services.runTrades,
  runExecutor: experimentRunExecutor,
  newId: (p) => `${p}-${randomUUID()}`,
  now,
});
```

> Confirm the `poll` values (`maxPolls`/`pollDelayMs`) and the `now`/`randomUUID` helpers already used in `composeRuntime` / `run-platform-backtest.ts`; reuse the same ones. `services.evaluatorThresholds`, `services.researchIntegration`, `services.backtestCallbackUrl`, `services.researchPlatform`, `services.backtests`, `services.runTrades` (Task 8) are already on `AppServices`.

- [ ] **Step 2: Add `experimentService` to `AppServices`** (`src/orchestrator/app-services.ts`) and assign it in `composeRuntime` (`services.experimentService = experimentService` — or include both in the initial `services` object construction).

- [ ] **Step 3: Reroute.** At the new-strategy call site (Task 0.3 discriminator), when it is an **initial new-strategy validation**, call `services.experimentService.runNewStrategyValidation({...})` instead of `runPlatformBacktest(...)`. Build the input from the handler's existing context:

```ts
await services.experimentService.runNewStrategyValidation({
  strategyProfileId: profile.id,
  hypothesisId,
  buildId,
  bundle,                       // the ModuleBundle the handler already assembled
  baselineRef,                  // the Ref the handler already computed ({ id: strategy:<profileId>, version })
  datasetScope: {               // from payload.platformRun (PlatformRunConfig) — full period
    datasetId: payload.platformRun.datasetId,
    symbols: [...payload.platformRun.symbols],
    timeframe: payload.platformRun.timeframe,
    period: payload.platformRun.period,
  },
  runConfig: {                  // same minus period
    datasetId: payload.platformRun.datasetId,
    symbols: [...payload.platformRun.symbols],
    timeframe: payload.platformRun.timeframe,
    seed: payload.platformRun.seed,
  },
  params: payload.params ?? {},
});
```

Keep the single-backtest `runPlatformBacktest(...)` call for the non-initial branch. Emit the same audit events the handler already emits around the call. Confirm the exact local variable names (`bundle`, `baselineRef`, `hypothesisId`, `buildId`, `payload.platformRun`) against the handler read in Task 0.3.

- [ ] **Step 4: Run** — `pnpm typecheck` clean; `pnpm test` full suite green. Confirm existing single-backtest tests still pass (zero-diff to `evaluateBacktest`/`finalizeBacktestCompletion`).

- [ ] **Step 5: Integration test** (`src/orchestrator/handlers/new-strategy-holdout.integration.test.ts`) — exercise the reroute with the in-memory/fake stack: a new-strategy build flows into `ExperimentService`, produces an experiment with sanity+train+holdout members and a verdict; assert a holdout-FAIL case does not yield `PAPER_CANDIDATE`, and that `GET /v1/experiments/:id/runs` (via the read app) lists the three members. (Reuse the fakes from Task 12 + the read-app harness from Task 5.)

- [ ] **Step 6: Commit** — `git add src/ && git commit -m "feat(research): route initial new-strategy validation through train/holdout flow"`

**Phase 3 checkpoint:** the guarantee holds — a new strategy cannot reach `PAPER_CANDIDATE` without a passing holdout; existing single-backtest flow unchanged.

---

## Final verification

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` full suite green.
- [ ] Grep `git diff main --stat` — confirm `src/validation/evaluator.ts`, `src/orchestrator/handlers/backtest-support.ts`, `src/orchestrator/handlers/run-platform-backtest.ts` have **zero** behavioural changes (only additive imports/wiring at call sites, if any).
- [ ] Confirm migration `0013` present + `meta/_journal.json` idx 13 (generated, not hand-edited).
- [ ] Open a PR from `feat/research-holdout-validation` summarizing: registry + holdout policy + train/holdout flow; scope explicitly excludes WFA-multifold/WFO/orchestrator/office.

---

## Self-review notes (coverage map spec → tasks)

- Spec §3 tables → Task 2; reserved WFO columns (`parameter_grid`, `params`, `oos`) included. ✓
- Spec §3.4 `experiment_key` idempotency → Task 11 + Task 12. ✓
- Spec §4.2 resolver (all edge cases) → Task 7. ✓
- Spec §4.3 `RunTradesPort` + manifest-based ref lookup → Task 8. ✓
- Spec §5 flow + resumability (skip-by-role) → Task 12; §5.0 BacktestRun persistence via executor → Task 12b. ✓
- Spec §6.1 composite evaluator + §6.3 sanity-as-gate + §6.4 low-confidence-not-paper → Task 10 + Task 12. ✓
- Spec §6.5 half-open encoding + `period.to` verify → Task 0.1 + Task 9. ✓
- Spec §7 read API → Task 5. ✓
- Spec §8 wiring + reroute criterion → Task 6, Task 8 Step 8, Task 13. ✓
- Spec §9 tests → unit (Tasks 7, 9, 10, 11), integration (Tasks 3, 5, 12, 13). ✓
- Spec §11 invariants (single-backtest zero-diff, INCONCLUSIVE≠FAIL, low-confidence not paper, no-leakage) → enforced across Tasks 9, 10, 12, 13 + Final verification. ✓
