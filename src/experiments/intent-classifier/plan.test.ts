// src/experiments/intent-classifier/plan.test.ts
import { describe, it, expect } from 'vitest';
import { planDryRun, KEY_BY_PROVIDER } from './plan.ts';

describe('planDryRun — paid-call accounting', () => {
  it('classifyCalls = models x repeat x caseCount (the real paid-call count)', () => {
    const plan = planDryRun({
      models: ['openrouter/x-ai/grok-4.1-fast', 'openrouter/qwen/qwen3.6-flash'],
      judge: false,
      env: { OPENROUTER_API_KEY: 'k' },
      caseCount: 20,
      repeat: 1,
    });
    expect(plan.classifyCalls).toBe(40); // 2 models * 1 repeat * 20 cases
    expect(plan.judgeCalls).toBe(0);
    expect(plan.totalPaidCalls).toBe(40);
    expect(plan.caseCount).toBe(20);
  });

  it('adds one judge call per model per repeat when judge is enabled', () => {
    const plan = planDryRun({
      models: ['openrouter/qwen/qwen3.6-flash'],
      judge: true,
      env: { OPENROUTER_API_KEY: 'k' },
      caseCount: 10,
      repeat: 2,
    });
    expect(plan.classifyCalls).toBe(20); // 1 * 2 * 10
    expect(plan.judgeCalls).toBe(2); // 1 model * 2 repeats
    expect(plan.totalPaidCalls).toBe(22);
  });

  it('defaults repeat to 1', () => {
    const plan = planDryRun({ models: ['openrouter/qwen/q'], judge: false, env: { OPENROUTER_API_KEY: 'k' }, caseCount: 5 });
    expect(plan.repeat).toBe(1);
    expect(plan.classifyCalls).toBe(5);
  });

  it('reports the required provider key and whether it is present', () => {
    const plan = planDryRun({ models: ['openrouter/qwen/q'], judge: false, env: {}, caseCount: 1 });
    const m = plan.perModel[0]!;
    expect(m.provider).toBe('openrouter');
    expect(m.requiredKey).toBe(KEY_BY_PROVIDER.openrouter);
    expect(m.keyPresent).toBe(false);
    expect(plan.missingKeys).toEqual(['OPENROUTER_API_KEY']);
  });

  it('dedupes missing keys across models of the same provider', () => {
    const plan = planDryRun({
      models: ['openrouter/a', 'openrouter/b'],
      judge: false,
      env: {},
      caseCount: 1,
    });
    expect(plan.missingKeys).toEqual(['OPENROUTER_API_KEY']);
  });

  it('marks a key present when set in env', () => {
    const plan = planDryRun({ models: ['openai/gpt-4o-mini'], judge: false, env: { OPENAI_API_KEY: 'k' }, caseCount: 1 });
    expect(plan.perModel[0]!.keyPresent).toBe(true);
    expect(plan.missingKeys).toEqual([]);
  });
});
