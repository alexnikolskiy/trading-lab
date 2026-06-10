import { loadEnv } from './config/env.ts';
import { BullMqQueueAdapter } from './adapters/queue/bullmq-queue.adapter.ts';
import { DrizzleResearchTaskRepository } from './adapters/repository/drizzle-research-task.repository.ts';
import { LocalFileArtifactStore } from './adapters/artifact/local-file-artifact-store.adapter.ts';
import { MockPlatformGatewayAdapter } from './adapters/platform/mock-platform-gateway.adapter.ts';
import { createDbClient } from './db/client.ts';
import { WorkflowRouter } from './orchestrator/workflow-router.ts';
import { echoHandler } from './orchestrator/handlers/echo.handler.ts';

export function composeRuntime() {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.REDIS_URL) throw new Error('REDIS_URL is required');

  const { db, pool } = createDbClient(env.DATABASE_URL);
  const repo = new DrizzleResearchTaskRepository(db);
  const queue = new BullMqQueueAdapter(env.REDIS_URL);
  const artifacts = new LocalFileArtifactStore(env.ARTIFACT_DIR);
  const platform = new MockPlatformGatewayAdapter();

  const router = new WorkflowRouter();
  router.register('strategy.onboard', echoHandler); // SP-1 stub; real workflows registered in SP-2+

  return { env, db, pool, repo, queue, artifacts, platform, router };
}
