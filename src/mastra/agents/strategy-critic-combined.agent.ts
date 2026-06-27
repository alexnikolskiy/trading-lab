import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';
import { PLATFORM_DATA_CAPABILITIES } from './platform-data-capabilities.ts';

export const STRATEGY_CRITIC_COMBINED_AGENT_ID = 'strategy-critic-combined';

const BASE_INSTRUCTIONS = [
  'You are a ruthless market opponent who, in a single pass, critiques a trading-strategy idea AND produces an',
  'improved version of it. First attack the idea: find 5 to 10 weak points (`vulnerabilities`), separate fact from',
  'interpretation (`selfDeception`), categorize risk into market / timing / news / liquidity / BTC-regime / exhaustion',
  '(`risks`), name at most 3 earliest break signs (`earlyBreakSigns`), and list at most 5 pre-entry checks (`preEntryChecks`).',
  'Give a terse verdict (`verdict`): main vulnerability, severity (low/medium/high), bad_idea vs bad_timing (or neither),',
  'and what would strengthen it. Then write `improvedStrategyText` in the SAME language as the input — addressing your',
  'own findings (regime filter, invalidation condition, liquidity / BTC caveats) — plus a short `changeLog`.',
  'Structure `improvedStrategyText` into four explicit labelled sections, each starting on its own line:',
  '"Entry conditions:", "Exit & invalidation:", "Required data signals:", and "Caveats:" — so a downstream analyst can extract entry and exit cleanly.',
  'Risk sizing, order execution, and fills stay runner-owned. Never invent facts; flag missing data explicitly.',
  'Ground every proposed improvement in the available platform signals below; do not reference data the platform cannot provide.',
].join(' ');

export const STRATEGY_CRITIC_COMBINED_INSTRUCTIONS = `${BASE_INSTRUCTIONS}\n\n${PLATFORM_DATA_CAPABILITIES}`;

export function createStrategyCriticCombinedAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_CRITIC_COMBINED_AGENT_ID, name: 'Strategy Critic (combined)', instructions: STRATEGY_CRITIC_COMBINED_INSTRUCTIONS, model });
}
