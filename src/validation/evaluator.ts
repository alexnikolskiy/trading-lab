// src/validation/evaluator.ts
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';

export type EvaluationDecision = 'PASS' | 'MODIFY' | 'FAIL' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface EvaluatorThresholds {
  minTrades: number;
  minPnlDeltaUsd: number;
  maxDrawdownTolerancePct: number;
  fragilityTopTradePct: number;
  strongPnlDeltaUsd: number;
  minProfitFactor: number;
}

export const DEFAULT_EVALUATOR_THRESHOLDS: EvaluatorThresholds = {
  minTrades: 20,
  minPnlDeltaUsd: 0,
  maxDrawdownTolerancePct: 2.0,
  fragilityTopTradePct: 50,
  strongPnlDeltaUsd: 100,
  minProfitFactor: 1.5,
};

export interface EvaluationOutcome {
  decision: EvaluationDecision;
  reasons: string[];
}

/** Deterministic first-match ladder. Math: positive maxDrawdownPct = worse. */
export function evaluateBacktest(summary: ComparisonSummary, t: EvaluatorThresholds): EvaluationOutcome {
  const { baseline, variant } = summary;
  const deltaNetPnlUsd = variant.netPnlUsd - baseline.netPnlUsd;
  const deltaMaxDrawdownPct = variant.maxDrawdownPct - baseline.maxDrawdownPct;
  const fragile = variant.topTradeContributionPct >= t.fragilityTopTradePct;

  if (variant.totalTrades < t.minTrades) return { decision: 'INCONCLUSIVE', reasons: ['insufficient_sample'] };
  if (deltaNetPnlUsd <= t.minPnlDeltaUsd) return { decision: 'FAIL', reasons: ['no_improvement_over_baseline'] };
  if (deltaMaxDrawdownPct > t.maxDrawdownTolerancePct) return { decision: 'MODIFY', reasons: ['drawdown_regression'] };
  if (fragile) return { decision: 'MODIFY', reasons: ['fragile_pnl'] };
  if (deltaNetPnlUsd >= t.strongPnlDeltaUsd && variant.profitFactor >= t.minProfitFactor && variant.winRate >= baseline.winRate) {
    return { decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'] };
  }
  return { decision: 'PASS', reasons: ['positive_edge'] };
}
