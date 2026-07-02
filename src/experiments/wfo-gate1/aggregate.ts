import type { ModelAggregate } from './eval-harness.ts';

export interface FrontierVerdict {
  incumbentModelId: string;
  bestModelId: string | null;
  bestScore: number;
  threshold: number;
  passes: boolean;
  reason: string;
}

export function rankAggregates(aggregates: ModelAggregate[]): ModelAggregate[] {
  return [...aggregates].sort((a, b) => b.meanScore - a.meanScore || b.accuracy - a.accuracy);
}

export function frontierVerdict(ranked: ModelAggregate[], opts: { incumbentModelId: string; threshold: number }): FrontierVerdict {
  const best = ranked[0];
  const bestModelId = best?.modelId ?? null;
  const bestScore = best?.meanScore ?? 0;
  const passes = !!best && best.meanScore >= opts.threshold;

  let reason: string;
  if (!best) {
    reason = 'no candidates';
  } else if (passes) {
    const isIncumbent = bestModelId === opts.incumbentModelId ? ' (is incumbent)' : '';
    reason = `frontier ${bestModelId} passes (meanScore ${bestScore} >= ${opts.threshold})${isIncumbent}`;
  } else {
    const isIncumbent = bestModelId === opts.incumbentModelId ? ' (is incumbent)' : '';
    reason = `frontier ${bestModelId} below threshold (${bestScore} < ${opts.threshold})${isIncumbent}`;
  }

  return {
    incumbentModelId: opts.incumbentModelId,
    bestModelId,
    bestScore,
    threshold: opts.threshold,
    passes,
    reason,
  };
}
