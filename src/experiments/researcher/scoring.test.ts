import { describe, expect, it } from 'vitest';
import { longOiStrategyProfile } from './fixtures.ts';
import { scoreResearcherOutput } from './scoring.ts';

const good = {
  researchSummary: 'Uses bot results: low winrate, negative pnl and be_stop clusters on ESPORTSUSDT show late exits after the long-only dump-and-bounce setup stays open too long.',
  hypotheses: [{
    thesis: 'Losses cluster around be_stop exits after long holding time, so tighten the stop earlier when the 10% dump bounce loses OI recovery.',
    targetBehavior: 'Reduce slow losing trades without changing execution.',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi fails to recover after the dump bounce and the trade remains open near 180 minutes', action: 'tighten_stop', params: {}, rationale: 'Observed be_stop losses on ESPORTSUSDT in bot results.' }] },
    requiredFeatures: ['oi', 'ohlcv'],
    validationPlan: 'Replay against the June bot-result window and compare winrate, pnl and holding time for be_stop-heavy losers.',
    expectedEffect: { metric: 'avg losing trade pnl', direction: 'increase', magnitude: 'less negative' },
    invalidationCriteria: ['Reject if total pnl decreases or be_stop count does not fall.'],
    confidence: 0.7,
  }],
};

const evalContext = {
  threshold: 0.7,
  profile: longOiStrategyProfile(),
  botResults: [{
    run: {
      runId: 'run-1',
      mode: 'paper',
      status: 'finished',
      strategy: { name: 'long_oi_strategy', version: '1' },
      symbols: ['ESPORTSUSDT'],
      startedAtMs: 1,
      finishedAtMs: 2,
      lastSeenMs: 2,
    },
    summary: {
      runId: 'run-1',
      asOf: 2,
      closedTrades: 2,
      wins: 0,
      losses: 2,
      breakeven: 0,
      winratePct: 0,
      pnlUsd: '-12',
      avgPnl: '-6',
      exitReasons: { be_stop: 1, time_exit: 1 },
      excludesReconcile: true,
    },
    trades: [{
      tradeId: 'trade-1',
      runId: 'run-1',
      symbol: 'ESPORTSUSDT',
      side: 'long',
      realizedPnl: '-10',
      pnlPct: '-1',
      isWin: false,
      closeReason: 'be_stop',
      openedAtMs: 1,
      closedAtMs: 2,
    }, {
      tradeId: 'trade-2',
      runId: 'run-1',
      symbol: 'COAIUSDT',
      side: 'long',
      realizedPnl: '-2',
      pnlPct: '-0.2',
      isWin: false,
      closeReason: 'time_exit',
      openedAtMs: 3,
      closedAtMs: 4,
    }],
  }],
  tradeEvidence: [{
    tradeId: 'trade-1',
    runId: 'run-1',
    symbol: 'ESPORTSUSDT',
    side: 'long',
    enteredAtMs: 1,
    closedAtMs: 2,
    entryPrice: '1',
    exitPrice: '0.99',
    realizedPnl: '-10',
    pnlPct: '-1',
    holdingDurationMs: 179 * 60_000,
    closeReason: 'be_stop',
    lifecycleEvents: [{ tsMs: 1, type: 'entry', price: '1', qty: '100', note: null }],
    minuteContext: [{ tsMs: 1, close: '1', volume: '100', oi: '200', liquidationsLong: '10', liquidationsShort: '0' }],
  }],
} as const satisfies Parameters<typeof scoreResearcherOutput>[1];

describe('scoreResearcherOutput', () => {
  it('passes schema-valid fact-grounded falsifiable output', () => {
    const result = scoreResearcherOutput(good, evalContext);
    expect(result.verdict).toBe('PASS');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.checks.find((c) => c.id === 'evidence_specificity')?.contribution).toBeGreaterThan(0);
    expect(result.checks.find((c) => c.id === 'profile_specificity')?.contribution).toBeGreaterThan(0);
  });

  it('fails output that uses generic language without profile or trade grounding', () => {
    const generic = {
      researchSummary: 'Bot results show negative pnl and low winrate, so the strategy needs better filters.',
      hypotheses: [{
        ...good.hypotheses[0],
        thesis: 'Try a generic trend filter.',
        targetBehavior: 'Make entries more selective.',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'trend is weak', action: 'skip_entry', params: {}, rationale: 'Generic selectivity.' }] },
        validationPlan: 'Run a backtest and compare metrics.',
        expectedEffect: { metric: 'entries', direction: 'decrease' },
        invalidationCriteria: ['Reject if entry count does not decrease.'],
      }],
    };
    const result = scoreResearcherOutput(generic, evalContext);
    expect(result.verdict).toBe('FAIL');
    expect(result.checks.find((c) => c.id === 'evidence_specificity')?.contribution).toBe(0);
    expect(result.checks.find((c) => c.id === 'profile_specificity')?.contribution).toBeLessThan(0.1);
  });
});
