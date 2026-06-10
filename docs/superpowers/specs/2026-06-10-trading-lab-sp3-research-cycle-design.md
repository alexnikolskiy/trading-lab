# trading-lab SP-3 — Research Cycle (Design)

**Дата:** 2026-06-10
**Статус:** Approved (design) → переход к implementation plan
**Фаза:** SP-3 Research Cycle (§8.2 общего дизайна)
**Язык:** русский (технические имена сущностей, типов, workflow, таблиц, интерфейсов — английские)
**Базовый дизайн:** `docs/superpowers/specs/2026-06-10-trading-lab-design.md`

---

## 0. Контекст и границы SP-3

SP-3 реализует **Research Cycle Workflow (§8.2)** общего дизайна: от загруженного `StrategyProfile` (результат SP-2) до **персистентных hypothesis proposals** (validated / rejected). SP-3 **останавливается до** Build & Backtest (это SP-4) — никакой кодогенерации, submit'а на платформу или backtest.

### Что входит в SP-3

- **Researcher Agent** (LLM, fake|mastra) → `HypothesisProposal[]` (только JSON).
- **`HypothesisProposal` domain schema** (Zod) + lab-контракт `hypothesis-proposal-v1`.
- **Deterministic hypothesis Validator** — **единственный обязательный accept/reject gate**.
- **Critic Agent** (LLM, fake|mastra) — за `ENABLE_CRITIC_AGENT=true` (default off), **advisory, никогда не gate**; ревью пишется в `hypothesis_review`.
- **Exact-fingerprint dedupe** — обязательный детерминированный механизм.
- **`SimilarHypothesisSearchPort`** — lexical/mock **advisory** (не gate); seam под будущий pgvector.
- **Persistence:** `hypothesis_proposal`, `hypothesis_review` (Postgres + in-memory).
- **Audit:** `research.run_cycle.started/completed`, `hypothesis.validated/rejected/deduped` через существующий `AgentEventRepository`.
- **`research.run_cycle` handler** + composition wiring + env.

### Зафиксированные решения брейншторминга SP-3

| # | Решение | Выбор |
|---|---|---|
| A | Similarity / dedupe | **Exact-fingerprint dedupe (mandatory)** + `SimilarHypothesisSearchPort` (lexical/mock, **advisory only**). pgvector + embeddings — later за тем же портом. |
| B | Researcher input | `StrategyProfile` + `MarketContext` + `MarketRegime` (существующие методы gateway) + summaries похожих гипотез. Trades / decision logs — **не** в SP-3 (ценны на реальных данных, SP-5). |
| C | Critic | **Реальный** (`fake` + `mastra`), за `ENABLE_CRITIC_AGENT`, ревью → `hypothesis_review`. **Никогда не gate.** Обязательный gate — всегда детерминированный Validator. |

### Унаследованные инварианты (из SP-1/SP-2)

- **NO TypeScript parameter properties** (`constructor(private x)`) — падают в runtime под type-stripping. Явное поле + присваивание в теле конструктора.
- **Все относительные импорты — с явным `.ts`.**
- **Никаких raw NUL byte в исходниках.** Separator только через `const sep = '\u0000';`.
- Agents возвращают **только** schema-validated JSON. Side-effects (DB writes, events) владеет orchestrator/handler.
- LLM-тесты — `describe.skip` без `RUN_LLM_TESTS=true` + `ANTHROPIC_API_KEY`. Integration-тесты gated на `DATABASE_URL`.
- In-memory repository кидает на duplicate id.

---

## 1. Доменная модель

### 1.1 OverlayAction — research-only overlay intent

`OverlayAction` — **research-only overlay intent**, описывающий *что гипотеза предлагает изменить* в поведении базовой стратегии. Это **НЕ** executable order, **НЕ** risk authority, **НЕ** команда бирже. Реальное исполнение, sizing и fills остаются за runner/платформой (§1 Hard constraints общего дизайна). Семантически — заготовка под `HypothesisOverlayModule` (017), но в SP-3 это только декларативный intent.

```ts
// src/domain/hypothesis-rules.ts
export const OVERLAY_ACTIONS = [
  'skip_entry', 'allow_entry', 'scale_in', 'scale_out',
  'tighten_stop', 'widen_stop', 'exit_now', 'adjust_size', 'no_op',
] as const;
export type OverlayAction = (typeof OVERLAY_ACTIONS)[number];
```

Action-specific param-схемы (диапазоны/типы под каждый action) **отложены до SP-4**. В SP-3 `params` валидируется только как **safe JSON object** (см. Validator rule `action_param_violation`).

### 1.2 LAB_FEATURE_CATALOG и нормализация features

```ts
// src/domain/hypothesis-rules.ts
export const LAB_FEATURE_CATALOG = [
  'ohlcv', 'volume', 'oi', 'funding', 'liquidations', 'cvd',
  'market_context', 'market_regime',
] as const;

// Нормализация перед validation: lowercase, trim, non-alnum → '_', схлопывание '_',
// плюс базовые синонимы (open_interest→oi, fundingrate→funding, liqs→liquidations, ...).
export function normalizeFeature(raw: string): string;
```

**Allowed feature set** для конкретного цикла = `normalize(StrategyProfile.requiredMarketFeatures)` ∪ `LAB_FEATURE_CATALOG`. `requiredFeatures` каждой гипотезы нормализуются тем же `normalizeFeature` **до** проверки.

### 1.3 HypothesisProposal schemas

```ts
// src/domain/hypothesis.ts
import { z } from 'zod';
import { OVERLAY_ACTIONS } from './hypothesis-rules.ts';
import { DIRECTIONS } from './strategy-profile.ts';

export const HypothesisRuleSchema = z.object({
  when: z.string().min(1),                 // условие (ссылается на requiredFeatures)
  action: z.enum(OVERLAY_ACTIONS),
  params: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  rationale: z.string().optional(),
});

export const RuleActionSchema = z.object({
  appliesTo: z.enum(DIRECTIONS),
  rules: z.array(HypothesisRuleSchema).min(1),
});
export type RuleAction = z.infer<typeof RuleActionSchema>;   // используется в hypothesisFingerprint

export const ExpectedEffectSchema = z.object({
  metric: z.string().min(1),
  direction: z.enum(['increase', 'decrease']),
  magnitude: z.string().optional(),
});

// Один элемент LLM-выхода (schema gate #1).
export const HypothesisProposalDraftSchema = z.object({
  thesis: z.string().min(1),               // falsifiable claim
  targetBehavior: z.string().min(1),       // какое поведение стратегии меняем
  ruleAction: RuleActionSchema,
  requiredFeatures: z.array(z.string()),
  validationPlan: z.string().min(1),
  expectedEffect: ExpectedEffectSchema,
  invalidationCriteria: z.array(z.string()).min(1),  // falsifiability
  confidence: z.number().min(0).max(1),
});
export type HypothesisProposalDraft = z.infer<typeof HypothesisProposalDraftSchema>;

export const ResearcherOutputSchema = z.object({
  hypotheses: z.array(HypothesisProposalDraftSchema),
  researchSummary: z.string(),
});
export type ResearcherOutput = z.infer<typeof ResearcherOutputSchema>;

export const HYPOTHESIS_PROPOSAL_CONTRACT_VERSION = 'hypothesis-proposal-v1';

export type HypothesisStatus = 'validated' | 'rejected';

export interface HypothesisProposal {
  id: string;
  strategyProfileId: string;
  thesis: string;
  targetBehavior: string;
  ruleAction: z.infer<typeof RuleActionSchema>;
  requiredFeatures: string[];              // нормализованные
  validationPlan: string;
  expectedEffect: z.infer<typeof ExpectedEffectSchema>;
  invalidationCriteria: string[];
  confidence: number;
  status: HypothesisStatus;
  fingerprint: string;
  proposal: HypothesisProposalDraft;       // полный исходный draft (с ненормализованными features)
  issues: ValidationIssue[];               // [] для validated; причины для rejected
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}
```

### 1.4 Fingerprint (exact dedupe)

```ts
// src/domain/hypothesis.ts (или fingerprint.ts), переиспользует canonicalizeContent из SP-2
import { canonicalizeContent } from './fingerprint.ts';

export function hypothesisFingerprint(thesis: string, ruleAction: RuleAction): string {
  const sep = '\u0000';                    // явный separator, НЕ raw NUL в исходнике
  const canonicalRule = canonicalizeContent(stableStringify(ruleAction));
  return sha256(`${canonicalizeContent(thesis)}${sep}${canonicalRule}`); // 'sha256:<hex>'
}
```

`stableStringify` — детерминированная сериализация с отсортированными ключами (чтобы порядок ключей в `ruleAction` не влиял на хэш). Dedupe — **per strategy profile** (см. unique index §4).

---

## 2. Deterministic hypothesis Validator — обязательный gate

`src/validation/hypothesis-validator.ts`. Запускается **после** schema gate, по каждому draft'у, на нормализованных features. Возвращает:

```ts
export interface HypothesisValidation {
  status: 'validated' | 'rejected';
  issues: ValidationIssue[];               // тип из domain/schemas.ts
  normalizedFeatures: string[];
}

export function validateHypothesis(
  draft: HypothesisProposalDraft,
  ctx: { allowedFeatures: Set<string> },   // normalize(profile features) ∪ LAB_FEATURE_CATALOG
): HypothesisValidation;
```

**Dedupe в Validator НЕ проверяется** — exact-fingerprint dedupe делает handler (см. §3), чтобы Validator оставался чистой функцией без зависимости от репозитория.

### Правила

| code | severity | правило |
|---|---|---|
| `missing_falsifiability` | error | `invalidationCriteria` пуст |
| `disallowed_action` | error | какой-то `rule.action` ∉ `OVERLAY_ACTIONS` (на практике ловит schema gate, но дублируется детерминированно) |
| `unavailable_feature` | error | нормализованный `requiredFeature` ∉ `allowedFeatures` |
| `action_param_violation` | error | `params` не safe JSON object: содержит запрещённые семантики live/order/exchange — ключи или строковые значения матчат denylist (`order`, `placeorder`, `marketorder`, `exchange`, `leverage`, `apikey`, `api_key`, `secret`, `live`, `withdraw`); либо значение не примитив (string/number/boolean/null) |
| `live_intent` / `authority_violation` | error | lexical denylist по `thesis` / `targetBehavior` / `when` / `rationale`: "place order", "live trade", "market order", "real money", claim на runner-owned risk sizing / fills / execution |
| `lookahead_marker` | error | lexical denylist: "future candle", "next close known", "lookahead", "look-ahead", "знание будущего" и т.п. |

`status='rejected'` если есть хотя бы один `error`-issue; иначе `validated`. Все denylists/allowlists — константы в `src/domain/hypothesis-rules.ts` (тестируемые, без магии в коде Validator).

---

## 3. Workflow handler — `research.run_cycle`

`src/orchestrator/handlers/research-run-cycle.handler.ts`.

```ts
ResearchRunCyclePayloadSchema = z.object({
  strategyProfileId: z.string().min(1),
  symbol: z.string().min(1).optional(),
  ts: z.string().min(1).optional(),
  maxHypotheses: z.number().int().positive().optional(),
});
```

Шаги:

1. **Schema gate payload.** Invalid → throw (worker → task failed).
2. **Load StrategyProfile** по `strategyProfileId`. Нет → throw.
3. **emit `research.run_cycle.started`** (taskId, strategyProfileId, adapters/models).
4. **Load market data (advisory):** `symbol = payload.symbol ?? 'BTCUSDT'`, `ts = payload.ts ?? new Date().toISOString()`. `platform.getMarketContext(symbol, ts)` + `platform.getMarketRegime(symbol, ts)`. Market context/regime — **advisory вход в prompt Researcher**; их отсутствие/дефолт **не** валит цикл.
5. **Similar search (advisory):** `similarHypotheses.search(profileId, profileQuery, limit)` → summaries. **Не gate.**
6. **effectiveMax** = `min(payload.maxHypotheses ?? env.MAX_HYPOTHESES_PER_CYCLE, env.MAX_HYPOTHESES_PER_CYCLE)`. Payload **не может превысить** env guardrail.
7. **Researcher:** `researcher.propose({ profile, marketContext, marketRegime, similarHypotheses, maxHypotheses: effectiveMax })`.
   - try → catch: emit `researcher.failed` + rethrow.
   - success: emit `researcher.completed`.
8. **Schema gate ResearcherOutput.** Invalid → throw.
9. **Truncate** `hypotheses` до `effectiveMax` (защита от LLM, проигнорировавшего лимит).
10. **allowedFeatures** = `normalize(profile.requiredMarketFeatures)` ∪ `LAB_FEATURE_CATALOG`.
11. **Per-draft loop**, поддерживая `seen: Set<fingerprint>` = существующие fingerprints профиля (из репозитория) ∪ вставленные в этом цикле:
    - `fp = hypothesisFingerprint(thesis, ruleAction)`.
    - **`fp ∈ seen`** → emit `hypothesis.deduped` (fingerprint), **строку НЕ создаём**, инкремент `deduped`-счётчика. `continue`.
    - иначе `validateHypothesis(draft, { allowedFeatures })`:
      - **validated** → создать `hypothesis_proposal` row `status='validated'`, `issues=[]`; `seen.add(fp)`; emit `hypothesis.validated`; инкремент `validated`.
      - **rejected** → создать row `status='rejected'` + `issues`; `seen.add(fp)`; emit `hypothesis.rejected` (codes); инкремент `rejected`.
12. **Critic (опц.):** если `services.critic !== null` (т.е. `ENABLE_CRITIC_AGENT=true`) — для каждой **validated** гипотезы: `critic.review(...)` → persist `hypothesis_review`; emit `critic.reviewed`. Ошибка Critic — **не валит цикл** (advisory): catch + emit `critic.failed`, продолжаем. Critic **не меняет** status гипотезы.
13. **emit `research.run_cycle.completed`** { proposed, validated, rejected, deduped, criticReviews }.

Worker помечает task completed/failed по возврату/исключению (как в SP-1/SP-2).

### Persistence semantics (refinement #1, явно)

- **validated** → строка `status='validated'`, `issues=[]`.
- **rejected** → строка `status='rejected'` + `issues` (причины).
- **duplicates** (по exact fingerprint) → **НЕ** сохраняются как rejected rows; только `hypothesis.deduped` event + учёт в summary.

---

## 4. Storage

### 4.1 `hypothesis_proposal` (`src/db/schema.ts`)

```
id (PK), strategy_profile_id, thesis, target_behavior,
rule_action (jsonb), required_features (jsonb string[] — нормализованные),
validation_plan, expected_effect (jsonb), invalidation_criteria (jsonb string[]),
confidence (real), status, fingerprint,
proposal (jsonb — полный draft), issues (jsonb ValidationIssue[]),
contract_version, created_at, updated_at
```

Индексы:
- **UNIQUE `hypothesis_proposal_profile_fp_uq` на `(strategy_profile_id, fingerprint)`** — DB-level dedupe guard (per profile).
- `index` на `strategy_profile_id`.
- `index` на `status`.

Без FK на `strategy_profile.id` — консистентно с тем, как `agent_event` не ссылается на `research_task` (append-friendly).

### 4.2 `hypothesis_review`

```
id (PK), hypothesis_id, critic_adapter, critic_model,
verdict ('ok' | 'concerns'), concerns (jsonb), summary, created_at
```

Индекс на `hypothesis_id`. Без FK (audit-friendly).

### 4.3 Migration

Новый `migrations/0002_*.sql` (обе таблицы + индексы). Существующие миграции не трогаем.

---

## 5. Ports & adapters

### 5.1 ResearcherPort

```ts
// src/ports/researcher.port.ts
export interface ResearcherInput {
  profile: StrategyProfile;
  marketContext: MarketContext;
  marketRegime: MarketRegime;
  similarHypotheses: SimilarHypothesisSummary[];
  maxHypotheses: number;
}
export interface ResearcherPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  propose(input: ResearcherInput): Promise<ResearcherOutput>;
}
```

- **`FakeResearcher`** (`src/adapters/researcher/fake-researcher.ts`): детерминированный stub — `min(2, maxHypotheses)` валидных черновиков, выведенных из `profile` (features из `profile.requiredMarketFeatures`, `appliesTo = profile.direction`), `researchSummary` детерминированный. Без сети.
- **`MastraResearcher`** (`src/adapters/researcher/mastra-researcher.ts`): зеркало `MastraStrategyAnalyst` — Anthropic-only guard, `anthropic(bareModelId)`, `structuredOutput: { schema: ResearcherOutputSchema }`, re-parse `ResearcherOutputSchema.parse(result.object)`. Instructions: фальсифицируемые гипотезы; **только overlay intent, не live execution**; использовать только features из allowed set; уважать `maxHypotheses`.

### 5.2 CriticPort

```ts
// src/ports/critic.port.ts
export interface CriticInput {
  proposal: HypothesisProposalDraft;
  profile: StrategyProfile;
}
export interface CriticConcern { code: string; severity: 'info' | 'warning'; message: string; }
export interface CriticOutput { verdict: 'ok' | 'concerns'; concerns: CriticConcern[]; summary: string; }
export interface CriticPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  review(input: CriticInput): Promise<CriticOutput>;
}
```

- **`FakeCritic`**: детерминированный `{ verdict: 'ok', concerns: [], summary }`.
- **`MastraCritic`**: зеркало Mastra-адаптера, `CriticOutputSchema` (Zod). Анализирует: falsifiable? overfit? lookahead? data-availability? sample size? boundary violation? Возвращает **advisory** concerns — **никогда не gate**.

### 5.3 HypothesisProposalRepository / HypothesisReviewRepository

```ts
// src/ports/hypothesis-proposal.repository.ts
export interface HypothesisProposalRepository {
  create(p: HypothesisProposal): Promise<void>;
  findById(id: string): Promise<HypothesisProposal | null>;
  listByStrategyProfile(strategyProfileId: string): Promise<HypothesisProposal[]>;
  listFingerprints(strategyProfileId: string): Promise<string[]>;   // для seed `seen`
}
// src/ports/hypothesis-review.repository.ts
export interface HypothesisReviewRepository {
  create(r: HypothesisReview): Promise<void>;
  listByHypothesis(hypothesisId: string): Promise<HypothesisReview[]>;
}
```

- In-memory: кидает на duplicate id (инвариант SP-1/SP-2). `listByStrategyProfile` / `listByHypothesis` — insertion order. Drizzle `listBy*` — `ORDER BY created_at ASC`.

### 5.4 SimilarHypothesisSearchPort (advisory)

```ts
// src/ports/similar-hypothesis-search.port.ts
export interface SimilarHypothesisSummary {
  hypothesisId: string; thesis: string; status: HypothesisStatus; score: number;
}
export interface SimilarHypothesisSearchPort {
  search(strategyProfileId: string, query: string, limit: number): Promise<SimilarHypothesisSummary[]>;
}
```

- **`InMemoryLexicalSimilarHypothesisSearch`** (`src/adapters/similarity/`): token-overlap (Jaccard по нормализованным токенам) над `hypotheses.listByStrategyProfile`. Возвращает top-`limit` по score. **Advisory only — не gate, не dedupe.** pgvector-адаптер — later за тем же портом.

---

## 6. Wiring

### 6.1 AppServices (`src/orchestrator/app-services.ts`)

Добавляются поля:

```ts
platform: PlatformGatewayPort;
researcher: ResearcherPort;
critic: CriticPort | null;                 // null когда ENABLE_CRITIC_AGENT=false
hypotheses: HypothesisProposalRepository;
hypothesisReviews: HypothesisReviewRepository;
similarHypotheses: SimilarHypothesisSearchPort;
```

### 6.2 composition.ts

- `buildResearcher(env)`: `RESEARCHER_ADAPTER==='mastra'` → `MastraResearcher` (требует `ANTHROPIC_API_KEY`, иначе throw); иначе `console.warn` + `FakeResearcher` (как `buildAnalyst`).
- `buildCritic(env)`: если `!env.ENABLE_CRITIC_AGENT` → **`null`**. Иначе `CRITIC_ADAPTER==='mastra'` → `MastraCritic` (требует ключ); иначе `FakeCritic`.
- Platform gateway runtime default — **`MockPlatformGatewayAdapter`**.
- `similarHypotheses` — `InMemoryLexicalSimilarHypothesisSearch` поверх runtime `hypotheses` repo (для Drizzle-runtime: lexical-поиск пока работает поверх загруженного per-profile списка — приемлемо для MVP; pgvector later).
- Регистрация `router.register('research.run_cycle', researchRunCycleHandler)`.

### 6.3 env.ts

```ts
RESEARCHER_ADAPTER: 'fake' | 'mastra';     // default 'fake'
RESEARCHER_MODEL: string;                  // default 'anthropic/claude-sonnet-4-6'
CRITIC_ADAPTER: 'fake' | 'mastra';         // default 'fake'
CRITIC_MODEL: string;                      // default 'anthropic/claude-sonnet-4-6'
MAX_HYPOTHESES_PER_CYCLE: number;          // default 5 (budget guardrail)
```

`MAX_HYPOTHESES_PER_CYCLE` парсится как положительное целое с дефолтом 5 (как `parsePort`).

### 6.4 test/support/make-services.ts

Расширяется: `platform` (Mock), `researcher` (Fake), `critic` (**default `null`** — базовый happy-path не зовёт Critic; тест включает Critic через `overrides: { critic: new FakeCritic() }`), `hypotheses`/`hypothesisReviews` (in-memory), `similarHypotheses` (lexical).

---

## 7. Audit / events (refinement #5)

Через существующий `AgentEventRepository` (без отдельной `research_run` таблицы):

| event type | когда |
|---|---|
| `research.run_cycle.started` | начало цикла |
| `researcher.started` / `researcher.completed` / `researcher.failed` | вокруг LLM-вызова Researcher |
| `hypothesis.validated` | гипотеза прошла Validator |
| `hypothesis.rejected` | гипотеза отклонена (с codes) |
| `hypothesis.deduped` | exact-fingerprint duplicate |
| `critic.reviewed` / `critic.failed` | если Critic включён |
| `research.run_cycle.completed` | сводка { proposed, validated, rejected, deduped, criticReviews } |

Цикл полностью аудируем по `events.listByTask(taskId)`.

---

## 8. Тестирование

- **Unit:**
  - `hypothesisFingerprint` — стабильность при перестановке ключей `ruleAction`, чувствительность к thesis; 0 raw NUL в исходнике (проверка Python).
  - `normalizeFeature` — синонимы, snake_case, lowercase.
  - `validateHypothesis` — по правилу на тест: `missing_falsifiability`, `disallowed_action`, `unavailable_feature`, `action_param_violation` (denylist key/value + не-примитив), `live_intent`, `lookahead_marker`; happy-path validated.
  - `FakeResearcher` (детерминизм, уважение `maxHypotheses`), `FakeCritic`.
  - `InMemoryLexicalSimilarHypothesisSearch` (ранжирование, limit).
- **Repository integration** (gated на `DATABASE_URL`): `DrizzleHypothesisProposalRepository` (create/find/list/listFingerprints, unique `(profile, fp)` violation), `DrizzleHypothesisReviewRepository`.
- **Handler unit** (`makeServices`): dedupe-path (deduped, без row), validate-accept, validate-reject, `effectiveMax` clamp (payload > env), critic on/off, event-trail последовательность.
- **E2E** `research.run_cycle`: ingress POST → worker → персистентные гипотезы + ожидаемый event-trail (как `strategy-onboard.test.ts`).
- **Live LLM** (`describe.skip` без `RUN_LLM_TESTS`): `MastraResearcher` отдаёт schema-valid `ResearcherOutput`; `MastraCritic` отдаёт schema-valid `CriticOutput`.

---

## 9. Out of scope (SP-3)

- Кодогенерация / `ModuleBundle` / Build Validator (SP-4).
- Submit на платформу / backtest / suspend-resume (SP-4/SP-5).
- pgvector / embeddings / реальный semantic search (later за `SimilarHypothesisSearchPort`).
- Trades / decision logs в Researcher input (SP-5, реальные данные).
- Action-specific param-схемы под каждый `OverlayAction` (SP-4).
- Research Policy / Budget Governor / pause-wake (SP-6) — в SP-3 только статический guardrail `MAX_HYPOTHESES_PER_CYCLE`.

---

## 10. Файловая карта SP-3

```
src/domain/hypothesis-rules.ts          OVERLAY_ACTIONS, LAB_FEATURE_CATALOG, normalizeFeature, denylists
src/domain/hypothesis.ts                schemas, HypothesisProposal, hypothesisFingerprint, contract version
src/validation/hypothesis-validator.ts  validateHypothesis (mandatory gate)
src/ports/researcher.port.ts            ResearcherPort + ResearcherInput
src/ports/critic.port.ts                CriticPort + CriticInput/Output
src/ports/hypothesis-proposal.repository.ts
src/ports/hypothesis-review.repository.ts
src/ports/similar-hypothesis-search.port.ts
src/adapters/researcher/fake-researcher.ts
src/adapters/researcher/mastra-researcher.ts
src/adapters/critic/fake-critic.ts
src/adapters/critic/mastra-critic.ts
src/adapters/repository/in-memory-hypothesis-proposal.repository.ts
src/adapters/repository/drizzle-hypothesis-proposal.repository.ts
src/adapters/repository/in-memory-hypothesis-review.repository.ts
src/adapters/repository/drizzle-hypothesis-review.repository.ts
src/adapters/similarity/in-memory-lexical-similar-hypothesis-search.ts
src/orchestrator/handlers/research-run-cycle.handler.ts
src/orchestrator/app-services.ts        (расширение)
src/composition.ts                      (buildResearcher/buildCritic + register)
src/config/env.ts                       (новые переменные)
src/db/schema.ts                        (hypothesis_proposal, hypothesis_review)
migrations/0002_*.sql
test/support/make-services.ts           (расширение)
test/e2e/research-run-cycle.test.ts
+ unit/integration тесты по §8
```

---

*Конец дизайн-документа SP-3. Реализация — после одобрения spec и перехода к implementation plan (writing-plans), исполнение — Subagent-Driven.*
