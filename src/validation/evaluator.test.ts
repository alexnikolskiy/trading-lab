// src/validation/evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateBacktest, DEFAULT_EVALUATOR_THRESHOLDS } from './evaluator.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../ports/platform-gateway.port.ts';

function block(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return { netPnlUsd: 100, netPnlPct: 1, totalTrades: 30, winRate: 0.5, profitFactor: 1.2, maxDrawdownPct: 7, expectancyUsd: 3, sharpe: 0.8, topTradeContributionPct: 20, ...over };
}
function summary(baseline: BacktestMetricBlock, variant: BacktestMetricBlock): ComparisonSummary {
  return { baseline, variant, sampleSize: { baselineTrades: baseline.totalTrades, variantTrades: variant.totalTrades }, platformContractVersion: 'test-0' };
}
const T = DEFAULT_EVALUATOR_THRESHOLDS;

describe('evaluateBacktest', () => {
  it('INCONCLUSIVE when variant trades below minTrades', () => {
    const r = evaluateBacktest(summary(block(), block({ totalTrades: T.minTrades - 1, netPnlUsd: 9999 })), T);
    expect(r.decision).toBe('INCONCLUSIVE');
  });

  it('FAIL when no improvement over baseline', () => {
    const r = evaluateBacktest(summary(block({ netPnlUsd: 100 }), block({ netPnlUsd: 100 })), T);
    expect(r.decision).toBe('FAIL');
  });

  it('MODIFY on drawdown regression beyond tolerance', () => {
    const r = evaluateBacktest(summary(block({ maxDrawdownPct: 7 }), block({ netPnlUsd: 200, maxDrawdownPct: 7 + T.maxDrawdownTolerancePct + 0.1 })), T);
    expect(r.decision).toBe('MODIFY');
    expect(r.reasons).toContain('drawdown_regression');
  });

  it('MODIFY on fragile pnl (top-trade contribution at/over threshold)', () => {
    const r = evaluateBacktest(summary(block(), block({ netPnlUsd: 200, topTradeContributionPct: T.fragilityTopTradePct })), T);
    expect(r.decision).toBe('MODIFY');
    expect(r.reasons).toContain('fragile_pnl');
  });

  it('PAPER_CANDIDATE on a strong, robust edge', () => {
    const r = evaluateBacktest(summary(block({ winRate: 0.5 }), block({ netPnlUsd: 100 + T.strongPnlDeltaUsd, profitFactor: T.minProfitFactor, winRate: 0.6 })), T);
    expect(r.decision).toBe('PAPER_CANDIDATE');
  });

  it('PASS on a modest positive edge', () => {
    const r = evaluateBacktest(summary(block({ netPnlUsd: 100 }), block({ netPnlUsd: 150, profitFactor: 1.3 })), T);
    expect(r.decision).toBe('PASS');
  });

  it('strong-edge but lower winRate than baseline → PASS, not PAPER_CANDIDATE', () => {
    const r = evaluateBacktest(summary(block({ winRate: 0.7 }), block({ netPnlUsd: 100 + T.strongPnlDeltaUsd, profitFactor: T.minProfitFactor, winRate: 0.6 })), T);
    expect(r.decision).toBe('PASS');
  });
});
