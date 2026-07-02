import { describe, it, expect } from 'vitest';
import { ParamGridRunner } from './param-grid-runner.ts';
import type { StrategyExperimentRunExecutor } from './strategy-experiment-run-executor.ts';

const bundle = {
  bytes: new Uint8Array(),
  source: '',
  manifest: { id: 'mod_x', version: '1', kind: 'strategy' },
  bundleHash: 'sha256:h',
} as any;
const trainRun = { datasetId: 'd', symbols: ['S'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 42 };

describe('ParamGridRunner', () => {
  it('runs every grid point on train, ledgers ALL results, ranks only completed', async () => {
    const seen: Record<string, unknown>[] = [];
    const fakeExec: StrategyExperimentRunExecutor = {
      async execute(req) {
        seen.push(req.params);
        const drop = Number(req.params['dump.minDropPct']);
        if (drop === 9) return { status: 'rejected', runId: 'r9', platformRunId: 'p9' }; // one point rejected by engine
        return {
          status: 'completed', runId: `r${drop}`, platformRunId: `p${drop}`, totalTrades: 5,
          metrics: {
            netPnlUsd: 0, netPnlPct: 0, totalTrades: 5, winRate: 0, profitFactor: 1,
            maxDrawdownPct: 0, expectancyUsd: 0, sharpe: drop, topTradeContributionPct: 0,
          },
        };
      },
    };
    const out = await new ParamGridRunner({ strategyRunExecutor: fakeExec }).runGrid({
      experimentId: 'e', strategyBundle: bundle, strategyProfileId: 'p', trainRun,
      grid: { 'dump.minDropPct': [2, 5, 9] }, metrics: ['sharpe'], maxPoints: 8, topN: 3, minTradesTrain: 3, foldId: 0,
    });
    expect(seen.length).toBe(3); // all points submitted on train
    expect(out.allResults.length).toBe(3); // ALL points in the ledger (incl. rejected)
    expect(out.allResults.find((r) => r.paramsHash === out.allResults[2]!.paramsHash)?.status).toBeDefined();
    expect(out.allResults.filter((r) => r.status === 'rejected').length).toBe(1);
    expect(out.ranked.map((r) => r.metrics.sharpe)).toEqual([5, 2]); // only completed, sharpe desc; rejected excluded
    expect(out.submitted).toBe(3);
    expect(out.rejected).toBe(1);
  });
});
