import { describe, it, expect } from 'vitest';
import { aggregateRuns, rankAggregates } from './aggregate.ts';
import type { CandidateResult, ModelAggregate, ScoreResult } from './types.ts';

function score(s: number): ScoreResult {
  return { gates: { schemaValid: true, directionPreserved: true, noRunnerOverreach: true, nonTrivialChange: true }, checks: [], score: s, threshold: 0.6, verdict: s >= 0.6 ? 'PASS' : 'FAIL' };
}
function run(over: Partial<CandidateResult>): CandidateResult {
  return { label: 'l', mode: 'single', criticModel: 'm', refinerModel: null, caseId: 'pump-short', latencyMs: 100, verdict: 'PASS', score: score(0.8), rawOutput: null, error: null, judge: null, profile: null, profileScore: null, ...over };
}

describe('aggregateRuns', () => {
  it('computes runs/passRate/det over repeated runs (failed counts as non-PASS)', () => {
    const agg = aggregateRuns([
      run({}),
      run({ verdict: 'FAIL', score: null, error: { type: 'schema', message: 'x' } }),
      run({ score: score(0.8) }),
    ]);
    expect(agg.runs).toEqual({ total: 3, ok: 2, failed: 1, failedByType: { schema: 1 } });
    expect(agg.passRate).toBeCloseTo(2 / 3, 10);
    expect(agg.det!.mean).toBeCloseTo(0.8, 10);
    expect(agg.det!.std).toBe(0); // 2 identical ok scores
  });
});

describe('rankAggregates', () => {
  it('sorts judge-mean -> passRate -> det-mean, carrying mode + role models', () => {
    const single: ModelAggregate = { label: 'single:a', mode: 'single', criticModel: 'a', refinerModel: null, runs: { total: 1, ok: 1, failed: 0, failedByType: {} }, passRate: 0.5, det: { mean: 0.7, median: 0.7, std: 0, min: 0.7, max: 0.7 }, judge: { mean: 0.6, median: 0.6, std: 0, min: 0.6, max: 0.6 }, latency: { mean: 100, median: 100 } };
    const twoStage: ModelAggregate = { label: 'two_stage:critic=a,refiner=b', mode: 'two_stage', criticModel: 'a', refinerModel: 'b', runs: { total: 1, ok: 1, failed: 0, failedByType: {} }, passRate: 1, det: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 }, judge: { mean: 0.9, median: 0.9, std: 0, min: 0.9, max: 0.9 }, latency: { mean: 100, median: 100 } };
    const ranked = rankAggregates([single, twoStage], true);
    expect(ranked.map((a) => a.label)).toEqual(['two_stage:critic=a,refiner=b', 'single:a']);
    expect(ranked[0]!.mode).toBe('two_stage');
    expect(ranked[0]!.refinerModel).toBe('b');
  });
});
