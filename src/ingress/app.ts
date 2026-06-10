import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { IngressTaskRequestSchema } from '../domain/schemas.ts';
import { validateWithSchema } from '../validation/validator.ts';
import type { QueueEnvelope, ResearchTask } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';

export interface IngressDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
}

export function createIngressApp(deps: IngressDeps): Hono {
  const app = new Hono();

  app.post('/tasks', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(IngressTaskRequestSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const req = validation.data;

    if (req.dedupeKey) {
      const existing = await deps.repo.findByDedupeKey(req.dedupeKey);
      if (existing) return c.json({ taskId: existing.id, status: existing.status }, 202);
    }

    const now = new Date().toISOString();
    const task: ResearchTask = {
      id: randomUUID(),
      taskType: req.taskType,
      source: req.source,
      correlationId: req.correlationId ?? randomUUID(),
      dedupeKey: req.dedupeKey,
      status: 'queued',
      payload: req.payload,
      createdAt: now,
      updatedAt: now,
    };
    await deps.repo.create(task);

    const envelope: QueueEnvelope = {
      taskId: task.id,
      taskType: task.taskType,
      correlationId: task.correlationId,
      source: task.source,
      attempt: 1,
      dedupeKey: task.dedupeKey,
    };
    await deps.queue.enqueue(envelope);

    return c.json({ taskId: task.id, status: task.status }, 202);
  });

  // SP-1 stub: resume callback endpoint. Real suspend/resume wiring lands in SP-4/SP-5.
  app.post('/callbacks/backtest-completed', (c) => c.json({ status: 'accepted' }, 202));

  return app;
}
