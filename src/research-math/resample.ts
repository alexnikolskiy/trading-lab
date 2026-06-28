import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

type Agg = {
  minute_ts: number; symbol: string;
  open: number; high: number; low: number; close: number; closeTs: number;
  volume: number; turnover: number;
  oi: number | null; funding: number | null; oiTs: number; fundingTs: number;
  liqLong: number; liqShort: number; anyLiq: boolean;
  takerBuy: number; takerSell: number; anyTaker: boolean;
  anyOi: boolean; anyFunding: boolean;
};

const addNull = (acc: number, v: number | null): number => (v != null ? acc + v : acc);

export function resampleRows(rows: readonly CanonicalRowV2[], tfMs: number): CanonicalRowV2[] {
  if (rows.length === 0 || tfMs <= 0) return [];
  const sorted = [...rows].sort((a, b) => a.minute_ts - b.minute_ts);
  const buckets = new Map<number, Agg>();
  for (const row of sorted) {
    const key = Math.floor(row.minute_ts / tfMs) * tfMs;
    let a = buckets.get(key);
    if (!a) {
      a = {
        minute_ts: key, symbol: row.symbol,
        open: row.open, high: row.high, low: row.low, close: row.close, closeTs: row.minute_ts,
        volume: row.volume, turnover: row.turnover,
        oi: row.oi_total_usd, funding: row.funding_rate, oiTs: row.minute_ts, fundingTs: row.minute_ts,
        liqLong: row.liq_long_usd ?? 0, liqShort: row.liq_short_usd ?? 0, anyLiq: row.has_liquidations,
        takerBuy: row.taker_buy_volume_usd ?? 0, takerSell: row.taker_sell_volume_usd ?? 0, anyTaker: row.has_taker_flow,
        anyOi: row.has_oi, anyFunding: row.has_funding,
      };
      buckets.set(key, a);
      continue;
    }
    if (row.high > a.high) a.high = row.high;
    if (row.low < a.low) a.low = row.low;
    if (row.minute_ts >= a.closeTs) { a.close = row.close; a.closeTs = row.minute_ts; }
    a.volume += row.volume;
    a.turnover += row.turnover;
    a.liqLong = addNull(a.liqLong, row.liq_long_usd); a.liqShort = addNull(a.liqShort, row.liq_short_usd);
    a.anyLiq = a.anyLiq || row.has_liquidations;
    a.takerBuy = addNull(a.takerBuy, row.taker_buy_volume_usd);
    a.takerSell = addNull(a.takerSell, row.taker_sell_volume_usd);
    a.anyTaker = a.anyTaker || row.has_taker_flow;
    if (row.oi_total_usd != null && row.minute_ts >= a.oiTs) { a.oi = row.oi_total_usd; a.oiTs = row.minute_ts; }
    if (row.funding_rate != null && row.minute_ts >= a.fundingTs) { a.funding = row.funding_rate; a.fundingTs = row.minute_ts; }
    a.anyOi = a.anyOi || row.has_oi; a.anyFunding = a.anyFunding || row.has_funding;
  }
  return [...buckets.values()]
    .sort((x, y) => x.minute_ts - y.minute_ts)
    .map((a): CanonicalRowV2 => ({
      schema_version: 2, minute_ts: a.minute_ts, symbol: a.symbol,
      open: a.open, high: a.high, low: a.low, close: a.close, volume: a.volume, turnover: a.turnover,
      oi_total_usd: a.anyOi ? a.oi : null, funding_rate: a.anyFunding ? a.funding : null,
      liq_long_usd: a.anyLiq ? a.liqLong : null, liq_short_usd: a.anyLiq ? a.liqShort : null,
      taker_buy_volume_usd: a.anyTaker ? a.takerBuy : null, taker_sell_volume_usd: a.anyTaker ? a.takerSell : null,
      has_oi: a.anyOi, has_funding: a.anyFunding, has_liquidations: a.anyLiq, has_taker_flow: a.anyTaker,
    } as CanonicalRowV2));
}
