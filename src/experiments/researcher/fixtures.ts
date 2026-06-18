import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import { GOOD_LONG_OI_PROFILE } from '../strategy-analyst/__fixtures__/profiles.ts';
import { FixtureBotResultsAdapter } from '../../adapters/platform/fixture-bot-results.adapter.ts';
import { FixtureTradeEvidenceAdapter } from '../../adapters/platform/fixture-trade-evidence.adapter.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';

export const RESEARCHER_FIXTURES = {
  'long-oi-vps-2026-06-01': {
    id: 'long-oi-vps-2026-06-01',
    botResultsDir: 'docs/fixtures/bot-results/vps-from-2026-06-01',
  },
} as const;

export type ResearcherFixtureId = keyof typeof RESEARCHER_FIXTURES;

export function resolveResearcherFixture(id: string): (typeof RESEARCHER_FIXTURES)[ResearcherFixtureId] {
  const fixture = RESEARCHER_FIXTURES[id as ResearcherFixtureId];
  if (!fixture) throw new Error(`unknown researcher fixture "${id}" (known: ${Object.keys(RESEARCHER_FIXTURES).join(', ')})`);
  return fixture;
}

export function longOiStrategyProfile(): StrategyProfile {
  return {
    id: 'long-oi-profile',
    version: 1,
    sourceKind: 'manual_description',
    sourceFingerprint: 'sha256:long-oi',
    direction: GOOD_LONG_OI_PROFILE.direction,
    coreIdea: GOOD_LONG_OI_PROFILE.coreIdea,
    requiredMarketFeatures: GOOD_LONG_OI_PROFILE.requiredMarketFeatures,
    confidence: GOOD_LONG_OI_PROFILE.confidence,
    unknowns: GOOD_LONG_OI_PROFILE.unknowns,
    profile: GOOD_LONG_OI_PROFILE,
    sourceArtifactRef: {
      artifact_id: 'fixture-long-oi-source',
      uri: 'docs/fixtures/strategies/long-oi-strategy-source.md',
      content_hash: 'sha256:fixture',
      kind: 'strategy-source',
      size_bytes: 0,
      mime_type: 'text/markdown',
      created_at: '2026-06-01T00:00:00Z',
      producer: 'researcher-eval',
      metadata: {},
    },
    contractVersion: 'strategy-profile-v1',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

export async function loadBotResultsFixture(dir: string): Promise<readonly BotRunResultDetail[]> {
  const adapter = new FixtureBotResultsAdapter(fileURLToPath(new URL(`../../../${dir}/`, import.meta.url)));
  const runs = await adapter.listBotRuns();
  return Promise.all(runs.map(async (run) => ({
    run,
    summary: await adapter.getRunSummary(run.runId),
    trades: await adapter.getClosedTrades(run.runId),
  })));
}

export async function loadTradeEvidenceFixture(
  dir: string,
  botResults: readonly BotRunResultDetail[],
  limit = 5,
): Promise<readonly TradeEvidenceBundle[]> {
  const adapter = new FixtureTradeEvidenceAdapter(fileURLToPath(new URL(`../../../${dir}/`, import.meta.url)));
  const tradeIds = botResults
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .sort((a, b) => Number(a.realizedPnl) - Number(b.realizedPnl) || a.tradeId.localeCompare(b.tradeId))
    .slice(0, limit)
    .map((trade) => trade.tradeId);
  if (tradeIds.length === 0) return [];
  return adapter.getTradeEvidence({ tradeIds, minuteWindowBefore: 20, minuteWindowAfter: 180 });
}

export function fingerprintFixture(
  profile: StrategyProfile,
  botResults: readonly BotRunResultDetail[],
  tradeEvidence: readonly TradeEvidenceBundle[] = [],
): string {
  const payload = JSON.stringify({
    profile: profile.sourceFingerprint,
    runs: botResults.map((d) => [d.run.runId, d.summary.closedTrades, d.summary.pnlUsd]),
    tradeEvidence: tradeEvidence.map((bundle) => [bundle.tradeId, bundle.symbol, bundle.closeReason, bundle.lifecycleEvents.length, bundle.minuteContext.length]),
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
