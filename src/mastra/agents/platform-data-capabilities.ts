// src/mastra/agents/platform-data-capabilities.ts
// Canonical, curated description of the platform's REAL research data — sourced from
// MarketDataKind ('openInterest' | 'liquidations' | 'funding' | 'taker',
// src/ports/research-run-lifecycle.ts) and the ctx.market API in
// src/adapters/builder/builder-sdk-doc.ts. NOT invented. Injected into the rewriting agents.
export const PLATFORM_DATA_CAPABILITIES = [
  'AVAILABLE PLATFORM DATA — ground every improvement in these signals ONLY; do not invent unavailable data sources:',
  '- OHLCV candles (open/high/low/close/volume) per bar.',
  '- Open interest with trend (open interest rising / falling / flat).',
  '- Long and short liquidations (liquidation volume per side; cascade risk).',
  '- Funding rate (a funding extreme signals crowded positioning).',
  '- Taker buy/sell volume (taker delta / CVD — aggressive-flow confirmation).',
  'Execution, fills, leverage and risk-sizing stay runner-owned — never prescribe them.',
].join('\n');
