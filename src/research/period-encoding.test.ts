import { describe, it, expect } from 'vitest';
import { encodeTrainPeriod, encodeHoldoutPeriod } from './period-encoding.ts';

describe('period encoding (half-open [from,T) / [T,to])', () => {
  const from = '2026-01-01T00:00:00.000Z';
  const t = '2026-02-01T00:00:00.000Z';
  const to = '2026-03-01T00:00:00.000Z';
  it('holdout starts exactly at T', () => {
    expect(encodeHoldoutPeriod(t, to)).toEqual({ from: t, to });
  });
  it('train ends at T (exclusive-to convention)', () => {
    expect(encodeTrainPeriod(from, t, '1m')).toEqual({ from, to: t });
  });
});
