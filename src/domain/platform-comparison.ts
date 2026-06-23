import type { RunResultSummary } from '../ports/research-platform.port.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../ports/platform-gateway.port.ts';

/** Metric names requested from the platform (038 catalog) so the comparison carries the full set. */
export const RESEARCH_RUN_METRICS = ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct'] as const;

/** Platform initial equity (data-model §6) — used to derive netPnlPct from absolute pnl. */
export const INITIAL_EQUITY = 10_000;

/** Sentinel profit factor for "no losing trades" (platform omits profit_factor when absGrossLoss==0).
 *  High finite value that passes the evaluator's minProfitFactor gate; "no losses" is a strong edge. */
export const NO_LOSS_PROFIT_FACTOR = 1_000_000;

export class MetricMappingError extends Error {
  readonly code: 'missing_metric' | 'ambiguous_profit_factor';
  constructor(code: 'missing_metric' | 'ambiguous_profit_factor', message: string) {
    super(message);
    this.name = 'MetricMappingError';
    this.code = code;
  }
}

const REQUIRED = ['pnl', 'max_drawdown', 'win_rate', 'sharpe', 'total_trades', 'top_trade_contribution_pct'] as const;

function block(side: 'baseline' | 'variant', m: Record<string, number>, profitFactor: number): BacktestMetricBlock {
  for (const name of REQUIRED) {
    if (!(name in m)) throw new MetricMappingError('missing_metric', `missing_metric: ${side} comparison is missing required metric '${name}'`);
  }
  const netPnlUsd = m['pnl'] ?? 0;
  const totalTrades = m['total_trades'] ?? 0;
  return {
    netPnlUsd,
    netPnlPct: (netPnlUsd / INITIAL_EQUITY) * 100,
    totalTrades,
    winRate: m['win_rate'] ?? 0,
    profitFactor,
    maxDrawdownPct: (m['max_drawdown'] ?? 0) * 100,
    expectancyUsd: totalTrades > 0 ? netPnlUsd / totalTrades : 0,
    sharpe: m['sharpe'] ?? 0,
    topTradeContributionPct: m['top_trade_contribution_pct'] ?? 0,
  };
}

/** Returns true when a metric block is provably no-loss: it has at least one trade and all trades
 *  were winners (win_rate===1). A losing trade always reduces win_rate below 1, so this never
 *  false-positives a side that actually had losses (FR-002: backtester omits profit_factor when
 *  absGrossLoss===0). */
const noLoss = (m: Record<string, number>): boolean =>
  (m['total_trades'] ?? 0) > 0 && m['win_rate'] === 1;

/** Resolve baseline/variant profitFactor per the 4-case rule (comparison carries baseline∩variant;
 *  summary.metrics is the baseline's FULL metric set):
 *  1. PF present in both comparison sides → use those values directly.
 *  2. PF absent from comparison but present in summary.metrics → baseline had losses (finite PF);
 *     comparison dropped it because variant had no losses → variant gets NO_LOSS_PROFIT_FACTOR.
 *  3. Both sides have zero trades → PF is undefined; map to 0 (degenerate run still evaluates).
 *  4. A side is provably no-loss (total_trades>0 && win_rate===1) but has no profit_factor →
 *     PF is undefined/+inf (not ambiguous); map to NO_LOSS_PROFIT_FACTOR (mirrors case 2 variant path).
 *  Any remaining case (trades present, win_rate<1, profit_factor absent) is genuinely ambiguous → throw. */
function resolveProfitFactors(
  baseline: Record<string, number>,
  variant: Record<string, number>,
  topMetrics: Record<string, number>,
): { baselinePf: number; variantPf: number } {
  // Case 1: PF present in both comparison sides.
  if ('profit_factor' in baseline && 'profit_factor' in variant) {
    return { baselinePf: baseline['profit_factor'] ?? 0, variantPf: variant['profit_factor'] ?? 0 };
  }
  // Case 2: baseline had losses (finite PF in its full metrics); comparison dropped it → variant omitted (no losses).
  if ('profit_factor' in topMetrics) {
    return { baselinePf: topMetrics['profit_factor'] ?? 0, variantPf: NO_LOSS_PROFIT_FACTOR };
  }
  // Case 3: A completed run with NO trades on either side has no profit_factor (the engine omits it
  // when there are no trades at all). That is not ambiguous — PF is simply undefined; map to 0 so a
  // degenerate (zero-trade) run still evaluates instead of failing the metric mapping.
  if ((baseline['total_trades'] ?? 0) === 0 && (variant['total_trades'] ?? 0) === 0) {
    return { baselinePf: 0, variantPf: 0 };
  }
  // Case 4: A side with trades but no losing trades (win_rate===1) has no profit_factor because the
  // engine omits it when absGrossLoss===0 (FR-002). PF is undefined/+inf, not ambiguous — map to the
  // NO_LOSS sentinel (mirrors the case-2 variant path). Resolve per side independently.
  const baselinePf =
    noLoss(baseline) || noLoss(topMetrics) ? NO_LOSS_PROFIT_FACTOR : undefined;
  const variantPf =
    noLoss(variant) ? NO_LOSS_PROFIT_FACTOR
    : (variant['total_trades'] ?? 0) === 0 ? 0
    : undefined;
  if (baselinePf !== undefined && variantPf !== undefined) {
    return { baselinePf, variantPf };
  }
  throw new MetricMappingError(
    'ambiguous_profit_factor',
    'ambiguous_profit_factor: profit_factor absent from comparison and from baseline summary.metrics; cannot disambiguate variant PF',
  );
}

export function mapPlatformComparison(summary: RunResultSummary): ComparisonSummary {
  const comparison = summary.comparison;
  if (comparison === undefined) {
    throw new MetricMappingError('missing_metric', 'missing_metric: RunResultSummary has no comparison (not a baseline-vs-variant run)');
  }
  const baseline = comparison.baseline as Record<string, number>;
  const variant = comparison.variant as Record<string, number>;
  const topMetrics = summary.metrics as Record<string, number>;
  const { baselinePf, variantPf } = resolveProfitFactors(baseline, variant, topMetrics);
  return {
    baseline: block('baseline', baseline, baselinePf),
    variant: block('variant', variant, variantPf),
    sampleSize: { baselineTrades: baseline['total_trades'] ?? 0, variantTrades: variant['total_trades'] ?? 0 },
    platformContractVersion: summary.evidence.contractVersion,
  };
}
