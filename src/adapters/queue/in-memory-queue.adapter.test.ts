import { describe, it, expect } from 'vitest';
import { InMemoryQueueAdapter } from './in-memory-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

describe('InMemoryQueueAdapter', () => {
  it('delivers enqueued envelopes to the handler on drain', async () => {
    const q = new InMemoryQueueAdapter();
    const seen: string[] = [];
    q.process(async (e) => { seen.push(e.taskId); });
    await q.enqueue(env({ taskId: 'a' }));
    await q.enqueue(env({ taskId: 'b' }));
    await q.drain();
    expect(seen).toEqual(['a', 'b']);
  });

  it('drops duplicate dedupeKey envelopes', async () => {
    const q = new InMemoryQueueAdapter();
    const seen: string[] = [];
    q.process(async (e) => { seen.push(e.taskId); });
    await q.enqueue(env({ taskId: 'a', dedupeKey: 'k' }));
    await q.enqueue(env({ taskId: 'b', dedupeKey: 'k' }));
    await q.drain();
    expect(seen).toEqual(['a']);
  });
});
