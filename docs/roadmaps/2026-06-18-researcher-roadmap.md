# Researcher Roadmap

Дата: 2026-06-18

## Цель

Довести `researcher` до состояния, где агент:

- получает полный профиль стратегии от `strategy-analyst`
- получает фактические результаты торговли ботов
- получает forensic-срез по худшим сделкам
- генерирует улучшенные гипотезы
- проходит офлайн eval на нескольких моделях по содержательным, а не только структурным критериям

## Текущее состояние

- `BotResultsReadPort` реализован и подключён в workflow.
- В `researcher` уже передаётся полный профиль стратегии, а не только краткое `coreIdea`.
- В prompt добавлен digest по bot results.
- Добавлен новый вход `tradeEvidence` и поддержка forensic bundles в `research-run-cycle`.
- Сделан `researcher:eval`.
- Scoring в eval больше не опирается только на JSON-структуру: добавлены проверки на привязку к профилю и observed failure patterns.
- Есть VPS fixture с bot runs / summaries / trades с 2026-06-01.

## Главные пробелы

### 1. Нет реального forensic trade evidence в fixtures

Сейчас `researcher:eval` видит:

- `runs.json`
- `summary-by-run.json`
- `trades-by-run.json`

Но не видит:

- `bundles-by-trade.json`
- minute-by-minute market context по конкретным сделкам
- lifecycle событий сделки: `entry`, `dca`, `tp`, `sl`, `be`, `stop_update`, `exit`

Следствие:

- `tradeEvidenceBundles` в dry-run сейчас равно `0`
- модель всё ещё рассуждает в основном по агрегатам и close reasons

### 2. Eval scoring всё ещё heuristic

Сейчас eval хорошо отсекает:

- невалидный JSON
- не research-only ответы
- слишком общие гипотезы без ссылок на профиль и observed failure patterns

Но он пока не проверяет:

- корректность причинно-следственной связи по minute-level данным
- привязку к конкретным ценовым участкам сделки
- корректную интерпретацию DCA / BE / stop updates
- качество гипотезы относительно альтернативной модели

### 3. Нет полного сравнения top-model candidates

Нужно прогнать и сравнить несколько сильных моделей на одном и том же forensic fixture, а не на агрегированном срезе.

## Roadmap

### Этап 1. Собрать forensic fixture по худшим сделкам

Задача:

- выбрать 3-5 худших закрытых сделок с VPS-среза
- для каждой сделки собрать bounded forensic bundle

Что должно попасть в `bundles-by-trade.json`:

- `tradeId`, `runId`, `symbol`, `side`
- `enteredAtMs`, `closedAtMs`
- `entryPrice`, `exitPrice`
- `realizedPnl`, `pnlPct`, `holdingDurationMs`, `closeReason`
- `lifecycleEvents`
- `minuteContext`

Что должно быть в `minuteContext` по каждой минуте:

- `tsMs`
- `close`
- `volume`
- `oi`
- `liquidationsLong`
- `liquidationsShort`

Источники:

- Postgres платформы для run / trade / execution-метаданных
- parquet market history из `trading-platform` для minute-level market context

Критерий готовности:

- `pnpm researcher:eval --models ...` в dry-run показывает `tradeEvidenceBundles > 0`
- хотя бы одна убыточная сделка имеет полный forensic bundle

### Этап 2. Экспортер forensic evidence

Задача:

- сделать воспроизводимый exporter, который строит `bundles-by-trade.json` из platform data

Требования:

- bounded output, чтобы не взорвать prompt
- стабильный формат fixtures
- deterministic ordering
- fail-fast при дырках в trade lifecycle или market history

Минимальный scope:

- CLI или script в `trading-lab`
- на вход: список `tradeId`
- на выход: fixture-ready JSON

Критерий готовности:

- exporter можно запустить повторно и получить тот же JSON при тех же исходных данных

### Этап 3. Усилить prompt researcher forensic-данными

Задача:

- убедиться, что LLM получает не только агрегаты, но и реальную динамику плохих сделок

Что проверить:

- видит ли модель `entry`, `DCA`, `BE`, `SL`, `time_exit`
- видит ли она OI / liquidation context до и после входа
- формулирует ли гипотезы как overlay над текущей стратегией, а не как новую стратегию

Критерий готовности:

- hypothesis ссылается на конкретный failure pattern сделки, а не только на общий `negative pnl`

### Этап 4. Усилить eval scoring

Задача:

- оценивать не только наличие ключевых слов, но и качество причинной интерпретации

Что добавить:

- check на ссылку на конкретные symbols / close reasons / lifecycle events
- check на использование profile-specific thresholds: `10% dump`, `180 minutes`, `TP1 3.5%`, `TP2 5%`, `SL -12%`, `DCA`, `BE`
- penalty за generic hypotheses уровня "добавить фильтр тренда"
- penalty за попытку переписать стратегию вместо локального overlay
- отдельный check на falsifiable validation plan именно по тем метрикам, которые гипотеза меняет

Желательно:

- pairwise judge или rubric-based secondary evaluator
- human-readable report, почему модель победила

Критерий готовности:

- generic output больше не может получить высокий score
- две разные модели начинают различаться не только по структуре, но и по качеству reasoning

### Этап 5. Полный model bake-off

Кандидаты:

- `openrouter/x-ai/grok-4.3`
- `openrouter/openai/gpt-5.5`
- `openrouter/openai/gpt-5`
- `openrouter/google/gemini-2.5-pro`
- при необходимости ещё 1-2 сильные reasoning-модели

Протокол:

- один и тот же fixture
- одинаковый threshold
- `repeat >= 3`
- сохранение raw outputs
- ручной разбор top-2 результатов

Смотреть не только на score:

- насколько hypothesis реально grounded в данных
- сохраняет ли она исходный strategy core
- насколько она builder-ready
- насколько validation plan воспроизводим

Критерий готовности:

- выбрана модель по совокупности auto-score + manual review

### Этап 6. Финальный e2e researcher workflow

Нужно проверить цепочку:

`strategy profile -> bot results -> trade evidence -> researcher -> refined hypothesis`

Что должно быть покрыто:

- workflow test
- fixture-based e2e
- happy path
- degraded path без `tradeEvidence`

Критерий готовности:

- researcher выдаёт валидную уточнённую гипотезу и не ломается при отсутствии forensic bundles

## Приоритеты

### P0

- собрать хотя бы один реальный `bundles-by-trade.json`
- подключить его в `researcher:eval`
- повторно прогнать top-model eval

### P1

- усилить scoring
- сделать bake-off 3-5 моделей
- выпустить отчёт по сравнению моделей

### P2

- автоматизировать exporter
- расширить e2e и regression coverage

## Definition of Done

Researcher можно считать доведённым, когда:

- eval использует полный профиль стратегии
- eval использует реальные forensic bundles по сделкам
- хотя бы 3 сильные модели сравнены на одном наборе данных
- победитель выбран не по форме JSON, а по качеству гипотез
- workflow покрыт e2e-тестом
- refined hypothesis пригодна для передачи builder-агенту без ручной правки структуры
