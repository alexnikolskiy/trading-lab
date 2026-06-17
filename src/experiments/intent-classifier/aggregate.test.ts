// src/experiments/intent-classifier/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { mean, median, std, quantile, aggregateRuns, rankAggregates } from './aggregate.ts';
import type { CandidateResult, ScoreResult, ModelAggregate } from './types.ts';

function score(intentAccuracy: number, payloadAccuracy: number | null): ScoreResult {
  return {
    intentAccuracy,
    payloadAccuracy,
    score: intentAccuracy,
    threshold: 0.7,
    verdict: intentAccuracy >= 0.7 ? 'PASS' : 'FAIL',
    cases: [],
    caseCount: 0,
    schemaValidCount: 0,
  };
}

function run(over: Partial<CandidateResult> & { model: string }): CandidateResult {
  return {
    provider: 'openrouter',
    modelId: 'm',
    latencyMs: 100,
    verdict: 'PASS',
    score: score(1, 1),
    error: null,
    judge: null,
    ...over,
  };
}

describe('stats primitives', () => {
  it('mean / median / std / quantile', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(std([2, 2, 2])).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe('aggregateRuns', () => {
  it('passRate over all runs; det over intentAccuracy; identical runs -> std 0', () => {
    const a = aggregateRuns([run({ model: 'm', score: score(1, 1) }), run({ model: 'm', score: score(1, 1) })]);
    expect(a.runs).toEqual({ total: 2, ok: 2, failed: 0, failedByType: {} });
    expect(a.passRate).toBe(1);
    expect(a.det!.mean).toBe(1);
    expect(a.det!.std).toBe(0);
  });

  it('aggregates payloadAccuracy across runs (skips null)', () => {
    const a = aggregateRuns([run({ model: 'm', score: score(1, 1) }), run({ model: 'm', score: score(1, 0) })]);
    expect(a.payload!.mean).toBe(0.5);
  });

  it('payload is null when no run carried a payload score', () => {
    const a = aggregateRuns([run({ model: 'm', score: score(1, null) })]);
    expect(a.payload).toBeNull();
  });

  it('counts a catastrophically failed run as non-PASS with classified error', () => {
    const a = aggregateRuns([
      run({ model: 'm', verdict: 'PASS', score: score(1, 1) }),
      run({ model: 'm', verdict: 'FAIL', score: null, error: { type: 'provider', message: 'boom' } }),
    ]);
    expect(a.runs).toEqual({ total: 2, ok: 1, failed: 1, failedByType: { provider: 1 } });
    expect(a.passRate).toBe(0.5);
    expect(a.det!.mean).toBe(1); // only the ok run contributes to det
  });

  it('judge is null when no run produced a judge verdict', () => {
    const a = aggregateRuns([run({ model: 'm' })]);
    expect(a.judge).toBeNull();
  });

  it('aggregates judge overallScore when present', () => {
    const a = aggregateRuns([
      run({ model: 'm', judge: { dimensions: [], overallScore: 0.8, disputedCases: [], notes: '' } }),
    ]);
    expect(a.judge!.mean).toBe(0.8);
  });
});

describe('rankAggregates', () => {
  const agg = (over: Partial<ModelAggregate> & { model: string }): ModelAggregate => ({
    provider: 'openrouter',
    modelId: 'm',
    runs: { total: 1, ok: 1, failed: 0, failedByType: {} },
    passRate: 1,
    det: { mean: 1, median: 1, std: 0, min: 1, max: 1 },
    payload: { mean: 1, median: 1, std: 0, min: 1, max: 1 },
    judge: null,
    latency: { mean: 100, median: 100 },
    ...over,
  });

  it('ranks by intent-accuracy (det.mean) desc when passRate ties', () => {
    const ranked = rankAggregates(
      [agg({ model: 'lo', det: { mean: 0.6, median: 0.6, std: 0, min: 0.6, max: 0.6 } }), agg({ model: 'hi', det: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 } })],
      false,
    );
    expect(ranked.map((a) => a.model)).toEqual(['hi', 'lo']);
  });

  it('breaks an accuracy tie by payload mean desc', () => {
    const ranked = rankAggregates(
      [agg({ model: 'lo-payload', payload: { mean: 0.4, median: 0, std: 0, min: 0, max: 0 } }), agg({ model: 'hi-payload', payload: { mean: 0.9, median: 0, std: 0, min: 0, max: 0 } })],
      false,
    );
    expect(ranked.map((a) => a.model)).toEqual(['hi-payload', 'lo-payload']);
  });

  it('breaks a full tie by latency asc (cheaper/faster first)', () => {
    const ranked = rankAggregates(
      [agg({ model: 'slow', latency: { mean: 900, median: 900 } }), agg({ model: 'fast', latency: { mean: 100, median: 100 } })],
      false,
    );
    expect(ranked.map((a) => a.model)).toEqual(['fast', 'slow']);
  });

  it('ranks by judge mean first when judge is enabled', () => {
    const ranked = rankAggregates(
      [agg({ model: 'lo-judge', judge: { mean: 0.5, median: 0.5, std: 0, min: 0.5, max: 0.5 }, passRate: 1 }), agg({ model: 'hi-judge', judge: { mean: 0.95, median: 0.95, std: 0, min: 0.95, max: 0.95 }, passRate: 0 })],
      true,
    );
    expect(ranked.map((a) => a.model)).toEqual(['hi-judge', 'lo-judge']);
  });
});
