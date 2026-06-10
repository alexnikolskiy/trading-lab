# trading-lab SP-1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic foundation of `trading-lab` — domain types, ports/adapters (queue, repository, platform gateway, artifact store), Ingress API, Workflow Router, and a deterministic Validator — wired into one working end-to-end vertical slice with full test coverage.

**Architecture:** Hexagonal (ports & adapters). The Orchestrator is plain deterministic TypeScript: an HTTP Ingress (Hono) accepts a task, persists it (canonical, Postgres via Drizzle), and enqueues a small envelope (BullMQ); a worker consumes the envelope and dispatches via a Workflow Router to a handler. Every external dependency sits behind a port with an in-memory adapter for fast unit tests and a real adapter for production.

**Tech Stack:** TypeScript (ESM, NodeNext), Node.js 22, pnpm, Hono, BullMQ (Redis), Drizzle ORM + drizzle-kit (Postgres/pgvector), Zod, Vitest.

---

## Scope & Deviations

**In scope (SP-1):** project skeleton; domain types + Zod schemas; `TaskQueuePort` (InMemory + BullMQ); `ResearchTaskRepository` (InMemory + Drizzle); `ArtifactStorePort` (LocalFileArtifactStore); `PlatformGatewayPort` (Mock + Fixture); deterministic `Validator`; `CriticPort` interface + `NoopCritic` (no LLM); `WorkflowRouter` + stub `echo` handler; Ingress API (Hono); worker; one end-to-end wiring test; docker-compose for Postgres+Redis.

**Out of scope (later phases):** real LLM agents (SP-2+), real Mastra workflows (SP-2+), real platform MCP adapter (SP-5), full StrategyProfile/HypothesisProposal schemas (SP-2/SP-3), pgvector retrieval (SP-3), S3ArtifactStore (SP-5).

**Deviation from design §18:** "Mastra setup" is **deferred from SP-1 to SP-2**. SP-1 has no LLM agents and no real workflows, so Mastra would be an unused dependency. The Orchestrator (Workflow Router + handlers) is plain TS per design §6. Mastra arrives with the Strategy Analyst agent in SP-2.

---

## File Structure

```
trading-lab/
  package.json              pnpm scripts + deps
  tsconfig.json             ESM / NodeNext strict
  vitest.config.ts          test runner
  drizzle.config.ts         drizzle-kit config
  docker-compose.yml        postgres(pgvector) + redis for local/integration
  .env.example              documented env vars
  src/
    config/env.ts           typed env loader
    domain/
      types.ts              AgentTaskType, TaskSource, TaskStatus, QueueEnvelope, ResearchTask, ArtifactRef, BacktestRunRef
      schemas.ts            Zod schemas + ValidationResult/ValidationIssue types
    ports/
      task-queue.port.ts
      research-task.repository.ts
      artifact-store.port.ts
      platform-gateway.port.ts
      critic.port.ts
    adapters/
      queue/in-memory-queue.adapter.ts
      queue/bullmq-queue.adapter.ts
      repository/in-memory-research-task.repository.ts
      repository/drizzle-research-task.repository.ts
      artifact/local-file-artifact-store.adapter.ts
      platform/mock-platform-gateway.adapter.ts
      platform/fixture-platform-gateway.adapter.ts
    db/
      schema.ts             Drizzle tables: research_task, agent_event
      client.ts             pg Pool + drizzle()
    validation/validator.ts deterministic Validator (schema gate + domain skeleton)
    orchestrator/
      workflow-router.ts
      handlers/echo.handler.ts
    ingress/app.ts          Hono app (POST /tasks, POST /callbacks/backtest-completed)
    worker/worker.ts        queue consumer → router
    composition.ts          wires concrete adapters for runtime
  test/
    fixtures/platform/*.json
    e2e/ingress-to-worker.test.ts
```

Unit tests live next to their source as `*.test.ts`. Integration tests that need real infra are gated on env vars (`DATABASE_URL`, `REDIS_URL`) and skip when unset.

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config/env.ts`, `test/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "trading-lab",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "ingress": "node --experimental-strip-types src/ingress/server.ts",
    "worker": "node --experimental-strip-types src/worker/worker.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "bullmq": "^5.21.0",
    "ioredis": "^5.4.1",
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "test/**/*", "*.config.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Update `.gitignore` (do NOT overwrite — preserve the existing `assets/` rule)**

The repo already has a `.gitignore` containing `assets/`. Append the new entries so the final file contains exactly these lines (keep `assets/`):

```
assets/
node_modules
dist
.env
*.local
.artifacts
.artifacts-test
```

- [ ] **Step 4b: Create `docker-compose.yml` (needed early — Redis/Postgres integration tests in Tasks 4 & 6 use it)**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: lab
      POSTGRES_PASSWORD: lab
      POSTGRES_DB: trading_lab
    ports: ["5432:5432"]
    volumes: ["lab_pg:/var/lib/postgresql/data"]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  lab_pg:
```

- [ ] **Step 4c: Create `.env.example`**

```
DATABASE_URL=postgres://lab:lab@localhost:5432/trading_lab
REDIS_URL=redis://localhost:6379
ARTIFACT_DIR=.artifacts
ENABLE_CRITIC_AGENT=false
INGRESS_PORT=3000
```

- [ ] **Step 5: Create `src/config/env.ts`**

```ts
export interface Env {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  ARTIFACT_DIR: string;
  ENABLE_CRITIC_AGENT: boolean;
  INGRESS_PORT: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    DATABASE_URL: source.DATABASE_URL,
    REDIS_URL: source.REDIS_URL,
    ARTIFACT_DIR: source.ARTIFACT_DIR ?? '.artifacts',
    ENABLE_CRITIC_AGENT: source.ENABLE_CRITIC_AGENT === 'true',
    INGRESS_PORT: Number(source.INGRESS_PORT ?? 3000),
  };
}
```

- [ ] **Step 6: Create `test/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

describe('env', () => {
  it('defaults ENABLE_CRITIC_AGENT to false', () => {
    expect(loadEnv({}).ENABLE_CRITIC_AGENT).toBe(false);
  });
  it('parses ENABLE_CRITIC_AGENT=true', () => {
    expect(loadEnv({ ENABLE_CRITIC_AGENT: 'true' }).ENABLE_CRITIC_AGENT).toBe(true);
  });
});
```

- [ ] **Step 7: Install and run**

Run: `pnpm install && pnpm test`
Expected: 2 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore docker-compose.yml .env.example src/config/env.ts test/smoke.test.ts
git commit -m "chore: scaffold trading-lab TS project (pnpm, vitest, env, docker-compose)"
```

---

### Task 2: Domain types & Zod schemas

**Files:**
- Create: `src/domain/types.ts`, `src/domain/schemas.ts`, `src/domain/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

`src/domain/schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { IngressTaskRequestSchema, QueueEnvelopeSchema } from './schemas.ts';

describe('IngressTaskRequestSchema', () => {
  it('accepts a valid request', () => {
    const r = IngressTaskRequestSchema.safeParse({
      taskType: 'strategy.onboard', source: 'web', payload: { foo: 1 },
    });
    expect(r.success).toBe(true);
  });
  it('rejects an unknown taskType', () => {
    const r = IngressTaskRequestSchema.safeParse({ taskType: 'nope', source: 'web', payload: {} });
    expect(r.success).toBe(false);
  });
  it('rejects an unknown source', () => {
    const r = IngressTaskRequestSchema.safeParse({ taskType: 'strategy.onboard', source: 'sms', payload: {} });
    expect(r.success).toBe(false);
  });
});

describe('QueueEnvelopeSchema', () => {
  it('round-trips a valid envelope', () => {
    const env = { taskId: 't1', taskType: 'backtest.submit', correlationId: 'c1', source: 'platform', attempt: 1 };
    expect(QueueEnvelopeSchema.parse(env)).toEqual(env);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/schemas.test.ts`
Expected: FAIL — cannot find module `./schemas.ts`.

- [ ] **Step 3: Create `src/domain/types.ts`**

```ts
export type AgentTaskType =
  | 'strategy.onboard'
  | 'strategy.analyze_source'
  | 'research.generate_hypotheses'
  | 'research.run_cycle'
  | 'hypothesis.build'
  | 'backtest.submit'
  | 'backtest.completed'
  | 'sweep.run'
  | 'paper.start'
  | 'paper.monitor'
  | 'performance.review'
  | 'research.pause'
  | 'research.wake_check';

export type TaskSource = 'telegram' | 'web' | 'crawler' | 'cron' | 'platform' | 'operator';

export type TaskStatus = 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'rejected';

export interface QueueEnvelope {
  taskId: string;
  taskType: AgentTaskType;
  correlationId: string;
  source: TaskSource;
  attempt: number;
  dedupeKey?: string;
}

export interface ResearchTask {
  id: string;
  taskType: AgentTaskType;
  source: TaskSource;
  correlationId: string;
  dedupeKey?: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRef {
  artifact_id: string;
  uri: string;
  content_hash: string; // sha256:<hex>
  kind: string;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  producer: string;
  metadata: Record<string, unknown>;
}

export interface BacktestRunRef {
  platformRunId: string;
  correlationId: string;
  submittedAt: string;
}
```

- [ ] **Step 4: Create `src/domain/schemas.ts`**

```ts
import { z } from 'zod';

export const AGENT_TASK_TYPES = [
  'strategy.onboard', 'strategy.analyze_source', 'research.generate_hypotheses',
  'research.run_cycle', 'hypothesis.build', 'backtest.submit', 'backtest.completed',
  'sweep.run', 'paper.start', 'paper.monitor', 'performance.review',
  'research.pause', 'research.wake_check',
] as const;

export const TASK_SOURCES = ['telegram', 'web', 'crawler', 'cron', 'platform', 'operator'] as const;

export const AgentTaskTypeSchema = z.enum(AGENT_TASK_TYPES);
export const TaskSourceSchema = z.enum(TASK_SOURCES);

export const IngressTaskRequestSchema = z.object({
  taskType: AgentTaskTypeSchema,
  source: TaskSourceSchema,
  correlationId: z.string().min(1).optional(),
  dedupeKey: z.string().min(1).optional(),
  payload: z.record(z.unknown()).default({}),
});
export type IngressTaskRequest = z.infer<typeof IngressTaskRequestSchema>;

export const QueueEnvelopeSchema = z.object({
  taskId: z.string().min(1),
  taskType: AgentTaskTypeSchema,
  correlationId: z.string().min(1),
  source: TaskSourceSchema,
  attempt: z.number().int().positive(),
  dedupeKey: z.string().min(1).optional(),
});

export type ValidationSeverity = 'error' | 'warning';
export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  path: string;
  message: string;
}
export interface ValidationResult {
  status: 'valid' | 'invalid';
  issues: ValidationIssue[];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/domain/schemas.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/domain/schemas.ts src/domain/schemas.test.ts
git commit -m "feat: add trading-lab domain types and Zod schemas"
```

---

### Task 3: TaskQueuePort + InMemoryQueueAdapter

**Files:**
- Create: `src/ports/task-queue.port.ts`, `src/adapters/queue/in-memory-queue.adapter.ts`, `src/adapters/queue/in-memory-queue.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/queue/in-memory-queue.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryQueueAdapter } from './in-memory-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

describe('InMemoryQueueAdapter', () => {
  it('delivers enqueued envelopes to the handler on drain', async () => {
    const q = new InMemoryQueueAdapter();
    const seen: string[] = [];
    q.process(async (e) => { seen.push(e.taskId); });
    await q.enqueue(env({ taskId: 'a' }));
    await q.enqueue(env({ taskId: 'b' }));
    await q.drain();
    expect(seen).toEqual(['a', 'b']);
  });

  it('drops duplicate dedupeKey envelopes', async () => {
    const q = new InMemoryQueueAdapter();
    const seen: string[] = [];
    q.process(async (e) => { seen.push(e.taskId); });
    await q.enqueue(env({ taskId: 'a', dedupeKey: 'k' }));
    await q.enqueue(env({ taskId: 'b', dedupeKey: 'k' }));
    await q.drain();
    expect(seen).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/queue/in-memory-queue.adapter.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/ports/task-queue.port.ts`**

```ts
import type { QueueEnvelope } from '../domain/types.ts';

export type QueueHandler = (envelope: QueueEnvelope) => Promise<void>;

export interface TaskQueuePort {
  enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void>;
  process(handler: QueueHandler): void;
  close(): Promise<void>;
}
```

- [ ] **Step 4: Create `src/adapters/queue/in-memory-queue.adapter.ts`**

```ts
import type { QueueEnvelope } from '../../domain/types.ts';
import type { QueueHandler, TaskQueuePort } from '../../ports/task-queue.port.ts';

export class InMemoryQueueAdapter implements TaskQueuePort {
  private handler?: QueueHandler;
  private readonly seen = new Set<string>();
  readonly queued: QueueEnvelope[] = [];

  async enqueue(envelope: QueueEnvelope): Promise<void> {
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/queue/in-memory-queue.adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/task-queue.port.ts src/adapters/queue/in-memory-queue.adapter.ts src/adapters/queue/in-memory-queue.adapter.test.ts
git commit -m "feat: add TaskQueuePort and in-memory queue adapter"
```

---

### Task 4: BullMQ queue adapter (integration, gated on REDIS_URL)

**Files:**
- Create: `src/adapters/queue/bullmq-queue.adapter.ts`, `src/adapters/queue/bullmq-queue.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/queue/bullmq-queue.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BullMqQueueAdapter } from './bullmq-queue.adapter.ts';
import type { QueueEnvelope } from '../../domain/types.ts';

const redisUrl = process.env.REDIS_URL;
const d = redisUrl ? describe : describe.skip;

const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 't1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

d('BullMqQueueAdapter (integration)', () => {
  it('delivers an enqueued envelope to the worker', async () => {
    const a = new BullMqQueueAdapter(redisUrl!, `test-${Date.now()}`);
    const received = new Promise<QueueEnvelope>((resolve) => {
      a.process(async (e) => { resolve(e); });
    });
    await a.enqueue(env({ taskId: 'x', dedupeKey: 'dk-1' }));
    const got = await received;
    expect(got.taskId).toBe('x');
    await a.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or skips without Redis)**

Run: `pnpm vitest run src/adapters/queue/bullmq-queue.adapter.test.ts`
Expected: FAIL — cannot find module (test body present; suite skips only after module resolves).

- [ ] **Step 3: Create `src/adapters/queue/bullmq-queue.adapter.ts`**

```ts
import { Queue, Worker, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { QueueEnvelope } from '../../domain/types.ts';
import type { QueueHandler, TaskQueuePort } from '../../ports/task-queue.port.ts';

export class BullMqQueueAdapter implements TaskQueuePort {
  private readonly connection: Redis;
  private readonly queue: Queue<QueueEnvelope>;
  private worker?: Worker<QueueEnvelope>;

  constructor(redisUrl: string, private readonly queueName = 'research-tasks') {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<QueueEnvelope>(this.queueName, { connection: this.connection });
  }

  async enqueue(envelope: QueueEnvelope, opts?: { delayMs?: number }): Promise<void> {
    const jobOpts: JobsOptions = {
      jobId: envelope.dedupeKey ?? envelope.taskId, // dedupe: BullMQ ignores duplicate jobId
      delay: opts?.delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    };
    await this.queue.add(envelope.taskType, envelope, jobOpts);
  }

  process(handler: QueueHandler): void {
    this.worker = new Worker<QueueEnvelope>(
      this.queueName,
      async (job) => { await handler(job.data); },
      { connection: this.connection },
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
```

- [ ] **Step 4: Run test to verify it passes (with Redis)**

Run: `REDIS_URL=redis://localhost:6379 docker compose up -d redis && REDIS_URL=redis://localhost:6379 pnpm vitest run src/adapters/queue/bullmq-queue.adapter.test.ts`
Expected: PASS (1 test). Without `REDIS_URL`: suite SKIPPED.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/queue/bullmq-queue.adapter.ts src/adapters/queue/bullmq-queue.adapter.test.ts
git commit -m "feat: add BullMQ queue adapter (jobId dedupe, retries)"
```

---

### Task 5: ResearchTaskRepository port + in-memory adapter

**Files:**
- Create: `src/ports/research-task.repository.ts`, `src/adapters/repository/in-memory-research-task.repository.ts`, `src/adapters/repository/in-memory-research-task.repository.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/repository/in-memory-research-task.repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryResearchTaskRepository } from './in-memory-research-task.repository.ts';
import type { ResearchTask } from '../../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'accepted', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});

describe('InMemoryResearchTaskRepository', () => {
  it('creates and finds by id', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a' }));
    expect((await repo.findById('a'))?.id).toBe('a');
    expect(await repo.findById('missing')).toBeNull();
  });

  it('finds by dedupeKey', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a', dedupeKey: 'k' }));
    expect((await repo.findByDedupeKey('k'))?.id).toBe('a');
    expect(await repo.findByDedupeKey('nope')).toBeNull();
  });

  it('updates status', async () => {
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task({ id: 'a' }));
    await repo.updateStatus('a', 'completed');
    expect((await repo.findById('a'))?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/in-memory-research-task.repository.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/ports/research-task.repository.ts`**

```ts
import type { ResearchTask, TaskStatus } from '../domain/types.ts';

export interface ResearchTaskRepository {
  create(task: ResearchTask): Promise<void>;
  findById(id: string): Promise<ResearchTask | null>;
  findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null>;
  updateStatus(id: string, status: TaskStatus): Promise<void>;
}
```

- [ ] **Step 4: Create `src/adapters/repository/in-memory-research-task.repository.ts`**

```ts
import type { ResearchTask, TaskStatus } from '../../domain/types.ts';
import type { ResearchTaskRepository } from '../../ports/research-task.repository.ts';

export class InMemoryResearchTaskRepository implements ResearchTaskRepository {
  private readonly byId = new Map<string, ResearchTask>();

  async create(task: ResearchTask): Promise<void> {
    this.byId.set(task.id, { ...task });
  }

  async findById(id: string): Promise<ResearchTask | null> {
    return this.byId.get(id) ?? null;
  }

  async findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null> {
    for (const t of this.byId.values()) {
      if (t.dedupeKey === dedupeKey) return t;
    }
    return null;
  }

  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`research_task not found: ${id}`);
    existing.status = status;
    existing.updatedAt = new Date().toISOString();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/repository/in-memory-research-task.repository.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/research-task.repository.ts src/adapters/repository/in-memory-research-task.repository.ts src/adapters/repository/in-memory-research-task.repository.test.ts
git commit -m "feat: add ResearchTaskRepository port and in-memory adapter"
```

---

### Task 6: Drizzle schema, client & repository (integration, gated on DATABASE_URL)

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`, `src/adapters/repository/drizzle-research-task.repository.ts`, `src/adapters/repository/drizzle-research-task.repository.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/repository/drizzle-research-task.repository.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDbClient } from '../../db/client.ts';
import { DrizzleResearchTaskRepository } from './drizzle-research-task.repository.ts';
import { researchTask } from '../../db/schema.ts';
import type { ResearchTask } from '../../domain/types.ts';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: crypto.randomUUID(), taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'accepted', payload: { a: 1 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});

d('DrizzleResearchTaskRepository (integration)', () => {
  const { db, pool } = createDbClient(url!);
  const repo = new DrizzleResearchTaskRepository(db);

  beforeAll(async () => { await db.delete(researchTask); });
  afterAll(async () => { await pool.end(); });

  it('creates, finds, and updates status', async () => {
    const t = task({ dedupeKey: 'dk-1' });
    await repo.create(t);
    expect((await repo.findById(t.id))?.payload).toEqual({ a: 1 });
    expect((await repo.findByDedupeKey('dk-1'))?.id).toBe(t.id);
    await repo.updateStatus(t.id, 'completed');
    expect((await repo.findById(t.id))?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/drizzle-research-task.repository.test.ts`
Expected: FAIL — cannot find module `../../db/client.ts`.

- [ ] **Step 3: Create `src/db/schema.ts`**

```ts
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
```

- [ ] **Step 4: Create `src/db/client.ts`**

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;

export function createDbClient(databaseUrl: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
```

- [ ] **Step 5: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
```

- [ ] **Step 6: Create `src/adapters/repository/drizzle-research-task.repository.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchTask } from '../../db/schema.ts';
import type { ResearchTask, TaskStatus } from '../../domain/types.ts';
import type { ResearchTaskRepository } from '../../ports/research-task.repository.ts';

type Row = typeof researchTask.$inferSelect;

function toDomain(row: Row): ResearchTask {
  return {
    id: row.id,
    taskType: row.taskType as ResearchTask['taskType'],
    source: row.source as ResearchTask['source'],
    correlationId: row.correlationId,
    dedupeKey: row.dedupeKey ?? undefined,
    status: row.status as TaskStatus,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleResearchTaskRepository implements ResearchTaskRepository {
  constructor(private readonly db: Db) {}

  async create(task: ResearchTask): Promise<void> {
    await this.db.insert(researchTask).values({
      id: task.id, taskType: task.taskType, source: task.source,
      correlationId: task.correlationId, dedupeKey: task.dedupeKey ?? null,
      status: task.status, payload: task.payload,
      createdAt: new Date(task.createdAt), updatedAt: new Date(task.updatedAt),
    });
  }

  async findById(id: string): Promise<ResearchTask | null> {
    const rows = await this.db.select().from(researchTask).where(eq(researchTask.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null> {
    const rows = await this.db.select().from(researchTask).where(eq(researchTask.dedupeKey, dedupeKey)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    await this.db.update(researchTask).set({ status, updatedAt: new Date() }).where(eq(researchTask.id, id));
  }
}
```

- [ ] **Step 7: Generate migration and apply, then run the test**

Run:
```bash
docker compose up -d postgres
export DATABASE_URL=postgres://lab:lab@localhost:5432/trading_lab
pnpm db:generate && pnpm db:migrate
pnpm vitest run src/adapters/repository/drizzle-research-task.repository.test.ts
```
Expected: migration files created in `migrations/`, applied; test PASS (1 test). Without `DATABASE_URL`: suite SKIPPED.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/client.ts drizzle.config.ts src/adapters/repository/drizzle-research-task.repository.ts src/adapters/repository/drizzle-research-task.repository.test.ts migrations
git commit -m "feat: add Drizzle schema, client, and Postgres research-task repository"
```

---

### Task 7: ArtifactStorePort + LocalFileArtifactStore

**Files:**
- Create: `src/ports/artifact-store.port.ts`, `src/adapters/artifact/local-file-artifact-store.adapter.ts`, `src/adapters/artifact/local-file-artifact-store.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

`src/adapters/artifact/local-file-artifact-store.adapter.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { LocalFileArtifactStore } from './local-file-artifact-store.adapter.ts';

const DIR = '.artifacts-test';

describe('LocalFileArtifactStore', () => {
  afterEach(async () => { await rm(DIR, { recursive: true, force: true }); });

  it('stores content and returns a content-addressable ref', async () => {
    const store = new LocalFileArtifactStore(DIR);
    const ref = await store.put('hello', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    expect(ref.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.size_bytes).toBe(5);
    expect(ref.uri.startsWith('file://')).toBe(true);
    expect((await readFile(new URL(ref.uri))).toString()).toBe('hello');
  });

  it('is content-addressable: identical content => identical hash', async () => {
    const store = new LocalFileArtifactStore(DIR);
    const a = await store.put('same', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    const b = await store.put('same', { kind: 'logs', mime_type: 'text/plain', producer: 'test' });
    expect(a.content_hash).toBe(b.content_hash);
    expect((await store.get(a)).toString()).toBe('same');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/artifact/local-file-artifact-store.adapter.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/ports/artifact-store.port.ts`**

```ts
import type { ArtifactRef } from '../domain/types.ts';

export interface PutArtifactMeta {
  kind: string;
  mime_type: string;
  producer: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactStorePort {
  put(content: Buffer | string, meta: PutArtifactMeta): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Buffer>;
  resolveUri(ref: ArtifactRef): string;
}
```

- [ ] **Step 4: Create `src/adapters/artifact/local-file-artifact-store.adapter.ts`**

```ts
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ArtifactStorePort, PutArtifactMeta } from '../../ports/artifact-store.port.ts';

export class LocalFileArtifactStore implements ArtifactStorePort {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  async put(content: Buffer | string, meta: PutArtifactMeta): Promise<ArtifactRef> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hex = createHash('sha256').update(buf).digest('hex');
    const contentHash = `sha256:${hex}`;
    await mkdir(this.baseDir, { recursive: true });
    const filePath = join(this.baseDir, hex);
    await writeFile(filePath, buf);
    return {
      artifact_id: contentHash,
      uri: pathToFileURL(filePath).href,
      content_hash: contentHash,
      kind: meta.kind,
      size_bytes: buf.byteLength,
      mime_type: meta.mime_type,
      created_at: new Date().toISOString(),
      producer: meta.producer,
      metadata: meta.metadata ?? {},
    };
  }

  async get(ref: ArtifactRef): Promise<Buffer> {
    return readFile(new URL(ref.uri));
  }

  resolveUri(ref: ArtifactRef): string {
    return ref.uri;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/artifact/local-file-artifact-store.adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ports/artifact-store.port.ts src/adapters/artifact/local-file-artifact-store.adapter.ts src/adapters/artifact/local-file-artifact-store.adapter.test.ts
git commit -m "feat: add ArtifactStorePort and content-addressable LocalFileArtifactStore"
```

---

### Task 8: PlatformGatewayPort + Mock & Fixture adapters

**Files:**
- Create: `src/ports/platform-gateway.port.ts`, `src/adapters/platform/mock-platform-gateway.adapter.ts`, `src/adapters/platform/fixture-platform-gateway.adapter.ts`, `test/fixtures/platform/market-context.json`, `src/adapters/platform/platform-gateway.adapter.test.ts`

- [ ] **Step 1: Create the fixture `test/fixtures/platform/market-context.json`**

```json
{ "symbol": "BTCUSDT", "ts": "2026-01-01T00:00:00Z", "features": { "oi": 123.0, "funding": 0.0001, "cvd": -42.0 } }
```

- [ ] **Step 2: Write the failing test**

`src/adapters/platform/platform-gateway.adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockPlatformGatewayAdapter } from './mock-platform-gateway.adapter.ts';
import { FixturePlatformGatewayAdapter } from './fixture-platform-gateway.adapter.ts';

describe('MockPlatformGatewayAdapter', () => {
  it('returns a plausible market context and a backtest ref', async () => {
    const gw = new MockPlatformGatewayAdapter();
    const ctx = await gw.getMarketContext('BTCUSDT', '2026-01-01T00:00:00Z');
    expect(ctx.symbol).toBe('BTCUSDT');
    const ref = await gw.submitBacktest({ correlationId: 'c1', baselineModuleId: 'b', variantModuleId: 'v', params: {} });
    expect(ref.platformRunId).toMatch(/^mock-run-/);
    expect(ref.correlationId).toBe('c1');
  });
});

describe('FixturePlatformGatewayAdapter', () => {
  it('returns the golden market context from fixtures deterministically', async () => {
    const gw = new FixturePlatformGatewayAdapter('test/fixtures/platform');
    const a = await gw.getMarketContext('BTCUSDT', '2026-01-01T00:00:00Z');
    const b = await gw.getMarketContext('BTCUSDT', '2026-01-01T00:00:00Z');
    expect(a).toEqual(b);
    expect(a.features.oi).toBe(123.0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/platform-gateway.adapter.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 4: Create `src/ports/platform-gateway.port.ts`**

```ts
import type { BacktestRunRef } from '../domain/types.ts';

export interface MarketContext {
  symbol: string;
  ts: string;
  features: Record<string, number>;
}

export type MarketRegime =
  | 'capitulation' | 'short_squeeze' | 'trending' | 'ranging'
  | 'high_volatility' | 'low_liquidity' | 'post_dump_recovery' | 'distribution' | 'unknown';

export interface BacktestRunRequest {
  correlationId: string;
  baselineModuleId: string;
  variantModuleId: string;
  params: Record<string, unknown>;
}

/** ResearchRunEnvelope — narrowed SP-1 mirror of platform contract 022. */
export interface ResearchRunEnvelope {
  platformRunId: string;
  runStatus: 'completed' | 'rejected';
  metrics: Record<string, number>;
  artifactRefs: string[];
  platformContractVersion: string;
}

export interface PlatformGatewayPort {
  getMarketContext(symbol: string, tsOrWindow: string): Promise<MarketContext>;
  getMarketRegime(symbol: string, tsOrWindow: string): Promise<MarketRegime>;
  submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef>;
  getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope>;
}
```

> Note: design §15 lists additional methods (`getBotTrades`, `getDecisionLogs`, `startPaperValidation`, `getPaperStatus`). They are intentionally **out of SP-1 scope** and added in the phases that first need them (SP-3/SP-6).

- [ ] **Step 5: Create `src/adapters/platform/mock-platform-gateway.adapter.ts`**

```ts
import type { BacktestRunRef } from '../../domain/types.ts';
import type {
  BacktestRunRequest, MarketContext, MarketRegime, PlatformGatewayPort, ResearchRunEnvelope,
} from '../../ports/platform-gateway.port.ts';

let counter = 0;

export class MockPlatformGatewayAdapter implements PlatformGatewayPort {
  async getMarketContext(symbol: string, tsOrWindow: string): Promise<MarketContext> {
    return { symbol, ts: tsOrWindow, features: { oi: 100, funding: 0.0001, cvd: 0 } };
  }

  async getMarketRegime(): Promise<MarketRegime> {
    return 'ranging';
  }

  async submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef> {
    counter += 1;
    return { platformRunId: `mock-run-${counter}`, correlationId: req.correlationId, submittedAt: new Date().toISOString() };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 0, total_trades: 0, win_rate: 0 },
      artifactRefs: [],
      platformContractVersion: 'mock-0',
    };
  }
}
```

- [ ] **Step 6: Create `src/adapters/platform/fixture-platform-gateway.adapter.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BacktestRunRef } from '../../domain/types.ts';
import type {
  BacktestRunRequest, MarketContext, MarketRegime, PlatformGatewayPort, ResearchRunEnvelope,
} from '../../ports/platform-gateway.port.ts';

export class FixturePlatformGatewayAdapter implements PlatformGatewayPort {
  private readonly dir: string;

  constructor(fixtureDir: string) {
    this.dir = resolve(fixtureDir);
  }

  private async load<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(join(this.dir, name), 'utf8')) as T;
  }

  async getMarketContext(): Promise<MarketContext> {
    return this.load<MarketContext>('market-context.json');
  }

  async getMarketRegime(): Promise<MarketRegime> {
    return 'ranging';
  }

  async submitBacktest(req: BacktestRunRequest): Promise<BacktestRunRef> {
    return { platformRunId: 'fixture-run-1', correlationId: req.correlationId, submittedAt: '2026-01-01T00:00:00Z' };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 42, total_trades: 10, win_rate: 0.6 },
      artifactRefs: [],
      platformContractVersion: 'fixture-0',
    };
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/platform-gateway.adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add src/ports/platform-gateway.port.ts src/adapters/platform/mock-platform-gateway.adapter.ts src/adapters/platform/fixture-platform-gateway.adapter.ts test/fixtures/platform/market-context.json src/adapters/platform/platform-gateway.adapter.test.ts
git commit -m "feat: add PlatformGatewayPort with mock and fixture adapters"
```

---

### Task 9: Deterministic Validator

**Files:**
- Create: `src/validation/validator.ts`, `src/validation/validator.test.ts`

- [ ] **Step 1: Write the failing test**

`src/validation/validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateWithSchema } from './validator.ts';
import { QueueEnvelopeSchema } from '../domain/schemas.ts';

describe('validateWithSchema', () => {
  it('returns valid for conforming input', () => {
    const r = validateWithSchema(QueueEnvelopeSchema, {
      taskId: 't1', taskType: 'backtest.submit', correlationId: 'c1', source: 'platform', attempt: 1,
    });
    expect(r.status).toBe('valid');
    expect(r.issues).toEqual([]);
  });

  it('returns invalid with stable issue codes for bad input', () => {
    const r = validateWithSchema(QueueEnvelopeSchema, { taskId: '', taskType: 'nope', source: 'platform', attempt: 0 });
    expect(r.status).toBe('invalid');
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.code === 'schema_violation' && i.severity === 'error')).toBe(true);
    // issues are sorted by path for determinism
    const paths = r.issues.map((i) => i.path);
    expect([...paths].sort()).toEqual(paths);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/validation/validator.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/validation/validator.ts`**

```ts
import type { ZodTypeAny } from 'zod';
import type { ValidationIssue, ValidationResult } from '../domain/schemas.ts';

/** Schema gate (gate #1 in design §12): validate unknown input against a Zod schema. */
export function validateWithSchema(schema: ZodTypeAny, input: unknown): ValidationResult {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { status: 'valid', issues: [] };

  const issues: ValidationIssue[] = parsed.error.issues
    .map((i) => ({
      code: 'schema_violation',
      severity: 'error' as const,
      path: i.path.join('.'),
      message: i.message,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));

  return { status: 'invalid', issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/validation/validator.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/validation/validator.ts src/validation/validator.test.ts
git commit -m "feat: add deterministic schema-gate Validator"
```

---

### Task 10: CriticPort interface + NoopCritic (no LLM)

**Files:**
- Create: `src/ports/critic.port.ts`, `src/ports/critic.port.test.ts`

- [ ] **Step 1: Write the failing test**

`src/ports/critic.port.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NoopCritic } from './critic.port.ts';

describe('NoopCritic', () => {
  it('passes everything through (default, critic disabled in SP-1)', async () => {
    const critic = new NoopCritic();
    const review = await critic.review({ anything: true });
    expect(review.verdict).toBe('pass');
    expect(review.issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ports/critic.port.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/ports/critic.port.ts`**

```ts
export interface CriticReview {
  verdict: 'pass' | 'concerns' | 'reject';
  issues: string[];
}

export interface CriticPort {
  review(input: unknown): Promise<CriticReview>;
}

/**
 * SP-1 default. The real LLM Critic is added in SP-3 behind ENABLE_CRITIC_AGENT.
 * The mandatory gate is always the deterministic Validator, never the Critic.
 */
export class NoopCritic implements CriticPort {
  async review(): Promise<CriticReview> {
    return { verdict: 'pass', issues: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ports/critic.port.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/ports/critic.port.ts src/ports/critic.port.test.ts
git commit -m "feat: add CriticPort interface and NoopCritic (LLM critic deferred to SP-3)"
```

---

### Task 11: WorkflowRouter + echo handler

**Files:**
- Create: `src/orchestrator/workflow-router.ts`, `src/orchestrator/handlers/echo.handler.ts`, `src/orchestrator/workflow-router.test.ts`

- [ ] **Step 1: Write the failing test**

`src/orchestrator/workflow-router.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WorkflowRouter, type HandlerDeps } from './workflow-router.ts';
import { echoHandler } from './handlers/echo.handler.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import type { ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});

describe('WorkflowRouter', () => {
  it('dispatches a task to its registered handler', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const t = task();
    const deps: HandlerDeps = { repo };
    const seen: string[] = [];
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async (task) => { seen.push(task.id); });
    await router.dispatch(t, deps);
    expect(seen).toEqual(['id-1']);
  });

  it('throws on an unregistered task type', async () => {
    const router = new WorkflowRouter();
    const repo = new InMemoryResearchTaskRepository();
    await expect(router.dispatch(task({ taskType: 'paper.monitor' }), { repo })).rejects.toThrow(/no handler/i);
  });
});

describe('echoHandler', () => {
  it('is a no-op stub: it does NOT own the status transition (the worker does)', async () => {
    const repo = new InMemoryResearchTaskRepository();
    const t = task({ status: 'running' });
    await repo.create(t);
    await echoHandler(t, { repo });
    expect((await repo.findById('id-1'))?.status).toBe('running'); // unchanged by the handler
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/orchestrator/workflow-router.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/orchestrator/workflow-router.ts`**

```ts
import type { AgentTaskType, ResearchTask } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';

export interface HandlerDeps {
  repo: ResearchTaskRepository;
}

export type WorkflowHandler = (task: ResearchTask, deps: HandlerDeps) => Promise<void>;

export class WorkflowRouter {
  private readonly handlers = new Map<AgentTaskType, WorkflowHandler>();

  register(taskType: AgentTaskType, handler: WorkflowHandler): void {
    this.handlers.set(taskType, handler);
  }

  async dispatch(task: ResearchTask, deps: HandlerDeps): Promise<void> {
    const handler = this.handlers.get(task.taskType);
    if (!handler) throw new Error(`no handler registered for task type: ${task.taskType}`);
    await handler(task, deps);
  }
}
```

- [ ] **Step 4: Create `src/orchestrator/handlers/echo.handler.ts`**

```ts
import type { WorkflowHandler } from '../workflow-router.ts';

/**
 * SP-1 no-op stub proving Ingress→queue→worker→router wiring. Replaced by real
 * workflows in SP-2+. The handler does NOT own status transitions: the worker
 * owns the generic running → completed/failed transition (see Task 13).
 */
export const echoHandler: WorkflowHandler = async () => {
  // intentionally empty: success is signalled by returning without throwing
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/orchestrator/workflow-router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/workflow-router.ts src/orchestrator/handlers/echo.handler.ts src/orchestrator/workflow-router.test.ts
git commit -m "feat: add deterministic WorkflowRouter and echo stub handler"
```

---

### Task 12: Ingress API (Hono)

**Files:**
- Create: `src/ingress/app.ts`, `src/ingress/app.test.ts`

- [ ] **Step 1: Write the failing test**

`src/ingress/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createIngressApp } from './app.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';

function setup() {
  const repo = new InMemoryResearchTaskRepository();
  const queue = new InMemoryQueueAdapter();
  const app = createIngressApp({ repo, queue });
  return { app, repo, queue };
}

describe('Ingress POST /tasks', () => {
  it('accepts a valid task, persists it, and enqueues an envelope', async () => {
    const { app, repo, queue } = setup();
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect((await repo.findById(body.taskId))?.status).toBe('queued');
    expect(queue.queued).toHaveLength(1);
    expect(queue.queued[0]!.taskId).toBe(body.taskId);
  });

  it('rejects an invalid payload with 400', async () => {
    const { app } = setup();
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'nope', source: 'web' }),
    });
    expect(res.status).toBe(400);
  });

  it('deduplicates by dedupeKey: second call returns the same taskId without re-enqueue', async () => {
    const { app, queue } = setup();
    const make = () => app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', dedupeKey: 'k1', payload: {} }),
    });
    const first = await (await make()).json();
    const second = await (await make()).json();
    expect(second.taskId).toBe(first.taskId);
    expect(queue.queued).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ingress/app.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/ingress/app.ts`**

```ts
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { IngressTaskRequestSchema } from '../domain/schemas.ts';
import { validateWithSchema } from '../validation/validator.ts';
import type { QueueEnvelope, ResearchTask } from '../domain/types.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';

export interface IngressDeps {
  repo: ResearchTaskRepository;
  queue: TaskQueuePort;
}

export function createIngressApp(deps: IngressDeps): Hono {
  const app = new Hono();

  app.post('/tasks', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const validation = validateWithSchema(IngressTaskRequestSchema, raw);
    if (validation.status === 'invalid') {
      return c.json({ status: 'rejected', issues: validation.issues }, 400);
    }
    const req = IngressTaskRequestSchema.parse(raw);

    if (req.dedupeKey) {
      const existing = await deps.repo.findByDedupeKey(req.dedupeKey);
      if (existing) return c.json({ taskId: existing.id, status: existing.status }, 202);
    }

    const now = new Date().toISOString();
    const task: ResearchTask = {
      id: randomUUID(),
      taskType: req.taskType,
      source: req.source,
      correlationId: req.correlationId ?? randomUUID(),
      dedupeKey: req.dedupeKey,
      status: 'queued',
      payload: req.payload,
      createdAt: now,
      updatedAt: now,
    };
    await deps.repo.create(task);

    const envelope: QueueEnvelope = {
      taskId: task.id,
      taskType: task.taskType,
      correlationId: task.correlationId,
      source: task.source,
      attempt: 1,
      dedupeKey: task.dedupeKey,
    };
    await deps.queue.enqueue(envelope);

    return c.json({ taskId: task.id, status: task.status }, 202);
  });

  // SP-1 stub: resume callback endpoint. Real suspend/resume wiring lands in SP-4/SP-5.
  app.post('/callbacks/backtest-completed', (c) => c.json({ status: 'accepted' }, 202));

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ingress/app.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ingress/app.ts src/ingress/app.test.ts
git commit -m "feat: add Hono Ingress API (validate, persist, enqueue, dedupe)"
```

---

### Task 13: Worker consumer

**Files:**
- Create: `src/worker/worker.ts`, `src/worker/worker.test.ts`

- [ ] **Step 1: Write the failing test**

`src/worker/worker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { startWorker } from './worker.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { WorkflowRouter } from '../orchestrator/workflow-router.ts';
import { echoHandler } from '../orchestrator/handlers/echo.handler.ts';
import type { QueueEnvelope, ResearchTask } from '../domain/types.ts';

const task = (over: Partial<ResearchTask> = {}): ResearchTask => ({
  id: 'id-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'queued', payload: {}, createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-10T00:00:00Z', ...over,
});
const env = (over: Partial<QueueEnvelope> = {}): QueueEnvelope => ({
  taskId: 'id-1', taskType: 'strategy.onboard', correlationId: 'c1', source: 'web', attempt: 1, ...over,
});

describe('startWorker', () => {
  it('marks task running then completed on success', async () => {
    const queue = new InMemoryQueueAdapter();
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, repo, router });
    await queue.enqueue(env());
    await queue.drain();
    expect((await repo.findById('id-1'))?.status).toBe('completed');
  });

  it('marks task failed when the handler throws', async () => {
    const queue = new InMemoryQueueAdapter();
    const repo = new InMemoryResearchTaskRepository();
    await repo.create(task());
    const router = new WorkflowRouter();
    router.register('strategy.onboard', async () => { throw new Error('boom'); });
    startWorker({ queue, repo, router });
    await queue.enqueue(env());
    await expect(queue.drain()).rejects.toThrow('boom');
    expect((await repo.findById('id-1'))?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/worker/worker.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Create `src/worker/worker.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/worker/worker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/worker/worker.ts src/worker/worker.test.ts
git commit -m "feat: add queue worker consumer wiring router + status transitions"
```

---

### Task 14: End-to-end wiring test

**Files:**
- Create: `test/e2e/ingress-to-worker.test.ts`

- [ ] **Step 1: Write the failing test**

`test/e2e/ingress-to-worker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { InMemoryResearchTaskRepository } from '../../src/adapters/repository/in-memory-research-task.repository.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { echoHandler } from '../../src/orchestrator/handlers/echo.handler.ts';

describe('E2E: Ingress → queue → worker → router', () => {
  it('drives a task from POST to completed', async () => {
    const queue = new InMemoryQueueAdapter();
    const repo = new InMemoryResearchTaskRepository();
    const router = new WorkflowRouter();
    router.register('strategy.onboard', echoHandler);
    startWorker({ queue, repo, router });

    const app = createIngressApp({ repo, queue });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskType: 'strategy.onboard', source: 'web', payload: { url: 'x' } }),
    });
    const { taskId } = await res.json();
    expect((await repo.findById(taskId))?.status).toBe('queued');

    await queue.drain();
    expect((await repo.findById(taskId))?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/e2e/ingress-to-worker.test.ts`
Expected: FAIL if any wiring is wrong; otherwise PASS. (All imports already exist from prior tasks — this test asserts they compose.)

- [ ] **Step 3: Make it pass**

No new production code expected. If it fails, fix the composition at the failing seam (do not weaken assertions).

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: all unit + e2e tests PASS; Redis/Postgres integration suites SKIPPED (no env vars).

- [ ] **Step 5: Commit**

```bash
git add test/e2e/ingress-to-worker.test.ts
git commit -m "test: add end-to-end ingress-to-worker wiring test"
```

---

### Task 15: Runtime composition, servers, docker-compose, README

**Files:**
- Create: `src/composition.ts`, `src/ingress/server.ts`, `README.md`

> Note: `docker-compose.yml` and `.env.example` were created in Task 1 (Steps 4b/4c).

- [ ] **Step 1: Create `src/composition.ts`**

```ts
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
```

- [ ] **Step 2: Create `src/ingress/server.ts`**

```ts
import { serve } from '@hono/node-server';
import { composeRuntime } from '../composition.ts';
import { createIngressApp } from './app.ts';

const { env, repo, queue } = composeRuntime();
const app = createIngressApp({ repo, queue });
serve({ fetch: app.fetch, port: env.INGRESS_PORT });
console.log(`ingress listening on :${env.INGRESS_PORT}`);
```

- [ ] **Step 3: Update `src/worker/worker.ts` with a runtime entrypoint**

Append to `src/worker/worker.ts`:

```ts
// Runtime entrypoint: `pnpm worker`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { composeRuntime } = await import('../composition.ts');
  const { queue, repo, router } = composeRuntime();
  startWorker({ queue, repo, router });
  console.log('worker started, consuming research-tasks');
}
```

- [ ] **Step 4: Create `README.md`**

```markdown
# trading-lab

Research-only multi-agent system over trading-platform. Research brain; no live authority.

## Dev

    pnpm install
    docker compose up -d
    cp .env.example .env
    pnpm db:generate && pnpm db:migrate
    pnpm test

## Run (SP-1 foundation slice)

    pnpm ingress   # POST /tasks
    pnpm worker    # consumes queue, dispatches via WorkflowRouter

Design: docs/superpowers/specs/2026-06-10-trading-lab-design.md
```

- [ ] **Step 5: Typecheck and run the worker entrypoint guard**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests PASS (integration suites skip without env vars).

- [ ] **Step 6: Commit**

```bash
git add src/composition.ts src/ingress/server.ts src/worker/worker.ts README.md
git commit -m "feat: add runtime composition, ingress/worker entrypoints, README"
```

---

## Self-Review

**Spec coverage (design §§ → tasks):**
- §1 boundaries / research-only → no execution adapter exists; PlatformGatewayPort exposes only research/backtest methods (Task 8). ✓
- §3 Ingress role → Task 12 (validate, normalize, persist, enqueue, dedupe; resume-callback stub). ✓
- §4–5 queue/envelope → Tasks 3–4 (`TaskQueuePort`, InMemory + BullMQ, dedupe, envelope-only). ✓
- §6 Orchestrator/router (deterministic TS) → Task 11; suspend/resume noted as SP-4/SP-5 (callback stub in Task 12). ✓ (deferred portions flagged)
- §7 agent roles → Validator (Task 9), Critic interface (Task 10); LLM agents deferred to SP-2+. ✓ (scope)
- §10 domain/min schemas → Task 2 (types subset); full StrategyProfile/HypothesisProposal deferred to SP-2/SP-3. ✓ (scope)
- §11 storage → Task 6 (Drizzle research_task/agent_event), Task 7 (`ArtifactStorePort` + LocalFile, content-addressable). ✓
- §12 gates → schema gate (Task 9); later gates deferred to phases that build them. ✓ (scope)
- §15 ports/adapters → Task 8 (Mock/Fixture); Http/Mcp deferred to SP-5. ✓
- §17 lifecycles → `TaskStatus` transitions exercised (Tasks 12–13: queued→running→completed/failed). ✓
- §18 SP-1 list → all items covered; Mastra deferred to SP-2 with rationale. ✓ (flagged deviation)

**Placeholder scan:** No "TBD/TODO/handle edge cases" in steps; every code step shows complete code. Stub handlers (`echoHandler`, callback endpoint) are intentional, named, and tested. ✓

**Type consistency:** `ResearchTask`, `QueueEnvelope`, `ArtifactRef`, `ValidationResult`, `HandlerDeps`, `WorkflowHandler`, `TaskQueuePort.enqueue/process/close`, `ResearchTaskRepository.{create,findById,findByDedupeKey,updateStatus}`, `ArtifactStorePort.{put,get,resolveUri}`, `PlatformGatewayPort.{getMarketContext,getMarketRegime,submitBacktest,getBacktestResult}` are used identically across tasks. `InMemoryQueueAdapter.drain()` is test-only and used consistently in Tasks 13–14. ✓

---

*End of SP-1 Foundation plan. Subsequent phases (SP-2 Strategy Onboarding incl. Mastra setup, SP-3 Research Cycle, SP-4 Build & Backtest, SP-5 Platform Integration, SP-6 Paper & Performance) each get their own plan.*
