import { loadEnv } from './config/env.ts';
import { BullMqQueueAdapter } from './adapters/queue/bullmq-queue.adapter.ts';
import { DrizzleResearchTaskRepository } from './adapters/repository/drizzle-research-task.repository.ts';
import { LocalFileArtifactStore } from './adapters/artifact/local-file-artifact-store.adapter.ts';
import { createDbClient } from './db/client.ts';
import { WorkflowRouter } from './orchestrator/workflow-router.ts';
import { echoHandler } from './orchestrator/handlers/echo.handler.ts';
import { FakeStrategyAnalyst } from './adapters/analyst/fake-strategy-analyst.ts';
import { InMemoryStrategyProfileRepository } from './adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryAgentEventRepository } from './adapters/repository/in-memory-agent-event.repository.ts';
import type { AppServices } from './orchestrator/app-services.ts';

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);

  const services: AppServices = {
    researchTasks: new DrizzleResearchTaskRepository(db),
    strategyProfiles: new InMemoryStrategyProfileRepository(), // replaced with Drizzle in Task 14
    analyst: new FakeStrategyAnalyst(),                        // adapter selection added in Task 14
    artifacts: new LocalFileArtifactStore(env.ARTIFACT_DIR),
    events: new InMemoryAgentEventRepository(),                // replaced with Drizzle in Task 14
  };

  const router = new WorkflowRouter();
  router.register('strategy.onboard', echoHandler); // replaced with strategyOnboardHandler in Task 14

  return { env, db, pool, queue, router, services };
}
