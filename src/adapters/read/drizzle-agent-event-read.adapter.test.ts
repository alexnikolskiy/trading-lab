import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../../db/client.ts';
import { agentEvent, researchTask } from '../../db/schema.ts';
import { DrizzleAgentEventReadAdapter } from './drizzle-agent-event-read.adapter.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleAgentEventReadAdapter', () => {
  const { db, pool } = createDbClient(url!);
  const taskId = 'sp5task';
  const evIds = ['sp5e1', 'sp5e2'];

  beforeAll(async () => {
    await db.delete(agentEvent).where(inArray(agentEvent.id, evIds));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await db.insert(researchTask).values({
      id: taskId, taskType: 'strategy.onboard', source: 'web', correlationId: 'corr-sp5', status: 'queued', payload: {},
    });
    await db.insert(agentEvent).values([
      { id: 'sp5e1', taskId, type: 'strategy_analyst.started', payload: { secret: 'x' }, createdAt: new Date('2026-04-01T00:00:01Z') },
      { id: 'sp5e2', taskId, type: 'strategy_analyst.completed', payload: { profileId: 'p1' }, createdAt: new Date('2026-04-01T00:00:02Z') },
    ]);
  });

  afterAll(async () => {
    await db.delete(agentEvent).where(inArray(agentEvent.id, evIds));
    await db.delete(researchTask).where(eq(researchTask.id, taskId));
    await pool.end();
  });

  it('lists ascending, resolves correlationId via JOIN, filters by type + correlationId', async () => {
    const a = new DrizzleAgentEventReadAdapter(db);
    const rows = await a.list({ taskId, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(['sp5e1', 'sp5e2']);
    expect(rows[0]!.correlationId).toBe('corr-sp5');
    expect((await a.list({ type: 'strategy_analyst.completed', limit: 10 })).some((r) => r.id === 'sp5e2')).toBe(true);
    expect((await a.list({ correlationId: 'corr-sp5', limit: 10 })).map((r) => r.id)).toEqual(['sp5e1', 'sp5e2']);
  });
});
