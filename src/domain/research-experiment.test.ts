import { describe, it, expect } from 'vitest';
import { DEFAULT_HOLDOUT_POLICY } from './research-experiment.ts';

describe('DEFAULT_HOLDOUT_POLICY', () => {
  it('uses the spec defaults', () => {
    expect(DEFAULT_HOLDOUT_POLICY).toEqual({
      mode: 'trade_based',
      minTradesTrain: 50,
      minTradesHoldout: 30,
      lowConfidenceThreshold: 15,
      minHistoryDays: 30,
    });
  });
});
