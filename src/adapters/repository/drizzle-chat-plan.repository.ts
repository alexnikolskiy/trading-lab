import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { chatPlan } from '../../db/schema.ts';
import type { AgentTaskType } from '../../domain/types.ts';
import type { ChatPlan, ChatPlanRepository, ChatPlanStatus } from '../../ports/chat-plan.repository.ts';

type Row = typeof chatPlan.$inferSelect;

function toDomain(row: Row): ChatPlan {
  return {
    id: row.id,
    sessionId: row.sessionId,
    afterTaskId: row.afterTaskId,
    nextTaskType: row.nextTaskType as AgentTaskType,
    resolveProfileByFingerprint: row.resolveProfileByFingerprint,
    correlationId: row.correlationId,
    status: row.status as ChatPlanStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleChatPlanRepository implements ChatPlanRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async create(plan: ChatPlan): Promise<void> {
    await this.db.insert(chatPlan).values({
      id: plan.id, sessionId: plan.sessionId, afterTaskId: plan.afterTaskId,
      nextTaskType: plan.nextTaskType, resolveProfileByFingerprint: plan.resolveProfileByFingerprint,
      correlationId: plan.correlationId, status: plan.status,
      createdAt: new Date(plan.createdAt), updatedAt: new Date(plan.updatedAt),
    });
  }

  async findById(id: string): Promise<ChatPlan | null> {
    const rows = await this.db.select().from(chatPlan).where(eq(chatPlan.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findPendingByAfterTaskId(afterTaskId: string): Promise<ChatPlan | null> {
    const rows = await this.db.select().from(chatPlan)
      .where(and(eq(chatPlan.afterTaskId, afterTaskId), eq(chatPlan.status, 'pending')))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async markAdvanced(id: string): Promise<void> {
    await this.db.update(chatPlan).set({ status: 'advanced', updatedAt: new Date() }).where(eq(chatPlan.id, id));
  }

  async markFailed(id: string): Promise<void> {
    await this.db.update(chatPlan).set({ status: 'failed', updatedAt: new Date() }).where(eq(chatPlan.id, id));
  }
}
