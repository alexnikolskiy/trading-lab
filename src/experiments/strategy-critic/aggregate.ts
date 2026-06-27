// src/experiments/strategy-critic/aggregate.ts
// Pure aggregation over repeated runs. No I/O. Aggregates the deterministic scores /
// judge verdicts that scoreRefinement / judge already produced.
import type { CandidateResult, ModelAggregate, Stats } from './types.ts';

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function std(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function stats(xs: number[]): Stats {
  return { mean: mean(xs), median: median(xs), std: std(xs), min: Math.min(...xs), max: Math.max(...xs) };
}

/** Aggregate N independent runs of a single candidate. `runs` must be non-empty and the same label. */
export function aggregateRuns(runs: CandidateResult[]): ModelAggregate {
  const first = runs[0]!;
  const total = runs.length;
  const failed = runs.filter((r) => r.error !== null);
  const failedByType: Record<string, number> = {};
  for (const r of failed) failedByType[r.error!.type] = (failedByType[r.error!.type] ?? 0) + 1;

  const detScores = runs.filter((r) => r.score != null).map((r) => r.score!.score);
  const judgeScores = runs.filter((r) => r.judge != null).map((r) => r.judge!.overallScore);
  const latencies = runs.map((r) => r.latencyMs);
  const passCount = runs.filter((r) => r.verdict === 'PASS').length;

  return {
    label: first.label,
    mode: first.mode,
    criticModel: first.criticModel,
    refinerModel: first.refinerModel,
    runs: { total, ok: total - failed.length, failed: failed.length, failedByType },
    passRate: passCount / total,
    det: detScores.length > 0 ? stats(detScores) : null,
    judge: judgeScores.length > 0 ? stats(judgeScores) : null,
    latency: { mean: mean(latencies), median: median(latencies) },
  };
}

/**
 * Rank candidates: judge-mean desc (only when judge ran) -> PASS-rate desc -> det-mean desc.
 * Candidates without a judge/det mean sort last on that key. Pure; returns a new array.
 */
export function rankAggregates(aggs: ModelAggregate[], judgeEnabled: boolean): ModelAggregate[] {
  const j = (a: ModelAggregate): number => a.judge?.mean ?? -1;
  const d = (a: ModelAggregate): number => a.det?.mean ?? -1;
  return [...aggs].sort((a, b) => {
    if (judgeEnabled) {
      const dj = j(b) - j(a);
      if (dj !== 0) return dj;
    }
    const dp = b.passRate - a.passRate;
    if (dp !== 0) return dp;
    return d(b) - d(a);
  });
}
