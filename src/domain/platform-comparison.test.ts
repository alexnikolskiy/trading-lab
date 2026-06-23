import { describe, it, expect } from 'vitest';
import type { RunResultSummary } from '../ports/research-platform.port.ts';
import { mapPlatformComparison, MetricMappingError, NO_LOSS_PROFIT_FACTOR } from './platform-comparison.ts';

const M = ['pnl', 'sharpe', 'max_drawdown', 'win_rate', 'total_trades', 'profit_factor', 'top_trade_contribution_pct'] as const;

function summary(baseline: Record<string, number>, variant: Record<string, number>, topMetrics?: Record<string, number>): RunResultSummary {
  return {
    runId: 'r1', status: 'completed', runKind: 'baseline-vs-variant', validationIssues: [],
    metrics: topMetrics ?? baseline,
    comparison: {
      baseline, variant,
      deltas: Object.fromEntries(Object.keys(variant).map((k) => [k, (variant[k] ?? 0) - (baseline[k] ?? 0)])),
    },
    coverage: [], artifactRefs: [],
    evidence: { seed: 1, contractVersion: '017.2', moduleVersions: [] },
  } as RunResultSummary;
}

const full = (pf: number) => ({ pnl: 1200, sharpe: 1.4, max_drawdown: 0.12, win_rate: 0.55, total_trades: 40, profit_factor: pf, top_trade_contribution_pct: 30 });

describe('mapPlatformComparison', () => {
  it('maps the 7 metrics into the 9-field BacktestMetricBlock (max_drawdown ×100; derives netPnlPct/expectancyUsd)', () => {
    const c = mapPlatformComparison(summary(full(1.8), full(2.2)));
    expect(c.variant.netPnlUsd).toBe(1200);
    expect(c.variant.maxDrawdownPct).toBeCloseTo(12);            // 0.12 * 100
    expect(c.variant.winRate).toBe(0.55);
    expect(c.variant.sharpe).toBe(1.4);
    expect(c.variant.totalTrades).toBe(40);
    expect(c.variant.topTradeContributionPct).toBe(30);
    expect(c.variant.profitFactor).toBe(2.2);
    expect(c.variant.netPnlPct).toBeCloseTo(12);                 // 1200 / 10000 * 100
    expect(c.variant.expectancyUsd).toBeCloseTo(30);             // 1200 / 40
    expect(c.sampleSize).toEqual({ baselineTrades: 40, variantTrades: 40 });
    expect(c.platformContractVersion).toBe('017.2');
  });

  it('profit_factor case 2: comparison omits it but summary.metrics (baseline) has it → baseline real, variant sentinel', () => {
    const b = full(1.8); const v = full(0); delete (v as Record<string, number>).profit_factor; delete (b as Record<string, number>).profit_factor;
    const c = mapPlatformComparison(summary(b, v, { ...full(1.8) }));   // top-level metrics keeps baseline profit_factor
    expect(c.baseline.profitFactor).toBe(1.8);
    expect(c.variant.profitFactor).toBe(NO_LOSS_PROFIT_FACTOR);
  });

  it('profit_factor case 3: comparison AND summary.metrics both omit it → MetricMappingError ambiguous_profit_factor', () => {
    const b = full(0); const v = full(0);
    [b, v].forEach((m) => delete (m as Record<string, number>).profit_factor);
    const top = { ...full(0) }; delete (top as Record<string, number>).profit_factor;
    expect(() => mapPlatformComparison(summary(b, v, top))).toThrowError(/ambiguous_profit_factor/);
  });

  it('a missing required metric → MetricMappingError missing_metric', () => {
    const b = full(1.8); const v = full(2.2); delete (v as Record<string, number>).sharpe;
    expect(() => mapPlatformComparison(summary(b, v))).toThrowError(/missing_metric/);
  });

  // Ground-truth no-loss: win_rate===1 && total_trades>0, profit_factor absent everywhere → NO_LOSS_PROFIT_FACTOR on both sides.
  // Captured live from the demo real-top5 fixture (FR-002: backtester omits profit_factor when absGrossLoss===0).
  const noLossMetrics = { pnl: 7667.62, sharpe: 0.0947, win_rate: 1, max_drawdown: 0.40, total_trades: 1, top_trade_contribution_pct: 100 };

  it('no-loss run (win_rate===1, total_trades>0, profit_factor absent everywhere) → both PFs map to NO_LOSS_PROFIT_FACTOR, no throw', () => {
    const b = { ...noLossMetrics };
    const v = { ...noLossMetrics };
    const top = { ...noLossMetrics };
    const c = mapPlatformComparison(summary(b, v, top));
    expect(c.baseline.profitFactor).toBe(NO_LOSS_PROFIT_FACTOR);
    expect(c.variant.profitFactor).toBe(NO_LOSS_PROFIT_FACTOR);
  });

  it('regression — genuinely ambiguous (win_rate<1, no profit_factor) still throws ambiguous_profit_factor', () => {
    const b = { ...noLossMetrics };
    const v = { ...noLossMetrics, win_rate: 0.6 }; // has losses → PF is truly unknown
    const top = { ...noLossMetrics };
    expect(() => mapPlatformComparison(summary(b, v, top))).toThrowError(/ambiguous_profit_factor/);
  });

  it('case 1 unchanged: profit_factor present in both baseline and variant → those exact values used', () => {
    const c = mapPlatformComparison(summary(full(1.8), full(2.2)));
    expect(c.baseline.profitFactor).toBe(1.8);
    expect(c.variant.profitFactor).toBe(2.2);
  });

  it('case 3 unchanged: both total_trades===0 → both PFs 0, no throw', () => {
    const zeroTrades = { pnl: 0, sharpe: 0, win_rate: 0, max_drawdown: 0, total_trades: 0, top_trade_contribution_pct: 0 };
    const b = { ...zeroTrades };
    const v = { ...zeroTrades };
    const top = { ...zeroTrades };
    const c = mapPlatformComparison(summary(b, v, top));
    expect(c.baseline.profitFactor).toBe(0);
    expect(c.variant.profitFactor).toBe(0);
  });
});
