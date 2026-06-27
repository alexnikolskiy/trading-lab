import { describe, it, expect } from 'vitest';
import { CRITIC_EVAL_CASES, resolveCase } from './fixtures.ts';
import { StrategyRefinementSchema } from '../../domain/strategy-critic.ts';
import {
  GOOD_PUMP_SHORT_REFINEMENT,
  WRONG_DIRECTION_REFINEMENT,
  LOW_COVERAGE_REFINEMENT,
  RUNNER_OVERREACH_REFINEMENT,
} from './__fixtures__/refinements.ts';

describe('CRITIC_EVAL_CASES', () => {
  it('has the two real cases with the right direction + RU lang', () => {
    expect(resolveCase('pump-short')).toMatchObject({ direction: 'short', lang: 'ru', text: 'шорт после пампа от 10% за 20 минут' });
    expect(resolveCase('dump-long')).toMatchObject({ direction: 'long', lang: 'ru', text: 'лонг после дампа от 10% за 20 минут' });
  });
  it('every case enumerates weighted, non-empty expected aspects', () => {
    for (const c of Object.values(CRITIC_EVAL_CASES)) {
      expect(c.expectedAspects.length).toBeGreaterThanOrEqual(6);
      for (const a of c.expectedAspects) {
        expect(a.weight).toBeGreaterThan(0);
        expect(a.any.length).toBeGreaterThan(0);
      }
    }
  });
  it('resolveCase throws on an unknown id', () => {
    expect(() => resolveCase('nope')).toThrow(/unknown critic eval case/);
  });
});

describe('canned refinements', () => {
  it('all four are StrategyRefinementSchema-valid (intended failures are gate/coverage, not schema)', () => {
    for (const r of [GOOD_PUMP_SHORT_REFINEMENT, WRONG_DIRECTION_REFINEMENT, LOW_COVERAGE_REFINEMENT, RUNNER_OVERREACH_REFINEMENT]) {
      expect(StrategyRefinementSchema.safeParse(r).success).toBe(true);
    }
  });
  it('carries its intended-failure marker in improvedStrategyText', () => {
    expect(WRONG_DIRECTION_REFINEMENT.improvedStrategyText.toLowerCase()).toContain('лонг'); // flipped away from short
    expect(WRONG_DIRECTION_REFINEMENT.improvedStrategyText.toLowerCase()).not.toContain('шорт');
    expect(RUNNER_OVERREACH_REFINEMENT.improvedStrategyText.toLowerCase()).toMatch(/плеч|10x|\$\s*\d/);
    expect(LOW_COVERAGE_REFINEMENT.improvedStrategyText.toLowerCase()).toContain('taker');
  });
});
