import type { CandidateResult, ModelAggregate } from './types.ts';

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function aggregateRuns(runs: readonly CandidateResult[]): ModelAggregate {
  const first = runs[0];
  if (!first) throw new Error('aggregateRuns requires at least one run');
  const failedByType: Record<string, number> = {};
  for (const r of runs) {
    if (r.error) failedByType[r.error.type] = (failedByType[r.error.type] ?? 0) + 1;
  }
  const ok = runs.filter((r) => r.error === null).length;
  const scoreMean = mean(runs.map((r) => r.score?.score).filter((v): v is number => v !== undefined));
  return {
    model: first.model,
    provider: first.provider,
    modelId: first.modelId,
    runs: { total: runs.length, ok, failed: runs.length - ok, failedByType },
    passRate: runs.filter((r) => r.verdict === 'PASS').length / runs.length,
    scoreMean,
    latencyMeanMs: mean(runs.map((r) => r.latencyMs)) ?? 0,
  };
}

export function rankAggregates(aggregates: readonly ModelAggregate[]): ModelAggregate[] {
  return aggregates.slice().sort((a, b) =>
    b.passRate - a.passRate
    || (b.scoreMean ?? -1) - (a.scoreMean ?? -1)
    || a.latencyMeanMs - b.latencyMeanMs
    || a.model.localeCompare(b.model));
}
