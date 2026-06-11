import type { BacktestRunRef } from '../../domain/types.ts';
import type {
  BacktestRunRequest, ComparisonSummary, MarketContext, MarketRegime, PlatformGatewayPort, ResearchRunEnvelope,
} from '../../ports/platform-gateway.port.ts';

export class MockPlatformGatewayAdapter implements PlatformGatewayPort {
  // Instance-level call counter: keeps run ids unique per adapter without bleeding
  // across independently-constructed mocks (the conventional stateful-test-double pattern).
  private counter = 0;

  async getMarketContext(symbol: string, tsOrWindow: string): Promise<MarketContext> {
    return { symbol, ts: tsOrWindow, features: { oi: 100, funding: 0.0001, cvd: 0 } };
  }

  async getMarketRegime(_symbol: string, _tsOrWindow: string): Promise<MarketRegime> {
    return 'ranging';
  }

  async submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef> {
    this.counter += 1;
    return { platformRunId: `mock-run-${this.counter}`, correlationId: req.correlationId, submittedAt: new Date().toISOString() };
  }

  private comparison(): ComparisonSummary {
    // Deterministic, strongly-improving variant → drives the e2e happy path to PAPER_CANDIDATE.
    return {
      baseline: { netPnlUsd: 100, netPnlPct: 1.0, totalTrades: 28, winRate: 0.50, profitFactor: 1.2, maxDrawdownPct: 7, expectancyUsd: 3.5, sharpe: 0.8, topTradeContributionPct: 20 },
      variant: { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.60, profitFactor: 2.0, maxDrawdownPct: 8, expectancyUsd: 8.3, sharpe: 1.4, topTradeContributionPct: 22 },
      sampleSize: { baselineTrades: 28, variantTrades: 30 },
      platformContractVersion: 'mock-0',
    };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 250, total_trades: 30, win_rate: 0.6 },
      artifactRefs: [],
      platformContractVersion: 'mock-0',
      comparison: this.comparison(),
    };
  }
}
