import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FixtureTradeEvidenceAdapter } from './fixture-trade-evidence.adapter.ts';

describe('FixtureTradeEvidenceAdapter', () => {
  it('reads bounded forensic bundles by requested trade ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade-evidence-fixture-'));
    writeFileSync(join(dir, 'bundles-by-trade.json'), JSON.stringify({
      trade_a: {
        tradeId: 'trade_a',
        runId: 'run_a',
        symbol: 'COAIUSDT',
        side: 'long',
        enteredAtMs: 1,
        closedAtMs: 2,
        entryPrice: '1.25',
        exitPrice: '1.10',
        realizedPnl: '-50.81',
        pnlPct: '-4.1',
        holdingDurationMs: 8_640_000,
        closeReason: 'stop_loss',
        lifecycleEvents: [{ tsMs: 1, type: 'entry', price: '1.25', qty: '100' }],
        minuteContext: [{ tsMs: 1, close: '1.25', volume: '12000', oi: '450000', liquidationsLong: '1300', liquidationsShort: '0' }],
      },
      trade_b: {
        tradeId: 'trade_b',
        runId: 'run_b',
        symbol: 'ESPORTSUSDT',
        side: 'long',
        enteredAtMs: 3,
        closedAtMs: 4,
        entryPrice: '2.00',
        exitPrice: '2.15',
        realizedPnl: '15.10',
        pnlPct: '1.8',
        holdingDurationMs: 3_600_000,
        closeReason: 'take_profit',
        lifecycleEvents: [{ tsMs: 3, type: 'entry', price: '2.00', qty: '50' }],
        minuteContext: [{ tsMs: 3, close: '2.00', volume: '9000', oi: '220000', liquidationsLong: '0', liquidationsShort: '500' }],
      },
    }), 'utf8');

    const adapter = new FixtureTradeEvidenceAdapter(dir);
    const bundles = await adapter.getTradeEvidence({
      tradeIds: ['trade_b', 'trade_a'],
      minuteWindowBefore: 20,
      minuteWindowAfter: 180,
    });

    expect(bundles.map((b) => b.tradeId)).toEqual(['trade_b', 'trade_a']);
    expect(bundles[0]?.minuteContext[0]?.close).toBe('2.00');
    expect(bundles[1]?.lifecycleEvents[0]?.type).toBe('entry');
  });
});
