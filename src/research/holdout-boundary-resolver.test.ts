import { describe, it, expect } from 'vitest';
import { resolveHoldoutBoundary } from './holdout-boundary-resolver.ts';
import { DEFAULT_HOLDOUT_POLICY, type TradeRecord } from '../domain/research-experiment.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');
const period = { from: '2026-01-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' }; // ~90 days

// helper: n trades, one per `gapDays`, entryTs increasing from START
function trades(n: number, gapDays = 1): TradeRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    entryTs: START + i * gapDays * DAY, exitTs: START + i * gapDays * DAY + 3_600_000,
    side: 'long' as const, realizedPnl: 1,
  }));
}

describe('resolveHoldoutBoundary', () => {
  it('trade_based: 90 trades → 60 train / 30 holdout, T = 61st trade entry', () => {
    const b = resolveHoldoutBoundary(trades(90), period, DEFAULT_HOLDOUT_POLICY);
    expect(b.mode).toBe('trade_based');
    expect(b.lowConfidence).toBe(false);
    expect(b.trainTrades).toBe(60);
    expect(b.holdoutTrades).toBe(30);
    expect(b.t).toBe(new Date(START + 60 * DAY).toISOString());
  });

  it('low_confidence band: 70 trades (50 train + 20 holdout < 30 but ≥ 15) → lowConfidence', () => {
    const b = resolveHoldoutBoundary(trades(70), period, DEFAULT_HOLDOUT_POLICY);
    expect(b.mode).toBe('trade_based');
    expect(b.lowConfidence).toBe(true);
    expect(b.trainTrades).toBe(50);
    expect(b.holdoutTrades).toBe(20);
  });

  it('none/insufficient_trades: 60 trades cannot give 50 train + ≥15 holdout', () => {
    const b = resolveHoldoutBoundary(trades(60), period, DEFAULT_HOLDOUT_POLICY);
    // 60 - 15 = 45 train < 50 → cannot honour both minimums
    expect(b.mode).toBe('none');
    expect(b.reason).toBe('insufficient_trades');
  });

  it('none/insufficient_history: period under minHistoryDays', () => {
    const short = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-20T00:00:00.000Z' }; // 19 days
    const b = resolveHoldoutBoundary(trades(200), short, DEFAULT_HOLDOUT_POLICY);
    expect(b.mode).toBe('none');
    expect(b.reason).toBe('insufficient_history');
  });

  it('ties straddling the boundary counted from chosen T (holdoutTrades exceeds the index count)', () => {
    const base = trades(90);
    // Move a trade from BELOW the boundary (index 59) onto the boundary value (index 60's entryTs).
    // After sort, two trades tie at T, so the tie-recount yields 31 holdout trades while a naive
    // `holdoutTrades = h` (no recount) would report 30 — this asserts the recount is actually active.
    base[59] = { ...base[59]!, entryTs: base[60]!.entryTs };
    const b = resolveHoldoutBoundary(base, period, DEFAULT_HOLDOUT_POLICY);
    const T = Date.parse(b.t!);
    const holdout = base.filter((t) => t.entryTs >= T).length;
    expect(b.mode).toBe('trade_based');
    expect(holdout).toBe(31);           // 2 tied at T + 29 strictly after
    expect(b.holdoutTrades).toBe(31);   // recount, NOT the naive index count 30
    expect(b.trainTrades).toBe(59);
    expect(b.lowConfidence).toBe(false);
  });

  it('n=0 → none', () => {
    expect(resolveHoldoutBoundary([], period, DEFAULT_HOLDOUT_POLICY).mode).toBe('none');
  });
});
