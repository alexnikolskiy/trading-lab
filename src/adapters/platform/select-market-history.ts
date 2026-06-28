import { HistoricalClient } from '@trading-platform/sdk/historical';
import { HttpMarketHistoryAdapter, type HistoricalRowsSource } from './http-market-history.adapter.ts';
import type { MarketHistoryReadPort } from '../../ports/market-history-read.port.ts';

export interface MarketHistoryConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export function selectMarketHistory(cfg: MarketHistoryConfig): MarketHistoryReadPort {
  const client = new HistoricalClient({ baseUrl: cfg.baseUrl, token: cfg.token });
  const source: HistoricalRowsSource = {
    queryRows: (args) => client.queryRows(args),
  };
  return new HttpMarketHistoryAdapter(source);
}
