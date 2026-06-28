// src/experiments/strategy-analyst/judge.ts
import type { Agent } from '@mastra/core/agent';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';
import { MAX_OUTPUT_TOKENS } from '../../adapters/llm/generate-defaults.ts';

export interface JudgeInput {
  profile: AnalystProfileOutput;
  rubricText: string;
  notesText: string;
}

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    '--- RUBRIC START ---',
    input.rubricText,
    '--- RUBRIC END ---',
    '',
    '--- RESEARCH NOTES (reference) START ---',
    input.notesText,
    '--- RESEARCH NOTES END ---',
    '',
    '--- CANDIDATE PROFILE (JSON) START ---',
    JSON.stringify(input.profile, null, 2),
    '--- CANDIDATE PROFILE END ---',
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
