import { describe, it, expect } from 'vitest';
import { evaluateStrategyBaseline } from './strategy-baseline-evaluator.ts';

const good = { netPnlUsd: 10, netPnlPct: 1, totalTrades: 40, winRate: 0.6, profitFactor: 1.6, maxDrawdownPct: 8, expectancyUsd: 2, sharpe: 1.2, topTradeContributionPct: 20 };
const bad = { ...good, profitFactor: 0.7, sharpe: -0.3 };
const viableBoundary = { mode: 'trade_based' as const, t: 'T', trainTrades: 60, holdoutTrades: 35, lowConfidence: false, reason: 'ok' as const };
const lowConf = { ...viableBoundary, holdoutTrades: 18, lowConfidence: true };

describe('evaluateStrategyBaseline', () => {
  it('viable survived holdout → PAPER_CANDIDATE', () => {
    expect(evaluateStrategyBaseline({ holdout: good, boundary: viableBoundary }).verdict).toBe('PAPER_CANDIDATE');
  });
  it('below-floor holdout → FAIL', () => {
    const r = evaluateStrategyBaseline({ holdout: bad, boundary: viableBoundary });
    expect(r.verdict).toBe('FAIL');
  });
  it('low-confidence holdout → INCONCLUSIVE even if metrics pass', () => {
    const r = evaluateStrategyBaseline({ holdout: good, boundary: lowConf });
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.flags.lowConfidenceHoldout).toBe(true);
  });
});
