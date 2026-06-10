import type { QueueEnvelope } from '../../domain/types.ts';
import type { QueueHandler, TaskQueuePort } from '../../ports/task-queue.port.ts';

export class InMemoryQueueAdapter implements TaskQueuePort {
  private handler?: QueueHandler;
  private readonly seen = new Set<string>();
  readonly queued: QueueEnvelope[] = [];

  // Dedupe semantics: only envelopes carrying a dedupeKey are deduplicated.
  // Envelopes without a dedupeKey are always delivered. This mirrors the BullMQ
  // adapter, whose jobId defaults to `dedupeKey ?? taskId` — do not assume two
  // keyless envelopes with the same taskId are deduplicated here.
  // `delayMs` is intentionally ignored: this in-memory adapter exists for
  // deterministic tests and has no scheduling. The param is kept to match the port.
  async enqueue(envelope: QueueEnvelope, _opts?: { delayMs?: number }): Promise<void> {
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
