import type { BacktestRun } from '../domain/backtest-run.ts';
import type { BacktestCompletionCallback } from '../domain/backtest-callback.schema.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import { createAndEnqueueTask } from '../orchestrator/task-intake.ts';

export interface BacktestCallbackDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
  findRunByPlatformRunId(platformRunId: string): Promise<BacktestRun | null>;
}

export interface BacktestCallbackResult {
  status: 'accepted';
  action: 'enqueued' | 'deduped' | 'ignored';
  taskId?: string;
  reason?: string;
}

export async function handleBacktestCompletionCallback(
  event: BacktestCompletionCallback,
  deps: BacktestCallbackDeps,
): Promise<BacktestCallbackResult> {
  const run = await deps.findRunByPlatformRunId(event.runId);
  if (!run) {
    return { status: 'accepted', action: 'ignored', reason: 'run_not_found' };
  }
  if (run.status !== 'submitted') {
    return { status: 'accepted', action: 'ignored', reason: 'not_resumable' };
  }

  const result = await createAndEnqueueTask(
    {
      taskType: 'backtest.resume',
      source: 'platform',
      payload: { platformRunId: event.runId, backtestRunId: run.id },
      correlationId: event.correlationId ?? run.correlationId,
      dedupeKey: `backtest.resume:${event.runId}`,
    },
    deps,
  );

  return {
    status: 'accepted',
    action: result.deduped ? 'deduped' : 'enqueued',
    taskId: result.taskId,
  };
}
