import { describe, it, expect } from 'vitest';
import { computeStrategyParamsHash } from './strategy-run-identity.ts';

const run = { datasetId: 'd', symbols: ['B', 'A'], timeframe: '1h', period: { from: 'x', to: 'y' }, seed: 42 };

describe('computeStrategyParamsHash', () => {
  it('is deterministic and symbol-order-independent', () => {
    const h1 = computeStrategyParamsHash({ bundleHash: 'sha256:h', platformRun: run, params: {} });
    const h2 = computeStrategyParamsHash({ bundleHash: 'sha256:h', platformRun: { ...run, symbols: ['A', 'B'] }, params: {} });
    expect(h1).toBe(h2);
  });
  it('differs on bundleHash / params / period', () => {
    const base = { bundleHash: 'sha256:h', platformRun: run, params: {} };
    expect(computeStrategyParamsHash(base)).not.toBe(computeStrategyParamsHash({ ...base, bundleHash: 'sha256:g' }));
    expect(computeStrategyParamsHash(base)).not.toBe(computeStrategyParamsHash({ ...base, params: { k: 1 } }));
  });
});
