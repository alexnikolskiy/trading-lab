// src/experiments/intent-classifier/judge.test.ts
import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, runJudge } from './judge.ts';
import type { Agent } from '@mastra/core/agent';
import type { EvalCase, CaseResult, JudgeVerdict } from './types.ts';

const cases: EvalCase[] = [
  { id: 'a', lang: 'ru', message: 'статус задачи', expect: { intent: 'task.status' } },
  { id: 'b', lang: 'en', message: 'help', expect: { intent: 'help' } },
];
const results: CaseResult[] = [
  { id: 'a', lang: 'ru', expectedIntent: 'task.status', actualIntent: 'task.status', intentMatch: true, schemaValid: true, payloadChecks: [], payloadScore: null, latencyMs: 5, error: null },
  { id: 'b', lang: 'en', expectedIntent: 'help', actualIntent: 'out_of_scope', intentMatch: false, schemaValid: true, payloadChecks: [], payloadScore: null, latencyMs: 5, error: null },
];

describe('buildJudgePrompt', () => {
  it('includes each message, its expected and actual intent', () => {
    const prompt = buildJudgePrompt({ cases, results });
    expect(prompt).toContain('статус задачи');
    expect(prompt).toContain('task.status');
    expect(prompt).toContain('out_of_scope'); // the disagreement is visible to the judge
    expect(prompt).toContain('Return the structured judge verdict.');
  });
});

describe('runJudge', () => {
  it('calls agent.generate with the JudgeVerdict structured-output schema and returns the parsed verdict', async () => {
    const verdict: JudgeVerdict = { dimensions: [{ name: 'overall', score: 0.8, rationale: 'fine' }], overallScore: 0.8, disputedCases: [{ id: 'b', note: 'arguable' }], notes: 'ok' };
    let sawSchema = false;
    const agent = {
      async generate(_prompt: string, opts: { structuredOutput?: { schema?: unknown } }) {
        sawSchema = opts?.structuredOutput?.schema != null;
        return { object: verdict };
      },
    } as unknown as Agent;
    const out = await runJudge(agent, { cases, results });
    expect(sawSchema).toBe(true);
    expect(out).toEqual(verdict);
  });
});
