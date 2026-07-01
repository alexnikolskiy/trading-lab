import { describe, it, expect } from 'vitest';
import { mapStrategyMetrics } from './strategy-metrics.ts';
import { NO_LOSS_PROFIT_FACTOR } from './platform-comparison.ts';

// NOTE (deviation from the task brief): the brief's inline fixture used BacktestMetricBlock-shaped
// keys directly (netPnlUsd, winRate, ...) as `summary.metrics`. The REAL RunResultSummary.metrics
// carries the platform's raw snake_case names (see MockResearchPlatformAdapter.cannedStrategySummary
// and platform-comparison.ts's RESEARCH_RUN_METRICS): pnl, sharpe, max_drawdown, win_rate,
// total_trades, profit_factor, top_trade_contribution_pct. Fixtures below use the real raw shape so
// the test exercises the actual raw->domain mapping.
describe('mapStrategyMetrics', () => {
  it('maps a variant-only metrics summary (no comparison)', () => {
    const m = mapStrategyMetrics({
      status: 'completed',
      metrics: {
        pnl: 120, sharpe: 1.1, max_drawdown: 0.06, win_rate: 0.75,
        total_trades: 4, profit_factor: 1.8, top_trade_contribution_pct: 35,
      },
      artifactRefs: [],
    } as any);
    expect(m.totalTrades).toBe(4);
    expect(m.profitFactor).toBe(1.8);
    expect(m.netPnlUsd).toBe(120);
    expect(m.netPnlPct).toBeCloseTo(1.2, 6);
    expect(m.winRate).toBe(0.75);
    expect(m.maxDrawdownPct).toBeCloseTo(6, 6);
    expect(m.expectancyUsd).toBe(30);
    expect(m.sharpe).toBe(1.1);
    expect(m.topTradeContributionPct).toBe(35);
  });

  it('throws when metrics are absent', () => {
    expect(() => mapStrategyMetrics({ status: 'completed', artifactRefs: [] } as any)).toThrow();
  });

  it('maps profitFactor to NO_LOSS_PROFIT_FACTOR when win_rate===1 and profit_factor is absent', () => {
    const m = mapStrategyMetrics({
      status: 'completed',
      metrics: {
        pnl: 500, sharpe: 2.0, max_drawdown: 0.02, win_rate: 1,
        total_trades: 3, top_trade_contribution_pct: 50,
      },
      artifactRefs: [],
    } as any);
    expect(m.profitFactor).toBe(NO_LOSS_PROFIT_FACTOR);
  });
});
