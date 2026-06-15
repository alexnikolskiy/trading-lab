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
      deltas: Object.fromEntries(Object.keys(variant).map((k) => [k, variant[k] - (baseline[k] ?? 0)])),
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
});
