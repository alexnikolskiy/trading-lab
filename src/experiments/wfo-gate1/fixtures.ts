// src/experiments/wfo-gate1/fixtures.ts
//
// FOR UNIT TESTS ONLY. These are hand-built synthetic RawCase objects covering the oracle's
// obvious/structural branches (see oracle.ts::labelObvious). They are NOT the golden Gate1 eval
// dataset — that dataset is built from RECORDED baseline experiments via DbCaseSource (real DB)
// or SnapshotCaseSource (a frozen JSON snapshot of the same), not from this file.
import type { RawCase } from './types.ts';
import type { StrategyProfile, StrategyParameter } from '../../domain/strategy-profile.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';

const NOW = '2026-01-01T00:00:00.000Z';

function metrics(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return {
    netPnlUsd: 0, netPnlPct: 0, totalTrades: 0, winRate: 0, profitFactor: 0,
    maxDrawdownPct: 0, expectancyUsd: 0, sharpe: 0, topTradeContributionPct: 0,
    ...over,
  };
}

function param(over: Partial<StrategyParameter> & { name: string }): StrategyParameter {
  return { value: 1, unit: null, description: '', tunable: true, ...over };
}

function profile(id: string, parameters: StrategyParameter[]): StrategyProfile {
  return {
    id, version: 1, sourceKind: 'bot_code', sourceFingerprint: `fp-${id}`,
    direction: 'long', coreIdea: 'x', requiredMarketFeatures: [], confidence: 0.8, unknowns: [],
    profile: {
      direction: 'long', coreIdea: 'x', summary: 's', requiredMarketFeatures: [],
      entryConditions: [], exitConditions: [], timeframes: ['1h'], indicators: [],
      parameters, watchLifecycleSummary: null, positionManagementSummary: null,
      riskManagementSummary: null, runnerOwnedAuthorities: [], confidence: 0.8, unknowns: [], evidence: [],
    },
    sourceArtifactRef: {} as never, contractVersion: 'v1', createdAt: NOW, updatedAt: NOW,
  };
}

// Exit/risk-only param: name has no entry-affecting prefix, description has no entry keyword —
// classifyEntryAffectingParams buckets it into exitRisk, so entryAffecting === [].
const EXIT_ONLY_PARAMS: StrategyParameter[] = [param({ name: 'hardStopPct', description: 'hard stop loss' })];

// Entry-affecting param: 'dump.' name prefix matches ENTRY_AFFECTING_NAME_PREFIXES.
const ENTRY_PARAMS: StrategyParameter[] = [param({ name: 'dump.minDropPct', description: 'entry filter threshold' })];

export const SYNTHETIC_CASES: RawCase[] = [
  // Oracle Rule 1: 0 trades, no entry-affecting params -> stop_insufficient_evidence (obvious).
  {
    id: 'synthetic-0trade-exit-only',
    input: {
      profile: profile('p-exit-only', EXIT_ONLY_PARAMS),
      baselineMetrics: metrics({ totalTrades: 0 }),
      entryAffecting: [],
      hasEntrySignalEvidence: false,
    },
    meta: { experimentId: 'synthetic-exp-exit-only', sourceRef: 'synthetic' },
  },
  // Oracle Rule 2: 0 trades, entry-affecting params present, recorded evidence -> allow_exploratory_sweep.
  {
    id: 'synthetic-0trade-entry-evidence',
    input: {
      profile: profile('p-entry-evidence', ENTRY_PARAMS),
      baselineMetrics: metrics({ totalTrades: 0 }),
      entryAffecting: ['dump.minDropPct'],
      hasEntrySignalEvidence: true,
    },
    meta: { experimentId: 'synthetic-exp-entry-evidence', sourceRef: 'synthetic' },
  },
  // Oracle Rule 3: 0 trades, entry-affecting params present, no evidence -> stop_insufficient_evidence.
  {
    id: 'synthetic-0trade-entry-no-evidence',
    input: {
      profile: profile('p-entry-no-evidence', ENTRY_PARAMS),
      baselineMetrics: metrics({ totalTrades: 0 }),
      entryAffecting: ['dump.minDropPct'],
      hasEntrySignalEvidence: false,
    },
    meta: { experimentId: 'synthetic-exp-entry-no-evidence', sourceRef: 'synthetic' },
  },
  // Oracle Rule 4: trades exist -> needsTeacher (not an obvious/structural branch).
  {
    id: 'synthetic-has-trades',
    input: {
      profile: profile('p-has-trades', ENTRY_PARAMS),
      baselineMetrics: metrics({ totalTrades: 12, profitFactor: 1.4, sharpe: 1.1 }),
      entryAffecting: ['dump.minDropPct'],
      hasEntrySignalEvidence: true,
    },
    meta: { experimentId: 'synthetic-exp-has-trades', sourceRef: 'synthetic' },
  },
];
