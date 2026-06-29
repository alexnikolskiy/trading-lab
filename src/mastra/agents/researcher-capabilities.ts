// Curated capability menu for the researcher — what the market-context blocks expose, so the
// LLM anchors hypotheses on real signals instead of inferring them from numbers. Kept separate
// from the critic/refiner PLATFORM_DATA_CAPABILITIES (different audience).
export const RESEARCHER_CAPABILITIES = [
  'AVAILABLE RESEARCH DATA & INDICATORS — anchor hypotheses on these only; a field shown n/a is genuinely absent, never assume it:',
  'Market data: OHLCV candles, volume, open interest (with rising/falling/flat trend), long/short liquidations, funding rate, taker buy/sell volume (→ CVD).',
  'Indicators (computed per timeframe-term and per losing-trade window): EMA, RSI, ATR, realized volatility, MACD, Bollinger Bands (%B and bandwidth), Stochastic, ADX (+DI/−DI), Fibonacci retracements, classic floor Pivots, TTM Squeeze, taker Pressure, OI delta, CVD, liquidation aggregates, funding.',
  'Per-trade context gives indicator snapshots at the entry bar and the exit bar of each losing trade — use them to reason about what conditions preceded the loss.',
  'Execution, fills, leverage and risk sizing stay runner-owned — never prescribe them.',
].join('\n');
