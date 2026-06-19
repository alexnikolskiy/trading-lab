import type { SimilarStrategyCandidate } from '../domain/strategy-retrieval.ts';

export interface RerankConfig {
  timeoutMs: number;
  limit: number;
  minCandidates: number;
  rrfMargin: number;
}

/** §7 gate + triggers. Pure: no clock, no I/O. `remainingMs` is the budget left for the rerank step. */
export function shouldRerank(args: {
  candidates: readonly SimilarStrategyCandidate[];
  goal: string | undefined;
  remainingMs: number;
  cfg: RerankConfig;
}): boolean {
  const { candidates, goal, remainingMs, cfg } = args;
  if (candidates.length < 2) return false;                  // minimum to reorder
  if (remainingMs < cfg.timeoutMs) return false;            // budget must permit the timeout
  // triggers (any):
  if (goal === 'show_similar') return true;                 // explicit comparison
  if (candidates.length >= cfg.minCandidates) return true;  // volume
  const [a, b] = candidates;                                // RRF ambiguity (top-two gap)
  if (a && b && Math.abs(a.rrfScore - b.rrfScore) <= cfg.rrfMargin) return true;
  return false;
}
