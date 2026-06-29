# Per-trade context math + researcher capability menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For each losing trade the researcher already gets as forensic evidence, also give it the full indicator suite + rich market fields computed on that trade's own window (entry & exit snapshots + a micro trajectory), and add an explicit capability menu to the researcher's system prompt.

**Architecture:** A new pure `buildTradeContextMath` *orchestrates* the existing `buildMarketContextMath` engine on each losing trade's `[entry−warmup, exit]` window (rows from the existing `MarketHistoryReadPort`, full `CanonicalRowV2`), taking indicator snapshots at the entry bar (rows truncated at entry) and exit bar. A new formatter reuses the existing summary/row/precision helpers. The handler iterates the already-fetched `TradeEvidenceBundle`s; a new `RESEARCHER_CAPABILITIES` string is appended to the researcher agent's instructions. Zero new indicator math.

**Tech Stack:** TypeScript under `node --experimental-strip-types`; Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-per-trade-context-math-design.md`

## Global Constraints

- Pure, deterministic functions (`nowMs` injected) — no I/O, no `Date.now()`/`Math.random()` inside the math/format modules.
- **Reuse the engine** — `buildTradeContextMath` calls `buildMarketContextMath`; re-implement NO indicator/resample/format math. The formatter reuses the existing `summaryLine`/`rowLine`/`priceNum`/`isoMinute`/table-header helpers (export them; do not duplicate).
- Do NOT change: the symbol-level `marketContextMath` block, the indicator functions, `term-config`, or the per-row table's column header/separator strings.
- Do NOT widen the narrow `TradeMinuteContextPoint`/trade-evidence read port — per-trade context uses `MarketHistoryReadPort`.
- Coverage-honest: `n/a`/notes driven by the source rows' `has_*` flags + the engine's term-inclusion gate; never fabricate.
- Fail-soft: a per-trade or whole-feature failure degrades to "no per-trade context" + an event; it must NEVER fail the research cycle.
- Relative imports carry the `.ts` extension. `noUncheckedIndexedAccess` on: `!`/guards only where a loop/length bound proves presence — no logic change to satisfy the checker.
- Zero new runtime dependencies. BOTH gates green per task: `npm run typecheck` (exit 0) AND `npx vitest run` (no regression; baseline 2344 passed / 0 failed before this work).

---

### Task 1: `buildTradeContextMath` (per-trade engine orchestration)

**Files:**
- Create: `src/research-math/trade-context-math.ts`
- Test: `src/research-math/trade-context-math.test.ts`

**Interfaces:**
- Consumes: `buildMarketContextMath`, `TermMath`, `TermMathRow` (from `./market-context-math.ts`, already exported); `TERM_CONFIGS`, `TermConfig` (from `./term-config.ts`); `CanonicalRowV2` (from `../ports/market-history-read.port.ts`); `Direction` (`../domain/strategy-profile.ts`); `MarketRegime` (`../ports/platform-gateway.port.ts`).
- Produces:
  ```ts
  export const TRADE_TERM_CONFIGS: readonly TermConfig[];
  export interface TradeContextMath { tradeId: string; symbol: string; entryMs: number; exitMs: number;
    realizedPnl: number; pnlPct: number | null; closeReason: string | null;
    atEntry: readonly TermMath[]; atExit: readonly TermMath[]; microRows: readonly TermMathRow[]; notes: readonly string[]; }
  export interface TradeContextMathInput { tradeId: string; symbol: string; rows: readonly CanonicalRowV2[];
    entryMs: number; exitMs: number; realizedPnl: number; pnlPct: number | null; closeReason: string | null;
    direction: Direction; regime: MarketRegime; requiredFeatures: readonly string[]; microTableRows?: number; }
  export function buildTradeContextMath(input: TradeContextMathInput, nowMs: number): TradeContextMath;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/research-math/trade-context-math.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTradeContextMath, TRADE_TERM_CONFIGS } from './trade-context-math.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

const MIN = 60_000;

function series(n: number, withTaker: boolean): CanonicalRowV2[] {
  return Array.from({ length: n }, (_, i) => ({
    schema_version: 2, minute_ts: i * MIN, symbol: 'PENNYUSDT',
    open: 0.05 + i * 0.0001, high: 0.05 + i * 0.0001 + 0.0002, low: 0.05 + i * 0.0001 - 0.0002,
    close: 0.05 + i * 0.0001, volume: 1000, turnover: 50,
    oi_total_usd: 1_000_000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: withTaker ? 6 : null, taker_sell_volume_usd: withTaker ? 4 : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: withTaker,
  } as CanonicalRowV2));
}

const base = {
  tradeId: 'tr1', symbol: 'PENNYUSDT', direction: 'long' as const, regime: 'ranging' as const,
  requiredFeatures: ['oi'], realizedPnl: -5, pnlPct: -1.2, closeReason: 'stop_loss',
};

describe('TRADE_TERM_CONFIGS', () => {
  it('is micro + short only', () => {
    expect(TRADE_TERM_CONFIGS.map((t) => t.key)).toEqual(['micro', 'short']);
  });
});

describe('buildTradeContextMath', () => {
  it('snapshots indicators at the entry bar and at the exit bar (entry close ≠ exit close)', () => {
    const rows = series(260, true); // 1m
    const entryMs = 200 * MIN, exitMs = 240 * MIN;
    const tc = buildTradeContextMath({ ...base, rows, entryMs, exitMs }, 1_700_000_000_000);
    const entMicro = tc.atEntry.find((t) => t.config.key === 'micro')!;
    const exMicro = tc.atExit.find((t) => t.config.key === 'micro')!;
    expect(entMicro).toBeDefined();
    expect(exMicro).toBeDefined();
    expect(entMicro.indicators.close).toBeCloseTo(rows[200]!.close, 9); // snapshot AS OF entry bar
    expect(exMicro.indicators.close).toBeCloseTo(rows[240]!.close, 9);   // snapshot AS OF exit bar
  });

  it('returns the last micro rows through exit as microRows (default 10)', () => {
    const rows = series(260, true);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(tc.microRows.length).toBe(10);
    expect(tc.microRows.at(-1)!.tsMs).toBe(240 * MIN); // last bar at/through exit
  });

  it('drops a term unavailable at entry for insufficient warmup, with a note', () => {
    // entry at bar 140 → short(5m) has ~28 bars before entry (< minBars 30) → absent@entry; present@exit (260 → ~52)
    const rows = series(260, true);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 140 * MIN, exitMs: 259 * MIN }, 0);
    expect(tc.atEntry.some((t) => t.config.key === 'short')).toBe(false);
    expect(tc.atExit.some((t) => t.config.key === 'short')).toBe(true);
    expect(tc.notes.some((n) => /warmup/i.test(n) && /Short/i.test(n))).toBe(true);
  });

  it('marks CVD/Pressure n/a when the window has no taker flow', () => {
    const rows = series(260, false);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const exMicro = tc.atExit.find((t) => t.config.key === 'micro')!;
    expect(exMicro.indicators.cvdNet).toBeNull();
    expect(exMicro.indicators.pressure).toBeNull();
  });

  it('handles empty rows without throwing (empty terms + a note)', () => {
    const tc = buildTradeContextMath({ ...base, rows: [], entryMs: 0, exitMs: MIN }, 0);
    expect(tc.atEntry).toEqual([]);
    expect(tc.atExit).toEqual([]);
    expect(tc.microRows).toEqual([]);
    expect(tc.notes.length).toBeGreaterThan(0);
  });

  it('is deterministic for the same input + nowMs', () => {
    const rows = series(260, true);
    const a = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 42);
    const b = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 42);
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/research-math/trade-context-math.test.ts`
Expected: FAIL — `buildTradeContextMath` / `TRADE_TERM_CONFIGS` not exported.

- [ ] **Step 3: Write the implementation**

Create `src/research-math/trade-context-math.ts`:

```ts
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';
import type { Direction } from '../domain/strategy-profile.ts';
import type { MarketRegime } from '../ports/platform-gateway.port.ts';
import { buildMarketContextMath, type TermMath, type TermMathRow } from './market-context-math.ts';
import { TERM_CONFIGS, type TermConfig } from './term-config.ts';

/** A single trade's window can't hold enough 15m/1h bars — micro(1m)+short(5m) only. */
export const TRADE_TERM_CONFIGS: readonly TermConfig[] =
  TERM_CONFIGS.filter((t) => t.key === 'micro' || t.key === 'short');

export interface TradeContextMath {
  readonly tradeId: string; readonly symbol: string;
  readonly entryMs: number; readonly exitMs: number;
  readonly realizedPnl: number; readonly pnlPct: number | null; readonly closeReason: string | null;
  readonly atEntry: readonly TermMath[];
  readonly atExit: readonly TermMath[];
  readonly microRows: readonly TermMathRow[];
  readonly notes: readonly string[];
}

export interface TradeContextMathInput {
  readonly tradeId: string; readonly symbol: string;
  readonly rows: readonly CanonicalRowV2[];
  readonly entryMs: number; readonly exitMs: number;
  readonly realizedPnl: number; readonly pnlPct: number | null; readonly closeReason: string | null;
  readonly direction: Direction; readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly microTableRows?: number;
}

export function buildTradeContextMath(input: TradeContextMathInput, nowMs: number): TradeContextMath {
  const { rows } = input;
  const microTableRows = input.microTableRows ?? 10;
  const head = {
    tradeId: input.tradeId, symbol: input.symbol, entryMs: input.entryMs, exitMs: input.exitMs,
    realizedPnl: input.realizedPnl, pnlPct: input.pnlPct, closeReason: input.closeReason,
  };

  if (rows.length === 0) {
    return { ...head, atEntry: [], atExit: [], microRows: [], notes: ['No market history rows for this trade window.'] };
  }

  const fromMs = rows[0]!.minute_ts;
  const baseInput = {
    symbol: input.symbol, direction: input.direction, regime: input.regime,
    requiredFeatures: input.requiredFeatures, terms: TRADE_TERM_CONFIGS,
  };

  // entry bar = last row with minute_ts <= entryMs (rows are ascending); fallback to the first row
  let entryIdx = 0;
  for (let i = 0; i < rows.length; i++) { if (rows[i]!.minute_ts <= input.entryMs) entryIdx = i; else break; }

  const atEntryMath = buildMarketContextMath(
    { ...baseInput, rows: rows.slice(0, entryIdx + 1), window: { fromMs, toMs: input.entryMs } }, nowMs);
  const atExitMath = buildMarketContextMath(
    { ...baseInput, rows, window: { fromMs, toMs: input.exitMs } }, nowMs);

  const microExit = atExitMath.terms.find((t) => t.config.key === 'micro');
  const microRows = microExit ? microExit.rows.slice(-microTableRows) : [];

  const entryKeys = new Set(atEntryMath.terms.map((t) => t.config.key));
  const warmupNotes = atExitMath.terms
    .filter((t) => !entryKeys.has(t.config.key))
    .map((t) => `Term ${t.config.label} unavailable at entry: insufficient warmup before the trade.`);
  const notes = Array.from(new Set([...atEntryMath.notes, ...atExitMath.notes, ...warmupNotes]));

  return { ...head, atEntry: atEntryMath.terms, atExit: atExitMath.terms, microRows, notes };
}
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `npx vitest run src/research-math/trade-context-math.test.ts && npm run typecheck`
Expected: PASS (all 7 tests) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/trade-context-math.ts src/research-math/trade-context-math.test.ts
git commit -m "feat(research-math): buildTradeContextMath — per-trade indicator snapshots (reuse engine)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: per-trade formatter (+ export reusable helpers)

**Files:**
- Modify: `src/research-math/format-market-context-math.ts` (export helpers; extract+export `tableHeaderLines`; refactor `termSection` to use it — behaviour unchanged)
- Create: `src/research-math/format-trade-context-math.ts`
- Test: `src/research-math/format-trade-context-math.test.ts`

**Interfaces:**
- Consumes: `TradeContextMath` (Task 1); the exported helpers below.
- Produces:
  ```ts
  // format-market-context-math.ts (newly exported, behaviour unchanged):
  export function priceNum(v: number | null): string;
  export function isoMinute(ms: number): string;
  export function summaryLine(t: TermMath): string;
  export function rowLine(r: TermMathRow): string;
  export function tableHeaderLines(cfg: TermConfig): [string, string];
  // format-trade-context-math.ts:
  export function formatTradeContextMath(tc: TradeContextMath): string;
  export function formatTradeContexts(tcs: readonly TradeContextMath[]): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/research-math/format-trade-context-math.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTradeContextMath } from './trade-context-math.ts';
import { formatTradeContextMath, formatTradeContexts } from './format-trade-context-math.ts';
import type { CanonicalRowV2 } from '../ports/market-history-read.port.ts';

const MIN = 60_000;
function series(n: number, withTaker: boolean): CanonicalRowV2[] {
  return Array.from({ length: n }, (_, i) => ({
    schema_version: 2, minute_ts: i * MIN, symbol: 'PENNYUSDT',
    open: 0.05 + i * 0.0001, high: 0.05 + i * 0.0001 + 0.0002, low: 0.05 + i * 0.0001 - 0.0002,
    close: 0.05 + i * 0.0001, volume: 1000, turnover: 50,
    oi_total_usd: 1_000_000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
    taker_buy_volume_usd: withTaker ? 6 : null, taker_sell_volume_usd: withTaker ? 4 : null,
    has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: withTaker,
  } as CanonicalRowV2));
}
const base = {
  tradeId: 'tr1', symbol: 'PENNYUSDT', direction: 'long' as const, regime: 'ranging' as const,
  requiredFeatures: ['oi'], realizedPnl: -5.5, pnlPct: -1.2, closeReason: 'stop_loss',
};

describe('formatTradeContextMath', () => {
  it('renders the header, @entry/@exit summaries, a micro table and is sub-dollar-precise', () => {
    const tc = buildTradeContextMath({ ...base, rows: series(260, true), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const md = formatTradeContextMath(tc);
    expect(md).toContain('### Trade tr1 · PENNYUSDT');
    expect(md).toContain('-5.50');         // realizedPnl
    expect(md).toContain('close=stop_loss');
    expect(md).toMatch(/@entry .*Micro \(1m\):/);
    expect(md).toMatch(/@exit .*Micro \(1m\):/);
    expect(md).toContain('| ts | open | high | low | close |'); // micro table header
    // sub-dollar precision: a Pivots PP with > 2 decimals appears somewhere
    expect(md).toMatch(/Pivots PP=0\.\d{3,}/);
    expect(md).not.toMatch(/\d[eE][+-]?\d/); // no scientific notation
  });

  it('renders n/a for CVD/Pressure when the window has no taker', () => {
    const tc = buildTradeContextMath({ ...base, rows: series(260, false), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const md = formatTradeContextMath(tc);
    expect(md).toContain('CVD n/a');
    expect(md).toContain('Pressure n/a');
  });
});

describe('formatTradeContexts', () => {
  it('returns empty string for no contexts and a header for ≥1', () => {
    expect(formatTradeContexts([])).toBe('');
    const tc = buildTradeContextMath({ ...base, rows: series(260, true), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(formatTradeContexts([tc])).toContain('## Per-trade context (losing trades)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/format-trade-context-math.test.ts`
Expected: FAIL — module `./format-trade-context-math.ts` / its exports do not exist.

- [ ] **Step 3a: Export reusable helpers from `format-market-context-math.ts`**

In `src/research-math/format-market-context-math.ts`:
- Add the import: `import type { TermConfig } from './term-config.ts';` (alongside the existing type import).
- Change `function priceNum` → `export function priceNum`, `function isoMinute` → `export function isoMinute`, `function summaryLine` → `export function summaryLine`, `function rowLine` → `export function rowLine`. (Leave `num` private.)
- Add and export `tableHeaderLines`, and refactor `termSection` to use it (output byte-identical):

```ts
export function tableHeaderLines(cfg: TermConfig): [string, string] {
  const cols = `| ts | open | high | low | close | vol | ema${cfg.emaFast} | ema${cfg.emaSlow} | rsi${cfg.rsiPeriod} | atr${cfg.atrPeriod} | oi | oiΔ | cvd | liqL | liqS |`;
  const sep = `|----|------|------|-----|-------|-----|------|-------|-------|-------|----|-----|-----|------|------|`;
  return [cols, sep];
}

function termSection(t: TermMath): string {
  const header = `### ${t.config.label} · ${t.barCount} bars`;
  const [cols, sep] = tableHeaderLines(t.config);
  return [header, summaryLine(t), '', cols, sep, ...t.rows.map(rowLine)].join('\n');
}
```

(`formatMarketContextMath` and the rest are unchanged; existing `format-market-context-math.test.ts` stays green.)

- [ ] **Step 3b: Create the per-trade formatter**

Create `src/research-math/format-trade-context-math.ts`:

```ts
import type { TradeContextMath } from './trade-context-math.ts';
import type { TermMath } from './market-context-math.ts';
import { summaryLine, rowLine, isoMinute, tableHeaderLines } from './format-market-context-math.ts';

function summariesFor(label: string, terms: readonly TermMath[]): string[] {
  return terms.map((t) => `${label} ${t.config.label}: ${summaryLine(t)}`);
}

export function formatTradeContextMath(tc: TradeContextMath): string {
  const pnlPct = tc.pnlPct == null ? '' : ` (${tc.pnlPct >= 0 ? '+' : ''}${tc.pnlPct.toFixed(2)}%)`;
  const durMin = Math.round((tc.exitMs - tc.entryMs) / 60_000);
  const lines: string[] = [
    `### Trade ${tc.tradeId} · ${tc.symbol} · pnl ${tc.realizedPnl.toFixed(2)}${pnlPct} · close=${tc.closeReason ?? 'unknown'}`,
    `entry ${isoMinute(tc.entryMs)} → exit ${isoMinute(tc.exitMs)} (${durMin}m)`,
    ...summariesFor('@entry', tc.atEntry),
    ...summariesFor('@exit', tc.atExit),
  ];
  const micro = tc.atExit.find((t) => t.config.key === 'micro');
  if (micro && tc.microRows.length > 0) {
    const [cols, sep] = tableHeaderLines(micro.config);
    lines.push(cols, sep, ...tc.microRows.map(rowLine));
  }
  if (tc.notes.length > 0) lines.push(`> Notes: ${tc.notes.join(' ')}`);
  return lines.join('\n');
}

export function formatTradeContexts(tcs: readonly TradeContextMath[]): string {
  if (tcs.length === 0) return '';
  return ['## Per-trade context (losing trades)', '', ...tcs.map((tc) => formatTradeContextMath(tc) + '\n')]
    .join('\n').trimEnd() + '\n';
}
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `npx vitest run src/research-math/format-trade-context-math.test.ts src/research-math/format-market-context-math.test.ts && npm run typecheck`
Expected: PASS (new per-trade tests + existing format tests still green) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/format-market-context-math.ts src/research-math/format-trade-context-math.ts src/research-math/format-trade-context-math.test.ts
git commit -m "feat(research-math): per-trade context formatter (reuse summary/row/precision helpers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `RESEARCHER_CAPABILITIES` menu in the researcher agent

**Files:**
- Create: `src/mastra/agents/researcher-capabilities.ts`
- Modify: `src/mastra/agents/researcher.agent.ts` (append the menu; export the composed instructions)
- Test: `src/mastra/agents/researcher-capabilities.test.ts`

**Interfaces:**
- Produces: `export const RESEARCHER_CAPABILITIES: string;` and `export const RESEARCHER_INSTRUCTIONS: string;` (the latter = base instructions + the menu, used by `createResearcherAgent`).

- [ ] **Step 1: Write the failing test**

Create `src/mastra/agents/researcher-capabilities.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RESEARCHER_CAPABILITIES } from './researcher-capabilities.ts';
import { RESEARCHER_INSTRUCTIONS } from './researcher.agent.ts';

describe('RESEARCHER_CAPABILITIES', () => {
  it('lists the data dimensions and the indicator vocabulary', () => {
    for (const marker of ['open interest', 'liquidations', 'funding', 'taker', 'EMA', 'RSI', 'ATR', 'MACD', 'Bollinger', 'Stochastic', 'ADX', 'Fibonacci', 'Pivots', 'Squeeze', 'Pressure']) {
      expect(RESEARCHER_CAPABILITIES).toContain(marker);
    }
  });
  it('keeps the runner-owned execution guard', () => {
    expect(RESEARCHER_CAPABILITIES.toLowerCase()).toContain('runner-owned');
  });
});

describe('RESEARCHER_INSTRUCTIONS', () => {
  it('embeds the capability menu and keeps the falsifiable-hypothesis guidance', () => {
    expect(RESEARCHER_INSTRUCTIONS).toContain(RESEARCHER_CAPABILITIES);
    expect(RESEARCHER_INSTRUCTIONS).toContain('FALSIFIABLE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mastra/agents/researcher-capabilities.test.ts`
Expected: FAIL — `researcher-capabilities.ts` / `RESEARCHER_INSTRUCTIONS` do not exist.

- [ ] **Step 3a: Create the capability menu**

Create `src/mastra/agents/researcher-capabilities.ts`:

```ts
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
```

- [ ] **Step 3b: Wire it into the researcher agent**

In `src/mastra/agents/researcher.agent.ts`: add `import { RESEARCHER_CAPABILITIES } from './researcher-capabilities.ts';`, rename the existing `const INSTRUCTIONS` to `const BASE_INSTRUCTIONS`, then export the composed instructions and use them in the agent:

```ts
const BASE_INSTRUCTIONS = [
  // ...existing lines unchanged...
].join(' ');

export const RESEARCHER_INSTRUCTIONS = `${BASE_INSTRUCTIONS}\n\n${RESEARCHER_CAPABILITIES}`;

export function createResearcherAgent(model: ProviderModel): Agent {
  return new Agent({ id: RESEARCHER_AGENT_ID, name: 'Researcher', instructions: RESEARCHER_INSTRUCTIONS, model });
}
```

(Note: the existing base lines already contain the word `FALSIFIABLE`. Do not change the shared `PLATFORM_DATA_CAPABILITIES` or the critic/refiner agents.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/mastra/agents/researcher-capabilities.test.ts && npm run typecheck`
Expected: PASS and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/agents/researcher-capabilities.ts src/mastra/agents/researcher.agent.ts src/mastra/agents/researcher-capabilities.test.ts
git commit -m "feat(research): explicit RESEARCHER_CAPABILITIES menu in the researcher agent (C)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `ResearcherInput.tradeContexts` + prompt injection

**Files:**
- Modify: `src/ports/researcher.port.ts` (add field)
- Modify: `src/adapters/researcher/mastra-researcher.ts` (`buildPrompt` injects per-trade sections)
- Test: `src/adapters/researcher/mastra-researcher.test.ts` (append)

**Interfaces:**
- Consumes: `TradeContextMath` (Task 1), `formatTradeContexts` (Task 2).
- Produces: `ResearcherInput.tradeContexts?: readonly TradeContextMath[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/adapters/researcher/mastra-researcher.test.ts` (it already imports `buildPrompt`; add the new imports it needs):

```ts
import { buildTradeContextMath } from '../../research-math/trade-context-math.ts';
import type { CanonicalRowV2 } from '../../ports/market-history-read.port.ts';

describe('buildPrompt per-trade context', () => {
  const MIN = 60_000;
  function rows(): CanonicalRowV2[] {
    return Array.from({ length: 260 }, (_, i) => ({
      schema_version: 2, minute_ts: i * MIN, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    } as CanonicalRowV2));
  }
  function tc() {
    return buildTradeContextMath({
      tradeId: 'tr1', symbol: 'BTCUSDT', rows: rows(), entryMs: 200 * MIN, exitMs: 240 * MIN,
      realizedPnl: -12, pnlPct: -1.5, closeReason: 'stop_loss',
      direction: 'long', regime: 'ranging', requiredFeatures: ['oi'],
    }, 0);
  }
  // `researcherInput` is the helper/fixture the existing buildPrompt tests already use to build a
  // minimal ResearcherInput; reuse it (or an inline minimal input) and add tradeContexts.

  it('injects per-trade context sections when tradeContexts is present', () => {
    const prompt = buildPrompt({ ...researcherInput(), tradeContexts: [tc()] });
    expect(prompt).toContain('## Per-trade context (losing trades)');
    expect(prompt).toContain('### Trade tr1 · BTCUSDT');
  });

  it('omits per-trade sections when tradeContexts is absent', () => {
    const prompt = buildPrompt(researcherInput());
    expect(prompt).not.toContain('## Per-trade context');
  });
});
```

(If the test file has no shared `researcherInput()` helper, build a minimal `ResearcherInput` inline — the same shape the existing `buildPrompt` tests in this file construct — and spread `tradeContexts` onto it. Match the existing tests' fixture style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts`
Expected: FAIL — `tradeContexts` not on `ResearcherInput` / not injected by `buildPrompt`.

- [ ] **Step 3a: Add the field**

In `src/ports/researcher.port.ts`: add the import `import type { TradeContextMath } from '../research-math/trade-context-math.ts';` and the field to `ResearcherInput` (after `tradeEvidence`):

```ts
  tradeContexts?: readonly TradeContextMath[];
```

- [ ] **Step 3b: Inject in `buildPrompt`**

In `src/adapters/researcher/mastra-researcher.ts`: add `import { formatTradeContexts } from '../../research-math/format-trade-context-math.ts';`. In `buildPrompt`, after the `...forensicBundleText(input.tradeEvidence)` entry in the returned array, add:

```ts
    ...(input.tradeContexts && input.tradeContexts.length > 0 ? [formatTradeContexts(input.tradeContexts)] : []),
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts && npm run typecheck`
Expected: PASS and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/ports/researcher.port.ts src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/mastra-researcher.test.ts
git commit -m "feat(research): ResearcherInput.tradeContexts + buildPrompt injection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Handler — gather per-trade context from the fetched bundles

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (append)

**Interfaces:**
- Consumes: `buildTradeContextMath` / `TradeContextMath` (Task 1); `ResearcherInput.tradeContexts` (Task 4); existing `services.marketHistory`, the fetched `tradeEvidence` bundles, `marketRegime`, `profile`.
- Produces: per-trade contexts attached to the `propose(...)` input; a `researcher.trade_context_unavailable` event on per-trade failure.

- [ ] **Step 1: Write the failing test**

Append to `src/orchestrator/handlers/research-run-cycle.handler.test.ts`. It already has `capturingResearcher`, `makeServices`, `seedProfile`, `task`, `types`, and the `BotResultsReadPort`/`TradeEvidenceReadPort`/`MarketHistoryReadPort` types. Mirror the existing "selects suspicious trades…" test's `botResults`+`tradeEvidence` fakes, set realistic entry/exit ms, and add a `marketHistory` fake:

```ts
describe('researchRunCycleHandler per-trade context', () => {
  const MIN = 60_000;
  function losingBotResults(): BotResultsReadPort {
    return {
      async listBotRuns() {
        return [{ runId: 'r1', mode: 'paper', status: 'finished', strategy: { name: 's', version: '1' }, startedAtMs: 1, finishedAtMs: 2, lastSeenMs: 2, symbols: ['BTCUSDT'] }];
      },
      async getRunSummary() {
        return { runId: 'r1', excludesReconcile: true, asOf: 2, closedTrades: 1, wins: 0, losses: 1, breakeven: 0, winratePct: 0, pnlUsd: '-15', avgPnl: '-15', exitReasons: { stop_loss: 1 } };
      },
      async getClosedTrades() {
        return [{ tradeId: 't-loss-1', runId: 'r1', symbol: 'BTCUSDT', side: 'long', openedAtMs: 200 * MIN, closedAtMs: 240 * MIN, realizedPnl: '-15', pnlPct: '-1.5', isWin: false, closeReason: 'stop_loss' }];
      },
      async getOperationalEvents() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
      async getDecisionLog() { return { items: [], nextCursor: null, asOf: 2, window: {}, freshness: 'fresh' }; },
    };
  }
  function losingBundle() {
    return {
      tradeId: 't-loss-1', runId: 'r1', symbol: 'BTCUSDT', side: 'long' as const,
      enteredAtMs: 200 * MIN, closedAtMs: 240 * MIN, entryPrice: '1.0', exitPrice: '0.9',
      realizedPnl: '-15', pnlPct: '-1.5', holdingDurationMs: 40 * MIN, closeReason: 'stop_loss',
      lifecycleEvents: [], minuteContext: [],
    };
  }
  function historyRows(): CanonicalRowV2[] {
    return Array.from({ length: 260 }, (_, i) => ({
      schema_version: 2 as const, minute_ts: i * MIN, symbol: 'BTCUSDT',
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10, turnover: (100 + i) * 10,
      oi_total_usd: 1000 + i, funding_rate: 0.0001, liq_long_usd: 1, liq_short_usd: 2,
      taker_buy_volume_usd: 6, taker_sell_volume_usd: 4,
      has_oi: true, has_funding: true, has_liquidations: true, has_taker_flow: true,
    }));
  }

  it('attaches per-trade contexts built from the fetched losing bundles', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis ptc')], researchSummary: 's' });
    const tradeEvidence: TradeEvidenceReadPort = { async getTradeEvidence() { return [losingBundle()]; } };
    const marketHistory: MarketHistoryReadPort = { async getRows() { return historyRows(); } };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    const ctxs = cap.captured()?.tradeContexts;
    expect(ctxs?.length).toBe(1);
    expect(ctxs?.[0]?.tradeId).toBe('t-loss-1');
    expect(ctxs?.[0]?.atExit.some((t) => t.config.key === 'micro')).toBe(true);
  });

  it('is fail-soft: a per-trade getRows failure skips that context + emits an event, cycle still completes', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis ptc-fail')], researchSummary: 's' });
    const tradeEvidence: TradeEvidenceReadPort = { async getTradeEvidence() { return [losingBundle()]; } };
    const marketHistory: MarketHistoryReadPort = { async getRows() { throw new Error('history down'); } };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    expect(cap.captured()?.tradeContexts).toBeUndefined();
    expect(await types(services)).toContain('researcher.trade_context_unavailable');
    expect((await types(services)).at(-1)).toBe('research.run_cycle.completed');
  });

  it('omits tradeContexts when there are no losing trades', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis no-losers')], researchSummary: 's' });
    const services = makeServices({ researcher: cap.port }); // default botResults → no trades
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1' }), services);
    expect(cap.captured()?.tradeContexts).toBeUndefined();
  });
});
```

Note: the per-trade `marketHistory.getRows` fake ignores its args and returns a 260-bar 1m series; with `enteredAtMs = 200*MIN` / `closedAtMs = 240*MIN` the engine finds the entry/exit bars inside it → micro term present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: FAIL — `tradeContexts` is never attached; the `researcher.trade_context_unavailable` event is never emitted.

- [ ] **Step 3: Implement the gather block**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`:

Add the imports (next to the existing research-math imports):
```ts
import { buildTradeContextMath, type TradeContextMath } from '../../research-math/trade-context-math.ts';
```

After the existing `tradeEvidence` block (the `try { … getTradeEvidence … } catch { … }`) and before the `marketContextMath` block, add the per-trade gather:

```ts
  const tradeContexts: TradeContextMath[] = [];
  {
    const parsedWarmup = Number(process.env.TRADE_CONTEXT_WARMUP_MIN ?? '150');
    const warmupMin = Number.isFinite(parsedWarmup) && parsedWarmup > 0 ? parsedWarmup : 150;
    for (const b of tradeEvidence) {
      if (b.closedAtMs == null) continue;
      try {
        const fromMs = b.enteredAtMs - warmupMin * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: b.symbol, fromMs, toMs: b.closedAtMs });
        const pnlPctNum = Number(b.pnlPct);
        tradeContexts.push(buildTradeContextMath({
          tradeId: b.tradeId, symbol: b.symbol, rows,
          entryMs: b.enteredAtMs, exitMs: b.closedAtMs,
          realizedPnl: Number(b.realizedPnl), pnlPct: Number.isFinite(pnlPctNum) ? pnlPctNum : null,
          closeReason: b.closeReason,
          direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures,
        }, Date.now()));
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.trade_context_unavailable', { tradeId: b.tradeId, error: errMsg(err) }));
      }
    }
  }
```

Then attach it to the `propose(...)` input via a conditional spread (alongside the existing `marketContextMath` spread):

```ts
    output = await services.researcher.propose({
      profile, marketContext, marketRegime, similarHypotheses, botResults, tradeEvidence, maxHypotheses: effectiveMax,
      ...(marketContextMath && marketContextMath.terms.length > 0 ? { marketContextMath } : {}),
      ...(tradeContexts.length > 0 ? { tradeContexts } : {}),
    }, {
      // ...unchanged opts...
    });
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts && npm run typecheck`
Expected: PASS (the 3 new tests + all existing handler tests) and typecheck exit 0.

- [ ] **Step 5: Run the full suite (no regression)**

Run: `npx vitest run`
Expected: 0 failed; passed count ≥ baseline + all new tests.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(research): gather per-trade context from losing bundles into the researcher input

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after Task 5)

- [ ] `npm run typecheck` → exit 0.
- [ ] `npx vitest run` → 0 failed.
- [ ] `git diff main -- src/research-math/market-context-math.ts` is empty (engine unchanged); `git diff main -- src/research-math/format-market-context-math.ts` shows only `export` additions + the `tableHeaderLines` extraction (no column-string change).
- [ ] `git diff main -- package.json` empty (no new deps).
- [ ] No edit to `PLATFORM_DATA_CAPABILITIES` / critic / refiner agents.

## Task dependency graph

- **Task 1** (engine) → prerequisite for Tasks 2, 4, 5.
- **Task 2** (formatter) depends on Task 1; prerequisite for Task 4.
- **Task 3** (capability menu) is independent — run any time.
- **Task 4** (port + prompt) depends on Tasks 1 & 2.
- **Task 5** (handler) depends on Tasks 1 & 4.
- Suggested order: T1 → T2 → T3 → T4 → T5 (one implementer at a time).
