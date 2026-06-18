import type { Agent } from '@mastra/core/agent';
import type { ResearcherInput, ResearcherPort } from '../../ports/researcher.port.ts';
import { ResearcherOutputSchema, type ResearcherOutput } from '../../domain/hypothesis.ts';
import { buildBotResultsDigestText } from './bot-results-digest.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';

function profileDetailsText(input: ResearcherInput): string[] {
  const profile = input.profile.profile;
  if (!profile) return [];
  return [
    `Strategy summary: ${profile.summary}`,
    `Entry conditions: ${profile.entryConditions.join(' | ') || '(none)'}`,
    `Exit conditions: ${profile.exitConditions.join(' | ') || '(none)'}`,
    `Parameters: ${(profile.parameters ?? []).map((p) => `${p.name}=${String(p.value)}`).join(' | ') || '(none)'}`,
    `Position management: ${profile.positionManagementSummary ?? '(none)'}`,
    `Risk management: ${profile.riskManagementSummary ?? '(none)'}`,
    `Unknowns: ${(profile.unknowns ?? []).join(' | ') || '(none)'}`,
    `Profile evidence: ${(profile.evidence ?? []).join(' | ') || '(none)'}`,
  ];
}

function forensicBundleText(bundles: readonly TradeEvidenceBundle[] | undefined): string[] {
  if (!bundles || bundles.length === 0) return [];
  return [
    'Forensic trade evidence:',
    ...bundles.flatMap((bundle) => [
      `- ${bundle.symbol} tradeId=${bundle.tradeId} entryPrice=${bundle.entryPrice ?? 'unknown'}`
      + ` exitPrice=${bundle.exitPrice ?? 'unknown'} pnlUsd=${bundle.realizedPnl}`
      + ` pnlPct=${bundle.pnlPct} holdingDurationMs=${bundle.holdingDurationMs ?? 'unknown'} closeReason=${bundle.closeReason ?? 'unknown'}`,
      ...bundle.lifecycleEvents.map((event) =>
        `  lifecycle tsMs=${event.tsMs} type=${event.type} price=${event.price ?? 'unknown'} qty=${event.qty ?? 'unknown'} note=${event.note ?? ''}`),
      ...bundle.minuteContext.map((point) =>
        `  minute tsMs=${point.tsMs} close=${point.close} volume=${point.volume ?? 'unknown'}`
        + ` oi=${point.oi ?? 'unknown'} liquidationsLong=${point.liquidationsLong ?? 'unknown'} liquidationsShort=${point.liquidationsShort ?? 'unknown'}`),
    ]),
  ];
}

export function buildPrompt(input: ResearcherInput): string {
  const similar = input.similarHypotheses.length > 0
    ? input.similarHypotheses.map((s) => `- [${s.status}] ${s.thesis}`).join('\n')
    : '(none)';
  const botPerf = buildBotResultsDigestText(input.botResults);
  return [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Direction: ${input.profile.direction}`,
    `Profile required features: ${input.profile.requiredMarketFeatures.join(', ') || '(none)'}`,
    ...profileDetailsText(input),
    `Market regime: ${input.marketRegime}`,
    `Market context features: ${JSON.stringify(input.marketContext.features)}`,
    `Similar past hypotheses (advisory, avoid duplicating):\n${similar}`,
    ...(botPerf ? [botPerf] : []),
    ...forensicBundleText(input.tradeEvidence),
    `Produce at most ${input.maxHypotheses} hypotheses.`,
  ].join('\n');
}

export class MastraResearcher implements ResearcherPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async propose(input: ResearcherInput): Promise<ResearcherOutput> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: ResearcherOutputSchema },
    });
    // Re-parse to guarantee the typed shape regardless of the SDK's inferred return type.
    return ResearcherOutputSchema.parse(result.object);
  }
}
