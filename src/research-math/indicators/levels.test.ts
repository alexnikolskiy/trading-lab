import { describe, it, expect } from 'vitest';
import { swingHighLow, fibonacci, cvd, oiDelta, pctChangeOverWindow, liquidationAggregates } from './levels.ts';

describe('fibonacci', () => {
  it('places 0 at the high, 1 at the low, 0.5 at the midpoint', () => {
    const f = fibonacci(100, 0);
    expect(f.levels['0']).toBeCloseTo(100, 10);
    expect(f.levels['1']).toBeCloseTo(0, 10);
    expect(f.levels['0.5']).toBeCloseTo(50, 10);
  });
});

describe('swingHighLow', () => {
  it('returns the max high and min low over the trailing window', () => {
    expect(swingHighLow([1, 5, 3], [0, 2, 1], 3)).toEqual({ swingHigh: 5, swingLow: 0 });
  });
});

describe('cvd', () => {
  it('accumulates buy minus sell, null where taker missing from the start', () => {
    expect(cvd([10, 5, null], [4, 5, null])).toEqual([6, 6, 6]);
    expect(cvd([null, null], [null, null])).toEqual([null, null]);
  });
});

describe('oiDelta + pctChangeOverWindow', () => {
  it('computes per-bar delta and windowed pct change', () => {
    expect(oiDelta([100, 110, 121])).toEqual([null, 10, 11]);
    expect(pctChangeOverWindow([100, 110, 121], 2)).toBeCloseTo(21, 6);
  });
});

describe('liquidationAggregates', () => {
  it('sums sides and computes imbalance', () => {
    expect(liquidationAggregates([50, null], [30, 20])).toEqual({ longTotal: 50, shortTotal: 50, imbalance: 0 });
  });
});
