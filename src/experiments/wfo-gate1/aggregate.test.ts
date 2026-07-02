import { describe, it, expect } from 'vitest';
import { rankAggregates, frontierVerdict } from './aggregate.ts';
import type { ModelAggregate } from './eval-harness.ts';

describe('rankAggregates', () => {
  it('sorts by meanScore desc, then accuracy desc', () => {
    const agg1: ModelAggregate = {
      modelId: 'model-a',
      provider: 'provider-a',
      runs: 1,
      meanScore: 0.7,
      accuracy: 0.8,
      oracleAccuracy: 0.9,
      teacherAccuracy: 0.85,
      passRate: 0.75,
      meanLatencyMs: 100,
    };

    const agg2: ModelAggregate = {
      modelId: 'model-b',
      provider: 'provider-b',
      runs: 1,
      meanScore: 0.9,
      accuracy: 0.85,
      oracleAccuracy: 0.95,
      teacherAccuracy: 0.9,
      passRate: 0.85,
      meanLatencyMs: 120,
    };

    const agg3: ModelAggregate = {
      modelId: 'model-c',
      provider: 'provider-c',
      runs: 1,
      meanScore: 0.9,
      accuracy: 0.9,
      oracleAccuracy: 0.92,
      teacherAccuracy: 0.91,
      passRate: 0.88,
      meanLatencyMs: 110,
    };

    const input = [agg1, agg2, agg3];
    const ranked = rankAggregates(input);

    // Should be sorted by meanScore desc, then accuracy desc
    // agg3 (0.9, 0.9) > agg2 (0.9, 0.85) > agg1 (0.7, 0.8)
    expect(ranked[0]!.modelId).toBe('model-c');
    expect(ranked[1]!.modelId).toBe('model-b');
    expect(ranked[2]!.modelId).toBe('model-a');

    // Input should not be mutated
    expect(input[0]!.modelId).toBe('model-a');
    expect(input[1]!.modelId).toBe('model-b');
    expect(input[2]!.modelId).toBe('model-c');
  });

  it('returns a new array without mutating input', () => {
    const input: ModelAggregate[] = [
      {
        modelId: 'model-x',
        provider: 'provider-x',
        runs: 1,
        meanScore: 0.5,
        accuracy: 0.6,
        oracleAccuracy: 0.7,
        teacherAccuracy: 0.65,
        passRate: 0.55,
        meanLatencyMs: 100,
      },
    ];

    const ranked = rankAggregates(input);

    expect(ranked).not.toBe(input);
    expect(input[0]!.modelId).toBe('model-x');
  });
});

describe('frontierVerdict', () => {
  it('passes when best.meanScore >= threshold', () => {
    const aggregates: ModelAggregate[] = [
      {
        modelId: 'model-a',
        provider: 'provider-a',
        runs: 1,
        meanScore: 0.85,
        accuracy: 0.9,
        oracleAccuracy: 0.95,
        teacherAccuracy: 0.92,
        passRate: 0.88,
        meanLatencyMs: 100,
      },
    ];

    const verdict = frontierVerdict(aggregates, { incumbentModelId: 'incumbent', threshold: 0.8 });

    expect(verdict.passes).toBe(true);
    expect(verdict.bestModelId).toBe('model-a');
    expect(verdict.bestScore).toBe(0.85);
    expect(verdict.threshold).toBe(0.8);
  });

  it('fails when best.meanScore < threshold', () => {
    const aggregates: ModelAggregate[] = [
      {
        modelId: 'model-a',
        provider: 'provider-a',
        runs: 1,
        meanScore: 0.7,
        accuracy: 0.8,
        oracleAccuracy: 0.85,
        teacherAccuracy: 0.82,
        passRate: 0.75,
        meanLatencyMs: 100,
      },
    ];

    const verdict = frontierVerdict(aggregates, { incumbentModelId: 'incumbent', threshold: 0.8 });

    expect(verdict.passes).toBe(false);
    expect(verdict.bestModelId).toBe('model-a');
    expect(verdict.bestScore).toBe(0.7);
    expect(verdict.threshold).toBe(0.8);
  });

  it('returns passes:false and bestModelId:null for empty input', () => {
    const verdict = frontierVerdict([], { incumbentModelId: 'incumbent', threshold: 0.8 });

    expect(verdict.passes).toBe(false);
    expect(verdict.bestModelId).toBe(null);
    expect(verdict.bestScore).toBe(0);
    expect(verdict.threshold).toBe(0.8);
  });

  it('includes reason string describing pass/fail status', () => {
    const aggregates: ModelAggregate[] = [
      {
        modelId: 'model-a',
        provider: 'provider-a',
        runs: 1,
        meanScore: 0.85,
        accuracy: 0.9,
        oracleAccuracy: 0.95,
        teacherAccuracy: 0.92,
        passRate: 0.88,
        meanLatencyMs: 100,
      },
    ];

    const verdict = frontierVerdict(aggregates, { incumbentModelId: 'incumbent', threshold: 0.8 });

    expect(verdict.reason).toContain('model-a');
    expect(verdict.reason).toContain('0.85');
  });

  it('includes information about incumbent in reason', () => {
    const aggregates: ModelAggregate[] = [
      {
        modelId: 'incumbent',
        provider: 'provider-a',
        runs: 1,
        meanScore: 0.85,
        accuracy: 0.9,
        oracleAccuracy: 0.95,
        teacherAccuracy: 0.92,
        passRate: 0.88,
        meanLatencyMs: 100,
      },
    ];

    const verdict = frontierVerdict(aggregates, { incumbentModelId: 'incumbent', threshold: 0.8 });

    expect(verdict.reason).toContain('incumbent');
  });
});
