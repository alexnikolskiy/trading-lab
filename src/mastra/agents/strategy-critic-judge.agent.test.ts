import { describe, it, expect } from 'vitest';
import { resolveLanguageModel } from '../../adapters/llm/model-provider.ts';
import { createStrategyCriticJudgeAgent, STRATEGY_CRITIC_JUDGE_AGENT_ID } from './strategy-critic-judge.agent.ts';

const { model } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-opus-4-6');

describe('strategy-critic-judge agent (construction)', () => {
  it('builds the judge agent with its id + name', () => {
    expect(STRATEGY_CRITIC_JUDGE_AGENT_ID).toBe('strategy-critic-judge');
    expect(createStrategyCriticJudgeAgent(model).name).toBe('Strategy Critic Judge');
  });
});
