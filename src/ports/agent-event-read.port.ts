import type { Cursor } from './keyset.ts';

export interface AgentEventRow {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>; // raw — consumed only by the sanitizing mapper, never serialized
  createdAt: string;
  correlationId?: string;
}

export interface AgentEventListQuery {
  taskId?: string;
  type?: string;
  since?: string; // ISO-8601
  correlationId?: string;
  limit: number;
  after?: Cursor;
}

export interface AgentEventReadPort {
  list(q: AgentEventListQuery): Promise<AgentEventRow[]>;
}
