import type { BacktestRun, BacktestRunStatus } from '../domain/backtest-run.ts';
import type { Cursor } from './keyset.ts';

export interface BacktestListQuery {
  hypothesisId?: string;
  status?: BacktestRunStatus;
  limit: number;
  after?: Cursor;
}

export interface BacktestReadPort {
  list(q: BacktestListQuery): Promise<BacktestRun[]>;
  getById(id: string): Promise<BacktestRun | null>;
}
