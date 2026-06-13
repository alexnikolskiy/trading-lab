import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { hypothesisProposal } from '../../db/schema.ts';
import type { HypothesisProposalDraft } from '../../domain/hypothesis.ts';
import { DrizzleHypothesisReadAdapter } from './drizzle-hypothesis-read.adapter.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleHypothesisReadAdapter', () => {
  const { db, pool } = createDbClient(url!);
  const ids = ['sp5h1', 'sp5h2'];

  beforeAll(async () => {
    await db.delete(hypothesisProposal).where(inArray(hypothesisProposal.id, ids));
    let i = 1;
    for (const id of ids) {
      await db.insert(hypothesisProposal).values({
        id, strategyProfileId: id === 'sp5h2' ? 'pB' : 'pA', thesis: 't', targetBehavior: 'tb',
        ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
        requiredFeatures: ['oi'], validationPlan: 'plan', expectedEffect: { metric: 'pnl', direction: 'increase' },
        invalidationCriteria: ['c'], confidence: 0.7, status: id === 'sp5h2' ? 'rejected' : 'validated',
        fingerprint: `fp-${id}`, proposal: {} as unknown as HypothesisProposalDraft, issues: [], contractVersion: 'v1',
        createdAt: new Date(`2026-03-0${i}T00:00:00Z`), updatedAt: new Date(`2026-03-0${i}T00:00:00Z`),
      });
      i++;
    }
  });

  afterAll(async () => {
    await db.delete(hypothesisProposal).where(inArray(hypothesisProposal.id, ids));
    await pool.end();
  });

  it('lists newest-first; filters status + profileId; getById', async () => {
    const a = new DrizzleHypothesisReadAdapter(db);
    const all = (await a.list({ limit: 50 })).filter((h) => ids.includes(h.id)).map((h) => h.id);
    expect(all).toEqual(['sp5h2', 'sp5h1']);
    expect((await a.list({ status: 'rejected', limit: 50 })).filter((h) => ids.includes(h.id)).map((h) => h.id)).toEqual(['sp5h2']);
    expect((await a.list({ profileId: 'pA', limit: 50 })).map((h) => h.id)).toEqual(['sp5h1']);
    expect((await a.getById('sp5h1'))?.status).toBe('validated');
    expect(await a.getById('nope')).toBeNull();
  });
});
