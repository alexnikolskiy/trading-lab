import { describe, it, expect } from 'vitest';
import { makeOnUsage } from './make-on-usage.ts';
import { makeServices } from '../../test/support/make-services.ts';
import type { ResearchTask } from '../domain/types.ts';
import type { ModelPricingPort } from '../ports/model-pricing.port.ts';

const task = (): ResearchTask => ({
  id: 'task-1', taskType: 'research.run_cycle', source: 'web', correlationId: 'corr-1',
  status: 'running', payload: {}, createdAt: '2026-06-26T00:00:00Z', updatedAt: '2026-06-26T00:00:00Z',
});

describe('makeOnUsage', () => {
  it('adds tokens and accrues $ cost when the model is priced', async () => {
    const pricing: ModelPricingPort = { priceFor: async () => ({ inputUsdPerToken: 0.001, outputUsdPerToken: 0.002 }) };
    const services = makeServices({ modelPricing: pricing });
    const opts = makeOnUsage(task(), services);
    await opts.onUsage?.({ modelId: 'm1', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(await services.tokenUsage.get('corr-1')).toBe(15);
    expect(await services.tokenUsage.getCost('corr-1')).toBeCloseTo(10 * 0.001 + 5 * 0.002, 10);
  });

  it('emits research.cost_unpriced when the model has no price', async () => {
    const pricing: ModelPricingPort = { priceFor: async () => null };
    const services = makeServices({ modelPricing: pricing });
    const opts = makeOnUsage(task(), services);
    await opts.onUsage?.({ modelId: 'unpriced-model', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('research.cost_unpriced');
    expect(await services.tokenUsage.get('corr-1')).toBe(2);
  });
});
