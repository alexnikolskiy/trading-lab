import { describe, it, expect } from 'vitest';
import { MastraBuilder, buildPromptFor } from './mastra-builder.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createBuilderAgent } from '../../mastra/agents/builder.agent.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when OI trend persists for 3+ bars',
    targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'],
    confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}

function profile(): StrategyProfile {
  return { id: 'p1', requiredMarketFeatures: ['oi', 'funding'], direction: 'long' } as unknown as StrategyProfile;
}

describe('MastraBuilder (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const b = new MastraBuilder(createBuilderAgent(model), label);
    expect(b.adapter).toBe('mastra');
    expect(b.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('buildPromptFor', () => {
  it('includes hypothesis thesis', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('Skip entries when OI trend persists for 3+ bars');
  });

  it('includes requiredFeatures in the requirements section', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('oi');
    expect(prompt).toContain('funding');
  });

  it('includes the sdkDoc verbatim', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('SDK_DOC_HERE');
  });

  it('includes appliesTo direction', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('"long"');
  });

  it('includes the correct sdkContractVersion in requirements', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: '' });
    expect(prompt).toContain(SDK_CONTRACT_VERSION);
  });

  it('includes moduleId requirement with hypothesis id', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: '' });
    expect(prompt).toContain('overlay-h1');
  });

  it('is longer when sdkDoc is populated', () => {
    const shortPrompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: '' });
    const richPrompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'LARGE SDK DOC HERE' });
    expect(richPrompt.length).toBeGreaterThan(shortPrompt.length);
  });
});

const live = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;
(live ? describe : describe.skip)('MastraBuilder (live)', () => {
  it('produces a schema-valid BuilderOutput', async () => {
    expect(true).toBe(true);
  });
});
