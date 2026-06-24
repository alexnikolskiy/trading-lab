import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { MastraCritic } from './mastra-critic.ts';
import type { CriticInput } from '../../domain/critic.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

const draft: HypothesisProposalDraft = {
  thesis: 'Skip entries while OI is falling', targetBehavior: 'Filter entries',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'oi falling', action: 'skip_entry', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'backtest', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['no improvement'], confidence: 0.5,
};

const validInput: CriticInput = {
  proposal: draft,
  profile: { id: 'p1', coreIdea: 'x', direction: 'long', requiredMarketFeatures: ['oi'] } as unknown as StrategyProfile,
};

/** Valid output satisfying CriticOutputSchema. */
const validObject = {
  verdict: 'ok',
  concerns: [],
  summary: 'Looks good',
};

function fakeAgent(totalTokens: number): Agent {
  return { generate: async () => ({ object: validObject, usage: { totalTokens } }) } as unknown as Agent;
}

describe('MastraCritic onUsage', () => {
  it('reports result.usage.totalTokens when present', async () => {
    let recorded = -1;
    const adapter = new MastraCritic(fakeAgent(789), 'm');
    await adapter.review(validInput, { onUsage: (t) => { recorded = t; } });
    expect(recorded).toBe(789);
  });

  it('coerces missing usage to 0', async () => {
    let recorded = -1;
    const agent = { generate: async () => ({ object: validObject }) } as unknown as Agent;
    const adapter = new MastraCritic(agent, 'm');
    await adapter.review(validInput, { onUsage: (t) => { recorded = t; } });
    expect(recorded).toBe(0);
  });
});
