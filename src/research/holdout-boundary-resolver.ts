import type { TradeRecord, HoldoutPolicy, HoldoutBoundary } from '../domain/research-experiment.ts';

const DAY_MS = 86_400_000;

export function resolveHoldoutBoundary(
  trades: TradeRecord[],
  period: { from: string; to: string },
  policy: HoldoutPolicy,
): HoldoutBoundary {
  const spanDays = (Date.parse(period.to) - Date.parse(period.from)) / DAY_MS;
  if (spanDays < policy.minHistoryDays) {
    return { mode: 'none', lowConfidence: false, reason: 'insufficient_history' };
  }

  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  const n = sorted.length;

  // choose the largest holdout count h such that train (n - h) >= minTradesTrain,
  // preferring h >= minTradesHoldout (full confidence), else h in [lowConfidenceThreshold, minTradesHoldout).
  const pick = (h: number): HoldoutBoundary | null => {
    if (h < 1 || h > n) return null;
    const trainCount = n - h;
    if (trainCount < policy.minTradesTrain) return null;
    const tMs = sorted[n - h]!.entryTs;
    const holdoutTrades = sorted.filter((t) => t.entryTs >= tMs).length; // recount from chosen T (ties)
    const trainTrades = n - holdoutTrades;
    if (trainTrades < policy.minTradesTrain) return null;
    return {
      mode: 'trade_based',
      t: new Date(tMs).toISOString(),
      trainTrades,
      holdoutTrades,
      lowConfidence: holdoutTrades < policy.minTradesHoldout,
      reason: 'ok',
    };
  };

  const full = pick(policy.minTradesHoldout);
  if (full && !full.lowConfidence) return full;

  // largest low-confidence holdout in [lowConfidenceThreshold, minTradesHoldout)
  for (let h = policy.minTradesHoldout - 1; h >= policy.lowConfidenceThreshold; h--) {
    const lc = pick(h);
    if (lc) return lc;
  }

  return { mode: 'none', lowConfidence: false, reason: 'insufficient_trades' };
}
