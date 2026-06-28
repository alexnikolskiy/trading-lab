import { describe, it, expect } from 'vitest';
import { HttpMarketHistoryAdapter, type HistoricalRowsSource } from './http-market-history.adapter.ts';
import type { CanonicalRowV2 } from '../../ports/market-history-read.port.ts';

function row(ts: number, close: number): CanonicalRowV2 {
  return {
    schema_version: 2, minute_ts: ts, symbol: 'BTCUSDT',
    open: close, high: close, low: close, close, volume: 1, turnover: close,
    oi_total_usd: null, funding_rate: null, liq_long_usd: null, liq_short_usd: null,
    taker_buy_volume_usd: null, taker_sell_volume_usd: null,
    has_oi: false, has_funding: false, has_liquidations: false, has_taker_flow: false,
  } as CanonicalRowV2;
}

function fakeSource(pages: CanonicalRowV2[][]): HistoricalRowsSource {
  return {
    async *queryRows() { for (const p of pages) yield p; },
  };
}

describe('HttpMarketHistoryAdapter', () => {
  it('drains pages, sorts ascending and dedupes by minute_ts (last-wins)', async () => {
    const a = row(120_000, 1);
    const b = row(60_000, 2);
    const bDup = row(60_000, 99); // later page wins
    const adapter = new HttpMarketHistoryAdapter(fakeSource([[a, b], [bDup]]));
    const out = await adapter.getRows({ symbol: 'BTCUSDT', fromMs: 0, toMs: 200_000 });
    expect(out.map((r) => r.minute_ts)).toEqual([60_000, 120_000]);
    expect(out[0]!.close).toBe(99);
  });

  it('returns [] when the source yields nothing', async () => {
    const adapter = new HttpMarketHistoryAdapter(fakeSource([]));
    expect(await adapter.getRows({ symbol: 'X', fromMs: 0, toMs: 1 })).toEqual([]);
  });
});
