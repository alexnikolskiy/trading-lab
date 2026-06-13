import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleChatSessionRepository } from './drizzle-chat-session.repository.ts';
import { chatSession } from '../../db/schema.ts';
import type { ChatSessionContext } from '../../ports/chat-session.repository.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const ctx = (over: Partial<ChatSessionContext> = {}): ChatSessionContext => ({
  sessionId: crypto.randomUUID(), updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleChatSessionRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleChatSessionRepository(db);

  beforeAll(async () => { await db.delete(chatSession); });
  afterAll(async () => { await pool.end(); });

  it('returns null for an unknown session', async () => {
    expect(await repo.get('does-not-exist')).toBeNull();
  });

  it('upserts then reads back, and a second upsert overwrites', async () => {
    const c = ctx({ lastStrategyProfileId: 'p1', lastUserGoal: 'strategy.onboard' });
    await repo.upsert(c);
    expect((await repo.get(c.sessionId))?.lastStrategyProfileId).toBe('p1');

    await repo.upsert({ ...c, lastStrategyProfileId: 'p2', lastHypothesisId: 'h9', updatedAt: new Date().toISOString() });
    const got = await repo.get(c.sessionId);
    expect(got?.lastStrategyProfileId).toBe('p2');
    expect(got?.lastHypothesisId).toBe('h9');
  });
});
