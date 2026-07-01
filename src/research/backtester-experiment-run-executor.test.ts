import { describe, it, expect } from 'vitest';
import type { ModuleBundle } from '../domain/module-bundle.ts';
import type { ResearchPlatformPort, SubmitOverlayRunOptions } from '../ports/research-platform.port.ts';
import type { BacktestRun, BacktestCompletion } from '../domain/backtest-run.ts';
import type { BacktestRunRepository } from '../ports/backtest-run.repository.ts';
import type { ExperimentRunRequest } from './experiment-run-executor.ts';
import { BacktesterExperimentRunExecutor } from './backtester-experiment-run-executor.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bundle: ModuleBundle = {
  manifest: {
    moduleId: 'mod-1',
    moduleKind: 'hypothesis_overlay',
    appliesTo: 'long',
    entry: 'index.ts',
    exports: ['default'],
    capabilities: [],
    sdkContractVersion: 'builder-sdk-v0',
  },
  files: { 'index.ts': '// stub' },
  bundleHash: 'bundle-hash-abc',
  bundleContractVersion: 'module-bundle-v1',
};

const req: ExperimentRunRequest = {
  experimentId: 'exp-1',
  role: 'holdout',
  bundle,
  baselineRef: { id: 'baseline-1', version: 'v1' },
  strategyProfileId: 'profile-1',
  hypothesisId: 'hyp-1',
  buildId: 'build-1',
  run: {
    datasetId: 'ds-1',
    symbols: ['BTCUSDT'],
    timeframe: '1m',
    period: { from: '2024-01-01', to: '2024-01-31' },
    seed: 42,
  },
  params: { window: 20 },
};

const terminalStatusView = { jobId: 'j1', runId: 'plat-1', status: 'failed' as const, timeline: { acceptedAtMs: 0 } };
const nonTerminalStatusView = { jobId: 'j1', runId: 'plat-1', status: 'running' as const, timeline: { acceptedAtMs: 0 } };
const jobHandle = { jobId: 'j1', runId: 'plat-1', status: 'accepted' as const, effectiveSeed: 0, requestFingerprint: 'fp', idempotentReplay: false };

function makeOrder() {
  const order: string[] = [];
  return order;
}

function makeFakePlatformRejected(order: string[]): ResearchPlatformPort {
  return {
    discover: async () => { throw new Error('not implemented'); },
    listDatasets: async () => { throw new Error('not implemented'); },
    validateModule: async () => { throw new Error('not implemented'); },
    submitOverlayRun: async (_bundle: ModuleBundle, _opts: SubmitOverlayRunOptions) => {
      order.push('submit');
      return jobHandle;
    },
    getRunStatus: async (_runId: string) => {
      order.push('poll');
      return terminalStatusView;
    },
    getRunResult: async (_runId: string) => {
      return { ok: true as const, kind: 'status' as const, view: terminalStatusView };
    },
  };
}

function makeFakePlatformPending(order: string[]): ResearchPlatformPort {
  return {
    discover: async () => { throw new Error('not implemented'); },
    listDatasets: async () => { throw new Error('not implemented'); },
    validateModule: async () => { throw new Error('not implemented'); },
    submitOverlayRun: async (_bundle: ModuleBundle, _opts: SubmitOverlayRunOptions) => {
      order.push('submit');
      return jobHandle;
    },
    getRunStatus: async (_runId: string) => {
      order.push('poll');
      return nonTerminalStatusView;
    },
    getRunResult: async (_runId: string) => {
      throw new Error('should not be called in pending path');
    },
  };
}

function makeFakeBacktestRepo(order: string[]): { repo: BacktestRunRepository; captured: { run: BacktestRun | null } } {
  const captured: { run: BacktestRun | null } = { run: null };
  const repo: BacktestRunRepository = {
    createSubmitted: async (run: BacktestRun) => { order.push('createSubmitted'); captured.run = run; },
    markCompleted: async (_id: string, _c: BacktestCompletion) => { order.push('markCompleted'); },
    markRejected: async (_id: string) => { order.push('markRejected'); },
    markFailed: async (_id: string) => { order.push('markFailed'); },
    markEvaluated: async (_id: string) => {},
    findById: async (_id: string) => null,
    findByPlatformRunId: async (_id: string) => null,
    findByIdentity: async (_hId: string, _ph: string, _bh: string) => null,
    listByHypothesis: async (_hId: string) => [],
    listResumablePlatformRuns: async () => [],
  };
  return { repo, captured };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BacktesterExperimentRunExecutor — persistence order', () => {
  it('REJECTED: order is submit → createSubmitted → poll → markRejected', async () => {
    const order = makeOrder();
    const platform = makeFakePlatformRejected(order);
    const { repo, captured } = makeFakeBacktestRepo(order);

    const executor = new BacktesterExperimentRunExecutor({
      platform,
      backtests: repo,
      researchIntegration: 'backtester',
      fragilityTopTradePct: 50,
      poll: { maxPolls: 3, pollDelayMs: 0, sleep: async () => {} },
      now: () => '2024-01-01T00:00:00.000Z',
    });

    const result = await executor.execute(req);

    // Persistence order: createSubmitted happens before poll resolves and before markRejected
    expect(order).toEqual(['submit', 'createSubmitted', 'poll', 'markRejected']);

    // BacktestRun was persisted with status 'submitted' immediately after submit
    expect(captured.run).not.toBeNull();
    expect(captured.run!.status).toBe('submitted');
    expect(captured.run!.platformRunId).toBe('plat-1');
    // Lab id is a uuid distinct from the platform run id
    expect(captured.run!.id).not.toBe('plat-1');
    expect(captured.run!.id).toMatch(/^[0-9a-f-]{36}$/);

    // Result carries both ids
    expect(result.status).toBe('rejected');
    expect(result.runId).toBe(captured.run!.id);
    expect(result.platformRunId).toBe('plat-1');
  });

  it('PENDING: order is submit → createSubmitted → poll (no mark, run persisted)', async () => {
    const order = makeOrder();
    const platform = makeFakePlatformPending(order);
    const { repo, captured } = makeFakeBacktestRepo(order);

    const executor = new BacktesterExperimentRunExecutor({
      platform,
      backtests: repo,
      researchIntegration: 'backtester',
      fragilityTopTradePct: 50,
      poll: { maxPolls: 1, pollDelayMs: 0, sleep: async () => {} },
      now: () => '2024-01-01T00:00:00.000Z',
    });

    const result = await executor.execute(req);

    expect(order).toEqual(['submit', 'createSubmitted', 'poll']);

    // Run was still persisted before the pending-timeout
    expect(captured.run).not.toBeNull();
    expect(captured.run!.status).toBe('submitted');
    expect(captured.run!.platformRunId).toBe('plat-1');

    expect(result.status).toBe('pending');
    expect(result.runId).toBe(captured.run!.id);
    expect(result.platformRunId).toBe('plat-1');
  });
});
