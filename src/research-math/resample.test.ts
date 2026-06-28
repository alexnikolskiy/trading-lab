import { describe, it, expect } from 'vitest';
import { resampleRows } from './resample.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

function r(ts: number, o: number, h: number, l: number, c: number, v: number, taker?: [number, number]): CanonicalRowV2 {
  return {
    schema_version: 2, minute_ts: ts, symbol: 'BTCUSDT',
    open: o, high: h, low: l, close: c, volume: v, turnover: c * v,
    oi_total_usd: 1000, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: taker ? taker[0] : null, taker_sell_volume_usd: taker ? taker[1] : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: taker != null,
  } as CanonicalRowV2;
}

describe('resampleRows', () => {
  it('aggregates three 1m rows into one 5m bar (OHLC/sum/last/OR)', () => {
    const rows = [
      r(0, 10, 12, 9, 11, 100, [60, 40]),
      r(60_000, 11, 15, 10, 14, 50, undefined),
      r(120_000, 14, 14, 8, 9, 25, [10, 5]),
    ];
    const out = resampleRows(rows, 300_000);
    expect(out).toHaveLength(1);
    const b = out[0];
    expect([b.open, b.high, b.low, b.close]).toEqual([10, 15, 8, 9]);
    expect(b.volume).toBe(175);
    expect(b.taker_buy_volume_usd).toBe(70); // 60 + 10 (null row contributes nothing)
    expect(b.has_taker_flow).toBe(true);     // OR across the bucket
    expect(b.minute_ts).toBe(0);
  });

  it('splits across bucket boundaries', () => {
    const rows = [r(240_000, 1, 1, 1, 1, 1), r(300_000, 2, 2, 2, 2, 1)];
    expect(resampleRows(rows, 300_000).map((x) => x.minute_ts)).toEqual([0, 300_000]);
  });
});
