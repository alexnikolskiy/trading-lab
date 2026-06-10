import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleAgentEventRepository } from './drizzle-agent-event.repository.ts';
import { agentEvent } from '../../db/schema.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('DrizzleAgentEventRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleAgentEventRepository(db);
  beforeAll(async () => { await db.delete(agentEvent); });
  afterAll(async () => { await pool.end(); });

  it('appends and lists by task', async () => {
    await repo.append({ id: crypto.randomUUID(), taskId: 'tA', type: 'strategy_analyst.started', payload: { model: 'm' }, createdAt: new Date().toISOString() });
    await repo.append({ id: crypto.randomUUID(), taskId: 'tA', type: 'strategy_analyst.completed', payload: {}, createdAt: new Date().toISOString() });
    await repo.append({ id: crypto.randomUUID(), taskId: 'tB', type: 'strategy_analyst.started', payload: {}, createdAt: new Date().toISOString() });
    const a = await repo.listByTask('tA');
    expect(a.map((e) => e.type).sort()).toEqual(['strategy_analyst.completed', 'strategy_analyst.started']);
    expect(a[0]!.payload).toBeTypeOf('object');
  });
});
