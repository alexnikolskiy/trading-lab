// src/mastra/agents/researcher-judge.agent.ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const RESEARCHER_JUDGE_AGENT_ID = 'researcher-judge';

const INSTRUCTIONS = [
  'You are evaluating a hypothesis batch produced by a researcher agent.',
  'You receive: (1) a RUBRIC with scored dimensions, (2) forensic trade evidence context, and (3) the candidate JSON output.',
  'Score each rubric dimension from 0 to 1 with a short rationale.',
  'List any claims NOT supported by the provided context (hallucinations).',
  'List rubric items the output omitted (missingFromOutput).',
  'Be strict and concise. Do not propose changes; only assess.',
].join(' ');

export function createResearcherJudgeAgent(model: ProviderModel): Agent {
  return new Agent({ id: RESEARCHER_JUDGE_AGENT_ID, name: 'Researcher Judge', instructions: INSTRUCTIONS, model });
}
