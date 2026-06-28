import { describe, it, expect } from 'vitest';
import { FixtureBacktesterAdapter } from './fixture-backtester.adapter.ts';
import type { StrategyRunSubmission, StrategyRunResult } from '../../ports/backtester-strategy.port.ts';

const sub: StrategyRunSubmission = {
  bundleBytes: new Uint8Array([1, 2, 3]),
  bundleHash: 'sha256:abc123',
  manifest: {} as StrategyRunSubmission['manifest'],
  curatedBundleHash: 'sha256:cura456',
  scope: {
    datasetRef: 'ds:test',
    window: { fromMs: 1000, toMs: 2000 },
    symbols: ['BTCUSDT'],
    timeframe: '1m',
  },
};

const statuses: StrategyRunResult['status'][] = ['signed', 'equivalent', 'divergent', 'rejected', 'unavailable'];

describe('FixtureBacktesterAdapter', () => {
  it('defaults to signed status', async () => {
    const adapter = new FixtureBacktesterAdapter({});
    const result = await adapter.submitStrategyRun(sub);
    expect(result.status).toBe('signed');
  });

  for (const outcome of statuses) {
    it(`returns status '${outcome}' when configured`, async () => {
      const adapter = new FixtureBacktesterAdapter({ outcome });
      const result = await adapter.submitStrategyRun(sub);
      expect(result.status).toBe(outcome);
    });
  }

  it('signed: evidence has schema backtest-evidence/v1 and bundleHash matches submission', async () => {
    const adapter = new FixtureBacktesterAdapter({ outcome: 'signed' });
    const result = await adapter.submitStrategyRun(sub);
    expect(result.evidence).toBeDefined();
    expect(result.evidence!.body.schema).toBe('backtest-evidence/v1');
    expect(result.evidence!.body.bundleHash).toBe(sub.bundleHash);
  });

  it('divergent: divergence is present', async () => {
    const adapter = new FixtureBacktesterAdapter({ outcome: 'divergent' });
    const result = await adapter.submitStrategyRun(sub);
    expect(result.divergence).toBeDefined();
  });
});
