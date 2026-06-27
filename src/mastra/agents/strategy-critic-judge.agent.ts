// src/mastra/agents/strategy-critic-judge.agent.ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_CRITIC_JUDGE_AGENT_ID = 'strategy-critic-judge';

export const STRATEGY_CRITIC_JUDGE_INSTRUCTIONS = [
  'You are evaluating a candidate strategy REFINEMENT produced by another model, given the original vague strategy text.',
  'Score each rubric dimension from 0 to 1 with a short rationale:',
  'did it strengthen the REAL weaknesses of the idea;',
  'did it add the missing nuances grounded in AVAILABLE data (OHLCV; open interest + trend; long/short liquidations; funding rate; taker buy/sell -> delta/CVD);',
  'did it AVOID inventing facts or unavailable data sources;',
  'is the strategy still analyzable and buildable with NO runner overreach (no leverage / base-order sizing / equity %).',
  'List any invented or unavailable-data claims (`hallucinations`) and any weaknesses it failed to address (`missing`).',
  'Be strict and concise. Do not rewrite the strategy; only assess.',
].join(' ');

export function createStrategyCriticJudgeAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_CRITIC_JUDGE_AGENT_ID, name: 'Strategy Critic Judge', instructions: STRATEGY_CRITIC_JUDGE_INSTRUCTIONS, model });
}
