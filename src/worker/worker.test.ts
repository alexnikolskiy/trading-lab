import { describe, it, expect } from 'vitest';
import { startWorker } from './worker.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import { echoHandler } from '../orchestrator/handlers/echo.handler.ts';
import type { QueueEnvelope, ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'queued', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});
const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 'id-1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

describe('startWorker', () => {
  it('marks task running then completed on success', async () => {
    const queue = new InMemoryQueueAdapter();
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, repo, router });
    await queue.enqueue(env());
    await queue.drain();
    expect((await repo.findById('id-1'))?.status).toBe('completed');
  });

  it('marks task failed when the handler throws', async () => {
    const queue = new InMemoryQueueAdapter();
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { throw new Error('boom'); });
    startWorker({ queue, repo, router });
    await queue.enqueue(env());
    await expect(queue.drain()).rejects.toThrow('boom');
    expect((await repo.findById('id-1'))?.status).toBe('failed');
  });
});
