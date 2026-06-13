import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisReadAdapter } from './in-memory-hypothesis-read.adapter.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';

function hyp(id: string, over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, strategyProfileId: 'p1', thesis: 't', targetBehavior: 'tb',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'x>1', action: 'skip_entry', params: {} }] },
    requiredFeatures: ['oi'], validationPlan: 'plan',
    expectedEffect: { metric: 'pnl', direction: 'increase' },
    invalidationCriteria: ['c'], confidence: 0.7, status: 'validated', fingerprint: 'fp',
    proposal: {} as HypothesisProposal['proposal'], issues: [], contractVersion: 'v1',
    createdAt: now, updatedAt: now, ...over,
  };
}

describe('InMemoryHypothesisReadAdapter', () => {
  const seed = [
    hyp('h1', { createdAt: '2026-01-01T00:00:01.000Z', strategyProfileId: 'p1', status: 'validated' }),
    hyp('h2', { createdAt: '2026-01-01T00:00:02.000Z', strategyProfileId: 'p2', status: 'rejected' }),
  ];

  it('lists newest-first and filters by status + profileId', async () => {
    const a = new InMemoryHypothesisReadAdapter(seed);
    expect((await a.list({ limit: 10 })).map((h) => h.id)).toEqual(['h2', 'h1']);
    expect((await a.list({ status: 'rejected', limit: 10 })).map((h) => h.id)).toEqual(['h2']);
    expect((await a.list({ profileId: 'p1', limit: 10 })).map((h) => h.id)).toEqual(['h1']);
  });

  it('getById returns the row or null', async () => {
    const a = new InMemoryHypothesisReadAdapter(seed);
    expect((await a.getById('h1'))?.id).toBe('h1');
    expect(await a.getById('nope')).toBeNull();
  });
});
