// src/experiments/intent-classifier/judge.ts
// Optional LLM-as-judge. One batch call per model run: it sees every (message, expected, actual)
// triple and assesses classification quality + flags arguable gold labels. Never affects the
// deterministic verdict (the harness keeps the judge best-effort).
import type { Agent } from '@mastra/core/agent';
import { JudgeVerdictSchema, type CaseResult, type EvalCase, type JudgeVerdict } from './types.ts';

export interface JudgeInput {
  cases: EvalCase[];
  results: CaseResult[];
}

export function buildJudgePrompt(input: JudgeInput): string {
  const rows = input.cases.map((c, i) => {
    const r = input.results[i];
    return {
      id: c.id,
      lang: c.lang,
      message: c.message,
      expectedIntent: c.expect.intent,
      actualIntent: r?.actualIntent ?? null,
      intentMatch: r?.intentMatch ?? false,
    };
  });
  return [
    'You are auditing an intent classifier over a labelled chat dataset.',
    'Each row has the user message, the EXPECTED intent label, and the classifier ACTUAL intent.',
    '--- CASES (JSON) START ---',
    JSON.stringify(rows, null, 2),
    '--- CASES END ---',
    '',
    'Assess how reasonable the classifications are, and flag any case where the EXPECTED label itself is arguable (disputedCases).',
    'Return the structured judge verdict.',
  ].join('\n');
}

export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
  return JudgeVerdictSchema.parse(result.object);
}
