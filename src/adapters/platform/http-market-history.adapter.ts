import type {
  CanonicalRowV2, MarketHistoryReadPort, MarketHistoryWindow,
} from '../../ports/market-history-read.port.ts';

/** The slice of the SDK HistoricalClient this adapter needs (testable seam). */
export interface HistoricalRowsSource {
  queryRows(args: { symbols: string[]; fromMs: number; toMs: number }): AsyncIterable<CanonicalRowV2[]>;
}

export class HttpMarketHistoryAdapter implements MarketHistoryReadPort {
  readonly #source: HistoricalRowsSource;

  constructor(source: HistoricalRowsSource) {
    this.#source = source;
  }

  async getRows(window: MarketHistoryWindow): Promise<readonly CanonicalRowV2[]> {
    const byTs = new Map<number, CanonicalRowV2>();
    for await (const page of this.#source.queryRows({
      symbols: [window.symbol], fromMs: window.fromMs, toMs: window.toMs,
    })) {
      for (const r of page) byTs.set(r.minute_ts, r); // last-wins
    }
    return [...byTs.values()].sort((x, y) => x.minute_ts - y.minute_ts);
  }
}
