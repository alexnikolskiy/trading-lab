import { describe, it, expect } from 'vitest';
import { BullMqQueueAdapter } from './bullmq-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const redisUrl = process.env.REDIS_URL;
const d = redisUrl ? describe : describe.skip;

const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

d('BullMqQueueAdapter (integration)', () => {
  it('delivers an enqueued envelope to the worker', async () => {
    const a = new BullMqQueueAdapter(redisUrl!, `test-${Date.now()}`);
    const received = new Promise<QueueEnvelope>((resolve) => {
      a.process(async (e) => { resolve(e); });
    });
    await a.enqueue(env({ taskId: 'x', dedupeKey: 'dk-1' }));
    const got = await received;
    expect(got.taskId).toBe('x');
    await a.close();
  });
});
