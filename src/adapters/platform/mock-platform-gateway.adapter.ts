import type { BacktestRunRef } from '../../domain/types.ts';
import type {
  BacktestRunRequest, MarketContext, MarketRegime, PlatformGatewayPort, ResearchRunEnvelope,
} from '../../ports/platform-gateway.port.ts';

let counter = 0;

export class MockPlatformGatewayAdapter implements PlatformGatewayPort {
  async getMarketContext(symbol: string, tsOrWindow: string): Promise<MarketContext> {
    return { symbol, ts: tsOrWindow, features: { oi: 100, funding: 0.0001, cvd: 0 } };
  }

  async getMarketRegime(_symbol: string, _tsOrWindow: string): Promise<MarketRegime> {
    return 'ranging';
  }

  async submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef> {
    counter += 1;
    return { platformRunId: `mock-run-${counter}`, correlationId: req.correlationId, submittedAt: new Date().toISOString() };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 0, total_trades: 0, win_rate: 0 },
      artifactRefs: [],
      platformContractVersion: 'mock-0',
    };
  }
}
