import type { BacktestRunRef } from '../domain/types.ts';

export interface MarketContext {
  symbol: string;
  ts: string;
  features: Record<string, number>;
}

export type MarketRegime =
  | 'capitulation' | 'short_squeeze' | 'trending' | 'ranging'
  | 'high_volatility' | 'low_liquidity' | 'post_dump_recovery' | 'distribution' | 'unknown';

export interface BacktestRunRequest {
  correlationId: string;
  baselineModuleId: string;
  variantModuleId: string;
  params: Record<string, unknown>;
}

/** ResearchRunEnvelope — narrowed SP-1 mirror of platform contract 022. */
export interface ResearchRunEnvelope {
  platformRunId: string;
  runStatus: 'completed' | 'rejected';
  metrics: Record<string, number>;
  artifactRefs: string[];
  platformContractVersion: string;
}

export interface PlatformGatewayPort {
  getMarketContext(symbol: string, tsOrWindow: string): Promise<MarketContext>;
  getMarketRegime(symbol: string, tsOrWindow: string): Promise<MarketRegime>;
  submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef>;
  getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope>;
}
