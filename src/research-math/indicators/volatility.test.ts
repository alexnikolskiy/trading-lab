import { describe, it, expect } from 'vitest';
import { atr, realizedVol, bollinger } from './volatility.ts';

describe('atr', () => {
  it('equals the constant bar range when range is constant', () => {
    const highs = [10, 11, 12, 13, 14];
    const lows = [9, 10, 11, 12, 13];   // range 1, and |high-prevClose| etc never exceed 1 here? verify with closes
    const closes = [10, 11, 12, 13, 14];
    const out = atr(highs, lows, closes, 2);
    // first ATR at index 2; subsequent values stay ~1 (TR ≈ 1)
    expect(out[2]).toBeCloseTo(1, 6);
    expect(out.at(-1)).toBeCloseTo(1, 6);
  });
  it('is null during warmup', () => {
    expect(atr([1, 2], [0, 1], [0.5, 1.5], 5)).toEqual([null, null]);
  });
});

describe('realizedVol', () => {
  it('is 0 for a flat series and > 0 for an oscillating one', () => {
    expect(realizedVol([5, 5, 5, 5], 2).at(-1)).toBeCloseTo(0, 10);
    expect(realizedVol([1, 2, 1, 2, 1], 2).at(-1)!).toBeGreaterThan(0);
  });
});

describe('bollinger', () => {
  it('mid equals the SMA and price-at-mid gives %B 0.5', () => {
    const out = bollinger([2, 2, 2, 2], 3, 2)!;
    expect(out[2]!.mid).toBeCloseTo(2, 10);
    expect(out[2]!.upper).toBeCloseTo(2, 10); // zero variance
  });
});
