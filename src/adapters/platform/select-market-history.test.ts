import { describe, it, expect } from 'vitest';
import { selectMarketHistory } from './select-market-history.ts';

describe('selectMarketHistory', () => {
  it('builds an adapter bound to the configured base URL + token', () => {
    const port = selectMarketHistory({ baseUrl: 'http://mock-platform:8839', token: 't' });
    expect(typeof port.getRows).toBe('function');
  });
});
