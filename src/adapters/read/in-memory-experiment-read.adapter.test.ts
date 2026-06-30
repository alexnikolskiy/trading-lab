import { describe, it, expect } from 'vitest';
import { InMemoryExperimentReadAdapter } from './in-memory-experiment-read.adapter.ts';
import { DEFAULT_HOLDOUT_POLICY, type ResearchExperiment } from '../../domain/research-experiment.ts';

function exp(id: string, createdAt: string, over: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id,
    experimentKey: `key-${id}`,
    experimentType: 'new_strategy_validation',
    strategyProfileId: 'p1',
    datasetScope: { datasetId: 'd', symbols: ['BTC'], timeframe: '1m', period: { from: 'a', to: 'b' } },
    holdoutPolicy: DEFAULT_HOLDOUT_POLICY,
    status: 'completed',
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

describe('InMemoryExperimentReadAdapter', () => {
  it('lists newest-first, filters by status, paginates by cursor', async () => {
    const a = exp('a', '2026-01-01T00:00:00.000Z', { status: 'running' });
    const b = exp('b', '2026-01-02T00:00:00.000Z');
    const c = exp('c', '2026-01-03T00:00:00.000Z');
    const r = new InMemoryExperimentReadAdapter({ experiments: [a, b, c] });

    expect((await r.list({ limit: 2 })).map((e) => e.id)).toEqual(['c', 'b']);
    expect((await r.list({ limit: 10, status: 'completed' })).map((e) => e.id)).toEqual(['c', 'b']);
    expect((await r.list({ limit: 10, after: { t: b.createdAt, id: 'b' } })).map((e) => e.id)).toEqual(['a']);
  });

  it('filters by strategyProfileId', async () => {
    const a = exp('a', '2026-01-01T00:00:00.000Z', { strategyProfileId: 'p1' });
    const b = exp('b', '2026-01-02T00:00:00.000Z', { strategyProfileId: 'p2' });
    const r = new InMemoryExperimentReadAdapter({ experiments: [a, b] });

    expect((await r.list({ limit: 10, strategyProfileId: 'p1' })).map((e) => e.id)).toEqual(['a']);
    expect((await r.list({ limit: 10, strategyProfileId: 'p2' })).map((e) => e.id)).toEqual(['b']);
  });

  it('getById returns the matching experiment or null', async () => {
    const a = exp('a', '2026-01-01T00:00:00.000Z');
    const r = new InMemoryExperimentReadAdapter({ experiments: [a] });

    expect(await r.getById('a')).toEqual(a);
    expect(await r.getById('missing')).toBeNull();
  });

  it('listRuns returns members for experimentId ordered by createdAt', async () => {
    const m1 = {
      id: 'm1', experimentId: 'e1', role: 'train' as const,
      periodFrom: '2026-01-01T00:00:00.000Z', periodTo: '2026-01-15T00:00:00.000Z',
      symbols: ['BTC'], paramsHash: 'h1', bundleHash: 'b1',
      createdAt: '2026-01-02T00:00:00.000Z',
    };
    const m2 = {
      id: 'm2', experimentId: 'e1', role: 'holdout' as const,
      periodFrom: '2026-01-15T00:00:00.000Z', periodTo: '2026-01-31T00:00:00.000Z',
      symbols: ['BTC'], paramsHash: 'h1', bundleHash: 'b1',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const m3 = { ...m1, id: 'm3', experimentId: 'e2' };
    const r = new InMemoryExperimentReadAdapter({ members: [m1, m2, m3] });

    const runs = await r.listRuns('e1');
    expect(runs.map((m) => m.id)).toEqual(['m2', 'm1']); // oldest first
    expect((await r.listRuns('e2')).map((m) => m.id)).toEqual(['m3']);
    expect(await r.listRuns('none')).toEqual([]);
  });
});
