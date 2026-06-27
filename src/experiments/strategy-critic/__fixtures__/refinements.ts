// src/experiments/strategy-critic/__fixtures__/refinements.ts
import type { StrategyRefinement } from '../../../domain/strategy-critic.ts';

// All four are paired with the `pump-short` case (direction = 'short').
const BASE_CRITIQUE = {
  vulnerabilities: ['Vague entry trigger', 'No confirmation signal', 'No invalidation level'],
  selfDeception: [],
  risks: { market: 'n/a', timing: 'n/a', news: 'n/a', liquidity: 'n/a', btcRegime: 'n/a', exhaustion: 'n/a' },
  earlyBreakSigns: [],
  preEntryChecks: [],
  verdict: { mainVulnerability: 'no confirmation', severity: 'medium' as const, badIdeaOrBadTiming: 'bad_timing' as const, whatWouldStrengthen: 'add flow confirmation' },
};

/** GOOD: short preserved, no overreach, covers every aspect -> PASS. */
export const GOOD_PUMP_SHORT_REFINEMENT: StrategyRefinement = {
  ...BASE_CRITIQUE,
  improvedStrategyText:
    'Шорт после пампа от 10% за 20 минут на таймфрейме M5. Подтверждаем разворот по taker delta (CVD слабеет, ' +
    'агрессивные покупки иссякают) и по динамике open interest (перегретый long). Фандинг на экстремуме усиливает сигнал. ' +
    'Учитываем риск каскада long-ликвидаций. Уровень инвалидации сетапа — новый максимум выше пика пампа, стоп за ним. ' +
    'Окно удержания ограничено несколькими барами M5.',
  changeLog: ['added taker/CVD confirmation', 'added OI trend filter', 'added funding extreme', 'added liquidation cascade caveat', 'added invalidation level', 'added timeframe/holding window'],
};

/** GATE FAIL — direction flipped to long (no short marker) -> directionPreserved=false. */
export const WRONG_DIRECTION_REFINEMENT: StrategyRefinement = {
  ...BASE_CRITIQUE,
  improvedStrategyText:
    'Вместо контр-тренда рекомендую вход в лонг (buy) после разворота вверх на таймфрейме M5. ' +
    'Подтверждение по taker delta и CVD, динамика open interest, фандинг, риск ликвидаций, уровень инвалидации (стоп), окно удержания.',
  changeLog: ['flipped to long'],
};

/** LOW COVERAGE — short preserved, no overreach, but only taker-flow is addressed -> coverage < threshold. */
export const LOW_COVERAGE_REFINEMENT: StrategyRefinement = {
  ...BASE_CRITIQUE,
  improvedStrategyText:
    'Шорт после резкого роста на 10 процентов, добавим подтверждение входа по taker delta и cvd как единственный фильтр агрессивного потока.',
  changeLog: ['added taker confirmation only'],
};

/** RUNNER OVERREACH — covers aspects + short preserved, but prescribes leverage / base size -> noRunnerOverreach=false. */
export const RUNNER_OVERREACH_REFINEMENT: StrategyRefinement = {
  ...BASE_CRITIQUE,
  improvedStrategyText:
    'Шорт после пампа от 10% за 20 минут на M5. Подтверждение по taker delta/CVD, open interest, фандинг, ликвидации, ' +
    'уровень инвалидации (стоп), окно удержания. Вход с плечом 10x, базовый ордер $100, риск 2% от депозита.',
  changeLog: ['added confirmations', 'added sizing (overreach)'],
};
