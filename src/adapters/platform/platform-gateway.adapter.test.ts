import { describe, it, expect } from 'vitest';
import { MockPlatformGatewayAdapter } from './mock-platform-gateway.adapter.ts';
import { FixturePlatformGatewayAdapter } from './fixture-platform-gateway.adapter.ts';

describe('MockPlatformGatewayAdapter', () => {
  it('returns a plausible market context and a backtest ref', async () => {
    const gw = new MockPlatformGatewayAdapter();
    const ctx = await gw.getMarketContext('BTCUSDT', '2026-01-01T00:00:00Z');
    expect(ctx.symbol).toBe('BTCUSDT');
    const ref = await gw.submitBacktest({ correlationId: 'c1', baselineModuleId: 'b', variantModuleId: 'v', params: {} });
    expect(ref.platformRunId).toMatch(/^mock-run-/);
    expect(ref.correlationId).toBe('c1');
  });
});

describe('FixturePlatformGatewayAdapter', () => {
  it('returns the golden market context from fixtures deterministically', async () => {
    const gw = new FixturePlatformGatewayAdapter('test/fixtures/platform');
    const a = await gw.getMarketContext('BTCUSDT', '2026-01-01T00:00:00Z');
    const b = await gw.getMarketContext('BTCUSDT', '2026-01-01T00:00:00Z');
    expect(a).toEqual(b);
    expect(a.features.oi).toBe(123.0);
  });
});
