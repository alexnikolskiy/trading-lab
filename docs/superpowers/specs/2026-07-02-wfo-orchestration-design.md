# Slice G1 — WFO Orchestration: bundle-ref reconstruction + task types + budget gate

**Date:** 2026-07-02
**Status:** DESIGN — ждёт ревью пользователя (вариант «автоцепочка» принят как допущение: пользователь был AFK на моменте вопроса; альтернативы в §7).
**Parent:** `2026-06-30-backtest-research-orchestrator-roadmap.md` §8 гап G1.

## 1. Цель

Закрыть первый разрыв Цикла 1: baseline/WFO-контур сегодня — два ручных CLI-скрипта, причём WFO самоблокируется (LLM-ребилд бандла → `bundleHash ≠ baseline.bundleHash` → fail-fast). После слайса:

1. WFO **реконструирует** бандл из персистентного артефакта baseline-эксперимента, а не пересобирает его.
2. Baseline и WFO — оркестрированные task types, достижимые из чата: подтверждённый онбординг новой стратегии автоматически проходит воронку onboard → baseline → WFO (GATE1 внутри WFO сам решает «достаточно / sweep / стоп» — §3 roadmap).
3. WFO-контур уважает токен-бюджет (`RESEARCH_TASK_TOKEN_BUDGET`, correlationId-keyed) между LLM-раундами.

Вне scope: paper-мост (G2), ревизии/merge гипотез (G3), адаптивная длительность (G4), изменения TurnInterpreter-промпта.

## 2. Bundle-ref: персист и реконструкция (фикс самоблока)

**Схема.** Аддитивная миграция: `research_experiment.bundle_artifact_ref text NULL`. Домен: `ResearchExperiment.bundleArtifactRef?: string`; маппинг в drizzle- и in-memory-репозиториях; поле проходит через `create`.

**Персист.** Вызывающая сторона (handler / CLI-скрипт) делает `services.artifacts.put(JSON.stringify({source, manifest, bundleHash}), {kind:'strategy_bundle', ...})` — как сегодня, но **не выбрасывает ref**, а передаёт его в `runStrategyBaselineValidation({..., bundleArtifactRef})`; сервис кладёт ref на строку эксперимента.

**Реконструкция.** Новый чистый хелпер `reconstructStrategyBundle(artifacts, ref)` (src/domain или src/research): `artifacts.get(ref)` → parse `{source, manifest, bundleHash}` → `assembleStrategyBundle({source, manifest})` → **инвариант**: пересчитанный `bundleHash` обязан равняться сохранённому (порча/дрейф → fail-fast с внятной ошибкой). WFO-путь (handler и CLI) использует только реконструкцию; guard `bundleHash === baseline.bundleHash` в `runWalkForwardOptimization` остаётся (теперь проходит по построению).

Если у baseline-эксперимента ref отсутствует (старые строки) — WFO падает с actionable-ошибкой «re-run baseline» (без fallback на ребилд: недетерминизм — источник исходного бага).

## 3. Task types + автоцепочка

**`strategy.baseline`** (handler `strategyBaselineHandler`): payload `{strategyProfileId}`.
Профиль → `strategyBuilder.build` (LLM) → `assembleStrategyBundle` → `artifacts.put` → ref → `runStrategyBaselineValidation({..., bundleArtifactRef})` (datasetScope/runConfig из `services.defaultPlatformRun`, метрики `RESEARCH_RUN_METRICS`) → события → **enqueue `strategy.wfo`** `{baselineExperimentId, strategyProfileId}` тем же correlationId.
Гейт цепочки: WFO ставится всегда, когда baseline-эксперимент дошёл до `status='completed'` (включая INCONCLUSIVE — GATE1 умеет `entrySignalEvidence` для 0-trade baseline); при `status='failed'` цепочка обрывается с событием.

**`strategy.wfo`** (handler `strategyWfoHandler`): payload `{baselineExperimentId, strategyProfileId?}`.
Baseline-эксперимент → `bundleArtifactRef` → реконструкция (§2) → `runWalkForwardOptimization({baselineExperimentId, strategyBundle, profile, datasetScope: baseline.datasetScope, runConfig: из baseline.datasetScope + defaultPlatformRun.seed, metrics, taskId})` → событие завершения с `{experimentId, verdict, terminalReason}`.

**Регистрация** обоих в `composition.ts` рядом с существующими пятью. События — по образцу существующих (`strategy.baseline.started/completed`, `strategy.wfo.started/completed`) — хук для Phase E.

**Чат.** `planChatAction`: подтверждённый онбординг НОВОЙ стратегии получает chained-план `strategy.onboard → strategy.baseline` (механизм chain.nextTaskType уже существует — сегодня так чейнится research.run_cycle при `goal==='research'`; этот путь сохраняется для явных improvement-запросов). Текст proposal явно говорит, что после онбординга автоматически пойдут baseline-бэктест и, по решению GATE1, sweep. TurnInterpreter не трогаем (schema/prompt eval'нуты — риск регрессии).

## 4. Budget kill-switch в WFO

Точка входа раундового цикла `runWalkForwardOptimization`: **перед GATE1 и перед каждым следующим sweep-раундом** — проверка `withinTokenBudget(cumulative, budget)` (существующий `src/orchestrator/token-budget.ts`; cumulative — тот же correlationId-keyed учёт, что у research.run_cycle; бюджет — `RESEARCH_TASK_TOKEN_BUDGET`).
Превышение до GATE1 → verdict `INCONCLUSIVE`, terminalReason `budget_exhausted`. Превышение между раундами → цикл останавливается; если interpreter уже сделал `select` — holdout-прогон выполняется (это бэктест, не LLM), иначе `INCONCLUSIVE`/`budget_exhausted`. Заодно `RESEARCH_TASK_TOKEN_BUDGET` добавляется в `.env.example` + docker-оверлеи (давний хвост PR#86).

## 5. CLI-скрипты

- `run-strategy-baseline.mts`: передаёт `bundleArtifactRef` (put уже есть — просто перестать выбрасывать ref).
- `run-strategy-wfo.mts`: шаг 3 (LLM-ребилд) и pre-flight hash guard **удаляются**, вместо них реконструкция из `baseline.bundleArtifactRef`; env-требования `BUILDER_ADAPTER`/`MODEL_PROVIDER` для этого скрипта отпадают (LLM остаются только у трёх WFO-агентов). KNOWN LIMITATION-блок в шапке убирается.
- Оба остаются ops-инструментами (ручной прогон/отладка); оркестрация — через task types.

## 6. Тесты (TDD, существующие паттерны)

1. Домен/репо: `bundleArtifactRef` round-trip (drizzle + in-memory), миграция аддитивна.
2. `reconstructStrategyBundle`: happy path; порченый артефакт → hash-mismatch fail-fast; отсутствующий ref → actionable error.
3. `strategyBaselineHandler`: с fake builder/experiment-service — персист ref, enqueue `strategy.wfo` on completed, обрыв цепочки on failed.
4. `strategyWfoHandler`: реконструкция вместо ребилда (fake artifacts), guard проходит; отсутствие ref → ошибка.
5. Budget gate: бюджет исчерпан до GATE1 → `budget_exhausted`; между раундами → остановка, select-ветка доигрывает holdout.
6. Интеграционный: onboard → baseline → wfo chain на in-memory инфраструктуре + fake-агентах (образец — new-strategy-holdout.integration.test.ts).
7. Chat: план онбординга содержит chained strategy.baseline; proposal-текст упоминает воронку.

## 7. Рассмотренные альтернативы

- **Ручные шаги из чата** (оператор сам дёргает baseline, потом sweep): больше контроля затрат, но воронка не автономна — противоречит §3 roadmap. Отклонено (затраты и так гейтятся confirm'ом онбординга + бюджетом §4; demo-стек по умолчанию на fake-адаптерах).
- **Единый task type `strategy.validate`** (baseline+WFO в одном хендлере): проще диспатч, но худшие retry/resume-свойства и беднее события. Отклонено.
- **Fallback на LLM-ребилд при отсутствии ref**: отклонено — возвращает недетерминизм, ради устранения которого слайс и делается.

## 8. Риски

- Автоцепочка тратит реальные LLM+backtester-раунды на каждый подтверждённый онбординг — митигируется confirm-гейтом, бюджетом (§4) и тем, что GATE1 может остановить воронку за один дешёвый вызов.
- Существующие строки research_experiment без ref — WFO по ним потребует пере-прогона baseline (осознанно).
- live tradeCount=0 (G7) не решается этим слайсом: живой прогон воронки до его починки будет давать INCONCLUSIVE — ожидаемо.
