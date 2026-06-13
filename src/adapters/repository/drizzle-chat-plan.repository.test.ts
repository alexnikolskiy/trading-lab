import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleChatPlanRepository } from './drizzle-chat-plan.repository.ts';
import { chatPlan } from '../../db/schema.ts';
import type { ChatPlan } from '../../ports/chat-plan.repository.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const plan = (over: Partial<ChatPlan> = {}): ChatPlan => ({
  id: crypto.randomUUID(), sessionId: 's1', afterTaskId: crypto.randomUUID(),
  nextTaskType: 'research.run_cycle', resolveProfileByFingerprint: 'sha256:fp', correlationId: 'c1',
  status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleChatPlanRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleChatPlanRepository(db);

  beforeAll(async () => { await db.delete(chatPlan); });
  afterAll(async () => { await pool.end(); });

  it('creates, finds pending by afterTaskId, and advancing removes it from pending', async () => {
    const p = plan();
    await repo.create(p);
    expect((await repo.findById(p.id))?.correlationId).toBe('c1');
    expect((await repo.findPendingByAfterTaskId(p.afterTaskId))?.id).toBe(p.id);

    await repo.markAdvanced(p.id);
    expect((await repo.findById(p.id))?.status).toBe('advanced');
    expect(await repo.findPendingByAfterTaskId(p.afterTaskId)).toBeNull();
  });

  it('markFailed flips status to failed', async () => {
    const p = plan();
    await repo.create(p);
    await repo.markFailed(p.id);
    expect((await repo.findById(p.id))?.status).toBe('failed');
  });
});
