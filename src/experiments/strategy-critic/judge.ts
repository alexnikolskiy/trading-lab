// src/experiments/strategy-critic/judge.ts
import type { Agent } from '@mastra/core/agent';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';
import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';

export interface JudgeInput {
  originalText: string;
  refinement: StrategyRefinement;
  profile?: AnalystProfileOutput;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const lines = [
    '--- ORIGINAL STRATEGY TEXT START ---',
    input.originalText,
    '--- ORIGINAL STRATEGY TEXT END ---',
    '',
    '--- CANDIDATE REFINEMENT (JSON) START ---',
    JSON.stringify(input.refinement, null, 2),
    '--- CANDIDATE REFINEMENT END ---',
    '',
  ];
  if (input.profile) {
    lines.push(
      '--- RESULTING ANALYST PROFILE (JSON) ---',
      JSON.stringify(input.profile, null, 2),
      '--- RESULTING ANALYST PROFILE END ---',
      '',
    );
  }
  lines.push('Return the structured judge verdict.');
  return lines.join('\n');
}

export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
  const result = await agent.generate(buildJudgePrompt(input), {
    structuredOutput: { schema: JudgeVerdictSchema },
    modelSettings: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
  return JudgeVerdictSchema.parse(result.object);
}
