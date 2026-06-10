import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BacktestRunRef } from '../../domain/types.ts';
import type {
  BacktestRunRequest, MarketContext, MarketRegime, PlatformGatewayPort, ResearchRunEnvelope,
} from '../../ports/platform-gateway.port.ts';

export class FixturePlatformGatewayAdapter implements PlatformGatewayPort {
  private readonly dir: string;

  constructor(fixtureDir: string) {
    this.dir = resolve(fixtureDir);
  }

  private async load<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(join(this.dir, name), 'utf8')) as T;
  }

  async getMarketContext(_symbol: string, _tsOrWindow: string): Promise<MarketContext> {
    return this.load<MarketContext>('market-context.json');
  }

  async getMarketRegime(_symbol: string, _tsOrWindow: string): Promise<MarketRegime> {
    return 'ranging';
  }

  async submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef> {
    return { platformRunId: 'fixture-run-1', correlationId: req.correlationId, submittedAt: '2026-01-01T00:00:00Z' };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 42, total_trades: 10, win_rate: 0.6 },
      artifactRefs: [],
      platformContractVersion: 'fixture-0',
    };
  }
}
