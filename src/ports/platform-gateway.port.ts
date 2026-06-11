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

export interface BacktestMetricBlock {
  netPnlUsd: number;
  netPnlPct: number;
  totalTrades: number;
  winRate: number;                 // 0..1
  profitFactor: number;
  maxDrawdownPct: number;          // positive magnitude; larger = worse
  expectancyUsd: number;
  sharpe: number;
  topTradeContributionPct: number; // 0..100
}

export interface ComparisonSummary {
  baseline: BacktestMetricBlock;
  variant: BacktestMetricBlock;
  sampleSize: { baselineTrades: number; variantTrades: number };
  platformContractVersion: string;
}

/** ResearchRunEnvelope — narrowed SP-1 mirror of platform contract 022. */
export interface ResearchRunEnvelope {
  platformRunId: string;
  runStatus: 'completed' | 'rejected';
  metrics: Record<string, number>;
  artifactRefs: string[];
  platformContractVersion: string;
  comparison?: ComparisonSummary;   // SP-4 lab-side mock/fixture shape (aligned to platform in SP-5)
}

export interface PlatformGatewayPort {
  getMarketContext(symbol: string, tsOrWindow: string): Promise<MarketContext>;
  getMarketRegime(symbol: string, tsOrWindow: string): Promise<MarketRegime>;
  submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef>;
  getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope>;
}
