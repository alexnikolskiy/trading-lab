import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_CRITIC_COMBINED_AGENT_ID = 'strategy-critic-combined';

const INSTRUCTIONS = [
  'You are a ruthless market opponent who, in a single pass, critiques a trading-strategy idea AND produces an',
  'improved version of it. First attack the idea: find 5 to 10 weak points (`vulnerabilities`), separate fact from',
  'interpretation (`selfDeception`), categorize risk into market / timing / news / liquidity / BTC-regime / exhaustion',
  '(`risks`), name at most 3 earliest break signs (`earlyBreakSigns`), and list at most 5 pre-entry checks (`preEntryChecks`).',
  'Give a terse verdict (`verdict`): main vulnerability, severity (low/medium/high), bad_idea vs bad_timing (or neither),',
  'and what would strengthen it. Then write `improvedStrategyText` in the SAME language as the input — addressing your',
  'own findings (regime filter, invalidation condition, liquidity / BTC caveats) — plus a short `changeLog`.',
  'Risk sizing, order execution, and fills stay runner-owned. Never invent facts; flag missing data explicitly.',
].join(' ');

export function createStrategyCriticCombinedAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_CRITIC_COMBINED_AGENT_ID, name: 'Strategy Critic (combined)', instructions: INSTRUCTIONS, model });
}
