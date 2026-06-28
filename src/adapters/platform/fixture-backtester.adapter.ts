import type {
  BacktesterStrategyPort,
  StrategyRunResult,
  StrategyRunSubmission,
} from '../../ports/backtester-strategy.port.ts';

export interface FixtureBacktesterAdapterOptions {
  outcome?: StrategyRunResult['status'];
}

export class FixtureBacktesterAdapter implements BacktesterStrategyPort {
  private readonly outcome: StrategyRunResult['status'];

  constructor({ outcome = 'signed' }: FixtureBacktesterAdapterOptions) {
    this.outcome = outcome;
  }

  async submitStrategyRun(s: StrategyRunSubmission): Promise<StrategyRunResult> {
    switch (this.outcome) {
      case 'signed':
        return {
          status: 'signed',
          resultHash: 'sha256:' + 'f'.repeat(64),
          evidence: {
            body: {
              schema: 'backtest-evidence/v1',
              backtesterRunId: 'fixture',
              bundleHash: s.bundleHash,
              verdict: 'passed',
              datasetRef: s.scope.datasetRef,
              window: s.scope.window,
              symbols: s.scope.symbols,
              timeframe: s.scope.timeframe,
              keyId: 'fixture',
            },
            signature: 'fixture',
          },
        };
      case 'equivalent':
        return { status: 'equivalent', resultHash: 'sha256:' + 'e'.repeat(64) };
      case 'divergent':
        return {
          status: 'divergent',
          resultHash: 'sha256:' + 'd'.repeat(64),
          divergence: { bar: 0, field: 'pnl', expected: 1, actual: 2 },
        };
      case 'rejected':
        return { status: 'rejected' };
      case 'unavailable':
        return { status: 'unavailable' };
    }
  }
}
