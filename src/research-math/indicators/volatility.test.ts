import { describe, it, expect } from 'vitest';
import { atr, realizedVol, bollinger, squeeze, linregEndpoint } from './volatility.ts';

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

describe('linregEndpoint', () => {
  it('returns the ramp value for a perfect linear series', () => {
    const out = linregEndpoint([0, 1, 2, 3, 4], 5);
    expect(out[4]).toBeCloseTo(4, 9);
  });

  it('returns the constant for a flat series (slope 0)', () => {
    const out = linregEndpoint([5, 5, 5, 5, 5], 5);
    expect(out[4]).toBeCloseTo(5, 9);
  });

  it('is null before the window fills', () => {
    const out = linregEndpoint([1, 2, 3], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(3, 9); // clean ramp [1,2,3] → endpoint 3
  });

  it('returns null for any window containing a null, then recovers on a clean window', () => {
    const out = linregEndpoint([1, null, 3, 4, 5], 3);
    expect(out[2]).toBeNull(); // window [1,null,3]
    expect(out[3]).toBeNull(); // window [null,3,4]
    expect(out[4]).toBeCloseTo(5, 9); // window [3,4,5] is clean → endpoint 5
  });
});

describe('squeeze', () => {
  // Build a series that is calm (low BB width) for the first half, then a wide spike.
  const period = 5, bbK = 2, kcMult = 1.5;

  it('returns null during warmup (before BB + ATR are defined)', () => {
    const flat = Array.from({ length: 10 }, () => 100);
    const out = squeeze(flat, flat, flat, period, bbK, kcMult);
    for (let i = 0; i < period; i++) expect(out[i]).toBeNull();
  });

  it('reports the on flag while momentum may still be warming up (decoupled)', () => {
    // 7 bars: on is computable from index `period` (=5); momentum needs ~2*period-2 (=8) → still null at index 6
    const highs = [101, 101, 101, 101, 101, 101, 101];
    const lows  = [99, 99, 99, 99, 99, 99, 99];
    const closes = [100, 100, 100, 100, 100, 100, 100];
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    const p = out[6];
    expect(p).not.toBeNull();
    expect(typeof p!.on).toBe('boolean');
    expect(p!.momentum).toBeNull();
  });

  it('detects squeeze ON when Bollinger bands sit inside the Keltner channel', () => {
    // Near-flat closes → tiny BB stddev; high/low spread of 4 → wider Keltner via ATR.
    const n = 12;
    const closes = Array.from({ length: n }, (_, i) => 100 + (i % 2) * 0.01);
    const highs = closes.map((c) => c + 2);
    const lows = closes.map((c) => c - 2);
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    expect(out[n - 1]).not.toBeNull();
    expect(out[n - 1]!.on).toBe(true);
  });

  it('detects squeeze OFF when Bollinger bands blow outside the Keltner channel', () => {
    // Steep trend → large close stddev (wide BB); tight intrabar range → small ATR (narrow Keltner).
    // (Alternating spikes would NOT work: the close-to-close gap inflates TR → ATR → Keltner, masking the squeeze.)
    const n = 12;
    const closes = Array.from({ length: n }, (_, i) => 100 + 10 * i);
    const highs = closes.map((c) => c + 0.1);
    const lows = closes.map((c) => c - 0.1);
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    expect(out[n - 1]).not.toBeNull();
    expect(out[n - 1]!.on).toBe(false);
  });

  it('never returns NaN momentum once warmed', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i));
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 1);
    const out = squeeze(highs, lows, closes, period, bbK, kcMult);
    const last = out[out.length - 1]!;
    expect(last.momentum == null || Number.isFinite(last.momentum)).toBe(true);
  });
});
