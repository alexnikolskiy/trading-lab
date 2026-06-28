// src/experiments/researcher/judge.ts
import type { Agent } from '@mastra/core/agent';
import type { ResearcherOutput } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';
import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';

export const RESEARCHER_JUDGE_RUBRIC = `
Dimension: forensic_grounding (0–1)
  Does each hypothesis specifically reference the failure patterns visible in the forensic trade evidence
  (e.g. DCA sequences → sl/hard_stop, entry-to-close lifecycle, specific close reasons)?
  0 = generic language only. 1 = directly references at least one forensic data point per hypothesis.

Dimension: falsifiability (0–1)
  Does the output provide a concrete, checkable validation plan with explicit invalidation criteria
  (metric + direction + threshold)? 0 = vague "run a backtest". 1 = metric, direction, and reject condition present.

Dimension: overlay_readiness (0–1)
  Is each hypothesis expressed as a concrete overlay action (skip_entry, tighten_stop, exit_now, etc.)
  that a builder agent could implement? 0 = narrative only. 1 = valid ruleAction with when/action/params.

Dimension: research_only (0–1)
  Does the output stay within research scope — proposing hypotheses, not rewriting the base strategy
  or issuing live orders? 0 = contains strategy rewrite or live-order intent. 1 = fully research-scoped.

Dimension: specificity (0–1)
  Does the validation plan reference specific metrics from the provided bot results
  (e.g. hard_stop rate, avg pnl, winrate)? 0 = generic metrics. 1 = at least two specific metrics cited.
`.trim();

export interface JudgeInput {
  output: ResearcherOutput;
  profile: StrategyProfile;
  botResults: readonly BotRunResultDetail[];
  tradeEvidence?: readonly TradeEvidenceBundle[];
}

export function buildJudgePrompt(input: JudgeInput): string {
  const contextLines: string[] = [
    `Strategy: ${input.profile.coreIdea} (direction: ${input.profile.direction})`,
  ];
  if (input.tradeEvidence && input.tradeEvidence.length > 0) {
    contextLines.push('Forensic trade bundles (worst losing trades):');
    for (const b of input.tradeEvidence) {
      const lifecycle = b.lifecycleEvents.map((e) => e.type).join('→');
      contextLines.push(`  ${b.symbol} closeReason=${b.closeReason ?? 'unknown'} lifecycle=${lifecycle} pnl=${b.realizedPnl}`);
    }
  }
  if (input.botResults.length > 0) {
    const summary = input.botResults[0]?.summary;
    if (summary) {
      contextLines.push(`Bot summary: winrate=${summary.winratePct}% pnl=${summary.pnlUsd} exitReasons=${JSON.stringify(summary.exitReasons)}`);
    }
  }

  return [
    '--- RUBRIC START ---',
    RESEARCHER_JUDGE_RUBRIC,
    '--- RUBRIC END ---',
    '',
    '--- CONTEXT (evidence available to the researcher) START ---',
    contextLines.join('\n'),
    '--- CONTEXT END ---',
    '',
    '--- CANDIDATE OUTPUT (JSON) START ---',
    JSON.stringify(input.output, null, 2),
    '--- CANDIDATE OUTPUT END ---',
    '',
    'Return the structured judge verdict.',
  ].join('\n');
}

export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
  const result = await agent.generate(buildJudgePrompt(input), {
    structuredOutput: { schema: JudgeVerdictSchema },
    modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
  return JudgeVerdictSchema.parse(result.object);
}
