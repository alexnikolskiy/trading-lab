import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createIngressApp } from '../../src/ingress/app.ts';
import { startWorker } from '../../src/worker/worker.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { researchRunCycleHandler } from '../../src/orchestrator/handlers/research-run-cycle.handler.ts';
import { makeServices } from '../support/make-services.ts';
import type { StrategyProfile } from '../../src/domain/strategy-profile.ts';
import { FixtureBotResultsAdapter } from '../../src/adapters/platform/fixture-bot-results.adapter.ts';
import type { ResearcherInput, ResearcherPort } from '../../src/ports/researcher.port.ts';

const BOT_RESULTS_DIR = fileURLToPath(new URL('../../docs/fixtures/bot-results/vps-from-2026-06-01/', import.meta.url));

function profile(): StrategyProfile {
  return {
    id: 'p-e2e', version: 1, sourceKind: 'manual_description', sourceFingerprint: 'sha256:e2e',
    direction: 'long', coreIdea: 'Long OI divergence', requiredMarketFeatures: ['oi'],
    confidence: 0.5, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never,
    contractVersion: 'strategy-profile-v1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('E2E: research.run_cycle ingress -> worker -> persisted hypotheses', () => {
  it('drives a run-cycle task from POST to persisted hypotheses', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();
    await services.strategyProfiles.create(profile());

    const router = new WorkflowRouter();
    router.register('research.run_cycle', researchRunCycleHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({
        taskType: 'research.run_cycle',
        source: 'operator',
        payload: { strategyProfileId: 'p-e2e', symbol: 'ESPORTSUSDT' },
      }),
    });
    expect(res.status).toBe(202);
    const { taskId } = (await res.json()) as { taskId: string };

    await queue.drain();

    expect((await services.researchTasks.findById(taskId))?.status).toBe('completed');
    const stored = await services.hypotheses.listByStrategyProfile('p-e2e');
    expect(stored.length).toBe(2); // FakeResearcher emits two validated hypotheses
    expect(stored.every((h) => h.status === 'validated')).toBe(true);

    const events = (await services.events.listByTask(taskId)).map((e) => e.type);
    expect(events[0]).toBe('research.run_cycle.started');
    expect(events.at(-1)).toBe('research.run_cycle.completed');
  });

  it('passes real VPS bot-results fixtures through the workflow into the researcher input', async () => {
    const queue = new InMemoryQueueAdapter();
    let captured: ResearcherInput | undefined;
    const researcher: ResearcherPort = {
      adapter: 'fake',
      model: 'capture',
      async propose(input) {
        captured = input;
        return {
          researchSummary: `captured ${input.botResults?.length ?? 0} bot results`,
          hypotheses: [{
            thesis: 'Use OI confirmation to skip weak bounce entries seen in paper losses.',
            targetBehavior: 'Reduce hard-stop losers from weak reversals.',
            ruleAction: {
              appliesTo: 'long',
              rules: [{ when: 'oi recovery fails after bounce', action: 'skip_entry', params: {}, rationale: 'Observed losing paper trades without OI confirmation.' }],
            },
            requiredFeatures: ['oi', 'ohlcv'],
            validationPlan: 'Replay the June fixture window and compare pnl, win_rate and hard_stop counts.',
            expectedEffect: { metric: 'pnlUsd', direction: 'increase' },
            invalidationCriteria: ['Reject if pnlUsd does not improve or hard_stop exits stay flat.'],
            confidence: 0.6,
          }],
        };
      },
    };
    const services = makeServices({
      botResults: new FixtureBotResultsAdapter(BOT_RESULTS_DIR),
      researcher,
    });
    await services.strategyProfiles.create(profile());

    const router = new WorkflowRouter();
    router.register('research.run_cycle', researchRunCycleHandler);
    startWorker({ queue, router, services });

    const app = createIngressApp({ repo: services.researchTasks, queue, taskToken: 'e2e-task-token' });
    const res = await app.request('/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-task-token' },
      body: JSON.stringify({
        taskType: 'research.run_cycle',
        source: 'operator',
        payload: { strategyProfileId: 'p-e2e', symbol: 'ESPORTSUSDT' },
      }),
    });
    expect(res.status).toBe(202);

    await queue.drain();

    expect(captured?.botResults?.length).toBeGreaterThan(0);
    expect(captured?.botResults?.some((d) => d.trades.length > 0)).toBe(true);
    expect(captured?.botResults?.some((d) => Number(d.summary.pnlUsd) !== 0)).toBe(true);
  });
});
