# Walk-Forward Analysis & Research Experiment Registry — Design Spec (sp9)

**Date:** 2026-06-28  
**Repo:** trading-lab  
**Status:** DRAFT — ready for Claude Code planning

---

## 1. Context & Motivation

### Current state

trading-lab уже реализует один research flow:

```
StrategyProfile
→ HypothesisProposal
→ HypothesisBuild (ModuleBundle)
→ BacktestRun (via trading-backtester)
→ Evaluation
→ PASS / MODIFY / FAIL / INCONCLUSIVE / PAPER_CANDIDATE
```

Этот flow отвечает на вопрос «работает ли эта конкретная гипотеза на данном периоде?»

### Проблема

Один backtest на одном периоде — недостаточно. Стратегия может:
- переоптимизироваться под конкретный период (overfitting)
- работать только в одном рыночном режиме (trend/flat/high-vol)
- «запомнить» аномалии, а не обнаружить устойчивые паттерны

### Решение

Нужны два взаимосвязанных компонента:

1. **Research Experiment / Run Series Registry** — persistent container для серий runs: зачем запущены, с какими окнами, какой aggregate verdict
2. **Walk-Forward Orchestration** — оркестрация последовательных backtestов по скользящим окнам с aggregate evaluation

---

## 2. Архитектурная карта (подтверждённая)

```
trading-lab
  владеет:
  ✓ ResearchExperiment (NEW)
  ✓ ExperimentRunMember (NEW)
  ✓ WFA Orchestrator (NEW)
  ✓ StrategyProfile, HypothesisProposal, HypothesisBuild, BacktestRun, Evaluation

trading-backtester
  владеет:
  ✓ single-run deterministic execution
  ✓ validate → submit → status/result/artifacts
  ✓ workflowId, correlationId, resumeToken (уже есть — используем)

trading-platform / trading-mock-platform
  владеет:
  ✓ historical rows / market data
  ✓ paper admission/proof/execution (platform)
  ✓ ops-read

trading-office
  владеет:
  ✓ read-only visualization
  → добавить: experiment panels, WFA fold view
```

**Важно:** trading-backtester остаётся single-run executor. Он НЕ становится WFA-оркестратором. Весь research-смысл серии живёт в trading-lab.

---

## 3. Новые сущности (schema)

### 3.1 `research_experiment`

```sql
research_experiment
  id                    uuid PK
  experiment_type       enum: new_strategy_validation | paper_improvement | walk_forward | robustness_suite | regression_suite
  strategy_profile_id   uuid FK → strategy_profiles
  hypothesis_id         uuid FK → hypothesis_proposals (nullable)
  build_id              uuid FK → hypothesis_builds (nullable)
  bundle_hash           text
  objective             text                    -- зачем запущен этот эксперимент
  dataset_scope         jsonb                   -- symbols, exchange, timeframe
  fold_policy           jsonb                   -- train_days, test_days, step_days, min_trades_per_fold
  metrics_policy        jsonb                   -- thresholds: pass_rate, max_drawdown_regression, etc.
  status                enum: pending | running | completed | failed | cancelled
  verdict               enum: PASS | FAIL | MODIFY | INCONCLUSIVE | PAPER_CANDIDATE | null
  verdict_reason        text
  aggregate_metrics     jsonb                   -- pass_rate, avg_delta_pnl, median_delta_pnl, worst_fold, etc.
  regime_breakdown      jsonb                   -- pass_rate by bullish/bearish/sideways/high_vol
  phoenix_trace_id      text
  created_at            timestamptz
  completed_at          timestamptz
```

### 3.2 `experiment_run_member`

```sql
experiment_run_member
  id                    uuid PK
  experiment_id         uuid FK → research_experiment
  backtest_run_id       uuid FK → backtest_runs
  role                  enum: sanity | targeted_failure | fold_test | regression | holdout | stress | canary
  fold_id               int (nullable)          -- порядковый номер fold в WFA
  window_id             text (nullable)
  period_from           timestamptz
  period_to             timestamptz
  symbols               text[]
  params_hash           text
  bundle_hash           text
  regime_label          text                    -- bullish | bearish | sideways | high_vol | mixed
  result_summary        jsonb                   -- PnL, sharpe, drawdown, trade_count, pass/fail
  created_at            timestamptz
```

### 3.3 `experiment_evaluation`

```sql
experiment_evaluation
  id                    uuid PK
  experiment_id         uuid FK → research_experiment
  evaluator_version     text
  raw_scores            jsonb
  flags                 jsonb                   -- fragility_flags, coverage_warnings, top_trade_dependency
  verdict               enum: PASS | FAIL | MODIFY | INCONCLUSIVE | PAPER_CANDIDATE
  verdict_reason        text
  created_at            timestamptz
```

---

## 4. WFA — как работает

### Fold Policy

```
train_days:  количество дней в обучающем окне  (рекомендуется 30–60 для intraday)
test_days:   количество дней в тестовом окне   (рекомендуется 10–15 для intraday)
step_days:   сдвиг окна                        (обычно = test_days, no-overlap)
min_trades_per_fold: минимум сделок для valid fold (рекомендуется ≥ 30)
```

### Визуализация скользящих окон

```
История: [---|---|---|---|---|---|---|---|---|---|]

Fold 1:
  train:  [---train---]
  test:              [--test--]

Fold 2:
  train:      [---train---]
  test:                  [--test--]

Fold 3:
  train:          [---train---]
  test:                      [--test--]
```

### Инвариант корректности (no data leakage)

**КРИТИЧЕСКИ ВАЖНО:** bundle_hash фиксируется ОДИН РАЗ до начала WFA. Один и тот же bundle_hash используется для всех foldов. Параметры стратегии НЕ меняются между foldами.

Агент-researcher НЕ должен видеть результаты test-foldов при генерации следующей гипотезы. В контексте LLM-генерации это structural protection — bundle зафиксирован до запуска WFA.

### WFA Flow в trading-lab

```
WFA Orchestrator (trading-lab)
  1. Получает: strategy_profile_id + build_id + bundle_hash + dataset_scope + fold_policy
  2. Создаёт ResearchExperiment(type='walk_forward', status='running')
  3. Строит fold plan: список (period_from, period_to, fold_id) по fold_policy
  4. Для каждого fold:
     a. POST /v1/runs к trading-backtester
        body: { bundleHash, datasetScope: {from, to, symbols}, workflowId: experiment.id, correlationId: fold_id, role: 'fold_test' }
     b. Polling: GET /v1/runs/:id/status (или webhook если есть)
     c. GET /v1/runs/:id/result → извлечь result_summary
     d. Сохранить ExperimentRunMember { experiment_id, backtest_run_id, fold_id, period_from, period_to, result_summary, regime_label }
  5. После всех foldов:
     a. Вычислить aggregate_metrics
     b. Запустить WFAEvaluator
     c. Получить verdict
     d. Обновить ResearchExperiment { status: 'completed', verdict, aggregate_metrics }
  6. Если verdict == PAPER_CANDIDATE:
     → создать PaperCandidateRequest → platform paper admission
```

---

## 5. Aggregate Metrics

Вычисляются по всем foldам после завершения WFA:

```typescript
interface WFAAggregateMetrics {
  folds_total: number;
  folds_valid: number;          // folds с достаточным числом сделок
  folds_passed: number;
  pass_rate: number;            // folds_passed / folds_valid

  avg_delta_pnl: number;        // средний PnL по тестовым окнам
  median_delta_pnl: number;
  worst_fold_delta: number;     // наихудший fold PnL

  avg_sharpe: number;
  min_sharpe: number;

  max_drawdown_avg: number;
  max_drawdown_worst: number;
  max_drawdown_regression: number;  // vs baseline single backtest

  trade_count_avg: number;
  trade_count_min: number;      // если < min_trades_per_fold → coverage warning

  // Regime breakdown
  regime_breakdown: {
    bullish:   { folds: number; pass_rate: number };
    bearish:   { folds: number; pass_rate: number };
    sideways:  { folds: number; pass_rate: number };
    high_vol:  { folds: number; pass_rate: number };
  };

  // Fragility flags
  top_trade_dependency: boolean;   // top-1 trade > 50% total PnL
  parameter_stability: 'stable' | 'unstable';
  coverage_warnings: string[];
  fragility_flags: string[];
}
```

### Verdict Thresholds (defaults, configurable per experiment)

```typescript
interface EvaluatorThresholds {
  min_pass_rate: 0.6;              // минимум 60% folds должны пройти
  min_folds_valid: 4;              // минимум 4 valid fold для PASS
  max_drawdown_regression: 0.2;    // drawdown не хуже baseline + 20%
  min_trade_count_per_fold: 30;    // иначе → coverage warning → INCONCLUSIVE
  top_trade_dependency_limit: 0.5; // иначе → fragility flag
}
```

---

## 6. Воронка проверки (двойной цикл)

### Цикл 1 — Новая стратегия

```
new strategy → critic → analyst → StrategyProfile
  → builder → ModuleBundle (bundle_hash зафиксирован)
  → [GATE 1] sanity run (1 backtester call)
      ↓ FAIL → reject immediately
      ↓ PASS (executes, trades > 0, metrics non-garbage)
  → [GATE 2] mini-WFA (3–5 folds: different regimes + holdout)
      ↓ FAIL → MODIFY or reject
      ↓ pass_rate ≥ 0.6, no fragility flags
  → [GATE 3] full WFA (6–10 folds, all regimes)
      ↓ PAPER_CANDIDATE
  → platform paper admission → paper runtime → cycle 2
```

### Цикл 2 — Улучшение по paper-результатам

```
paper degradation signal (from platform ops-read)
  → [GATE A] targeted backtest (1 call, проблемный период)
      ↓ FAIL → discard hypothesis
      ↓ improvement detected
  → [GATE B] regression test (1–2 calls, нормальные периоды)
      ↓ regression found → MODIFY or discard
      ↓ no regression
  → [GATE C] robustness suite / mini-WFA (3–5 folds)
      ↓ устойчив
  → platform paper canary (side-by-side с текущей стратегией)
  → compare live paper results
  → [optional] full WFA если хотим полностью заменить стратегию
```

### Experiment Types по воронке

| Gate | experiment_type | Folds | Backtests |
|------|----------------|-------|-----------|
| GATE 1 | `new_strategy_validation` | 0 | 1 (sanity) |
| GATE 2 | `robustness_suite` | 3–5 | 3–5 |
| GATE 3 | `walk_forward` | 6–10 | 6–10 |
| GATE A | `paper_improvement` | 0 | 1 (targeted) |
| GATE B | `regression_suite` | 0 | 1–2 |
| GATE C | `robustness_suite` | 3–5 | 3–5 |

---

## 7. Интеграция с существующим кодом

### ResearchPlatformPort (уже есть)

```typescript
// Текущий port в trading-lab уже имеет:
interface ResearchPlatformPort {
  submitOverlayRun(params: {
    bundleHash: string;
    datasetScope: DatasetScope;
    workflowId?: string;       // ← используем experimentId
    correlationId?: string;    // ← используем foldId
    resumeToken?: string;
    callbackUrl?: string;
  }): Promise<{ runId: string }>;

  getRunStatus(runId: string): Promise<RunStatus>;
  getRunResult(runId: string): Promise<RunResult>;
}
```

В MVP trading-backtester НЕ меняем. workflowId/correlationId echo уже есть.

### Evaluation (уже есть)

Текущий Evaluator возвращает PASS/FAIL/MODIFY/INCONCLUSIVE/PAPER_CANDIDATE для single run. Для WFA нужен новый `WFAEvaluator`, который принимает массив `ExperimentRunMember[]` + `WFAAggregateMetrics` и выносит aggregate verdict.

### Read API (sp5, уже есть)

Добавить эндпоинты:

```
GET /v1/experiments
GET /v1/experiments/:id
GET /v1/experiments/:id/runs
GET /v1/experiments/:id/evaluation
```

---

## 8. Roadmap (поэтапная реализация)

### Phase A — Research Experiment Registry (foundation)

**Репозиторий:** trading-lab  
**Цель:** persistent storage для серий runs без оркестрации

Deliverables:
- [ ] DB migration: `research_experiment`, `experiment_run_member`, `experiment_evaluation`
- [ ] `ResearchExperimentRepository` — CRUD
- [ ] `ExperimentService` — createExperiment, addRunMember, finalizeExperiment(verdict)
- [ ] Read API: `GET /v1/experiments`, `GET /v1/experiments/:id`
- [ ] Tests: unit для service, integration для repository

Out of scope: оркестрация, WFA планировщик, office panels

---

### Phase B — Walk-Forward Orchestration (core)

**Репозиторий:** trading-lab  
**Цель:** автоматическая оркестрация foldов через trading-backtester

Deliverables:
- [ ] `FoldPlanBuilder` — строит список (from, to, fold_id) по FoldPolicy
- [ ] `WFAOrchestrator` (Mastra workflow или service) — координирует fold execution
  - parallel или sequential fold dispatch к backtester
  - polling / webhook для каждого run
  - persist ExperimentRunMember после каждого fold
  - graceful resume при падении (через resumeToken)
- [ ] `WFAAggregateComputer` — вычисляет все aggregate metrics
- [ ] `WFAEvaluator` — aggregate verdict по thresholds
- [ ] `RegimeLabeler` — классифицирует каждый fold по рыночному режиму
  - использует mock-platform или platform /historical/rows для OHLCV
  - simple heuristic: trend strength, volatility percentile
- [ ] Tests: unit для FoldPlanBuilder, WFAAggregateComputer, WFAEvaluator

**Важные инварианты:**
- bundle_hash НЕ меняется между foldами
- Orchestrator использует `workflowId = experiment_id`, `correlationId = fold_id`
- При INCONCLUSIVE из-за малого числа сделок — не продвигать к PAPER_CANDIDATE

---

### Phase C — Experiment → Paper Candidate Bridge

**Репозиторий:** trading-lab  
**Цель:** автоматический переход от WFA PAPER_CANDIDATE к platform paper admission

Deliverables:
- [ ] `PaperCandidateBridge` — если verdict == PAPER_CANDIDATE → создать PaperCandidateRequest
- [ ] Attach: experiment_id, aggregate_metrics, WFA summary как evidence
- [ ] Integrate с существующим platform paper intake (036 spec)
- [ ] Tests: integration test WFA → paper candidate flow

---

### Phase D — trading-office Experiment Panels

**Репозиторий:** trading-office  
**Цель:** read-only визуализация экспериментов

Deliverables:
- [ ] `GET /api/office/experiments` — список экспериментов
- [ ] `GET /api/office/experiments/:id` — detail: folds, aggregate metrics, verdict
- [ ] Experiment list panel: status, verdict, strategy name, date
- [ ] WFA fold timeline: fold N → PASS/FAIL с PnL bar
- [ ] Aggregate metrics card: pass_rate, worst_fold, regime breakdown
- [ ] Paper candidate link (если PAPER_CANDIDATE)

Source of truth: trading-lab read API (не backtester напрямую)

---

### Phase E — Backtester Run Metadata (optional, later)

**Репозиторий:** trading-backtester  
**Цель:** convenience если lab захочет фильтровать runs по experiment context

Deliverables:
- [ ] Echo `workflowId`, `correlationId`, `experimentId`, `role` в status/result response
- [ ] `GET /v1/runs?workflowId=:id` — list/filter runs by workflowId
- [ ] Tests

**Примечание:** В MVP этого НЕ нужно — lab хранит всю связку у себя через ExperimentRunMember.

---

## 9. Integrations & Dependencies

| Компонент | Зависимость | Примечание |
|-----------|-------------|------------|
| WFAOrchestrator | trading-backtester `/v1/runs` | Уже работает, workflowId поддержан |
| WFAOrchestrator | trading-mock-platform `/historical/rows` | Для demo/smoke без credentials |
| RegimeLabeler | trading-platform или mock | OHLCV для классификации режима |
| PaperCandidateBridge | trading-platform paper intake | 036 spec уже реализован |
| Office panels | trading-lab read API | sp5 уже реализован, расширяем |

---

## 10. Что НЕ входит в scope

- Новый backtest engine (backtester уже готов)
- ML-оптимизация параметров между foldами (следующий уровень)
- Auto-live execution (paper → live — отдельный процесс)
- Parameter grid search / hyperparameter tuning
- Multi-strategy portfolio WFA (пока single strategy per experiment)
- trading-platform хранит research experiments (НЕТ, только lab)

---

## 11. Key Constraints & Gotchas

1. **No data leakage**: bundle_hash фиксируется до WFA. Researcher agent не видит test-fold результаты при генерации.

2. **INCONCLUSIVE ≠ FAIL**: если сделок мало (< 30 per fold), это coverage issue, не провал стратегии. Нужно больше данных или другие symbols/timeframe.

3. **Regime-awareness**: стратегия с pass_rate 0.7 но работающая только в bullish — слабый кандидат. regime_breakdown обязателен.

4. **WFA не означает paper**: WFA — evidence. Paper admission — отдельный шаг через platform.

5. **Parallel fold execution**: foldы можно запускать параллельно (они независимы). Это ускоряет WFA но требует правильного concurrency в orchestrator.

6. **Graceful resume**: если orchestrator упал посередине WFA — нужно уметь продолжить с незавершённых foldов (через resumeToken или experiment status).

---

## 12. Acceptance Criteria (фаза A + B)

### Phase A
- [ ] `research_experiment` и `experiment_run_member` создаются и сохраняются
- [ ] Эксперимент можно создать с типом `new_strategy_validation`
- [ ] RunMember добавляется к эксперименту с корректными fold metadata
- [ ] `GET /v1/experiments/:id` возвращает experiment + run members
- [ ] Существующие backtest flows НЕ сломаны

### Phase B
- [ ] FoldPlanBuilder строит корректный план для заданной fold_policy и date range
- [ ] WFAOrchestrator запускает все foldы, ждёт результаты, сохраняет members
- [ ] После завершения всех foldов — aggregate metrics посчитаны, verdict вынесен
- [ ] При падении orchestrator после K foldов — resume работает без дублирования runs
- [ ] INCONCLUSIVE при folds_valid < min_folds_valid
- [ ] Smoke test: WFA через trading-mock-platform без real credentials
