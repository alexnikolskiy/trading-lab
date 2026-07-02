import type { RunResultSummary } from '../ports/research-platform.port.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import { INITIAL_EQUITY, resolveProfitFactors, MetricMappingError } from './platform-comparison.ts';

/**
 * Maps a strategy-engine `RunResultSummary` (variant-only `metrics`, NO `comparison`) into the
 * domain `BacktestMetricBlock`. Strategy-lane counterpart to `mapPlatformComparison` (overlay lane,
 * comparison-based). `summary.metrics` carries the platform's raw snake_case names (038 catalog):
 * pnl, sharpe, max_drawdown, win_rate, total_trades, profit_factor, top_trade_contribution_pct.
 *
 * Reuses `resolveProfitFactors` for the profit-factor edge (win_rate===1 && no losses ->
 * NO_LOSS_PROFIT_FACTOR) by calling it with the same metrics record as baseline/variant/topMetrics:
 * there is only one side here, so the 4-case comparison rule degenerates correctly to the
 * single-side case (baselinePf === variantPf) without reimplementing the edge logic.
 */
export function mapStrategyMetrics(summary: RunResultSummary): BacktestMetricBlock {
  const metrics = summary.metrics as Record<string, number> | undefined;
  if (metrics === undefined) {
    throw new MetricMappingError('missing_metric', 'missing_metric: strategy run summary has no metrics');
  }
  const { variantPf } = resolveProfitFactors(metrics, metrics, metrics);
  const netPnlUsd = metrics['pnl'] ?? 0;
  const totalTrades = metrics['total_trades'] ?? 0;
  return {
    netPnlUsd,
    netPnlPct: (netPnlUsd / INITIAL_EQUITY) * 100,
    totalTrades,
    winRate: metrics['win_rate'] ?? 0,
    profitFactor: variantPf,
    maxDrawdownPct: (metrics['max_drawdown'] ?? 0) * 100,
    expectancyUsd: totalTrades > 0 ? netPnlUsd / totalTrades : 0,
    sharpe: metrics['sharpe'] ?? 0,
    topTradeContributionPct: metrics['top_trade_contribution_pct'] ?? 0,
  };
}
