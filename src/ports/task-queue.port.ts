import type { QueueEnvelope } from '../domain/types.ts';

export type QueueHandler = (envelope: QueueEnvelope) => Promise<void>;

export interface TaskQueuePort {
  enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void>;
  process(handler: QueueHandler): void;
  close(): Promise<void>;
}
