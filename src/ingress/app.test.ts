import { describe, it, expect } from 'vitest';
import { createIngressApp } from './app.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';

function setup() {
  const repo = new InMemoryResearchTaskRepository();
  const queue = new InMemoryQueueAdapter();
  const app = createIngressApp({ repo, queue });
  return { app, repo, queue };
}

describe('Ingress POST /tasks', () => {
  it('accepts a valid task, persists it, and enqueues an envelope', async () => {
    const { app, repo, queue } = setup();
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { taskId: string; status: string };
    expect(body.status).toBe('queued');
    expect((await repo.findById(body.taskId))?.status).toBe('queued');
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskId).toBe(body.taskId);
  });

  it('rejects an invalid payload with 400', async () => {
    const { app } = setup();
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'nope', source: 'web' }),
    });
    expect(res.status).toBe(400);
  });

  it('deduplicates by dedupeKey: second call returns the same taskId without re-enqueue', async () => {
    const { app, queue } = setup();
    const make = () => app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', dedupeKey: 'k1', payload: {} }),
    });
    const first = await (await make()).json() as { taskId: string; status: string };
    const second = await (await make()).json() as { taskId: string; status: string };
    expect(second.taskId).toBe(first.taskId);
    expect(queue.queued).toHaveLength(1);
  });
});
