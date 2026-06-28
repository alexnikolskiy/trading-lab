import { describe, it, expect } from 'vitest';
import { selectMarketHistory } from './select-market-history.ts';

describe('selectMarketHistory', () => {
  it('builds an adapter bound to the configured base URL + token', () => {
    const port = selectMarketHistory({ LAB_MARKET_HISTORY_URL: 'http://mock-platform:8839', LAB_OPS_READ_TOKEN: 't' });
    expect(typeof port.getRows).toBe('function');
  });
});
