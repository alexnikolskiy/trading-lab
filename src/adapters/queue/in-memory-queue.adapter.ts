import type { QueueEnvelope } from '../../domain/types.ts';
import type { QueueHandler, TaskQueuePort } from '../../ports/task-queue.port.ts';

export class InMemoryQueueAdapter implements TaskQueuePort {
  private handler?: QueueHandler;
  private readonly seen = new Set<string>();
  readonly queued: QueueEnvelope[] = [];

  async enqueue(envelope: QueueEnvelope): Promise<void> {
    if (envelope.dedupeKey) {
      if (this.seen.has(envelope.dedupeKey)) return;
      this.seen.add(envelope.dedupeKey);
    }
    this.queued.push(envelope);
  }

  process(handler: QueueHandler): void {
    this.handler = handler;
  }

  async drain(): Promise<void> {
    if (!this.handler) throw new Error('no handler registered');
    while (this.queued.length > 0) {
      const next = this.queued.shift()!;
      await this.handler(next);
    }
  }

  async close(): Promise<void> {}
}
