import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TradeEvidenceBundle, TradeEvidenceQuery, TradeEvidenceReadPort } from '../../ports/trade-evidence-read.port.ts';

export class FixtureTradeEvidenceAdapter implements TradeEvidenceReadPort {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private read<T>(file: string): T {
    return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
  }

  async getTradeEvidence(query: TradeEvidenceQuery): Promise<readonly TradeEvidenceBundle[]> {
    if (!existsSync(join(this.dir, 'bundles-by-trade.json'))) return [];
    const byTrade = this.read<Record<string, TradeEvidenceBundle>>('bundles-by-trade.json');
    return query.tradeIds.map((tradeId) => byTrade[tradeId]).filter((bundle): bundle is TradeEvidenceBundle => bundle != null);
  }
}
