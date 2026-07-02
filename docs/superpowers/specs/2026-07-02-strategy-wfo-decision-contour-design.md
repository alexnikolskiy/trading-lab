# Slice B — Strategy WFO decision contour (GATE1 → sweep-designer → 1-fold WFO → result-interpreter)

**Date:** 2026-07-02
**Status:** design, approved (Variant A + review edits) — pending spec review
**Predecessors:** [Slice A — strategy-baseline ExperimentService lane] (`2026-07-01-strategy-baseline-experimentservice-lane-design.md`, merged PR #120 a5ffeeb) + risk/exec-ref fix (PR #121 e35cb2b, live-proven the chain). Roadmap: `2026-06-30-backtest-research-orchestrator-roadmap.md` §2 (WFO), §2.5 (holdout by trade-count), §3 (funnel), §4 (pre-paper contour), §5 (token-economy).

---

## 1. Goal

After a strategy **baseline** run (Slice A), decide — with LLM only at judgment points — whether and how to tune the strategy's parameters before a paper/no-go verdict, by **sweeping `request.params` over the FIXED `bundle_hash`** (never rebuilding). This slice builds the **pre-paper decision contour** end-to-end at **1-fold** depth:

```
[baseline experiment, Slice A]
   → GATE1 decision-agent  ("worth improving?" over profile + baseline metrics)
   → sweep-designer (LLM)  (combined grid over the profile's tunable params)
   → ParamGridRunner       (deterministic: expand grid → submit variants on TRAIN → collect → top-N pre-filter)
   → result-interpreter (LLM, sees ONLY top-N)  → select | extend (≤1 more round) | stop
   → [on select] ONE holdout (OOS) run of the chosen params  → verdict via evaluateStrategyBaseline
```

**Prove the contour, not statistical validity.** Mirrors Slice A: the full N-fold WFA/WFO (roadmap Phase B2/C full) is data-gated at ≥60 days; we have a ~6-day mock slice. This slice is a **1-fold subset** — unit-proven deterministically + agent fixtures; live-proof shares Slice A's data-gate (6-day slice degrades to `mode:'none'` → `INCONCLUSIVE`; the live long_oi baseline currently yields 0 trades — a separate OPEN follow-up).

## 2. Scope

**In:** GATE1 decision-agent · sweep-designer · deterministic `ParamGridRunner` + top-N pre-filter · result-interpreter · `ExperimentService.runWalkForwardOptimization` orchestrator (1-fold) · the **`request.params` submit contract** (see §4) · one-shot trigger script.

**Out (deferred / data-gated):**
- **GATE2 WFA validation** (regime breakdown, multi-fold robustness) — needs ≥60d.
- **N-fold** WFO (`FoldPlanBuilder`/`WFAOrchestrator`) — 1-fold only here.
- Production research task/handler (one-shot script only, like `run-strategy-baseline.mts`).
- Paper-candidate → platform 036 intake bridge (Phase D).
- office panels (Phase E).
- Cycle-2 hypothesis-proposer contour.

## 3. Architecture (Variant A)

Orchestrator method on the existing `ExperimentService` + three Mastra agents + one deterministic runner. LLM lives only at the three judgment points (§5 roadmap: enumeration/aggregation/filtering is deterministic code; the LLM **never** sees the whole sweep).

| Unit | Kind | Location | Responsibility |
|---|---|---|---|
| `Gate1DecisionAgent` | Mastra agent | `src/mastra/agents/` + port in `src/ports/` | profile + baseline metrics + decision-record evidence → `{ decision, reason }`, `decision ∈ { 'improve', 'allow_exploratory_sweep', 'stop_not_worth', 'stop_insufficient_evidence' }` (see §7); `improve`/`allow_exploratory_sweep` proceed to the sweep, both `stop_*` are terminal |
| `SweepDesigner` | Mastra agent | `src/mastra/agents/` + port | profile tunables + baseline summary + `period.to=T` → combined grid `{ paramName: [values] }` |
| `ParamGridRunner` | deterministic | `src/research/param-grid-runner.ts` | expand grid → dedupe → submit each point on TRAIN via the strategy executor → collect → top-N pre-filter |
| `ResultInterpreter` | Mastra agent | `src/mastra/agents/` + port | top-N (train) + `period.to=T` → `{ decision: 'select' \| 'extend' \| 'stop', chosenParams?, extendHint? }` |
| `runWalkForwardOptimization` | orchestrator | `src/research/experiment-service.ts` | round loop, fixed boundary T, persistence, kill-switch, verdict |

Each agent gets a **fake** sibling for composition/tests (existing convention: `FakeStrategyAnalyst`, etc.), wired in `composition.ts` behind `*_ADAPTER=mastra`.

## 4. The `request.params` submit contract (REQUIRED — the load-bearing fix)

**Finding (verified):** the strategy executor **already** threads `params` into the identity hash and persistence — `computeStrategyParamsHash({ bundleHash, platformRun, params })`, `StrategyExperimentRunRequest.params`, and the persisted `strategy_backtest_run.params` all exist (Slice A). **The single gap:** `submitStrategyResearchRun` has **no `params` option**, so `req.params` never reaches the platform request — the engine runs default `manifest.params` every time. Result today: distinct grid points get distinct `params_hash` + persisted params but run the **identical backtest** → identical metrics. WFO would be a no-op.

**Fix (no SDK bump — vendored `RunSubmitRequest.params?: Record<string, unknown>` already exists, `contracts/index.d.ts:45` + 017 `backtest-run-request.schema.json`; engine merges `request.params` over `manifest.params` in `simulateTarget`, roadmap §2):**

1. `SubmitStrategyResearchRunOptions.params?: Record<string, unknown>` (port `research-platform.port.ts`).
2. `HttpBacktesterAdapter.submitStrategyResearchRun`: spread `...(opts.params && Object.keys(opts.params).length ? { params: opts.params } : {})` into the `BtRunSubmitRequest` (omit when empty → byte-identical to a no-params baseline run).
3. `MockResearchPlatformAdapter.submitStrategyResearchRun`: honor `opts.params` so fabricated metrics **vary by params** — required for deterministic unit tests that assert grid points differ (e.g. derive a deterministic metric perturbation from a stable hash of params).
4. `BacktesterStrategyExperimentRunExecutor.execute`: pass `params: req.params` in the `submitStrategyResearchRun(...)` call (currently omitted). Hash/persist paths unchanged (already correct).

**No migration — but domain/repo/DTO wiring IS required.** The DB columns already exist (`src/db/schema.ts:315`: `research_experiment.parameter_grid`, `experiment_run_member.params`, `experiment_run_member.oos`, `experiment_run_member.params_hash`), so no migration. **However, they are not yet threaded through the domain/repo layer** — Slice B must wire:
- `ResearchExperiment` (domain, `research-experiment.ts`) — add `parameterGrid?: ParameterGrid`.
- `ExperimentRunMember` (domain) — add `params?: Record<string, unknown>` and `oos?: boolean` (currently only `paramsHash`/`bundleHash` exist).
- `ResearchExperimentRepository` port + `drizzle-research-experiment.repository.ts` — map `parameterGrid` on create/read; `addMember` currently writes `paramsHash` but **not** `params`/`oos` → extend the INSERT + row mappers (in-memory adapter too).
- Read API DTO + `src/read-api/mappers.ts` — surface `parameterGrid` / member `params` / `oos`.
- `ExperimentType` TS union — add `'walk_forward_optimization'` (domain-level, not a DB check).

Without this wiring the ledger records `params_hash` but drops the actual `params`/`oos`, making the WFO ledger useless for later analysis.

## 5. WFO 1-fold data flow

**Boundary T (fixed ONCE, §2.5):** reuse Slice A's `HoldoutBoundaryResolver` on the **baseline** run's sanity trades → `T`. `T` is fixed for the whole WFO experiment. Sweep params change the trade distribution; if each param-set recomputed its own T the sets would be incomparable (§2.5). Variant holdout members with `trade_count < minTradesHoldout` carry a `low_confidence` flag — they do **not** move T.

**Per round r (≤2 rounds):**
1. `SweepDesigner` proposes a combined grid over ≤N tunable params (≤8 points/round after expansion).
2. `ParamGridRunner` runs **each grid point on TRAIN `[from, T)`** (executor with that point's `params`), collects metrics.
3. Deterministic **top-N pre-filter** (§6) → top-N by train metric.
4. `ResultInterpreter` sees **only top-N** (+ `period.to = T`): `select` / `extend` (→ round r+1, if r < 2) / `stop`.

**On `select`:** run **ONE holdout (OOS) run `[T, to]`** with the chosen params → this is the sole OOS measure. Verdict via the reused `evaluateStrategyBaseline` on the OOS metrics: `PAPER_CANDIDATE` / `FAIL`. `boundary.mode === 'none'` (insufficient data) → `INCONCLUSIVE` (as Slice A).

**No-leakage (§2.5):** both `SweepDesigner` and `ResultInterpreter` receive **only train-window summaries and `period.to = T`** — never any holdout data. Holdout runs strictly after `select`.

## 6. Top-N ranking (deterministic, trade-gated)

Applied to train-window metrics before the LLM ever sees them:

1. **Drop** points with `totalTrades === 0` (a zero-trade point is not a candidate; if ALL points are zero-trade → `sweep_failed`).
2. Points with `totalTrades < minTradesTrain` (default `minTradesTrain = 3`, config on the WFO request) → keep but tag `low_confidence` (a single lucky trade must not win on Sharpe alone).
3. Sort survivors: `sharpe desc → profitFactor desc → maxDrawdownPct asc → netPnlPct desc`. `low_confidence` points rank **below** full-confidence points regardless of raw metric.
4. Take top-N (default N=3).

## 7. GATE1 semantics (not a blind stop)

Input: profile (`parameters[]` tunables, `entryConditions`, direction) + baseline metrics + baseline decision-record evidence summary.

- baseline `totalTrades ≥ 1` → `improve` (normal sweep) or `stop_not_worth` (baseline already strong — configurable threshold).
- baseline `totalTrades === 0` → allowed into a sweep **only** as `allow_exploratory_sweep`, and **only** if the profile has tunable params that can plausibly affect **entry** — i.e. an **entry gate / signal threshold / entry filter strictness / cooldown / warmup-signal-age** param. Otherwise → **`stop_insufficient_evidence`**.
- **Anti-waste guard (explicit):** **exit/risk-only** tunables (e.g. `tpLadder.*`, `hardStopPct`, `maxHoldMin`, `protection.*`) are **NOT** sufficient for an exploratory sweep at 0 trades — they cannot turn a non-entry into an entry. `0 trades` + only exit/risk tunables → `stop_insufficient_evidence`. The classification is by param **role** (entry-affecting vs exit/risk), derived from the profile param name/description; the sweep-designer's grid at 0-trade baseline is restricted to the entry-affecting subset.

> Live long_oi today: baseline 0 trades, decision-records show `dump_detected` but no `enter`. It qualifies for `allow_exploratory_sweep` because it has **entry-affecting** tunables — `dump.minDropPct` / `dump.triggerMode` / `dump.highToLow*` (entry signal threshold), `entry.minBouncePctFromLow` / `entry.fastBouncePct` / `entry.requireGreenPriceCandles` (entry gate), `oiFilter.entryMinOiRecoveryPct2m` / `liqFilter.*` (entry filters), `watch.cooldownMinutes`, `warmup.maxSignalAgeMin` — NOT because of its exit-only `tpLadder.*`/`hardStopPct`/`maxHoldMin`. The 0-trade grid targets those entry params. **paper remains forbidden without OOS evidence** — an exploratory sweep reaches at most `INCONCLUSIVE`/`FAIL` on the current data, never `PAPER_CANDIDATE`.

## 8. Bounds, terminal reasons, token-economy

- **Caps:** ≤8 grid points/round; ≤2 rounds (≤16 train runs + ≤2 holdout runs).
- **Terminal reasons:** `stop_not_worth`, `stop_insufficient_evidence`, `grid_too_large` (designer proposed > cap after expansion), `round_limit_reached`, `budget_exhausted`, `sweep_failed` (empty top-N / all points rejected/zero-trade), plus the verdict outcomes `paper_candidate` / `holdout_failed` / `inconclusive`.
- **Kill-switch:** reuse the `correlationId`-keyed cumulative token/backtest budget (PR #86). Exceeding it → `budget_exhausted` (terminal, between rounds — never mid-round).
- **Never a silent fallback:** an LLM error at a judgment point is terminal (§5), not a default choice.

## 9. Persistence (ledger)

- New `research_experiment` row, `experiment_type = 'walk_forward_optimization'`, `parameter_grid` = the union of proposed grids, `holdout_boundary` = the fixed T (copied from baseline), `bundle_hash` = the fixed strategy bundle hash. `experiment_key` = stable hash over `{ baselineExperimentId, bundleHash, parameterGrid }` for idempotent re-runs.
- Each grid point = a `strategy_backtest_run` (distinct `params_hash`) linked as an `experiment_run_member`: train members `oos=false`, the chosen holdout member `oos=true`, each carrying `params` + `params_hash` + `trade_count`.
- **Aggregates computed ONLY over `oos=true` members** (roadmap §2 invariant).

## 10. Trigger

One-shot `scripts/run-strategy-wfo.mts` over an existing baseline experiment (analogue of `run-strategy-baseline.mts`): env-guarded (`BUILDER_ADAPTER`/`*_ADAPTER=mastra`, `TRADING_PLATFORM_INTEGRATION=backtester`, DB/Redis, model keys), takes `BASELINE_EXPERIMENT_ID` (or resolves the latest baseline for a `STRATEGY_PROFILE_ID`), prints `{ experimentId, verdict }` + per-round grid + chosen params + OOS member. Production task/handler deferred.

## 11. Error handling

- Invalid/rejected grid point (engine rejects a param set) → that member `rejected`; the sweep continues with the rest; top-N over successes. (The risk/exec-ref fix from PR #121 already prevents the whole-run `missing_risk_profile` rejection.)
- Empty top-N (all rejected or all zero-trade) → `sweep_failed` (terminal).
- Boundary `mode:'none'` → `INCONCLUSIVE` (no OOS possible on short data), sweep still recorded.
- Transient submit/poll error → propagates to the executor's existing retry/`resumeToken` idempotency (per-point `resumeToken` already keyed on `paramsHash`).

## 12. Testing

- **Deterministic units:** `ParamGridRunner` grid-expansion (cardinality, dedupe, `grid_too_large`), top-N ranking (trade-gate, low-confidence ordering, all-zero → `sweep_failed`), `params_hash` distinctness per point.
- **Agents on fixtures:** structured-output shape + no-leakage (assert the prompt/context carries `period.to=T` and no post-T data) for GATE1 / sweep-designer / result-interpreter. GATE1 anti-waste guard: `0 trades` + only exit/risk tunables → `stop_insufficient_evidence`; `0 trades` + entry-affecting tunables → `allow_exploratory_sweep` with the grid restricted to the entry-affecting subset.
- **Domain/repo wiring:** round-trip test that `parameterGrid` (experiment) and `params`/`oos` (member) persist and read back through the repo adapters + read DTO/mappers (the columns exist but were unmapped before Slice B).
- **Orchestrator lifecycle** (fake platform that varies metrics by params): full contour, `extend` round, `select` → OOS → verdict, `mode:'none'` → INCONCLUSIVE, `budget_exhausted`, `round_limit_reached`, all-rejected → `sweep_failed`, GATE1 `stop_insufficient_evidence` vs `allow_exploratory_sweep`.
- **Submit-contract regression:** wire test asserts `submitStrategyResearchRun` puts `opts.params` into the request (and omits when empty); mock adapter varies metrics by params.
- **Overlay-lane zero-diff:** Slice A / overlay paths behaviourally unchanged.
- **Gates:** `pnpm typecheck` clean, full suite green.

## 13. Open items / deferred

- **N-fold WFA + GATE2** (regime robustness) — data-gated ≥60d, roadmap Phase B2/C full.
- **Live tradeCount>0 proof** — shares Slice A's data-gate; depends on the OPEN long_oi "detect-but-no-enter" follow-up and/or richer (VPS 1m+taker) data.
- **Production task/handler + paper bridge (Phase D)** — after the contour is proven.
