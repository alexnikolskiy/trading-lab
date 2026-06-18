export interface TradeLifecycleEvidence {
  readonly tsMs: number;
  readonly type: 'entry' | 'dca' | 'tp' | 'sl' | 'exit' | 'stop_update';
  readonly price?: string | null;
  readonly qty?: string | null;
  readonly note?: string | null;
}

export interface TradeMinuteContextPoint {
  readonly tsMs: number;
  readonly close: string;
  readonly volume?: string | null;
  readonly oi?: string | null;
  readonly liquidationsLong?: string | null;
  readonly liquidationsShort?: string | null;
}

export interface TradeEvidenceBundle {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly enteredAtMs: number;
  readonly closedAtMs: number | null;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly holdingDurationMs: number | null;
  readonly closeReason: string | null;
  readonly lifecycleEvents: readonly TradeLifecycleEvidence[];
  readonly minuteContext: readonly TradeMinuteContextPoint[];
}

export interface TradeEvidenceQuery {
  readonly tradeIds: readonly string[];
  readonly minuteWindowBefore: number;
  readonly minuteWindowAfter: number;
}

export interface TradeEvidenceReadPort {
  getTradeEvidence(query: TradeEvidenceQuery): Promise<readonly TradeEvidenceBundle[]>;
}
