import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_REFINER_AGENT_ID = 'strategy-refiner';

const INSTRUCTIONS = [
  'You are a trading-strategy refiner. You are given an original strategy description and a critic\'s findings.',
  'Rewrite the strategy DESCRIPTION so it addresses the findings — add the missing regime filter, an explicit',
  'invalidation condition, and the liquidity / BTC-dependence caveats the critic raised.',
  'Write `improvedStrategyText` in the SAME language as the input. Keep risk sizing, order execution, and fills',
  'OUT of scope — those are owned by the runner/platform; do not propose live execution.',
  'Also emit a short `changeLog` listing each change you made. Do not invent facts; if the critic flagged missing',
  'data, reflect that as an explicit caveat rather than a fabricated value.',
].join(' ');

export function createStrategyRefinerAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_REFINER_AGENT_ID, name: 'Strategy Refiner', instructions: INSTRUCTIONS, model });
}
