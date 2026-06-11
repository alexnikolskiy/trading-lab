# SP-4 — Build & Backtest (design / spec)

**Дата:** 2026-06-11
**Фаза:** SP-4 (см. master design §8.3, §18)
**Статус:** approved (с 7 уточнениями ниже)
**Предыдущее:** SP-3 Research Cycle (PR #3, merged)

---

## 0. Цель и границы

SP-4 реализует **Build & Backtest workflow**: из `validated` `HypothesisProposal` собрать
`ModuleBundle` candidate (Builder Agent, полная кодогенерация), прогнать его через
детерминированный **Build Validator** (fast-fail), сохранить артефакт, отправить
`BacktestRunRequest` через **Mock** PlatformGateway, нормализовать результат в
`ComparisonSummary`, прогнать детерминированный **Evaluator** и персистировать решение.

**Жёсткие инварианты (из master design §12):**

1. `trading-lab` **никогда не исполняет** generated code. Build Validator — fast-fail gate,
   **не граница безопасности**. Авторитетная граница — платформенный sandbox 019 (SP-5).
2. Builder **не submit'ит** и не делает platform side-effects. **Orchestrator владеет side-effects.**
3. Все LLM-выходы schema-validated; все accept/reject gates детерминированы.
4. Bundle остаётся `candidate` до приёма платформой (SP-5).

**Вне scope SP-4 (явно):** Mastra suspend/resume (SP-5), реальный platform-контракт (SP-5),
`BacktestTrade` per-trade rows (SP-5 — у mock нет индивидуальных сделок), parameter sweep (later),
paper validation (SP-6), LLM-комментарий Evaluator (YAGNI).

---

## 1. Принятые архитектурные решения (4 forka)

| Решение | Выбор |
|---|---|
| **Build Validator depth** | Static-structural fast-fail only. Без TS-typecheck/исполнения. |
| **Comparison shape** | Narrowed lab-side `ComparisonSummary` (typed metric blocks). |
| **Workflow shape** | Synchronous `hypothesis.build` handler (mock immediate). Suspend/resume → SP-5. |
| **BacktestTrade** | Defer to SP-5. SP-4 создаёт `hypothesis_build` / `backtest_run` / `evaluation`. |

---

## 2. Уточнения (7, обязательны к учёту в spec)

### 2.1 ComparisonSummary — typed, не `Record<string, number>`

```ts
export interface BacktestMetricBlock {
  netPnlUsd: number;
  netPnlPct: number;
  totalTrades: number;
  winRate: number;                 // 0..1
  profitFactor: number;
  maxDrawdownPct: number;          // положительная величина; больше = хуже
  expectancyUsd: number;
  sharpe: number;
  topTradeContributionPct: number; // 0..100, доля PnL топ-сделки
}

export interface ComparisonSummary {
  baseline: BacktestMetricBlock;
  variant: BacktestMetricBlock;
  sampleSize: { baselineTrades: number; variantTrades: number };
  platformContractVersion: string;
}
```

Evaluator работает **только с typed fields** (никаких строковых ключей).

### 2.2 HypothesisBuild lifecycle — failed attempts персистируются

Row создаётся **до** Builder-вызова со `status='generating'`:

```
generating                              (row создан, Builder работает)
  → build_failed                        (Builder бросил → + issue builder_failed; terminal попытки)
  → build_failed                        (Build Validator fail → + validator issues; terminal попытки)
  → candidate                           (bundle valid + artifact stored)
  → submitted                           (Orchestrator отправил backtest)
```

`pending` из master design §17 опускаем: SP-4 создаёт row сразу в `generating`.
**Failed build attempts должны быть в БД**, не только в event-логе.

### 2.3 Bundle hash — lab вычисляет, supplied hash игнорируется

- LLM **никогда** не поставляет `bundleHash`.
- `assembleBundle(manifest, files)` **игнорирует любой supplied hash**.
- `bundleHash = sha256(canonical)`, где `canonical = stableStringify({ manifest, files })`
  с `manifest` **без** поля hash.
- Канонизация сортирует ключи объектов **и** пути файлов (последнее — следствие сортировки
  ключей `files`-объекта). Разделитель NUL **не нужен** — структурный JSON однозначен.
- Формат: `sha256:<hex>` (как `content_hash` / `sourceFingerprint` / `hypothesisFingerprint`).
- Тесты: (a) key-order independence (перестановка ключей manifest/files → тот же hash);
  (b) изменение содержимого файла → другой hash; (c) supplied hash игнорируется.

### 2.4 Build Validator restricted imports — явный denylist

Скан по тексту исходников всех `files` (fast-fail, **не** авторитетно). Denylist-токены:

```
fs, node:fs, child_process, node:child_process, net, node:net,
http, node:http, https, node:https,
process.env, eval, new Function, require, import(, fetch, WebSocket
```

`import(` ловит dynamic import. Allowed imports в SP-4 — **только SDK** (если вообще есть).
Любой импорт вне SDK-allowlist → issue `restricted_import`. Остаётся fast-fail, не security boundary.

### 2.5 Evaluator math — зафиксировано

```
deltaNetPnlUsd      = variant.netPnlUsd      - baseline.netPnlUsd
deltaMaxDrawdownPct = variant.maxDrawdownPct - baseline.maxDrawdownPct   // >0 = хуже
fragile             = variant.topTradeContributionPct >= fragilityTopTradePct
```

`maxDrawdownPct` — положительная величина, больше = хуже.
Условие **PAPER_CANDIDATE** использует `variant.profitFactor >= minProfitFactor`
**и** `variant.winRate >= baseline.winRate`.

### 2.6 BacktestRun idempotency — включает bundle_hash

`backtest_run` несёт колонку `bundle_hash`; уникальность:

```
UNIQUE (hypothesis_id, params_hash, bundle_hash)
```

Тот же hypothesis + те же params + тот же bundle → идемпотентно; новый build attempt
с новым bundle (другой `bundle_hash`) — разрешён. (Это шире, чем «per build attempt only».)

### 2.7 comparison? — lab-side mock/fixture shape, не финальный контракт

`comparison?: ComparisonSummary` на `ResearchRunEnvelope` — **narrowed lab-side
mock/fixture result shape для SP-4**, не финальное изменение platform-контракта.
SP-5 выровняет это с реальным trading-platform MCP/HTTP контрактом (018/022).

---

## 3. Workflow `hypothesis.build` (synchronous)

Task-type `hypothesis.build` уже в `AGENT_TASK_TYPES`. Диспатчится существующим
worker/router как `WorkflowHandler` (как `research.run_cycle`).

**Payload:**

```ts
HypothesisBuildPayloadSchema = z.object({
  hypothesisId: z.string().min(1),
  params: z.record(z.unknown()).optional(),   // default {}
});
```

**Поток (inline, mock возвращает синхронно):**

```
validate payload (Zod)
load HypothesisProposal by id      → not found → throw
  guard: status === 'validated'    → иначе throw (нельзя строить rejected)
load StrategyProfile by id         → not found → throw
emit build.started

create HypothesisBuild row (status=generating)         [event build.persisted? нет — только build.started]
emit builder.started
try Builder.build({ hypothesis, profile, sdkDoc })     → catch:
     update build → status=build_failed, issues=[builder_failed]
     emit builder.failed + build_failed; RETURN (terminal попытки)
emit builder.completed

bundle = assembleBundle(out.manifest, out.files)        // lab вычисляет bundleHash
validation = validateBundle(bundle, { allowedImports, allowedCapabilities })
if validation.status === 'build_failed':
     update build → status=build_failed, issues=validation.issues
     emit build_failed; RETURN (terminal попытки)
emit build.validated

ref = artifacts.put(JSON.stringify(bundle), { kind:'module_bundle', mime:'application/json', producer:'builder' })
update build → status=candidate, bundleHash, bundleArtifactRef=ref, manifest
emit artifact.stored

paramsHash = sha256(stableStringify(params))
req = { correlationId, baselineModuleId:`strategy:${profile.id}`, variantModuleId:manifest.moduleId, params }
runRef = platform.submitBacktest(req)
create BacktestRun row (status=submitted, bundleHash, paramsHash, baseline/variantModuleId, platformRunId)
update build → status=submitted
emit backtest.submitted

envelope = platform.getBacktestResult(runRef)
if !envelope.comparison or runStatus!=='completed':
     update BacktestRun → status=(rejected|failed)
     emit backtest.failed; RETURN
normalize envelope.comparison → BacktestRun normalized columns (variant block) + baseline_metrics jsonb + deltas
update BacktestRun → status=completed
emit backtest.completed

decision = evaluateBacktest(comparison, thresholds)
create Evaluation row (decision, reasons, metrics_snapshot, thresholds)
update BacktestRun → status=evaluated
emit evaluation.completed { decision }
```

**Builder не submit'ит. Orchestrator владеет всеми side-effects.** `build_failed` — терминально
для попытки, submit не происходит.

**HypothesisProposal.status остаётся `validated|rejected`** (без изменений из SP-3). Build/backtest/eval
lifecycle живёт в новых таблицах, связь по `hypothesis_id`. **Сознательное отклонение** от полного
lifecycle master design §17 (accepted→building→backtested→…) — не churним персистированную SP-3 модель.

---

## 4. Builder (port + fake + mastra)

Зеркалит SP-3 Researcher/Critic. За `BUILDER_ADAPTER` (`fake`|`mastra`) / `BUILDER_MODEL`.

```ts
export interface BuilderInput {
  hypothesis: HypothesisProposal;
  profile: StrategyProfile;
  sdkDoc: string;                  // статический RAG-fixture (см. ниже)
}

export interface BuilderOutput {
  manifest: Omit<ModuleManifest, never>;   // manifest БЕЗ доверенного hash (hash не в manifest)
  files: Record<string, string>;           // path -> ESM source text
  notes?: string;
}

export interface BuilderPort {
  readonly adapter: string;
  readonly model: string;
  build(input: BuilderInput): Promise<BuilderOutput>;
}
```

- **RAG = static SDK-doc fixture** `src/adapters/builder/builder-sdk-doc.ts` (экспорт строки
  `BUILDER_SDK_DOC`), подаётся в Mastra-промпт. `FakeBuilder` его игнорирует.
- **`FakeBuilder`** — детерминированно шаблонит overlay-модуль из `hypothesis.ruleAction`:
  `files['index.ts']` = маленький ESM, кодирующий правила; `manifest.capabilities` выводятся
  из `hypothesis.requiredFeatures`; `entry='index.ts'`, `exports=['overlay']`,
  `moduleKind='hypothesis_overlay'`, `appliesTo=ruleAction.appliesTo`. **Всегда проходит** Build Validator.
- **`MastraBuilder`** зеркалит `MastraResearcher`: Anthropic-only guard, `anthropic(bareModelId)`,
  `structuredOutput` против `BuilderOutputSchema`, re-parse. **Hash не запрашивается у LLM.**
- `BuilderOutputSchema` (Zod): `manifest` (без hash) + `files` (record string→string) + optional `notes`.

---

## 5. Narrowed contracts (lab mirrors)

```ts
export const MODULE_BUNDLE_CONTRACT_VERSION = 'module-bundle-v1';

export interface ModuleManifest {
  moduleId: string;
  moduleKind: 'hypothesis_overlay';
  appliesTo: Direction;            // из strategy-profile DIRECTIONS
  entry: string;                   // e.g. 'index.ts'
  exports: string[];               // required exported symbols, e.g. ['overlay']
  capabilities: string[];          // declared; ⊆ allowed
  sdkContractVersion: string;      // версия Builder SDK (021), под которую собран bundle
}

export interface ModuleBundle {
  manifest: ModuleManifest;
  files: Record<string, string>;
  bundleHash: string;              // sha256:<hex>, lab-computed
  bundleContractVersion: string;   // MODULE_BUNDLE_CONTRACT_VERSION
}

// assembleBundle: чистая функция; игнорирует любой supplied hash.
export function assembleBundle(manifest: ModuleManifest, files: Record<string,string>): ModuleBundle;
```

`SDK_CONTRACT_VERSION = 'builder-sdk-v0'` (placeholder для SP-4; реальный 021 → SP-5).

**ComparisonSummary** — см. §2.1. Добавляется на `ResearchRunEnvelope`:

```ts
export interface ResearchRunEnvelope {
  platformRunId: string;
  runStatus: 'completed' | 'rejected';
  metrics: Record<string, number>;        // существующее поле (SP-1), не трогаем
  artifactRefs: string[];
  platformContractVersion: string;
  comparison?: ComparisonSummary;         // NEW (SP-4 lab-side mock/fixture shape; §2.7)
}
```

Mock/Fixture адаптеры возвращают правдоподобные `baseline`/`variant` блоки.

---

## 6. Build Validator (pure, `src/validation/build-validator.ts`)

```ts
export interface BuildValidation {
  status: 'built' | 'build_failed';
  issues: ValidationIssue[];               // переиспользуем тип SP-1
}
export function validateBundle(
  bundle: ModuleBundle,
  ctx: { allowedImports: Set<string>; allowedCapabilities: Set<string> },
): BuildValidation;
```

Коды issue (static-structural, fast-fail):

| code | условие |
|---|---|
| `manifest_invalid` | manifest не проходит Zod-схему |
| `disallowed_module_kind` | `moduleKind !== 'hypothesis_overlay'` |
| `missing_entry` | `manifest.entry` отсутствует в `files` |
| `missing_export` | требуемый export не найден текстовым скан в entry-файле |
| `restricted_import` | denylist-токен (§2.4) встречен в любом файле / импорт вне SDK-allowlist |
| `capability_violation` | declared capability ∉ `allowedCapabilities` |
| `bundle_hash_mismatch` | пересчёт `assembleBundle(...).bundleHash !== bundle.bundleHash` |
| `sdk_contract_mismatch` | `manifest.sdkContractVersion !== SDK_CONTRACT_VERSION` |

`allowedCapabilities = profile.requiredMarketFeatures.map(normalizeFeature) ∪ LAB_FEATURE_CATALOG`.
`allowedImports` — SDK-only (в SP-4 пусто или один SDK-модуль). Issues сортируются
детерминированно (по `path`, затем `code`), как в `hypothesis-validator`.
`status='build_failed'` если есть хоть один `error`, иначе `built`.

---

## 7. Evaluator (pure, `src/validation/evaluator.ts`)

```ts
export type EvaluationDecision =
  'PASS' | 'MODIFY' | 'FAIL' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface EvaluatorThresholds {
  minTrades: number;                 // default 20
  minPnlDeltaUsd: number;            // default 0
  maxDrawdownTolerancePct: number;   // default 2.0
  fragilityTopTradePct: number;      // default 50
  strongPnlDeltaUsd: number;         // default 100
  minProfitFactor: number;           // default 1.5
}

export interface EvaluationOutcome {
  decision: EvaluationDecision;
  reasons: string[];
}

export function evaluateBacktest(
  summary: ComparisonSummary,
  t: EvaluatorThresholds,
): EvaluationOutcome;
```

**Ladder (first-match wins), math по §2.5:**

1. `summary.variant.totalTrades < t.minTrades` → **INCONCLUSIVE** (`insufficient_sample`)
2. `deltaNetPnlUsd <= t.minPnlDeltaUsd` → **FAIL** (`no_improvement_over_baseline`)
3. `deltaMaxDrawdownPct > t.maxDrawdownTolerancePct` → **MODIFY** (`drawdown_regression`)
4. `fragile` → **MODIFY** (`fragile_pnl`)
5. `deltaNetPnlUsd >= t.strongPnlDeltaUsd ∧ variant.profitFactor >= t.minProfitFactor
   ∧ variant.winRate >= baseline.winRate` → **PAPER_CANDIDATE** (`strong_robust_edge`)
6. else → **PASS** (`positive_edge`)

Чисто детерминированно, без LLM. Каждая ветка тестируется + граничные значения порогов.

---

## 8. Persistence (migration 0003)

Три таблицы, in-memory + Drizzle репозитории (паттерн SP-3). Без FK (append-only-дружелюбно).

### 8.1 `hypothesis_build`

```
id (PK), hypothesis_id, strategy_profile_id,
status,                                  // generating|build_failed|candidate|submitted
builder_adapter, builder_model,
bundle_hash (nullable до candidate),
bundle_artifact_ref (jsonb ArtifactRef, nullable),
manifest (jsonb ModuleManifest, nullable),
sdk_contract_version, bundle_contract_version,
issues (jsonb ValidationIssue[]),        // [] пока нет; validator/builder issues при build_failed
attempt (int, default 1),
created_at, updated_at
```
idx: `(hypothesis_id)`, `(status)`.

### 8.2 `backtest_run`

```
id (PK), hypothesis_build_id, hypothesis_id, strategy_profile_id,
platform_run_id, correlation_id,
params (jsonb), params_hash, bundle_hash,
status,                                  // queued|submitted|running|completed|rejected|failed|evaluated
baseline_module_id, variant_module_id,
-- normalized variant metric columns (real columns, §11 master design):
net_pnl_usd, net_pnl_pct, total_trades, win_rate, profit_factor,
max_drawdown_pct, expectancy_usd, sharpe, top_trade_contribution_pct, is_fragile,
-- baseline (small) + deltas:
baseline_metrics (jsonb BacktestMetricBlock),
delta_net_pnl_usd, delta_max_drawdown_pct,
artifact_refs (jsonb),
platform_contract_version, sdk_contract_version,
submitted_at, finished_at, created_at, updated_at
```
UNIQUE `(hypothesis_id, params_hash, bundle_hash)` — идемпотентность (§2.6).
idx: `(hypothesis_id)`, `(status)`. Metric-колонки nullable до `completed`.

### 8.3 `evaluation`

```
id (PK), backtest_run_id, hypothesis_id,
decision,                                // EvaluationDecision
reasons (jsonb string[]),
metrics_snapshot (jsonb ComparisonSummary),
thresholds (jsonb EvaluatorThresholds),
created_at
```
idx: `(backtest_run_id)`. Append-only (история ре-оценок).

**`BacktestTrade` — НЕ создаём в SP-4** (§0). Trade-tape придёт через `artifact_refs` в SP-5.

---

## 9. Config / wiring

**env (`src/config/env.ts`):**

```
BUILDER_ADAPTER: 'fake' | 'mastra'              (default 'fake')
BUILDER_MODEL:   string                          (default 'anthropic/claude-sonnet-4-6')
EVAL_MIN_TRADES, EVAL_MIN_PNL_DELTA_USD, EVAL_MAX_DRAWDOWN_TOLERANCE_PCT,
EVAL_FRAGILITY_TOP_TRADE_PCT, EVAL_STRONG_PNL_DELTA_USD, EVAL_MIN_PROFIT_FACTOR
```

Пороги парсятся как числа с дефолтами §7, собираются в `EvaluatorThresholds`.

**AppServices** (`src/orchestrator/app-services.ts`) добавляет:

```
builder: BuilderPort;
builds: HypothesisBuildRepository;
backtests: BacktestRunRepository;
evaluations: EvaluationRepository;
evaluatorThresholds: EvaluatorThresholds;
```

Build Validator и Evaluator — **импортируемые чистые функции**, не инъектируемые сервисы
(консистентно с `validateHypothesis` / `validateWithSchema`).

**Composition** (`src/composition.ts`): `buildBuilder(env)` (mastra-guard как у researcher),
Drizzle-репозитории для рантайма, загрузка `evaluatorThresholds`, регистрация
`router.register('hypothesis.build', hypothesisBuildHandler)`. Typecheck зелёный после каждой задачи
(composition service-wiring и регистрация — отдельной задачей в конце, как SP-3).

---

## 10. Test scope (обязательные проверки)

- **assembleBundle**: (a) key-order independence; (b) file change → hash change; (c) supplied hash ignored.
- **Build Validator**: отдельный тест на каждый код issue + valid bundle проходит (`built`).
- **Evaluator**: каждая из 5 веток (INCONCLUSIVE/FAIL/MODIFY×2/PAPER_CANDIDATE/PASS) +
  граничные значения порогов (`minTrades`, `minPnlDeltaUsd`, `maxDrawdownTolerancePct`,
  `fragilityTopTradePct`, `strongPnlDeltaUsd`, `minProfitFactor`).
- **FakeBuilder** → `assembleBundle` → `validateBundle` = `built` (валидный bundle).
- **params_hash** идемпотентность; **bundle_hash** в unique-ключе допускает новый build attempt.
- **Repos**: in-memory (unit) + Drizzle (integration, gated на `DATABASE_URL`, `afterAll` pool.end).
  In-memory `backtest_run` бросает на дубль `(hypothesis_id, params_hash, bundle_hash)`.
- **HypothesisBuild lifecycle**: тесты, что `build_failed` row персистится при (a) Builder throw
  (issue `builder_failed`) и (b) Build Validator fail (validator issues) — **до** submit.
- **e2e `hypothesis.build`**: (1) happy path build→backtest→evaluate — все три row + полный
  event-trail (`build.started`, `builder.completed`, `build.validated`, `artifact.stored`,
  `backtest.submitted`, `backtest.completed`, `evaluation.completed`); (2) `build_failed` путь
  останавливается **до** submit (нет `backtest_run`).
- Live-LLM тесты (`MastraBuilder`) — `describe.skip` без `RUN_LLM_TESTS=true` + `ANTHROPIC_API_KEY`.

---

## 11. Деривация / соответствие master design

| master design | SP-4 |
|---|---|
| §8.3 Build & Backtest workflow | `hypothesis.build` synchronous handler (suspend/resume → SP-5) |
| §7 Builder (LLM full codegen) | `BuilderPort` fake+mastra, RAG = static SDK-doc fixture |
| §7 Build Validator (det., fast-fail) | `validateBundle` pure, static-structural |
| §7 Evaluator (det.) | `evaluateBacktest` pure ladder |
| §11 BacktestRun (real columns) | `backtest_run` normalized variant columns + baseline jsonb + deltas |
| §11 BacktestTrade | **defer → SP-5** |
| §15 PlatformGateway | существующий `submitBacktest`/`getBacktestResult` + Mock/Fixture |
| §17 HypothesisBuild.status | `generating→build_failed\|candidate→submitted` |
| §17 BacktestRun.status | `submitted→completed\|rejected\|failed→evaluated` |
| §12 gates | Build (3) fast-fail + Evaluation (5) deterministic |

**Соответствие инвариантам:** lab не исполняет код; Builder не submit'ит; Orchestrator владеет
side-effects; все gates детерминированы; bundle остаётся `candidate`. ✔
