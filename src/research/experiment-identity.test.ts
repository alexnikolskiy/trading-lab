import { describe, it, expect } from 'vitest';
import { computeExperimentKey } from './experiment-identity.ts';
import { DEFAULT_HOLDOUT_POLICY } from '../domain/research-experiment.ts';

const base = {
  strategyProfileId: 'p1',
  buildId: 'b1',
  bundleHash: 'h1',
  datasetScope: {
    datasetId: 'd',
    symbols: ['BTC'],
    timeframe: '1m',
    period: { from: 'a', to: 'b' },
  },
  holdoutPolicy: DEFAULT_HOLDOUT_POLICY,
};

describe('computeExperimentKey', () => {
  it('is deterministic for identical input', () => {
    expect(computeExperimentKey(base)).toBe(computeExperimentKey({ ...base }));
  });

  it('differs when scope or policy differs', () => {
    const otherScope = {
      ...base,
      datasetScope: { ...base.datasetScope, period: { from: 'a', to: 'c' } },
    };
    const otherPolicy = {
      ...base,
      holdoutPolicy: { ...DEFAULT_HOLDOUT_POLICY, minTradesHoldout: 40 },
    };
    expect(computeExperimentKey(otherScope)).not.toBe(computeExperimentKey(base));
    expect(computeExperimentKey(otherPolicy)).not.toBe(computeExperimentKey(base));
  });

  it('is key-order-independent (canonical JSON guard)', () => {
    // Rebuild datasetScope with properties in a different declaration order.
    // Plain JSON.stringify would produce a different hash; stableStringify must not.
    const { datasetScope } = base;
    const reorderedScope = {
      timeframe: datasetScope.timeframe,
      symbols: datasetScope.symbols,
      datasetId: datasetScope.datasetId,
      period: datasetScope.period,
    };
    expect(computeExperimentKey({ ...base, datasetScope: reorderedScope })).toBe(
      computeExperimentKey(base),
    );
  });
});
