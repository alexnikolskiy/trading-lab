// src/experiments/strategy-critic/fixtures.ts
import type { AspectGroup, CriticEvalCase } from './types.ts';

// Data-grounded expected-improvement groups (keyword/regex; RU + EN synonyms).
const TAKER_FLOW: AspectGroup = { label: 'taker-flow', weight: 1, any: ['taker', 'тейкер', '\\bcvd\\b', 'delta', 'дельт', 'агресс'] };
const OI_TREND: AspectGroup = { label: 'oi-trend', weight: 1, any: ['\\boi\\b', 'open[ _]?interest', 'открыт\\w*\\s+интерес'] };
const FUNDING: AspectGroup = { label: 'funding', weight: 1, any: ['funding', 'фандинг', 'финансир'] };
const LIQUIDATION: AspectGroup = { label: 'liquidation', weight: 1, any: ['liquidation', '\\bliq\\b', 'ликвидац', 'каскад'] };
const INVALIDATION: AspectGroup = { label: 'invalidation', weight: 1, any: ['invalidat', 'инвалидац', '\\bstop\\b', 'стоп', 'уровень\\s+отмен', 'отмен\\w*\\s+сетап'] };
const TIMEFRAME: AspectGroup = { label: 'timeframe', weight: 1, any: ['timeframe', 'таймфрейм', 'holding', 'удержан', 'свеч', 'минут', '\\bm5\\b', '\\bm15\\b', 'окно'] };

const ASPECTS: AspectGroup[] = [TAKER_FLOW, OI_TREND, FUNDING, LIQUIDATION, INVALIDATION, TIMEFRAME];

export const CRITIC_EVAL_CASES: Record<string, CriticEvalCase> = {
  'pump-short': {
    id: 'pump-short',
    text: 'шорт после пампа от 10% за 20 минут',
    lang: 'ru',
    direction: 'short',
    expectedAspects: ASPECTS,
  },
  'dump-long': {
    id: 'dump-long',
    text: 'лонг после дампа от 10% за 20 минут',
    lang: 'ru',
    direction: 'long',
    expectedAspects: ASPECTS,
  },
};

export function resolveCase(id: string): CriticEvalCase {
  const c = CRITIC_EVAL_CASES[id];
  if (!c) throw new Error(`unknown critic eval case "${id}" (known: ${Object.keys(CRITIC_EVAL_CASES).join(', ')})`);
  return c;
}
