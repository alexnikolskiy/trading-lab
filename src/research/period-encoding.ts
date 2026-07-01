const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

// Set to true ONLY if Task 0.1 found the backtester treats period.to as inclusive.
const PERIOD_TO_INCLUSIVE = false;

export function encodeTrainPeriod(from: string, t: string, timeframe: string): { from: string; to: string } {
  if (!PERIOD_TO_INCLUSIVE) return { from, to: t };
  const step = TIMEFRAME_MS[timeframe] ?? 60_000;
  return { from, to: new Date(Date.parse(t) - step).toISOString() };
}

export function encodeHoldoutPeriod(t: string, to: string): { from: string; to: string } {
  return { from: t, to };
}
