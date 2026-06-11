import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../validation/evaluator.ts';

describe('loadEnv SP-3 fields', () => {
  it('defaults researcher and critic to fake and bounds hypotheses', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('fake');
    expect(env.CRITIC_ADAPTER).toBe('fake');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5);
  });

  it('honors overrides and rejects non-positive guardrails', () => {
    const env = loadEnv({ RESEARCHER_ADAPTER: 'mastra', MAX_HYPOTHESES_PER_CYCLE: '0' } as NodeJS.ProcessEnv);
    expect(env.RESEARCHER_ADAPTER).toBe('mastra');
    expect(env.MAX_HYPOTHESES_PER_CYCLE).toBe(5); // 0 is invalid -> fallback
  });
});

describe('SP-4 env', () => {
  it('defaults builder + thresholds', () => {
    const env = loadEnv({});
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.BUILDER_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.evaluatorThresholds).toEqual(DEFAULT_EVALUATOR_THRESHOLDS);
  });

  it('reads builder + threshold overrides', () => {
    const env = loadEnv({ BUILDER_ADAPTER: 'mastra', EVAL_MIN_TRADES: '40', EVAL_STRONG_PNL_DELTA_USD: '500', EVAL_MIN_PROFIT_FACTOR: '1.8' });
    expect(env.BUILDER_ADAPTER).toBe('mastra');
    expect(env.evaluatorThresholds.minTrades).toBe(40);
    expect(env.evaluatorThresholds.strongPnlDeltaUsd).toBe(500);
    expect(env.evaluatorThresholds.minProfitFactor).toBe(1.8);
  });
});
