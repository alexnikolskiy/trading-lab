import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';

export interface ReadApiDeps {
  hypotheses: HypothesisReadPort;
  backtests: BacktestReadPort;
  agentEvents: AgentEventReadPort;
  checkReadiness: () => Promise<boolean>;
  token: string;
}
