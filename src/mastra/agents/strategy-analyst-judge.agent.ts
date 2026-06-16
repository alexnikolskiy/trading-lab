// src/mastra/agents/strategy-analyst-judge.agent.ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_ANALYST_JUDGE_AGENT_ID = 'strategy-analyst-judge';

const INSTRUCTIONS = [
  'You are evaluating a candidate StrategyProfile produced by another model against a rubric and reference research notes.',
  'Score each rubric dimension from 0 to 1 with a short rationale.',
  'List any claims in the profile that are NOT supported by the source/notes (hallucinations).',
  'List rubric items the profile omitted (missingFromProfile).',
  'Be strict and concise. Do not propose changes; only assess.',
].join(' ');

export function createStrategyAnalystJudgeAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_ANALYST_JUDGE_AGENT_ID, name: 'Strategy Analyst Judge', instructions: INSTRUCTIONS, model });
}
