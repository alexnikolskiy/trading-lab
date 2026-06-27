// src/experiments/strategy-critic/judge.ts
import type { Agent } from '@mastra/core/agent';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';

export interface JudgeInput {
  originalText: string;
  refinement: StrategyRefinement;
}

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    '--- ORIGINAL STRATEGY TEXT START ---',
    input.originalText,
    '--- ORIGINAL STRATEGY TEXT END ---',
    '',
    '--- CANDIDATE REFINEMENT (JSON) START ---',
    JSON.stringify(input.refinement, null, 2),
    '--- CANDIDATE REFINEMENT END ---',
    '',
    'Return the structured judge verdict.',
  ].join('\n');
}

export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
  return JudgeVerdictSchema.parse(result.object);
}
