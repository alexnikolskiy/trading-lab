// src/experiments/strategy-analyst/plan.test.ts
import { describe, it, expect } from 'vitest';
import { planDryRun, KEY_BY_PROVIDER } from './plan.ts';

describe('planDryRun', () => {
  it('resolves providers via prefix and reports key presence per model', () => {
    const plan = planDryRun({
      models: ['anthropic/claude-x', 'openai/gpt-x'],
      judge: false,
      env: { ANTHROPIC_API_KEY: 'a' }, // OPENAI_API_KEY missing
    });
    expect(plan.perModel).toEqual([
      { model: 'anthropic/claude-x', provider: 'anthropic', modelId: 'claude-x', requiredKey: 'ANTHROPIC_API_KEY', keyPresent: true },
      { model: 'openai/gpt-x', provider: 'openai', modelId: 'gpt-x', requiredKey: 'OPENAI_API_KEY', keyPresent: false },
    ]);
    expect(plan.analystCalls).toBe(2);
    expect(plan.judgeCalls).toBe(0);
    expect(plan.totalPaidCalls).toBe(2);
    expect(plan.missingKeys).toEqual(['OPENAI_API_KEY']);
  });

  it('counts judge calls when judge is enabled', () => {
    const plan = planDryRun({ models: ['x/y', 'a/b'], judge: true, env: {} });
    expect(plan.judgeCalls).toBe(2);
    expect(plan.totalPaidCalls).toBe(4);
  });

  it('falls back to MODEL_PROVIDER for an unprefixed id', () => {
    const plan = planDryRun({ models: ['claude-x'], judge: false, env: { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' } });
    expect(plan.perModel[0]!.provider).toBe('anthropic');
    expect(plan.perModel[0]!.keyPresent).toBe(true);
  });

  it('marks an unresolvable provider (no prefix, no MODEL_PROVIDER) as unknown', () => {
    const plan = planDryRun({ models: ['mystery-model'], judge: false, env: {} });
    expect(plan.perModel[0]!.provider).toBe('unknown');
    expect(plan.perModel[0]!.keyPresent).toBe(false);
  });

  it('KEY_BY_PROVIDER maps each provider to its env var', () => {
    expect(KEY_BY_PROVIDER).toEqual({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' });
  });

  it('defaults repeat to 1 (no multiplier)', () => {
    const plan = planDryRun({ models: ['x/y'], judge: false, env: {} });
    expect(plan.repeat).toBe(1);
    expect(plan.analystCalls).toBe(1);
    expect(plan.totalPaidCalls).toBe(1);
  });

  it('multiplies planned paid calls by repeat (analyst + judge)', () => {
    const plan = planDryRun({ models: ['x/y', 'a/b'], judge: true, env: {}, repeat: 4 });
    expect(plan.repeat).toBe(4);
    expect(plan.analystCalls).toBe(8); // 2 models * 4
    expect(plan.judgeCalls).toBe(8); // 2 models * 4
    expect(plan.totalPaidCalls).toBe(16);
  });
});
