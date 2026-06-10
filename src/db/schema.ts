import { pgTable, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const researchTask = pgTable('research_task', {
  id: text('id').primaryKey(),
  taskType: text('task_type').notNull(),
  source: text('source').notNull(),
  correlationId: text('correlation_id').notNull(),
  dedupeKey: text('dedupe_key'),
  status: text('status').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // UNIQUE index: DB-level dedupe guard against races. Postgres treats multiple
  // NULLs as distinct, so tasks without a dedupeKey never collide.
  dedupeIdx: uniqueIndex('research_task_dedupe_key_uq').on(t.dedupeKey),
  corrIdx: index('research_task_correlation_idx').on(t.correlationId),
}));

export const agentEvent = pgTable('agent_event', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  taskIdx: index('agent_event_task_idx').on(t.taskId),
}));
