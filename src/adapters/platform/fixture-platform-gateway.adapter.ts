import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BacktestRunRef } from '../../domain/types.ts';
import type {
  BacktestRunRequest, ComparisonSummary, MarketContext, MarketRegime, PlatformGatewayPort, ResearchRunEnvelope,
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

  private comparison(): ComparisonSummary {
    return {
      baseline: { netPnlUsd: 30, netPnlPct: 0.3, totalTrades: 10, winRate: 0.5, profitFactor: 1.1, maxDrawdownPct: 6, expectancyUsd: 3, sharpe: 0.7, topTradeContributionPct: 25 },
      variant: { netPnlUsd: 42, netPnlPct: 0.42, totalTrades: 11, winRate: 0.6, profitFactor: 1.4, maxDrawdownPct: 6.5, expectancyUsd: 3.8, sharpe: 0.9, topTradeContributionPct: 28 },
      sampleSize: { baselineTrades: 10, variantTrades: 11 },
      platformContractVersion: 'fixture-0',
    };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 42, total_trades: 10, win_rate: 0.6 },
      artifactRefs: [],
      platformContractVersion: 'fixture-0',
      comparison: this.comparison(),
    };
  }
}
