import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BotResultsReadPort,
  BotRunsFilter,
  BotRunRecord,
  ClosedTrade,
  RunSummary,
  EventsPage,
  DecisionsPage,
} from '../../ports/bot-results-read.port.ts';

/** Reads Surface-A-shaped JSON fixtures (port-shaped arrays/object) from a directory. Dev/offline use. */
export class FixtureBotResultsAdapter implements BotResultsReadPort {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private read<T>(file: string): T {
    return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
  }

  private has(file: string): boolean {
    return existsSync(join(this.dir, file));
  }

  private pageFile(prefix: 'events' | 'decisions', runId: string, cursor?: string): string {
    return cursor ? `${prefix}-${runId}@${cursor}.json` : `${prefix}-${runId}.json`;
  }

  async listBotRuns(_filter?: BotRunsFilter): Promise<readonly BotRunRecord[]> {
    return this.read<BotRunRecord[]>('runs.json');
  }
  async getClosedTrades(runId: string): Promise<readonly ClosedTrade[]> {
    if (this.has('trades-by-run.json')) {
      const byRun = this.read<Record<string, ClosedTrade[]>>('trades-by-run.json');
      return byRun[runId] ?? [];
    }
    return this.read<ClosedTrade[]>('trades.json');
  }
  async getRunSummary(runId: string): Promise<RunSummary> {
    if (this.has('summary-by-run.json')) {
      const byRun = this.read<Record<string, RunSummary>>('summary-by-run.json');
      const summary = byRun[runId];
      if (!summary) throw new Error(`summary fixture not found for runId ${runId}`);
      return summary;
    }
    return this.read<RunSummary>('summary.json');
  }
  async getOperationalEvents(runId: string, cursor?: string): Promise<EventsPage> {
    return this.read<EventsPage>(this.pageFile('events', runId, cursor));
  }
  async getDecisionLog(runId: string, cursor?: string): Promise<DecisionsPage> {
    return this.read<DecisionsPage>(this.pageFile('decisions', runId, cursor));
  }
}
