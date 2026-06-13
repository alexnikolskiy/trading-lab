import { describe, it, expect } from 'vitest';
import { InMemoryChatSessionRepository } from './in-memory-chat-session.repository.ts';
import type { ChatSessionContext } from '../../ports/chat-session.repository.ts';

const ctx = (over: Partial<ChatSessionContext> = {}): ChatSessionContext => ({
  sessionId: 's1', updatedAt: '2026-06-13T00:00:00Z', ...over,
});

describe('InMemoryChatSessionRepository', () => {
  it('returns null for an unknown session', async () => {
    const repo = new InMemoryChatSessionRepository();
    expect(await repo.get('missing')).toBeNull();
  });

  it('upserts and reads back pointers', async () => {
    const repo = new InMemoryChatSessionRepository();
    await repo.upsert(ctx({ lastStrategyProfileId: 'p1', lastResearchTaskId: 't1' }));
    const got = await repo.get('s1');
    expect(got?.lastStrategyProfileId).toBe('p1');
    expect(got?.lastResearchTaskId).toBe('t1');
  });

  it('upsert overwrites the prior context for the same sessionId', async () => {
    const repo = new InMemoryChatSessionRepository();
    await repo.upsert(ctx({ lastUserGoal: 'strategy.onboard' }));
    await repo.upsert(ctx({ lastUserGoal: 'research.run_cycle', lastHypothesisId: 'h9' }));
    const got = await repo.get('s1');
    expect(got?.lastUserGoal).toBe('research.run_cycle');
    expect(got?.lastHypothesisId).toBe('h9');
  });
});
