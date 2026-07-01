import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { HoldoutBoundary, ExperimentFlags, ExperimentVerdict } from '../domain/research-experiment.ts';

export const STRATEGY_BASELINE_EVALUATOR_VERSION = 'strategy-baseline-v1';
export const STRATEGY_BASELINE_THRESHOLDS = { minSharpe: 0, minProfitFactor: 1, minTrades: 1 } as const;

export interface StrategyBaselineEvaluation {
  verdict: ExperimentVerdict;
  verdictReason?: string;
  rawScores: Record<string, unknown>;
  flags: ExperimentFlags;
}

export function evaluateStrategyBaseline(input: { holdout: BacktestMetricBlock; boundary: HoldoutBoundary }): StrategyBaselineEvaluation {
  const t = STRATEGY_BASELINE_THRESHOLDS;
  const flags: ExperimentFlags = { lowConfidenceHoldout: input.boundary.lowConfidence, overfit: false, fragility: [], coverageWarnings: [] };
  const rawScores = { thresholds: t, holdout: input.holdout, holdoutTrades: input.boundary.holdoutTrades };

  if (input.boundary.lowConfidence) {
    return { verdict: 'INCONCLUSIVE', verdictReason: 'low_confidence', rawScores, flags };
  }

  const viable = input.holdout.totalTrades >= t.minTrades && input.holdout.profitFactor >= t.minProfitFactor && input.holdout.sharpe > t.minSharpe;
  if (viable) {
    return { verdict: 'PAPER_CANDIDATE', rawScores, flags };
  }

  return { verdict: 'FAIL', verdictReason: 'baseline_below_floor', rawScores, flags };
}
