import { randomUUID } from 'node:crypto';
import type { ResearchTask } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { ChatSessionRepository } from '../ports/chat-session.repository.ts';
import type { ChatPlanRepository } from '../ports/chat-plan.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { createAndEnqueueTask } from './task-intake.ts';

export interface ChainRunnerDeps {
  researchTasks: ResearchTaskRepository;
  strategyProfiles: Pick<StrategyProfileRepository, 'findByFingerprint'>;
  events: AgentEventRepository;
  sessions: ChatSessionRepository;
  plans: ChatPlanRepository;
  queue: TaskQueuePort;
}

/**
 * Worker completion hook. Called ONLY after a task transitions to `completed`.
 * Advances the single MVP continuation (strategy.onboard -> research.run_cycle).
 * Best-effort: a failure here never fails the worker or masks the task outcome.
 */
export async function advanceChatPlan(completedTask: ResearchTask, deps: ChainRunnerDeps): Promise<void> {
  const plan = await deps.plans.findPendingByAfterTaskId(completedTask.id);
  if (!plan) return;

  const now = (): string => new Date().toISOString();
  const ev = (type: string, payload: Record<string, unknown>): Promise<void> =>
    deps.events.append({ id: randomUUID(), taskId: plan.afterTaskId, type, payload, createdAt: now() });

  try {
    const profile = await deps.strategyProfiles.findByFingerprint(plan.resolveProfileByFingerprint);
    if (!profile) {
      await deps.plans.markFailed(plan.id);
      await ev('chat.plan.advance_failed', { planId: plan.id, afterTaskId: plan.afterTaskId, reason: 'profile_not_found' });
      return;
    }

    // Deterministic dedupeKey: a worker retry returns the existing task instead of re-enqueuing.
    const dedupeKey = `chat_plan:${plan.id}:research.run_cycle`;
    const intake = await createAndEnqueueTask(
      {
        taskType: plan.nextTaskType,
        source: completedTask.source,
        payload: { strategyProfileId: profile.id },
        correlationId: plan.correlationId,
        dedupeKey,
      },
      { repo: deps.researchTasks, queue: deps.queue },
    );

    await deps.plans.markAdvanced(plan.id);

    const session = await deps.sessions.get(plan.sessionId);
    if (session) {
      await deps.sessions.upsert({
        ...session,
        lastStrategyProfileId: profile.id,
        lastResearchTaskId: intake.taskId,
        pendingPlanId: undefined,
        updatedAt: now(),
      });
    }

    await ev('chat.plan.advanced', { planId: plan.id, afterTaskId: plan.afterTaskId, nextTaskId: intake.taskId, deduped: intake.deduped });
  } catch (err) {
    await deps.plans.markFailed(plan.id).catch(() => { /* swallow */ });
    await ev('chat.plan.advance_failed', { planId: plan.id, afterTaskId: plan.afterTaskId, reason: err instanceof Error ? err.message : String(err) }).catch(() => { /* swallow */ });
  }
}
