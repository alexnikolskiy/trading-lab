# Strategy WFO Decision Contour (Slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a strategy baseline run, an LLM decision contour (GATE1 → sweep-designer → 1-fold WFO over `request.params` on the fixed `bundle_hash` → result-interpreter) decides whether/how to tune a strategy before a paper/no-go verdict.

**Architecture:** Variant A — a `ExperimentService.runWalkForwardOptimization` orchestrator drives three Mastra agents (`Gate1DecisionAgent`, `SweepDesigner`, `ResultInterpreter`) and a deterministic `ParamGridRunner`. LLM only at the three judgment points; grid expansion, per-point submission, top-N pre-filter, and the OOS verdict are deterministic code. Reuses Slice A's `resolveHoldoutBoundary` (fixed boundary T from the baseline) and `evaluateStrategyBaseline`.

**Tech Stack:** TypeScript on `node --experimental-strip-types`, Vitest, Drizzle (Postgres), Mastra agents (`@mastra/core/agent`, zod structured output). Gates: `pnpm typecheck` (`tsc -p tsconfig.json`) + `pnpm test` (`vitest run`).

## Global Constraints

- **No DB migration.** Columns already exist (`src/db/schema.ts`): `research_experiment.parameter_grid`, `experiment_run_member.params`, `experiment_run_member.oos`, `experiment_run_member.params_hash`. This slice wires them through domain/repo/DTO only.
- **`ExperimentType` already contains `'walk_forward_optimization'`** (`src/domain/research-experiment.ts`) — do NOT re-add it; verify it's present.
- **Sweep = walk-forward optimization, NOT grid-pick-best.** Optimize on train `[from, T)`; measure the CHOSEN set once on holdout `[T, to]` (OOS). The verdict uses ONLY the OOS run. Boundary T is fixed ONCE from the baseline for the whole experiment.
- **No-leakage:** `SweepDesigner` and `ResultInterpreter` receive ONLY train-window summaries and `period.to = T`. The holdout run happens strictly after `select`.
- **LLM never sees the whole sweep** — only the deterministic top-N (default N=3). LLM errors at a judgment point are terminal (no silent fallback).
- **Bounds:** ≤8 grid points/round after expansion (`grid_too_large` otherwise); ≤2 rounds (`round_limit_reached`); cumulative token/backtest kill-switch (`budget_exhausted`, checked between rounds).
- **`request.params` merges over `manifest.params` in the engine** (fixed `bundle_hash`; `params_hash` distinguishes points). SDK `RunSubmitRequest.params?` already exists — no SDK bump.
- **Overlay lane + Slice A baseline lane behaviour must be zero-diff** (params omitted when empty → byte-identical request).
- Commit after every task. Run `pnpm typecheck` before each commit touching `.ts`.

---

## File Structure

**Create:**
- `src/research/param-grid.ts` — `ParameterGrid` type, `expandGrid`, `GridTooLargeError`.
- `src/research/top-n-prefilter.ts` — `rankTopN` (trade-gated deterministic ranking).
- `src/research/param-grid-runner.ts` — `ParamGridRunner` (submit grid points on train, collect, rank).
- `src/ports/wfo-agents.port.ts` — `Gate1DecisionPort`, `SweepDesignerPort`, `ResultInterpreterPort` + input/output types.
- `src/domain/wfo.ts` — zod schemas + inferred output types for the three agents; `EntryAffectingParamClassifier` helper.
- `src/adapters/wfo/{fake-gate1,mastra-gate1,fake-sweep-designer,mastra-sweep-designer,fake-result-interpreter,mastra-result-interpreter}.ts`.
- `src/mastra/agents/{gate1-decision,sweep-designer,result-interpreter}.agent.ts` — agent factories.
- `src/research/wfo-experiment-identity.ts` — `computeWfoExperimentKey`.
- `scripts/run-strategy-wfo.mts` — one-shot trigger.

**Modify:**
- `src/ports/research-platform.port.ts` — `SubmitStrategyResearchRunOptions.params?`.
- `src/adapters/platform/http-backtester.adapter.ts` — thread `opts.params` into `BtRunSubmitRequest.params`.
- `src/adapters/platform/mock-research-platform.adapter.ts` — remember params per runId; vary fabricated metrics by params.
- `src/research/backtester-strategy-experiment-run-executor.ts` — pass `params: req.params` into `submitStrategyResearchRun`.
- `src/domain/research-experiment.ts` — `ResearchExperiment.parameterGrid?`, `ExperimentRunMember.params?`/`oos?`, `ParameterGrid` import.
- `src/ports/research-experiment.repository.ts` — `updateExperiment` patch Pick += `parameterGrid` (only for symmetry; set at create).
- `src/adapters/repository/{drizzle,in-memory}-research-experiment.repository.ts` — write/read `parameterGrid`, member `params`/`oos`.
- `src/read-api/mappers.ts` + its DTO types — map `parameterGrid`, member `params`/`oos`.
- `src/research/experiment-service.ts` — deps += agents + `paramGridRunner` + budget; `runWalkForwardOptimization`; generalize member writing to persist `params`/`oos`/`paramsHash`.
- `src/mastra/compose-mastra.ts` — register the three agents behind `*_ADAPTER=mastra`.
- `src/composition.ts` — `buildGate1`/`buildSweepDesigner`/`buildResultInterpreter` + wire `ParamGridRunner` + WFO deps into `ExperimentService`.
- `src/config/env.ts` — `WFO_*_ADAPTER` + `WFO_*_MODEL` envs.

---

## Task 1: Thread `request.params` through the submit boundary

**Files:**
- Modify: `src/ports/research-platform.port.ts` (`SubmitStrategyResearchRunOptions`)
- Modify: `src/adapters/platform/http-backtester.adapter.ts:283` (`submitStrategyResearchRun`)
- Modify: `src/research/backtester-strategy-experiment-run-executor.ts:44` (submit call)
- Test: `src/adapters/platform/http-backtester.adapter.test.ts`

**Interfaces:**
- Produces: `SubmitStrategyResearchRunOptions.params?: Record<string, unknown>`; when set and non-empty the wire request carries `params`.

- [ ] **Step 1: Failing wire test** — append to `http-backtester.adapter.test.ts` (the `FakeClient` + `strategyBundle` + `strategyOpts` already exist):

```ts
it('submitStrategyResearchRun puts non-empty opts.params into request.params (and omits when empty)', async () => {
  const fake = new FakeClient();
  await new HttpBacktesterAdapter(fake).submitStrategyResearchRun(strategyBundle, {
    ...strategyOpts, params: { 'dump.minDropPct': 2.5, 'entry.fastBouncePct': 0.4 },
  });
  expect(fake.submitted?.params).toEqual({ 'dump.minDropPct': 2.5, 'entry.fastBouncePct': 0.4 });

  const fake2 = new FakeClient();
  await new HttpBacktesterAdapter(fake2).submitStrategyResearchRun(strategyBundle, { ...strategyOpts, params: {} });
  expect(fake2.submitted && 'params' in fake2.submitted).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/adapters/platform/http-backtester.adapter.test.ts -t "into request.params"` → FAIL (`params` undefined; option not accepted).

- [ ] **Step 3: Add the option** — in `research-platform.port.ts`, inside `SubmitStrategyResearchRunOptions`, after `metrics`:

```ts
  /** request.params overrides merged over manifest.params by the engine (WFO sweep point). Omit/empty = manifest defaults. */
  readonly params?: Record<string, unknown>;
```

- [ ] **Step 4: Thread into the request** — in `http-backtester.adapter.ts`, add to the `req` object literal (next to `metrics`):

```ts
    ...(opts.params !== undefined && Object.keys(opts.params).length > 0 ? { params: opts.params } : {}),
```

- [ ] **Step 5: Executor passes params** — in `backtester-strategy-experiment-run-executor.ts`, the `submitStrategyResearchRun(req.strategyBundle, { ... })` call — add `params: req.params,` alongside `metrics: req.metrics,`.

- [ ] **Step 6: Run — expect PASS** — same `-t` command → PASS.

- [ ] **Step 7: Full suite + typecheck** — `pnpm typecheck && npx vitest run src/adapters/platform src/research/backtester-strategy-experiment-run-executor.test.ts` → all PASS (overlay/baseline zero-diff — the empty-params branch keeps the request byte-identical).

- [ ] **Step 8: Commit**

```bash
git add src/ports/research-platform.port.ts src/adapters/platform/http-backtester.adapter.ts src/research/backtester-strategy-experiment-run-executor.ts src/adapters/platform/http-backtester.adapter.test.ts
git commit -m "feat(research): thread request.params through strategy submit boundary"
```

---

## Task 2: Mock platform varies metrics by params

**Files:**
- Modify: `src/adapters/platform/mock-research-platform.adapter.ts` (track params per runId; derive metrics)
- Test: `src/adapters/platform/mock-research-platform.adapter.test.ts`

**Interfaces:**
- Consumes: `SubmitStrategyResearchRunOptions.params` (Task 1).
- Produces: mock `getRunResult` returns metrics that are a deterministic function of the submitted `params` (empty params → unchanged baseline metrics, preserving existing tests).

**Context:** The mock currently tracks strategy run ids in a `Set` and fabricates fixed metrics. Change the `Set` to a `Map<string, Record<string, unknown>>` (runId → params). In `getRunResult`, if the runId is a strategy run with non-empty params, perturb the fabricated metrics deterministically from a stable hash of the params so distinct grid points get distinct, reproducible metrics; empty params keep the current values.

- [ ] **Step 1: Failing test**

```ts
it('strategy getRunResult varies metrics deterministically by params (empty params unchanged)', async () => {
  const a = new MockResearchPlatformAdapter(/* existing ctor args */);
  const runA = await a.submitStrategyResearchRun(bundle, { ...opts, params: { 'dump.minDropPct': 2 } });
  const runB = await a.submitStrategyResearchRun(bundle, { ...opts, params: { 'dump.minDropPct': 5 } });
  const resA = await a.getRunResult(runA.runId); const resB = await a.getRunResult(runB.runId);
  if (resA.kind !== 'summary' || resB.kind !== 'summary') throw new Error('expected summaries');
  expect(resA.summary.metrics).not.toEqual(resB.summary.metrics);          // distinct points differ
  const again = await (async () => { const r = await a.submitStrategyResearchRun(bundle, { ...opts, params: { 'dump.minDropPct': 2 } }); return a.getRunResult(r.runId); })();
  if (again.kind !== 'summary') throw new Error('expected summary');
  expect(again.summary.metrics).toEqual(resA.summary.metrics);             // same params → same metrics (deterministic)
});
```
(Reuse the file's existing `bundle`/`opts` fixtures; if none, construct minimal ones mirroring `http-backtester.adapter.test.ts`.)

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/adapters/platform/mock-research-platform.adapter.test.ts -t "varies metrics"` → FAIL.

- [ ] **Step 3: Implement** — change the run-id tracker to `private readonly strategyRuns = new Map<string, Record<string, unknown>>();`; on `submitStrategyResearchRun` store `this.strategyRuns.set(runId, opts.params ?? {})`. Add a pure helper in the same file:

```ts
function perturbMetrics(base: Record<string, number>, params: Record<string, unknown>): Record<string, number> {
  if (Object.keys(params).length === 0) return base;
  const h = createHash('sha256').update(stableStringify(params)).digest();  // node:crypto + stableStringify
  const f = (i: number) => (h[i]! / 255);                                   // 0..1, deterministic
  return {
    ...base,
    pnl: base.pnl! * (0.5 + f(0)),
    sharpe: (base.sharpe ?? 0) + (f(1) - 0.5),
    total_trades: Math.max(1, Math.round((base.total_trades ?? 3) * (0.5 + f(2)))),
    max_drawdown: (base.max_drawdown ?? 0) * (0.5 + f(3)),
  };
}
```
In the strategy branch of `getRunResult`, look up `this.strategyRuns.get(runId)` and pass through `perturbMetrics` before building the summary. (Import `createHash` from `node:crypto` and `stableStringify` from `../../orchestrator/handlers/backtest-support.ts`.)

- [ ] **Step 4: Run — expect PASS** — same `-t` → PASS.

- [ ] **Step 5: Full mock + baseline suite** — `pnpm typecheck && npx vitest run src/adapters/platform src/research/experiment-service.strategy.test.ts` → PASS (empty-params path unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/platform/mock-research-platform.adapter.ts src/adapters/platform/mock-research-platform.adapter.test.ts
git commit -m "feat(research): mock platform varies strategy metrics by params (deterministic)"
```

---

## Task 3: Domain types + repo wiring for `parameterGrid` / member `params` / `oos`

**Files:**
- Modify: `src/domain/research-experiment.ts` (types)
- Modify: `src/adapters/repository/in-memory-research-experiment.repository.ts`
- Modify: `src/adapters/repository/drizzle-research-experiment.repository.ts`
- Modify: `src/ports/research-experiment.repository.ts` (update patch Pick — symmetry only)
- Test: `src/adapters/repository/in-memory-research-experiment.repository.test.ts`

**Interfaces:**
- Produces: `ParameterGrid = Record<string, unknown[]>`; `ResearchExperiment.parameterGrid?: ParameterGrid`; `ExperimentRunMember.params?: Record<string, unknown>`; `ExperimentRunMember.oos?: boolean`. Repo `createExperiment` persists `parameterGrid`; `addMember` persists `params`/`oos`.

- [ ] **Step 1: Failing round-trip test** — in the in-memory repo test:

```ts
it('round-trips parameterGrid on experiment and params/oos on member', async () => {
  const repo = new InMemoryResearchExperimentRepository();
  const exp = makeExperiment({ experimentType: 'walk_forward_optimization', parameterGrid: { 'dump.minDropPct': [2, 5] } });
  await repo.createExperiment(exp);
  expect((await repo.findById(exp.id))?.parameterGrid).toEqual({ 'dump.minDropPct': [2, 5] });
  await repo.addMember(makeMember({ experimentId: exp.id, role: 'train', params: { 'dump.minDropPct': 2 }, oos: false, paramsHash: 'h1' }));
  await repo.addMember(makeMember({ experimentId: exp.id, role: 'holdout', params: { 'dump.minDropPct': 2 }, oos: true, paramsHash: 'h1' }));
  const members = await repo.listMembers(exp.id);
  expect(members.map((m) => m.oos)).toEqual([false, true]);
  expect(members[0]?.params).toEqual({ 'dump.minDropPct': 2 });
});
```
(Use/extend the test file's existing `makeExperiment`/`makeMember` helpers; add the new optional fields to those helpers.)

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/adapters/repository/in-memory-research-experiment.repository.test.ts -t "round-trips parameterGrid"` → FAIL (types + persistence missing).

- [ ] **Step 3: Domain types** — in `research-experiment.ts`: add `export type ParameterGrid = Record<string, unknown[]>;` near the top types; add `parameterGrid?: ParameterGrid;` to `ResearchExperiment` (after `bundleHash?`); add to `ExperimentRunMember` (after `paramsHash`): `params?: Record<string, unknown>;` and `oos?: boolean;`.

- [ ] **Step 4: Repo port symmetry** — in `research-experiment.repository.ts`, add `'parameterGrid'` to the `updateExperiment` patch `Pick<...>` union (set at create in practice, but keep the type honest).

- [ ] **Step 5: In-memory adapter** — it stores whole objects; ensure `createExperiment`/`addMember` retain the new fields (usually structural clone — verify no field whitelist drops them; if it copies field-by-field, add `parameterGrid`, `params`, `oos`).

- [ ] **Step 6: Drizzle adapter** — `createExperiment` insert: add `parameterGrid: e.parameterGrid ?? null,`. `addMember` insert: add `params: m.params ?? null, oos: m.oos ?? null,`. Row→domain mappers (both `find*`/`listMembers`): map `parameterGrid` back onto the experiment and `params`/`oos` back onto members (mirror how `holdoutBoundary`/`resultSummary` jsonb are read).

- [ ] **Step 7: Run — expect PASS** — `npx vitest run src/adapters/repository/in-memory-research-experiment.repository.test.ts` → PASS.

- [ ] **Step 8: Typecheck + repo suites** — `pnpm typecheck && npx vitest run src/adapters/repository` → PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/research-experiment.ts src/ports/research-experiment.repository.ts src/adapters/repository/in-memory-research-experiment.repository.ts src/adapters/repository/drizzle-research-experiment.repository.ts src/adapters/repository/in-memory-research-experiment.repository.test.ts
git commit -m "feat(research): wire parameterGrid + member params/oos through domain and repos"
```

---

## Task 4: Read-API DTO + mappers for `parameterGrid` / member `params` / `oos`

**Files:**
- Modify: `src/read-api/mappers.ts` (`toExperimentDto`, `toExperimentRunMemberDto`) + their DTO type declarations
- Test: `src/read-api/mappers.test.ts`

**Interfaces:**
- Produces: `ExperimentDto.parameterGrid?`; `ExperimentRunMemberDto.params?`/`oos?`.

- [ ] **Step 1: Failing test**

```ts
it('maps parameterGrid and member params/oos into DTOs', () => {
  const dto = toExperimentDto(makeExperiment({ parameterGrid: { 'x': [1, 2] } }));
  expect(dto.parameterGrid).toEqual({ 'x': [1, 2] });
  const m = toExperimentRunMemberDto(makeMember({ params: { 'x': 1 }, oos: true }));
  expect(m.params).toEqual({ 'x': 1 });
  expect(m.oos).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/read-api/mappers.test.ts -t "parameterGrid and member"` → FAIL.

- [ ] **Step 3: Implement** — add `parameterGrid: e.parameterGrid ?? null` to `toExperimentDto` (and `parameterGrid?: ParameterGrid | null` to `ExperimentDto`); add `params: m.params ?? null, oos: m.oos ?? null` to `toExperimentRunMemberDto` (and the fields to `ExperimentRunMemberDto`).

- [ ] **Step 4: Run — expect PASS** — same `-t` → PASS.

- [ ] **Step 5: Typecheck + read-api suite** — `pnpm typecheck && npx vitest run src/read-api` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/read-api/mappers.ts src/read-api/mappers.test.ts
git commit -m "feat(read-api): surface parameterGrid + member params/oos in DTOs"
```

---

## Task 5: `ParameterGrid` expansion (`expandGrid`)

**Files:**
- Create: `src/research/param-grid.ts`
- Test: `src/research/param-grid.test.ts`

**Interfaces:**
- Produces: `type GridPoint = Record<string, unknown>`; `expandGrid(grid: ParameterGrid, maxPoints: number): GridPoint[]` (cartesian product, order-stable, deduped); throws `GridTooLargeError` when the product exceeds `maxPoints`.

- [ ] **Step 1: Failing test**

```ts
import { expandGrid, GridTooLargeError } from './param-grid.ts';
it('expands a grid to the cartesian product, deduped and stable', () => {
  expect(expandGrid({ a: [1, 2], b: ['x'] }, 8)).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'x' }]);
  expect(expandGrid({ a: [1, 1] }, 8)).toEqual([{ a: 1 }]);          // dedupe identical points
});
it('throws GridTooLargeError past the cap', () => {
  expect(() => expandGrid({ a: [1, 2, 3], b: [1, 2, 3] }, 8)).toThrow(GridTooLargeError);  // 9 > 8
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/research/param-grid.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `param-grid.ts`:

```ts
import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';
export type GridPoint = Record<string, unknown>;
export class GridTooLargeError extends Error {
  constructor(readonly size: number, readonly max: number) { super(`grid_too_large: ${size} > ${max}`); this.name = 'GridTooLargeError'; }
}
export function expandGrid(grid: Record<string, unknown[]>, maxPoints: number): GridPoint[] {
  const keys = Object.keys(grid).sort();
  let points: GridPoint[] = [{}];
  for (const k of keys) {
    const vals = grid[k] ?? [];
    points = points.flatMap((p) => vals.map((v) => ({ ...p, [k]: v })));
  }
  const seen = new Set<string>(); const out: GridPoint[] = [];
  for (const p of points) { const s = stableStringify(p); if (!seen.has(s)) { seen.add(s); out.push(p); } }
  if (out.length > maxPoints) throw new GridTooLargeError(out.length, maxPoints);
  return out;
}
```

- [ ] **Step 4: Run — expect PASS** — `npx vitest run src/research/param-grid.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/param-grid.ts src/research/param-grid.test.ts
git commit -m "feat(research): grid expansion with dedupe + size cap"
```

---

## Task 6: Trade-gated top-N pre-filter (`rankTopN`)

**Files:**
- Create: `src/research/top-n-prefilter.ts`
- Test: `src/research/top-n-prefilter.test.ts`

**Interfaces:**
- Consumes: `BacktestMetricBlock` (`src/ports/platform-gateway.port.ts`: `sharpe, profitFactor, maxDrawdownPct, netPnlPct, totalTrades, ...`), `GridPoint` (Task 5).
- Produces (the canonical result shapes used by Tasks 7 & 12):
```ts
export interface GridResult {
  point: GridPoint;
  paramsHash: string;
  status: 'completed' | 'rejected' | 'pending';
  strategyBacktestRunId: string;       // the executor returns a runId even for rejected points
  metrics?: BacktestMetricBlock;       // present only when status==='completed'
  tradeCount?: number;
}
export interface RankedPoint extends GridResult { status: 'completed'; metrics: BacktestMetricBlock; lowConfidence: boolean }
export function rankTopN(results: GridResult[], opts: { n: number; minTradesTrain: number }): RankedPoint[];
```

**Rules (spec §6):** consider only `status === 'completed'`; drop `totalTrades === 0`; `totalTrades < minTradesTrain` → keep, `lowConfidence: true`; sort `sharpe desc → profitFactor desc → maxDrawdownPct asc → netPnlPct desc`, with `lowConfidence` ranked below full-confidence regardless of raw metric; take `n`. (Rejected / zero-trade points are NOT ranked but are still returned in `allResults` by Task 7 so they are all balanced into the ledger.)

- [ ] **Step 1: Failing test**

```ts
import { rankTopN } from './top-n-prefilter.ts';
const mk = (o: Partial<BacktestMetricBlock>): BacktestMetricBlock => ({ netPnlUsd:0, netPnlPct:0, totalTrades:5, winRate:0, profitFactor:1, maxDrawdownPct:0, expectancyUsd:0, sharpe:0, topTradeContributionPct:0, ...o });
const gr = (paramsHash: string, m: Partial<BacktestMetricBlock>, status: GridResult['status'] = 'completed'): GridResult =>
  ({ point:{}, paramsHash, status, strategyBacktestRunId:`run-${paramsHash}`, metrics: mk(m), tradeCount: (m.totalTrades ?? 5) });
it('drops zero-trade + non-completed points and ranks trade-gated', () => {
  const res = rankTopN([
    gr('z', { totalTrades:0, sharpe:9 }),                 // dropped (zero-trade)
    gr('r', { totalTrades:9, sharpe:9 }, 'rejected'),     // dropped (not completed)
    gr('a', { totalTrades:1, sharpe:9 }),                 // low-confidence (< 3)
    gr('b', { totalTrades:5, sharpe:2 }),
    gr('c', { totalTrades:5, sharpe:3 }),
  ], { n: 3, minTradesTrain: 3 });
  expect(res.map((r) => r.paramsHash)).toEqual(['c', 'b', 'a']);   // full-conf by sharpe desc, then low-conf last
  expect(res.find((r) => r.paramsHash === 'a')?.lowConfidence).toBe(true);
});
it('returns empty when all points are zero-trade', () => {
  expect(rankTopN([gr('x', { totalTrades:0 })], { n: 3, minTradesTrain: 3 })).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/research/top-n-prefilter.test.ts` → FAIL.

- [ ] **Step 3: Implement** — sort comparator applies `lowConfidence` as the primary key (false first), then `sharpe desc, profitFactor desc, maxDrawdownPct asc, netPnlPct desc`. Filter `totalTrades > 0` first; map `lowConfidence = totalTrades < minTradesTrain`; sort; `slice(0, n)`.

- [ ] **Step 4: Run — expect PASS** — → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/top-n-prefilter.ts src/research/top-n-prefilter.test.ts
git commit -m "feat(research): trade-gated top-N pre-filter"
```

---

## Task 7: `ParamGridRunner` (submit grid points on train, collect, rank)

**Files:**
- Create: `src/research/param-grid-runner.ts`
- Test: `src/research/param-grid-runner.test.ts`

**Interfaces:**
- Consumes: `StrategyExperimentRunExecutor` (`execute(req): Promise<StrategyExperimentRunResult>`), `expandGrid` (T5), `rankTopN` (T6), `computeStrategyParamsHash` (`src/research/strategy-run-identity.ts`).
- Produces:
```ts
export interface ParamGridRunnerDeps { strategyRunExecutor: StrategyExperimentRunExecutor; }
export interface RunGridInput {
  experimentId: string; strategyBundle: AssembledStrategyBundle; strategyProfileId: string;
  trainRun: PlatformRunConfig;         // period already = [from, T)
  grid: ParameterGrid; metrics: readonly string[];
  maxPoints: number; topN: number; minTradesTrain: number; foldId: number;
}
export interface GridRunOutput { allResults: GridResult[]; ranked: RankedPoint[]; submitted: number; rejected: number; }
export class ParamGridRunner { constructor(deps: ParamGridRunnerDeps); runGrid(input: RunGridInput): Promise<GridRunOutput>; }
```
For EVERY expanded point → `strategyRunExecutor.execute({ experimentId, role:'train', strategyBundle, strategyProfileId, run: trainRun, params: point, metrics:[...metrics] })`; build a `GridResult` for **every** point (completed AND rejected/pending) with `paramsHash = computeStrategyParamsHash({ bundleHash: strategyBundle.bundleHash, platformRun: trainRun, params: point })`, `status: outcome.status`, `strategyBacktestRunId: outcome.runId`, and `metrics`/`tradeCount` when completed. Return **all** of them in `allResults` (so Task 11 can ledger every point); `ranked = rankTopN(allResults, { n: topN, minTradesTrain })` (top-N is completed+traded only). `submitted` = points attempted; `rejected` = count of non-`completed`. The runner does NOT write experiment members — Task 11 owns member persistence from `allResults`.

- [ ] **Step 1: Failing test** — with a fake executor returning per-params metrics:

```ts
it('runs every grid point on train, ledgers ALL results, ranks only completed', async () => {
  const seen: Record<string, unknown>[] = [];
  const fakeExec: StrategyExperimentRunExecutor = { async execute(req) {
    seen.push(req.params);
    const drop = Number(req.params['dump.minDropPct']);
    if (drop === 9) return { status:'rejected', runId:'r9', platformRunId:'p9' };   // one point rejected by engine
    return { status:'completed', runId:`r${drop}`, platformRunId:`p${drop}`, totalTrades: 5,
      metrics: { netPnlUsd:0, netPnlPct:0, totalTrades:5, winRate:0, profitFactor:1, maxDrawdownPct:0, expectancyUsd:0, sharpe: drop, topTradeContributionPct:0 } };
  }};
  const out = await new ParamGridRunner({ strategyRunExecutor: fakeExec }).runGrid({
    experimentId:'e', strategyBundle: bundle, strategyProfileId:'p', trainRun,
    grid: { 'dump.minDropPct': [2, 5, 9] }, metrics:['sharpe'], maxPoints:8, topN:3, minTradesTrain:3, foldId:0,
  });
  expect(seen.length).toBe(3);                               // all points submitted on train
  expect(out.allResults.length).toBe(3);                     // ALL points in the ledger (incl. rejected)
  expect(out.allResults.find((r) => r.paramsHash === out.allResults[2]!.paramsHash)?.status).toBeDefined();
  expect(out.allResults.filter((r) => r.status === 'rejected').length).toBe(1);
  expect(out.ranked.map((r) => r.metrics.sharpe)).toEqual([5, 2]);   // only completed, sharpe desc; rejected excluded
  expect(out.submitted).toBe(3); expect(out.rejected).toBe(1);
});
```

- [ ] **Step 2: Run — expect FAIL** — → FAIL.

- [ ] **Step 3: Implement** per the interface above.

- [ ] **Step 4: Run — expect PASS** — → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/research/param-grid-runner.ts src/research/param-grid-runner.test.ts
git commit -m "feat(research): ParamGridRunner — submit grid on train, collect, rank"
```

---

## Task 8: Entry-affecting param classifier + agent ports & schemas

**Files:**
- Create: `src/domain/wfo.ts` (zod schemas + classifier)
- Create: `src/ports/wfo-agents.port.ts`
- Test: `src/domain/wfo.test.ts`

**Interfaces:**
- Produces:
```ts
// classifier
export function classifyEntryAffectingParams(profileParams: ProfileParam[]): { entryAffecting: string[]; exitRisk: string[] };
// ProfileParam = { name: string; tunable: boolean; description?: string; ... } (from StrategyProfile.parameters)

// zod schemas + output types
export const Gate1OutputSchema = z.object({
  decision: z.enum(['improve', 'allow_exploratory_sweep', 'stop_not_worth', 'stop_insufficient_evidence']),
  reason: z.string(),
});
export const SweepDesignOutputSchema = z.object({ grid: z.record(z.array(z.unknown())), rationale: z.string() });
export const ResultInterpretOutputSchema = z.object({
  decision: z.enum(['select', 'extend', 'stop']),
  chosenParamsHash: z.string().optional(),   // must match one of the top-N paramsHashes when decision==='select'
  extendHint: z.string().optional(),
});
export type Gate1Output = z.infer<typeof Gate1OutputSchema>; /* etc. */

// ports (src/ports/wfo-agents.port.ts)
export interface Gate1DecisionPort { readonly adapter:'fake'|'mastra'; readonly model:string; decide(input: Gate1Input, opts?: AgentCallOpts): Promise<Gate1Output>; }
export interface SweepDesignerPort { readonly adapter:'fake'|'mastra'; readonly model:string; design(input: SweepInput, opts?: AgentCallOpts): Promise<SweepDesignOutput>; }
export interface ResultInterpreterPort { readonly adapter:'fake'|'mastra'; readonly model:string; interpret(input: InterpretInput, opts?: AgentCallOpts): Promise<ResultInterpretOutput>; }
```
`Gate1Input = { profile: StrategyProfile; baselineMetrics: BacktestMetricBlock; entryAffecting: string[]; hasEntrySignalEvidence: boolean }`.
`SweepInput = { profile: StrategyProfile; baselineTrainSummary: BacktestMetricBlock; tunableParams: ProfileParam[]; restrictToEntryParams: boolean; periodTo: string /* = T */; maxPoints: number }`.
`InterpretInput = { topN: RankedPoint[]; periodTo: string /* = T */; roundsSoFar: number; maxRounds: number }`.

**Classifier rule (spec §7):** entry-affecting = param name matches any of `dump.`, `entry.`, `oiFilter.`, `liqFilter.`, `watch.cooldown`, `warmup.maxSignalAge` (or description mentions entry/signal/filter/cooldown); everything else (`tpLadder.`, `hardStopPct`, `maxHoldMin`, `protection.`, `dca.`, `failFast.`) is exit/risk.

- [ ] **Step 1: Failing test**

```ts
import { classifyEntryAffectingParams } from './wfo.ts';
it('classifies entry-affecting vs exit/risk params', () => {
  const r = classifyEntryAffectingParams([
    { name:'dump.minDropPct', tunable:true }, { name:'entry.fastBouncePct', tunable:true },
    { name:'tpLadder.tp1Pct', tunable:true }, { name:'hardStopPct', tunable:true }, { name:'maxHoldMin', tunable:true },
  ] as any);
  expect(r.entryAffecting.sort()).toEqual(['dump.minDropPct', 'entry.fastBouncePct']);
  expect(r.exitRisk).toContain('tpLadder.tp1Pct');
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/domain/wfo.test.ts` → FAIL.

- [ ] **Step 3: Implement** the classifier + zod schemas + the port file.

- [ ] **Step 4: Run — expect PASS** — → PASS.

- [ ] **Step 5: Typecheck** — `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/wfo.ts src/ports/wfo-agents.port.ts src/domain/wfo.test.ts
git commit -m "feat(research): WFO agent ports, zod schemas, entry-param classifier"
```

---

## Task 9: Fake + Mastra adapters for the three agents

**Files:**
- Create: `src/adapters/wfo/fake-gate1.ts`, `mastra-gate1.ts`, `fake-sweep-designer.ts`, `mastra-sweep-designer.ts`, `fake-result-interpreter.ts`, `mastra-result-interpreter.ts`
- Create: `src/mastra/agents/gate1-decision.agent.ts`, `sweep-designer.agent.ts`, `result-interpreter.agent.ts`
- Test: `src/adapters/wfo/fake-agents.test.ts`

**Interfaces:**
- Consumes: ports + schemas (T8), the Mastra pattern from `src/adapters/critic/mastra-critic.ts` + `src/mastra/agents/critic.agent.ts` (copy structure exactly: `new Agent({ id, name, instructions, model })`; `agent.generate(prompt, { structuredOutput: { schema }, modelSettings: { maxOutputTokens } })`; `opts?.onUsage?.(...)`; `Schema.parse(result.object)`).
- Produces: `class FakeGate1 implements Gate1DecisionPort` (etc.); `class MastraGate1 implements Gate1DecisionPort` (etc.); `createGate1Agent(model): Agent` (etc.).

**Fake behaviours (deterministic, drive the happy path):**
- `FakeGate1.decide`: `baselineMetrics.totalTrades >= 1` → `improve`; `totalTrades === 0 && entryAffecting.length > 0 && hasEntrySignalEvidence === true` → `allow_exploratory_sweep`; else `stop_insufficient_evidence`. (BOTH entry-affecting tunables AND entry-signal evidence are required — entry-like params alone are not enough, per spec §7.)
- `FakeSweepDesigner.design`: return a small grid over the first 1–2 `tunableParams` (respecting `restrictToEntryParams`), e.g. `{ [firstEntryParam]: [v*0.5, v*1.5] }`.
- `FakeResultInterpreter.interpret`: `topN.length === 0` → `stop`; else `select` with `chosenParamsHash = topN[0].paramsHash`.

- [ ] **Step 1: Failing test**

```ts
it('fake gate1 needs BOTH entry params AND entry-signal evidence for exploratory', async () => {
  const g = new FakeGate1();
  const base = { profile: fakeProfile, baselineMetrics: mk({ totalTrades: 0 }), entryAffecting: ['dump.minDropPct'] };
  expect((await g.decide({ ...base, hasEntrySignalEvidence: true })).decision).toBe('allow_exploratory_sweep');
  expect((await g.decide({ ...base, hasEntrySignalEvidence: false })).decision).toBe('stop_insufficient_evidence');
  expect((await g.decide({ profile: fakeProfile, baselineMetrics: mk({ totalTrades: 0 }), entryAffecting: [], hasEntrySignalEvidence: true })).decision).toBe('stop_insufficient_evidence');
});
it('fake result-interpreter selects the top point', async () => {
  const out = await new FakeResultInterpreter().interpret({ topN: [{ paramsHash:'h', point:{}, metrics: mk({}), lowConfidence:false }], periodTo:'2026-06-15', roundsSoFar:1, maxRounds:2 });
  expect(out).toMatchObject({ decision: 'select', chosenParamsHash: 'h' });
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/adapters/wfo/fake-agents.test.ts` → FAIL.

- [ ] **Step 3: Implement** the three fakes + three Mastra adapters + three agent factories (mirror `mastra-critic.ts`/`critic.agent.ts` verbatim in structure; instructions strings describe each judgment: GATE1 worth-improving with the entry-guard rule; sweep-designer combined grid over tunables with `restrictToEntryParams`; result-interpreter select/extend/stop over top-N with `period.to=T` no-leakage note).

- [ ] **Step 4: Run — expect PASS** — → PASS.

- [ ] **Step 5: Typecheck** — `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/wfo/ src/mastra/agents/gate1-decision.agent.ts src/mastra/agents/sweep-designer.agent.ts src/mastra/agents/result-interpreter.agent.ts
git commit -m "feat(research): fake + mastra adapters and agent factories for WFO contour"
```

---

## Task 10: `computeWfoExperimentKey`

**Files:**
- Create: `src/research/wfo-experiment-identity.ts`
- Test: `src/research/wfo-experiment-identity.test.ts`

**Interfaces:**
- Consumes: `stableStringify` (`src/orchestrator/handlers/backtest-support.ts`).
- Produces: `computeWfoExperimentKey(input: { baselineExperimentId: string; bundleHash: string }): string` — `sha256(stableStringify({ v:1, kind:'strategy_wfo', ...input }))`. Keyed on the WFO INTENT (one WFO per baseline+bundle), NOT the grid — the grid is an LLM-designed output stored as data, not an identity input. Distinct from `computeStrategyExperimentKey` (which fixes `kind:'strategy_baseline'`) so a WFO experiment never collides with its baseline.

> **Identity policy (explicit):** "one WFO per (baseline, bundle)". A completed WFO experiment short-circuits on re-run. To re-run WFO with a new prompt/model/grid you need a NEW baseline experiment (new bundle → new `bundleHash`) or a manual reset of the prior WFO row. The grid is deliberately NOT part of identity (it is a non-deterministic LLM output).

- [ ] **Step 1: Failing test**

```ts
it('is stable and distinct by baseline + bundle', () => {
  const a = computeWfoExperimentKey({ baselineExperimentId:'e1', bundleHash:'sha256:b' });
  const b = computeWfoExperimentKey({ baselineExperimentId:'e1', bundleHash:'sha256:b' });
  const c = computeWfoExperimentKey({ baselineExperimentId:'e1', bundleHash:'sha256:c' });
  expect(a).toBe(b); expect(a).not.toBe(c);
});
```

- [ ] **Step 2: Run — expect FAIL** — → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/research/wfo-experiment-identity.ts src/research/wfo-experiment-identity.test.ts
git commit -m "feat(research): WFO experiment key (distinct from baseline)"
```

---

## Task 11: `runWalkForwardOptimization` orchestrator (incl. per-point member persistence)

**Files:**
- Modify: `src/research/experiment-service.ts` (deps + method + private `writeStrategyMember` helper)
- Test: `src/research/experiment-service.wfo.test.ts`

**Interfaces:**
- Consumes: `Gate1DecisionPort`, `SweepDesignerPort`, `ResultInterpreterPort`, `ParamGridRunner` (returns `allResults` + `ranked`), `StrategyBacktestRunRepository` (`findById`), `RunTradesPort` (`getRunTrades`), `resolveHoldoutBoundary`, `evaluateStrategyBaseline`, `computeWfoExperimentKey`, `classifyEntryAffectingParams`, `encodeTrainPeriod`/`encodeHoldoutPeriod` (existing).
- ExperimentServiceDeps += `gate1: Gate1DecisionPort; sweepDesigner: SweepDesignerPort; resultInterpreter: ResultInterpreterPort; paramGridRunner: ParamGridRunner; strategyBacktests: StrategyBacktestRunRepository; wfoBudget?: { maxRounds: number; maxPointsPerRound: number; minTradesTrain: number; topN: number }`.
- Produces a private helper (used ONLY by the WFO flow; the baseline `runStrategyMember` is left untouched → zero-diff):
```ts
private async writeStrategyMember(args: {
  experimentId: string; role: MemberRole; run: PlatformRunConfig;
  params: Record<string, unknown>; oos: boolean; foldId: number;
  strategyBacktestRunId: string; tradeCount?: number; bundleHash: string;
}): Promise<void>;
// single addMember: { strategyBacktestRunId, backtestRunId: undefined, params, oos, foldId,
//   paramsHash: computeStrategyParamsHash({ bundleHash, platformRun: run, params }),
//   tradeCount, role, periodFrom/To from run.period, symbols: run.symbols }
// emits experiment.member.completed
```

**Ledger invariant (spec §2/§9):** the orchestrator writes ONE `experiment_run_member` for **every** element of `runGrid(...).allResults` — including rejected and zero-trade points — with `oos:false`, `role:'train'`, `foldId = round-1`, and the point's `params`/`paramsHash`/`strategyBacktestRunId`/`tradeCount`. The top-N (`ranked`) is passed ONLY to the result-interpreter; it never gates what gets ledgered. The chosen holdout member is the single `oos:true` row.

**Baseline metrics + boundary source (explicit):** from `input.baselineExperimentId` → `experiments.findById` + `experiments.listMembers`; take the baseline `holdoutBoundary` if present. Read baseline metrics via the baseline's sanity (or holdout) member → `strategyBacktestRunId` → `strategyBacktests.findById(id)` → `.metrics` (a `BacktestMetricBlock`) + `.platformRunId`. If `holdoutBoundary` is absent, resolve it: `runTrades.getRunTrades(baselineSanity.platformRunId)` → `resolveHoldoutBoundary(trades, datasetScope.period, holdoutPolicy)`.
- Produces:
```ts
export interface RunWfoInput {
  baselineExperimentId: string;         // an existing completed strategy_baseline experiment
  strategyBundle: AssembledStrategyBundle;
  profile: StrategyProfile;
  strategyProfileId: string;
  datasetScope: DatasetScope;
  runConfig: Omit<PlatformRunConfig, 'period'>;
  metrics: readonly string[];
  entrySignalEvidence?: boolean;        // GATE1 evidence flag for a 0-trade baseline (trigger sets true when the baseline's decision-records show entry-signal annotations, e.g. long_oi dump_detected); defaults false
  taskId: string;
}
async runWalkForwardOptimization(input: RunWfoInput): Promise<{ experimentId: string; verdict: ExperimentVerdict; terminalReason: string }>;
```

**Flow (mirror `runStrategyBaselineValidation` structure; period helpers `encodeTrainPeriod`/`encodeHoldoutPeriod` already exist in the baseline flow — reuse them):**
1. Resolve baseline metrics + boundary per the **"Baseline metrics + boundary source"** note above (`findById` + `listMembers` → sanity member's `strategyBacktestRunId` → `strategyBacktests.findById` → `.metrics`/`.platformRunId`; boundary from `baseline.holdoutBoundary` or resolve via `getRunTrades`). Fix `T = boundary.t`.
2. `classifyEntryAffectingParams(profile.parameters)` → `entryAffecting`. `hasEntrySignalEvidence = baselineMetrics.totalTrades > 0 || input.entrySignalEvidence === true`.
3. **GATE1** `gate1.decide({ profile, baselineMetrics, entryAffecting, hasEntrySignalEvidence })`. If `stop_not_worth`/`stop_insufficient_evidence` → create the WFO experiment, finalize with `verdict:'INCONCLUSIVE'` + that `terminalReason`, return (no sweep).
4. `findByKey(computeWfoExperimentKey({ baselineExperimentId, bundleHash }))` — short-circuit if a completed WFO experiment already exists. Otherwise create it: `experimentType:'walk_forward_optimization'`, that `experimentKey`, `parameterGrid: {}` (empty at create), `holdoutBoundary: baseline.holdoutBoundary`, `status:'running'`. As each round's designer produces a grid, accumulate the union locally and persist it via `updateExperiment(id, { parameterGrid: unionSoFar, updatedAt })` (the `parameterGrid` key was added to the update Pick in Task 3).
5. If `boundary.mode === 'none'` → finalize `INCONCLUSIVE` (`terminalReason:'inconclusive'`) — still record GATE1 + the round grid, but no OOS possible. (This is the live 6-day-slice path.)
6. **Round loop (r = 1..maxRounds):**
   a. `sweepDesigner.design({ ..., restrictToEntryParams: gate1.decision==='allow_exploratory_sweep', periodTo: T, maxPoints })` → grid; `expandGrid` (→ `grid_too_large` terminal if it throws).
   b. `const { allResults, ranked } = await paramGridRunner.runGrid({ trainRun: { ...runConfig, period: encodeTrainPeriod(from, T) }, grid, foldId: r-1, topN, minTradesTrain, maxPoints, ... })`. **Then the orchestrator writes a `writeStrategyMember(...)` for EVERY `allResults` element** (`role:'train'`, `oos:false`, `foldId:r-1`, its `params`/`paramsHash`/`strategyBacktestRunId`/`tradeCount`) — including rejected/zero-trade points (the ledger invariant). If `ranked.length === 0` (no completed+traded point) → `sweep_failed` terminal.
   c. `resultInterpreter.interpret({ topN: ranked, periodTo: T, roundsSoFar: r, maxRounds })`.
   d. `select` → break with `chosenParamsHash`; `extend` → if `r < maxRounds` continue else `round_limit_reached` terminal; `stop` → `stop` terminal (no paper).
   e. Budget guard between rounds → `budget_exhausted` terminal if exceeded.
7. **On select:** recover the chosen `GridPoint` (map `chosenParamsHash` → point from the round's results); run ONE holdout OOS member: `role:'holdout'`, `oos:true`, `params: chosenPoint`, `run: { ...runConfig, period: encodeHoldoutPeriod(T, to) }`. `evaluateStrategyBaseline({ holdout: oosMetrics, boundary })` → verdict. `addEvaluation` + `updateExperiment({ status:'completed', verdict, verdictReason, aggregateMetrics, completedAt })`.
8. Return `{ experimentId, verdict, terminalReason }` (`terminalReason` = `'paper_candidate'|'holdout_failed'|'inconclusive'|'stop'|'grid_too_large'|'round_limit_reached'|'budget_exhausted'|'sweep_failed'|'stop_not_worth'|'stop_insufficient_evidence'`).

**Aggregates only over `oos=true` members** (single OOS member here).

- [ ] **Step 1: Failing lifecycle test** — with fake platform (Task 2 mock or a bespoke fake) varying metrics by params, fake agents (Task 9), a real `ParamGridRunner` + real `BacktesterStrategyExperimentRunExecutor` over the fake platform:

Test harness: an in-memory `ResearchExperimentRepository`, an in-memory `StrategyBacktestRunRepository`, a `BacktesterStrategyExperimentRunExecutor` over a fake platform whose strategy metrics vary by params (reuse Task 2's mock or a local fake), fake agents (Task 9), a real `ParamGridRunner`. Pre-seed a completed baseline strategy experiment via the repo (a sanity member → a persisted `strategy_backtest_run` with metrics + a `trade_based` boundary on the experiment).

```ts
it('runs GATE1 → sweep → train grid → select → OOS → verdict; ledgers EVERY grid point', async () => {
  // baseline pre-seeded: holdoutBoundary { mode:'trade_based', t:'<mid ISO>', lowConfidence:false }; sanity strategy_backtest_run metrics totalTrades:5
  const { experimentId, verdict } = await svc.runWalkForwardOptimization(wfoInput);   // grid designed by FakeSweepDesigner (≥2 points)
  const members = await repo.listMembers(experimentId);
  const train = members.filter((m) => m.role === 'train' && m.oos === false);
  expect(train.length).toBe(gridPointCount);                                   // EVERY expanded point ledgered (incl. any rejected/zero-trade)
  expect(train.every((m) => m.params && m.paramsHash)).toBe(true);
  expect(members.filter((m) => m.role === 'holdout' && m.oos === true).length).toBe(1);   // exactly one OOS
  expect(['PAPER_CANDIDATE','FAIL']).toContain(verdict);
});
it('a rejected train point still becomes an oos:false member', async () => {
  // fake platform rejects one specific params point → assert a train member exists with that paramsHash and no metrics
});
it('mode:none boundary → INCONCLUSIVE, no OOS member', async () => {
  // seed baseline boundary { mode:'none', lowConfidence:true }; expect verdict INCONCLUSIVE, zero oos:true members
});
it('GATE1 stop_insufficient_evidence (0-trade baseline, exit-only tunables) → no sweep, no train members', async () => {
  // baseline metrics totalTrades:0, profile has only tpLadder/hardStopPct tunables, entrySignalEvidence:false
});
it('empty top-N → sweep_failed', async () => {
  // fake platform returns totalTrades:0 for all points → ranked empty; train members still written; terminalReason 'sweep_failed'
});
it('interpreter always extend beyond maxRounds → round_limit_reached', async () => { /* FakeResultInterpreter overridden to always 'extend' */ });
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/research/experiment-service.wfo.test.ts` → FAIL.
- [ ] **Step 3: Implement** deps + `runWalkForwardOptimization` per the flow.
- [ ] **Step 4: Run — expect PASS** — → PASS (all cases).
- [ ] **Step 5: Full research suite + typecheck** — `pnpm typecheck && npx vitest run src/research` → PASS (baseline lane zero-diff).
- [ ] **Step 6: Commit**

```bash
git add src/research/experiment-service.ts src/research/experiment-service.wfo.test.ts
git commit -m "feat(research): runWalkForwardOptimization 1-fold WFO decision contour"
```

---

## Task 12: Env + composition wiring

**Files:**
- Modify: `src/config/env.ts` (`WFO_GATE1_ADAPTER`/`WFO_SWEEP_DESIGNER_ADAPTER`/`WFO_RESULT_INTERPRETER_ADAPTER` + `_MODEL` envs, mirroring `STRATEGY_CRITIC_ADAPTER`/`_MODEL` via `resolveAdapter`)
- Modify: `src/mastra/compose-mastra.ts` (register the three agents behind `*_ADAPTER === 'mastra'`)
- Modify: `src/composition.ts` (`buildGate1`/`buildSweepDesigner`/`buildResultInterpreter` + construct `ParamGridRunner` + pass all WFO deps into `ExperimentService`)
- Test: `src/composition.test.ts` (or the existing composition smoke test)

**Interfaces:**
- Consumes: T9 adapters/factories, T7 runner, T11 deps.
- Produces: `composeRuntime().services.experimentService` constructed with `gate1`, `sweepDesigner`, `resultInterpreter`, `paramGridRunner`, `wfoBudget` (defaults `{ maxRounds:2, maxPointsPerRound:8, minTradesTrain:3, topN:3 }`).

- [ ] **Step 1: Failing test** — assert `composeRuntime()` builds without throwing and the fake agents are wired when `WFO_*_ADAPTER` unset (fake path):

```ts
it('composeRuntime wires WFO fakes by default', () => {
  const { services } = composeRuntime();
  expect(services.experimentService).toBeDefined();      // constructed with WFO deps, no throw
});
```

- [ ] **Step 2: Run — expect FAIL** — `npx vitest run src/composition.test.ts` → FAIL (missing deps).
- [ ] **Step 3: Implement** env + compose-mastra registration + composition builders (mirror `buildCritic`/`buildStrategyCritic`: prefer Mastra entry, else warn + Fake).
- [ ] **Step 4: Run — expect PASS** — → PASS.
- [ ] **Step 5: Typecheck + suite** — `pnpm typecheck && npx vitest run src/composition.test.ts src/research` → PASS.
- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/mastra/compose-mastra.ts src/composition.ts src/composition.test.ts
git commit -m "feat(research): wire WFO agents + ParamGridRunner into composition"
```

---

## Task 13: One-shot trigger `scripts/run-strategy-wfo.mts`

**Files:**
- Create: `scripts/run-strategy-wfo.mts` (mirror `scripts/run-strategy-baseline.mts` header + env guards)

**Interfaces:**
- Consumes: `composeRuntime()`, `runWalkForwardOptimization`.

**Behaviour:** env-guarded (`*_ADAPTER=mastra` for gate1/sweep/interpreter + `BUILDER_ADAPTER=mastra`, `TRADING_PLATFORM_INTEGRATION=backtester`, DB/Redis, `MODEL_PROVIDER` + key); inputs `BASELINE_EXPERIMENT_ID` (required) + `STRATEGY_PROFILE_ID`; rebuild/load the strategy bundle the same way `run-strategy-baseline.mts` does; load the profile; call `runWalkForwardOptimization`; print `{ experimentId, verdict, terminalReason }` + per-member `{ role, oos, params, tradeCount, strategyBacktestRunId }`.

- [ ] **Step 1: Write the script** — copy the `run-strategy-baseline.mts` structure (env validation block, `composeRuntime()`, `try/finally { queue.close(); pool.end() }`); swap the baseline call for the WFO call; add the `*_ADAPTER=mastra` guards for the three WFO agents.

- [ ] **Step 2: Typecheck the script standalone** (it's outside tsconfig include, like the sibling scripts):

Run: `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --allowImportingTsExtensions --skipLibCheck scripts/run-strategy-wfo.mts`
Expected: no errors.

- [ ] **Step 3: Full gate** — `pnpm typecheck && pnpm test` → all green.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-strategy-wfo.mts
git commit -m "feat(research): run-strategy-wfo one-shot trigger"
```

---

## Post-plan verification (whole-branch)

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` — full suite green; overlay + strategy-baseline lanes behaviourally unchanged.
- [ ] Grep guard: `grep -rn "parameterGrid\|\.oos\b" src/read-api src/adapters/repository` shows the new fields mapped in both adapters + DTOs.
- [ ] Opus whole-branch review before PR (per prior slices).
- [ ] Live run deferred: shares Slice A's data-gate (6-day slice → `mode:'none'` → `INCONCLUSIVE`; long_oi 0-trade OPEN follow-up). Record any live attempt in a runbook note like Slice A §6.

## Deferred (not in this plan)

- N-fold WFA + GATE2 robustness (data-gated ≥60d).
- Production research task/handler + paper-candidate → 036 bridge (Phase D).
- office panels (Phase E).
