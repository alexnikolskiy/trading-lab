// src/adapters/llm/model-provider.test.ts
import { describe, it, expect } from 'vitest';
import { parseRoleModel, type ModelProviderEnv } from './model-provider.ts';

function env(MODEL_PROVIDER: ModelProviderEnv['MODEL_PROVIDER']): ModelProviderEnv {
  return { MODEL_PROVIDER };
}

describe('parseRoleModel', () => {
  const cases: Array<[string, ModelProviderEnv['MODEL_PROVIDER'], string, string]> = [
    // roleModelId,                              MODEL_PROVIDER, provider,     modelId
    ['claude-sonnet-4-6',                        'anthropic',  'anthropic',  'claude-sonnet-4-6'],
    ['anthropic/claude-sonnet-4-6',              'openai',     'anthropic',  'claude-sonnet-4-6'],
    ['openai/gpt-4o',                            'anthropic',  'openai',     'gpt-4o'],
    ['gpt-4o',                                   'openai',     'openai',     'gpt-4o'],
    ['meta-llama/llama-3.1-70b',                 'openrouter', 'openrouter', 'meta-llama/llama-3.1-70b'],
    ['openrouter/anthropic/claude-3.5-sonnet',   'anthropic',  'openrouter', 'anthropic/claude-3.5-sonnet'],
    ['google/gemini-flash-1.5',                  'anthropic',  'anthropic',  'google/gemini-flash-1.5'],
  ];

  for (const [roleModelId, provider, expProvider, expModelId] of cases) {
    it(`${roleModelId} @ ${provider} -> ${expProvider}:${expModelId}`, () => {
      const r = parseRoleModel(env(provider), roleModelId);
      expect(r.provider).toBe(expProvider);
      expect(r.modelId).toBe(expModelId);
    });
  }
});
