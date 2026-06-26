import { describe, it, expect } from 'vitest';
import { resolveLanguageModel } from '../../adapters/llm/model-provider.ts';
import { createStrategyCriticAgent, STRATEGY_CRITIC_AGENT_ID } from './strategy-critic.agent.ts';
import { createStrategyRefinerAgent, STRATEGY_REFINER_AGENT_ID } from './strategy-refiner.agent.ts';
import { createStrategyCriticCombinedAgent, STRATEGY_CRITIC_COMBINED_AGENT_ID } from './strategy-critic-combined.agent.ts';

const { model } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');

describe('strategy-critic agents (construction)', () => {
  it('builds the critic agent with its id + name', () => {
    expect(STRATEGY_CRITIC_AGENT_ID).toBe('strategy-critic');
    expect(createStrategyCriticAgent(model).name).toBe('Strategy Critic');
  });
  it('builds the refiner agent with its id + name', () => {
    expect(STRATEGY_REFINER_AGENT_ID).toBe('strategy-refiner');
    expect(createStrategyRefinerAgent(model).name).toBe('Strategy Refiner');
  });
  it('builds the combined agent with its id + name', () => {
    expect(STRATEGY_CRITIC_COMBINED_AGENT_ID).toBe('strategy-critic-combined');
    expect(createStrategyCriticCombinedAgent(model).name).toBe('Strategy Critic (combined)');
  });
});
