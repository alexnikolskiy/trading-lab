import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { echoHandler } from '../../src/orchestrator/handlers/echo.handler.ts';

describe('E2E: Ingress → queue → worker → router', () => {
  it('drives a task from POST to completed', async () => {
    const queue = new InMemoryQueueAdapter();
    const repo = new InMemoryResearchTaskRepository();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, repo, router });

    const app = createIngressApp({ repo, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
    const { taskId } = (await res.json()) as { taskId: string };
    expect((await repo.findById(taskId))?.status).toBe('queued');

    await queue.drain();
    expect((await repo.findById(taskId))?.status).toBe('completed');
    expect(queue.queued).toHaveLength(0); // nothing left behind or re-enqueued
  });
});
