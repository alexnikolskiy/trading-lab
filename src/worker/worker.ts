import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { WorkflowRouter } from '../orchestrator/workflow-router.ts';

export interface WorkerDeps {
  queue: TaskQueuePort;
  repo: ResearchTaskRepository;
  router: WorkflowRouter;
}

export function startWorker(deps: WorkerDeps): void {
  deps.queue.process(async (envelope) => {
    const task = await deps.repo.findById(envelope.taskId);
    if (!task) throw new Error(`research_task not found for envelope: ${envelope.taskId}`);
    // The worker owns the generic lifecycle transition. Handlers do their work
    // and signal success by returning (failure by throwing); they do not set
    // completed/failed themselves.
    await deps.repo.updateStatus(task.id, 'running');
    try {
      await deps.router.dispatch({ ...task, status: 'running' }, { repo: deps.repo });
      await deps.repo.updateStatus(task.id, 'completed');
    } catch (err) {
      await deps.repo.updateStatus(task.id, 'failed');
      throw err; // let the queue adapter apply its retry/backoff policy
    }
  });
}
