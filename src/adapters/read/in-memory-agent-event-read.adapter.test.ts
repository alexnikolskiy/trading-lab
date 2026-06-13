import { describe, it, expect } from 'vitest';
import { InMemoryAgentEventReadAdapter } from './in-memory-agent-event-read.adapter.ts';
import type { AgentEventRow } from '../../ports/agent-event-read.port.ts';

function ev(id: string, over: Partial<AgentEventRow> = {}): AgentEventRow {
  return { id, taskId: 't1', type: 'strategy_analyst.started', payload: {}, createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

describe('InMemoryAgentEventReadAdapter', () => {
  const seed = [
    ev('e1', { createdAt: '2026-01-01T00:00:01.000Z', taskId: 't1', type: 'strategy_analyst.started', correlationId: 'c1' }),
    ev('e2', { createdAt: '2026-01-01T00:00:02.000Z', taskId: 't1', type: 'strategy_analyst.completed', correlationId: 'c1' }),
    ev('e3', { createdAt: '2026-01-01T00:00:03.000Z', taskId: 't2', type: 'strategy_analyst.started', correlationId: 'c2' }),
  ];

  it('lists oldest-first (backfill order)', async () => {
    const a = new InMemoryAgentEventReadAdapter(seed);
    expect((await a.list({ limit: 10 })).map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('filters by taskId, type, since, correlationId', async () => {
    const a = new InMemoryAgentEventReadAdapter(seed);
    expect((await a.list({ taskId: 't1', limit: 10 })).map((r) => r.id)).toEqual(['e1', 'e2']);
    expect((await a.list({ type: 'strategy_analyst.started', limit: 10 })).map((r) => r.id)).toEqual(['e1', 'e3']);
    expect((await a.list({ since: '2026-01-01T00:00:02.000Z', limit: 10 })).map((r) => r.id)).toEqual(['e2', 'e3']);
    expect((await a.list({ correlationId: 'c2', limit: 10 })).map((r) => r.id)).toEqual(['e3']);
  });

  it('paginates ascending by keyset', async () => {
    const a = new InMemoryAgentEventReadAdapter(seed);
    const first = await a.list({ limit: 2 });
    const last = first[first.length - 1]!;
    const next = await a.list({ limit: 2, after: { t: last.createdAt, id: last.id } });
    expect(next.map((r) => r.id)).toEqual(['e3']);
  });
});
