// src/adapters/llm/model-provider.ts
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelProviderEnv {
  MODEL_PROVIDER: ModelProvider;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

const OVERRIDE_PREFIXES = new Set<string>(MODEL_PROVIDERS);

/** First path segment is a provider override ONLY when it's exactly anthropic|openai|openrouter;
 *  otherwise the whole id falls through to the global MODEL_PROVIDER. */
export function parseRoleModel(env: ModelProviderEnv, roleModelId: string): { provider: ModelProvider; modelId: string } {
  const slash = roleModelId.indexOf('/');
  if (slash > 0) {
    const head = roleModelId.slice(0, slash);
    if (OVERRIDE_PREFIXES.has(head)) {
      return { provider: head as ModelProvider, modelId: roleModelId.slice(slash + 1) };
    }
  }
  return { provider: env.MODEL_PROVIDER, modelId: roleModelId };
}
