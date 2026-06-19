import { describe, it, expect } from 'vitest';
import { buildCompletionSummary, type CompletionSummaryDeps } from './completion-summary.ts';

// Minimal in-memory deps. Each method returns canned data; override per test.
function fakeDeps(over: Partial<Record<string, unknown>> = {}): CompletionSummaryDeps {
  const base = {
    researchTasks: { findById: async () => null },
    strategyProfiles: { findById: async () => null },
    hypotheses: { list: async () => [], getById: async () => null },
    backtests: { list: async () => [], getById: async () => null },
    agentEvents: { list: async () => [] },
  };
  return { ...base, ...over } as unknown as CompletionSummaryDeps;
}

const completedTask = (over: Record<string, unknown>) => ({
  id: 't1', taskType: 'backtest.completed', source: 'operator', correlationId: 'c1',
  status: 'completed', payload: {}, createdAt: '2026-06-19T00:00:00.000Z', updatedAt: '2026-06-19T00:00:00.000Z',
  ...over,
});

describe('buildCompletionSummary — backtest.completed', () => {
  it('maps decision, metrics, hypothesis, profile and willRetry', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({
        payload: { backtestRunId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1', decision: 'FAIL', reasons: ['low sharpe'], cycleDepth: 0 },
      }) },
      backtests: { getById: async (id: string) => id === 'b1' ? {
        id: 'b1', metrics: { netPnlUsd: -10, netPnlPct: -1, totalTrades: 20, winRate: 0.4, profitFactor: 0.8, maxDrawdownPct: 15, expectancyUsd: -0.5, sharpe: -0.2, topTradeContributionPct: 30 },
      } : null },
      hypotheses: { list: async () => [], getById: async (id: string) => id === 'h1' ? { id: 'h1', thesis: 'short the pump', confidence: 0.6, status: 'validated' } : null },
      strategyProfiles: { findById: async (id: string) => id === 'p1' ? { id: 'p1', coreIdea: 'fade pumps', direction: 'short' } : null },
    });

    const s = await buildCompletionSummary(deps, 't1');

    expect(s?.kind).toBe('backtest.completed');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.decision).toBe('FAIL');
    expect(s.metrics.netPnlUsd).toBe(-10);
    expect(s.metrics.winRate).toBe(0.4);
    expect(s.metrics.sharpe).toBe(-0.2);
    expect(s.hypothesis).toEqual({ id: 'h1', thesis: 'short the pump', confidence: 0.6, status: 'validated' });
    expect(s.profile).toEqual({ id: 'p1', coreIdea: 'fade pumps', direction: 'short' });
    expect(s.reasons).toEqual(['low sharpe']);
    expect(s.willRetry).toBe(true); // FAIL && cycleDepth 0 < 2
    expect(s.links).toEqual({ taskId: 't1', profileId: 'p1', hypothesisId: 'h1', backtestRunId: 'b1' });
  });

  it('all-null metrics when the backtest run has no metric block', async () => {
    const deps = fakeDeps({
      researchTasks: { findById: async () => completedTask({ payload: { backtestRunId: 'b1', decision: 'INCONCLUSIVE' } }) },
      backtests: { getById: async () => ({ id: 'b1', metrics: null }) },
    });
    const s = await buildCompletionSummary(deps, 't1');
    if (s?.kind !== 'backtest.completed') throw new Error('wrong kind');
    expect(s.metrics).toEqual({ netPnlUsd: null, netPnlPct: null, winRate: null, profitFactor: null, maxDrawdownPct: null, sharpe: null, totalTrades: null });
    expect(s.willRetry).toBe(false);
  });
});
