// src/experiments/strategy-analyst/plan.ts
import { parseRoleModel, MODEL_PROVIDERS, type ModelProvider, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';

export const KEY_BY_PROVIDER: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface DryRunModelPlan {
  model: string;
  provider: ModelProvider | 'unknown';
  modelId: string;
  requiredKey: string | null;
  keyPresent: boolean;
}

export interface DryRunPlan {
  repeat: number;
  perModel: DryRunModelPlan[];
  analystCalls: number;
  judgeCalls: number;
  totalPaidCalls: number;
  missingKeys: string[];
}

function isProvider(value: string | undefined): value is ModelProvider {
  return value != null && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export interface PlanInput {
  models: string[];
  judge: boolean;
  env: Record<string, string | undefined>;
  repeat?: number; // independent runs per model; default 1
}

export function planDryRun(input: PlanInput): DryRunPlan {
  const repeat = input.repeat ?? 1;
  const modelEnv: ModelProviderEnv = { MODEL_PROVIDER: input.env.MODEL_PROVIDER as ModelProvider };

  const perModel: DryRunModelPlan[] = input.models.map((model) => {
    const { provider, modelId } = parseRoleModel(modelEnv, model);
    if (!isProvider(provider)) {
      return { model, provider: 'unknown', modelId, requiredKey: null, keyPresent: false };
    }
    const requiredKey = KEY_BY_PROVIDER[provider];
    return { model, provider, modelId, requiredKey, keyPresent: Boolean(input.env[requiredKey]) };
  });

  const missingKeys = [...new Set(perModel.filter((m) => m.requiredKey != null && !m.keyPresent).map((m) => m.requiredKey as string))];
  // Each model runs `repeat` times; each run is one analyst call (+ one judge call when --judge).
  const analystCalls = input.models.length * repeat;
  const judgeCalls = (input.judge ? input.models.length : 0) * repeat;

  return { repeat, perModel, analystCalls, judgeCalls, totalPaidCalls: analystCalls + judgeCalls, missingKeys };
}
