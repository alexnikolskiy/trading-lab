# Design: `commitXTermMath` — market-context math block for the researcher

- **Date:** 2026-06-28
- **Status:** Approved design (brainstorming complete) → ready for implementation plan
- **Owner:** Alexander Nikolskiy
- **Scope of this spec:** Sub-project 1 only (the lab-side math engine + data plumbing + integration). Sub-projects 2 and 3 (below) get their own specs.

---

## 1. Context & problem

The strategy researcher (`ResearcherPort`) proposes hypotheses of the form *"when `<market condition>` → overlay action"* with `expectedEffect` / `invalidationCriteria`. Today the only market signal it receives is `marketContext.features` serialized as a **raw `JSON.stringify`** blob of three scalars (`oi`, `funding`, `cvd`) plus a hardcoded `marketRegime: 'ranging'`. The agent has almost no quantitative ground to anchor a `when`-condition on.

We want a **`commitXTermMath`** capability (conceptually borrowed from `@backtest-kit/signals`, **clean-room, no runtime dependency**): compute a full set of indicators + derivatives over real market history and render **one structured markdown block per timeframe-term** that is injected into the researcher prompt and committed as an artifact next to the research run.

### 1.1 Ground truth (audit result)

The data needed for honest indicators exists upstream but is **not surfaced into lab today**:

| Layer | OHLCV | oi / funding / liq | taker (→ CVD) | Cadence | Reachable by lab? |
|---|---|---|---|---|---|
| Type `CanonicalRowV2` (`@trading-platform/sdk/historical`) | ✓ | ✓ | ✓ `taker_buy/sell_volume_usd` + `has_taker_flow` | 1m | n/a (contract) |
| Real platform `/historical/rows` (VPS) | ✓ | ✓ | ✓ | **1m** | via SDK `HistoricalClient.queryRows` |
| mock fixtures `real-top5` / `real-all` / `synthetic` | **1h/1d only** | ✓ per-minute | ✗ `null` | 1h | via mock `:8839/historical/rows` |
| mock `historical-golden` | ✓ | ✓ | ✓ | 1m (**only 30 rows**) | same |

Key facts:
- `CanonicalRowV2` (19-field frozen contract) is the rich superset: `open/high/low/close/volume/turnover/oi_total_usd/funding_rate/liq_long_usd/liq_short_usd/taker_buy_volume_usd/taker_sell_volume_usd` + `has_oi/has_funding/has_liquidations/has_taker_flow`. **CVD is derived from `taker_buy − taker_sell`, never stored.**
- lab already **vendors** `@trading-platform/sdk@0.7.2` including `@trading-platform/sdk/historical` → `HistoricalClient.queryRows({symbols, fromMs, toMs}) → AsyncIterable<CanonicalRowV2[]>`, but **imports it nowhere**. The mock serves `GET /historical/rows` at `mock-platform:8839` in the demo stack (fixture baked into image).
- The mock data-acquisition tool (`fetch-snapshot`) aggregates OHLC only to `1h/1d` and **never fetches taker**, so the committed demo fixtures are coarse; only the tiny `historical-golden` (30×1m) has full fidelity. This is why the engine must be **data-driven and coverage-honest** (compute what the data supports, mark the rest `n/a`), and why a richer committed fixture is a fast-follow (Sub-project 2).
- lab has no existing indicator/math code (`ema/rsi/atr/sma/cvd` = 0 hits) — clean slate, nothing to duplicate.
- lab has an artifact mechanism: `ArtifactStore.put(...) → ArtifactRef` (`LocalFileArtifactStore`, `InMemoryArtifactStore`).

### 1.2 Reference verdict (`@backtest-kit/signals`)

Port **conceptually** (clean-room): the `commit<Term>TermMath` family pattern ("append one markdown section per term to the LLM context"), the 4-term Micro/Short/Swing/Long model, and the indicator math (Wilder smoothing, `undefined`-during-warmup). **Do not** port: the runtime deps (`trading-signals`, DI kits), the signal-graph DAG, the order-book block (we have no L2), or GARCH-now (deferred to Phase F).

---

## 2. Goals / non-goals

**Goals**
1. A pure, deterministic, dependency-free math engine over `CanonicalRowV2[]` producing a typed `MarketContextMath`.
2. A markdown renderer `formatMarketContextMath` that emits a structured, LLM-friendly, human-readable block (summary + per-term tables), one section per term à la `commit<Term>TermMath`.
3. A read path (`MarketHistoryReadPort`) that surfaces real OHLCV+oi+funding+taker+liq minute history into lab via the already-vendored `HistoricalClient`.
4. Integration into `ResearcherInput` + the mastra prompt builder, replacing the raw features JSON; commit the rendered markdown as an artifact (+ Phoenix).
5. **Coverage-honest**: render only data-supported terms/columns; explicitly mark missing data (`n/a`), never fabricate.

**Non-goals (this spec)**
- GARCH(1,1) → Phase F (after core ships).
- The DCA signal-graph (volume-anomaly Hawkes/CUSUM/BOCPD) → Sub-project 3 (needs a new tick/aggTrade source not present in `CanonicalRowV2`).
- A richer committed 1m+taker mock fixture → Sub-project 2 (mock-platform repo).
- The long tail of rare indicators (CCI/DEMA/WMA/Squeeze/Pressure/pivots) → Phase E iteration.
- Changing `getMarketContext`/`MarketRegime` semantics (they stay the regime snapshot).

---

## 3. Architecture & data flow

```
research-run-cycle.handler.ts
  ├─ platform.getMarketContext / getMarketRegime         (unchanged: regime snapshot)
  ├─ marketHistory.getRows({symbol, fromMs, toMs})  ──►  readonly CanonicalRowV2[]      [Phase B]
  │      (HttpMarketHistoryAdapter → SDK HistoricalClient.queryRows; graceful try/catch)
  ├─ buildMarketContextMath({rows, direction, regime, requiredFeatures, window}, nowMs)  [Phase C+D]
  │      → MarketContextMath  (pure, deterministic)
  ├─ artifactStore.put(formatMarketContextMath(math))  → ArtifactRef   (commit + Phoenix) [Phase E]
  └─ researcher.propose({ ..., marketContextMath }, onUsage)                              [Phase E]
                                   │
                                   ▼
        mastra-researcher.ts buildPrompt(input)
          └─ if input.marketContextMath: inject formatMarketContextMath(it)
             REPLACING the raw `JSON.stringify(features)` line (fallback to raw line if absent)
```

**Module layout (new, lab):**
```
src/ports/market-history-read.port.ts            # MarketHistoryReadPort + re-exported CanonicalRowV2 DTO   [B]
src/adapters/platform/http-market-history.adapter.ts   # wraps SDK HistoricalClient (drains queryRows)      [B]
src/adapters/platform/select-market-history.ts   # selector (mirrors select-bot-results.ts)                 [B]
src/research-math/indicators/                     # ema, rsi, atr, sma, macd, bollinger, stochastic, adx, realized-vol, fibonacci, cvd, oi-delta  [C]
src/research-math/resample.ts                     # pure 1m→tf bar aggregation                               [C]
src/research-math/term-config.ts                  # typed TERM_CONFIGS table                                 [C]
src/research-math/market-context-math.ts          # buildMarketContextMath + types                           [D]
src/research-math/format-market-context-math.ts   # formatMarketContextMath(markdown)                        [D]
```

---

## 4. Data plumbing — `MarketHistoryReadPort` (Phase B)

Best-fit per audit: a **new dedicated read port** backed 1:1 by the vendored SDK, not an extension of the trade-scoped `TradeMinuteContextPoint` or the snapshot-shaped `MarketContext`.

```ts
// src/ports/market-history-read.port.ts
import type { CanonicalRowV2 } from '@trading-platform/sdk/historical'; // re-export, per sdk-import-boundary guard
export type { CanonicalRowV2 };

export interface MarketHistoryWindow {
  readonly symbol: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface MarketHistoryReadPort {
  /** Canonical rows for [fromMs, toMs], ascending by minute_ts, deduped (last-wins). May be []. */
  getRows(window: MarketHistoryWindow): Promise<readonly CanonicalRowV2[]>;
}
```

- **Adapter** `HttpMarketHistoryAdapter` drains `HistoricalClient.queryRows({symbols:[symbol], fromMs, toMs})` (AsyncIterable pages) into a sorted, deduped array. The SDK import lives only in the adapter; the DTO is re-exported through the port — this satisfies `sdk-import-boundary.guard.test.ts` (same convention as `bot-results-read.port.ts`).
- **Selector** `select-market-history.ts` mirrors `select-bot-results.ts:28` (base URL + token from env). Reuse `mock-platform:8839` in demo; env var e.g. `LAB_MARKET_HISTORY_URL` (default to the ops-read URL) + token (`MOCK_OPS_TOKEN`).
- **Wiring:** register `marketHistory` in `app-services.ts`; construct in the `composition.ts` adapter block; add docker env passthrough.
- **Window default:** lookback configurable via `MARKET_HISTORY_LOOKBACK_DAYS` (default 7 — enough for ~100×1h Long-term bars; real-top5 spans ~6.6 days). Handler computes `fromMs = toMs − lookback`.
- **Degradation:** handler wraps `getRows` in try/catch (like `botResults`/`tradeEvidence`): on error/empty → omit `marketContextMath`, emit `researcher.market_history_unavailable`, continue.

---

## 5. The math engine (Phase C) — pure & clean-room

All functions are pure (no I/O, no `Date.now`/`Math.random`), deterministic, unit-tested. Wilder smoothing where standard; indicators return `null`/`undefined` during warmup (never `NaN`). Formulas adapted clean-room from the public reference and `trading-backtester`'s indicator catalog (we own the code).

**Indicator set (v1 — strong core; long tail deferred to Phase E):**
- Price/momentum: `ema(values, period)` (seed = SMA of first `period`, mult `2/(p+1)`), `sma`, `rsi(values, period)` (Wilder RMA, close-to-close), `macd(values, fast, slow, signal)`, `stochastic(highs, lows, closes, k, d, smooth)`, `adx(highs, lows, closes, period)`.
- Volatility: `atr(highs, lows, closes, period)` (Wilder, TR = max(h−l, |h−prevC|, |l−prevC|)) — **real ATR, requires OHLC**; `realizedVol(closes, window)` = stddev of close-to-close pct returns (always available).
- Bands/levels: `bollinger(values, period, k)` (upper/mid/lower + %B + bandwidth), `fibonacci(swingHigh, swingLow)` (retracements 0/23.6/38.2/50/61.8/78.6/100 + ext 127.2/161.8).
- Derivatives: `oiDelta(oiSeries)` (per-bar + window pct change), `cvd(takerBuys, takerSells)` (cumulative `Σ(buy−sell)`; **requires taker**), liquidation aggregates (sum long/short + imbalance `(L−S)/(L+S)`).

**Resampling** `resampleRows(rows, tfMs): CanonicalRowV2[]` — pure aggregation of finer canonical rows into coarser bars: OHLC = first-open/max-high/min-low/last-close; `volume`/`turnover`/`liq_*`/`taker_*` summed; `oi_total_usd`/`funding_rate` = last; `has_*` = OR over the bucket. Bucket boundary = `floor(minute_ts / tfMs) * tfMs`.

**Term config** (typed table; data-driven inclusion):
```ts
export type TermKey = 'micro' | 'short' | 'swing' | 'long';
export interface TermConfig {
  readonly key: TermKey; readonly label: string; readonly tfMs: number;
  readonly maxRows: number; readonly minBars: number;
  readonly emaFast: number; readonly emaSlow: number; readonly rsiPeriod: number;
  readonly atrPeriod: number; readonly macd: readonly [number, number, number];
  readonly bbPeriod: number; readonly bbK: number;
  readonly stoch: readonly [number, number, number]; readonly adxPeriod: number;
}
// TERM_CONFIGS: micro 1m, short 5m, swing 15m, long 1h (clean ×5/×3/×4 ladder from 1m),
// per-term period tuning (faster on micro/short, standard on swing/long).
```
A term is **rendered only if** source native cadence `tfMs ≤ term.tfMs` (can't upsample) **and** resampled `barCount ≥ term.minBars`. So: real platform 1m → all 4 terms; mock real-top5 1h → only `long`; golden 1m → `micro` (others thin/dropped). Native cadence is inferred as the smallest gap between consecutive `minute_ts` in the source rows (the resampler never upsamples below it). Dropped terms produce a `notes` line explaining why.

---

## 6. Data model (Phase D)

```ts
export interface CoverageFlags {
  readonly hasOhlc: boolean;          // open/high/low present → real ATR/Fibonacci/Stoch/ADX
  readonly hasOi: boolean;
  readonly hasFunding: boolean;
  readonly hasLiquidations: boolean;
  readonly hasTaker: boolean;         // → real CVD
}

export interface TermMathRow {        // compact per-bar row (last maxRows)
  readonly tsMs: number;
  readonly open: number | null; readonly high: number | null;
  readonly low: number | null;  readonly close: number;
  readonly volume: number | null;
  readonly emaFast: number | null; readonly emaSlow: number | null;  // periods from TermConfig; concrete period shown in the markdown header
  readonly rsi: number | null; readonly atr: number | null;
  readonly oi: number | null; readonly oiDelta: number | null;
  readonly cvd: number | null;        // cumulative; null when !hasTaker
  readonly liqLong: number | null; readonly liqShort: number | null;
}

export interface TermIndicatorSnapshot {   // latest reads + structural levels (the summary line)
  readonly close: number;
  readonly emaFast: number | null; readonly emaSlow: number | null;
  readonly emaTrend: 'above' | 'below' | 'cross' | 'unknown';
  readonly rsi: number | null; readonly rsiState: 'overbought' | 'oversold' | 'neutral' | 'unknown';
  readonly atr: number | null; readonly realizedVol: number | null;
  readonly macd: { line: number; signal: number; hist: number } | null;
  readonly bollinger: { upper: number; mid: number; lower: number; pctB: number; bandwidth: number } | null;
  readonly stochastic: { k: number; d: number } | null;
  readonly adx: { adx: number; plusDi: number; minusDi: number } | null;
  readonly fibonacci: { swingHigh: number; swingLow: number; levels: Record<string, number> } | null;
  readonly oiChangePct: number | null; readonly funding: number | null;
  readonly cvdNet: number | null; readonly cvdTrend: 'rising' | 'falling' | 'flat' | 'unknown';
  readonly liqLongTotal: number | null; readonly liqShortTotal: number | null; readonly liqImbalance: number | null;
  // readonly garch?: { sigmaForecast: number; expectedMovePct: number } | null;  // Phase F
}

export interface TermMath {
  readonly config: TermConfig;
  readonly barCount: number;                       // bars available pre-trim
  readonly rows: readonly TermMathRow[];           // last config.maxRows
  readonly indicators: TermIndicatorSnapshot;
  readonly coverage: CoverageFlags;
}

export interface MarketContextMath {
  readonly symbol: string;
  readonly generatedAtMs: number;                  // passed in (pure fn stays deterministic)
  readonly window: { fromMs: number; toMs: number };
  readonly direction: Direction;                   // from profile → direction-aware summary
  readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];    // profile.requiredMarketFeatures → highlighted
  readonly coverage: CoverageFlags;                // overall (union)
  readonly terms: readonly TermMath[];             // only data-supported terms
  readonly notes: readonly string[];               // honest coverage notes
}

export interface MarketContextMathInput {
  readonly symbol: string;
  readonly rows: readonly CanonicalRowV2[];
  readonly direction: Direction;
  readonly regime: MarketRegime;
  readonly requiredFeatures: readonly string[];
  readonly window: { fromMs: number; toMs: number };
  readonly terms?: readonly TermConfig[];          // default TERM_CONFIGS
}
export function buildMarketContextMath(input: MarketContextMathInput, nowMs: number): MarketContextMath;
```

Design rationale: per-row table stays **compact and high-signal** (price + EMA/RSI/ATR + OI/OIΔ/CVD/liq); the richer indicators (MACD, Bollinger, Stochastic, ADX, Fibonacci) live in the **per-term summary** as latest reads + levels. This mirrors backtest-kit (focused table + summary), preserves LLM attention, and bounds prompt tokens.

---

## 7. Markdown format (Phase D) — `formatMarketContextMath`

Built dep-free with `string[].join('\n')` (mirrors `scripts/builder-eval.ts::renderMarkdownReport`). One `###` section per rendered term.

````markdown
## Market Context: BTCUSDT — regime: ranging · bias: long
Required features: oi, funding, cvd
Coverage: OHLC ✓ · OI ✓ · funding ✓ · liquidations ✓ · taker ✗ → CVD n/a
Window: 2026-06-21 00:00 → 2026-06-28 00:00 (7d)

### Micro (1m) · 10080 bars
Trend EMA9>EMA21 (up) · RSI14 52 (neutral) · ATR14 18.3 · realizedVol 0.21% · MACD 4.1/3.7/+0.4 · BB %B 0.61 bw 1.2% · Stoch 68/61 · ADX 22 (+DI 25 −DI 18) · Fib 0.618=94 850 · OIΔ +1.4% · CVD n/a · liq L/S 50k/30k (imb +0.25) · funding 0.0001
| ts | open | high | low | close | vol | ema9 | ema21 | rsi14 | atr14 | oi | oiΔ | cvd | liqL | liqS |
|----|------|------|-----|-------|-----|------|-------|-------|-------|----|-----|-----|------|------|
| 23:31 | … | … | … | … | … | … | … | … | … | … | … | n/a | … | … |
… last 30 rows …

### Long (1h) · 168 bars
… summary + table (the ema/rsi/atr headers show this term's own periods) …

> Notes: taker flow absent in this source → CVD/taker columns shown as n/a. (When the source cadence is coarser than a term's timeframe — e.g. a 1h-only fixture — that term is skipped with its own note.)
````

Rules: numbers rounded to instrument-sensible precision; `n/a` for unavailable columns; never invent values; `> Notes:` block lists every coverage gap and skipped term.

---

## 8. Integration (Phase E)

- **`ResearcherInput`** (`src/ports/researcher.port.ts`): add `readonly marketContextMath?: MarketContextMath;` (additive-optional → existing fixtures/tests unaffected).
- **`buildPrompt`** (`src/adapters/researcher/mastra-researcher.ts:107-124`): when `input.marketContextMath` is present, inject `formatMarketContextMath(input.marketContextMath)` **in place of** the raw `Market context features: ${JSON.stringify(features)}` line (line 118). When absent (onboarding / read failure) → keep the existing raw-features line as fallback. Update the `buildPrompt` snapshot test.
- **Handler** (`src/orchestrator/handlers/research-run-cycle.handler.ts`): after `getMarketContext`/`getMarketRegime`, fetch rows via `marketHistory.getRows`, build the math, attach to the `propose(...)` input. Graceful try/catch + event on failure.
- **Artifact / "commit"** (the `commit` in `commitXTermMath`): persist `formatMarketContextMath(math)` via `artifactStore.put(...)` → `ArtifactRef` stored alongside the research run, and attach to the Phoenix trace (observability already shipped). Side-effect-free with respect to the proposal itself; failure to commit must not fail the cycle.
- **Fake adapter** is prompt-blind (unchanged) — no effect, acceptable.
- **Token cost:** the block adds input tokens; bounded by `maxRows` per term + term count. Respect the existing research-cycle token budget; note the size delta in the plan.

---

## 9. Cross-cutting principles

- **Determinism:** `buildMarketContextMath` and `formatMarketContextMath` are pure; the wall-clock timestamp is passed in (`nowMs`). This makes them snapshot-testable and replay-safe.
- **Coverage honesty:** every `null`/missing field is driven by the `has_*` coverage flags on the source rows, surfaced in `CoverageFlags`, and explained in `notes`. No silent zero-fill, no fabricated proxies presented as real.
- **No-lookahead:** windows are strictly backward (`[fromMs, toMs]`, ascending); indicators consume only past-and-current bars. (Matches the SDK `PointInTimeMarketApi` discipline for the day this feeds decisions.)
- **Clean-room:** zero new runtime dependencies; all math is our code.

---

## 10. Decomposition (3 sub-projects)

1. **`commitXTermMath` (lab) — THIS spec.** Port + engine + format + integration. Data-driven; validated on `historical-golden` + unit fixtures + (when available) the real platform.
2. **Richer 1m+taker mock fixture (trading-mock-platform) — fast-follow, own spec.** Extend `fetch-snapshot` to acquire taker + emit dense 1m `rowsBySymbol`; commit a multi-thousand-row fixture so the **demo shows full multi-term + CVD**. (Chosen sequencing: engine-first, this follows immediately.)
3. **GARCH + DCA signal-graph (future) — own spec.** GARCH(1,1) is Phase F of *this* spec's roadmap (volatility forecast for DCA). The full volume-anomaly graph (Hawkes / CUSUM / BOCPD reversal source + GARCH source + `outputNode` DCA trigger) is a **separate** project that needs a **new tick/aggTrade data source** (not present in `CanonicalRowV2`, whose taker is per-minute-bucketed) and strict non-overlapping train/detect windows (look-ahead discipline).

---

## 11. Phase roadmap (Sub-project 1)

- **Phase A — Audit.** ✅ done (this document's §1).
- **Phase B — Data plumbing.** `MarketHistoryReadPort` + `HttpMarketHistoryAdapter` (drains `HistoricalClient.queryRows`) + selector + app-services/composition wiring + docker env + guard compliance. Tests: adapter mapping + boundary guard green.
- **Phase C — Math engine.** Pure indicators (`indicators/*`), `resample.ts`, `term-config.ts`. TDD, one unit suite per indicator (warmup → `null`, known-value vectors, Wilder correctness).
- **Phase D — Assembly + format.** `buildMarketContextMath` + `formatMarketContextMath`. Snapshot tests across coverage scenarios (full 1m+taker; 1h no-taker; empty).
- **Phase E — Integration.** `ResearcherInput` field + `buildPrompt` injection (replace raw JSON, fallback retained) + handler wiring + artifact commit + Phoenix. Update `buildPrompt`/handler tests. Then iterate the indicator long tail (CCI/DEMA/WMA/…) by demand.
- **Phase F — GARCH(1,1).** Volatility forecast (expected-move %) in the term summary, for DCA reasoning. Separate PR after core ships.

---

## 12. Testing strategy

- **Indicators:** pure unit tests with reference vectors; assert `null` during warmup, correct Wilder smoothing, no `NaN`.
- **Resample:** deterministic bucket aggregation tests (OHLC/sum/last/OR semantics, boundary alignment).
- **Builder:** coverage-scenario tests — full-fidelity (golden-like 1m+taker), coarse (1h, taker null → CVD n/a, only `long` term), empty (→ no terms, notes explain).
- **Formatter:** snapshot tests of the markdown per scenario; assert `n/a` rendering + `Notes` completeness.
- **Integration:** `buildPrompt` snapshot with/without `marketContextMath`; handler graceful-degradation on read failure; artifact commit asserted via `InMemoryArtifactStore`.
- **Determinism:** same input + `nowMs` → byte-identical markdown.

---

## 13. Success criteria

1. `formatMarketContextMath` output is a single coherent markdown block, human- and LLM-readable, with explicitly named indicators (no magic feature names) and honest `n/a` for missing data.
2. Real ATR and real CVD are computed when the source carries OHLC / taker (verified against `historical-golden` and/or the real platform).
3. Multi-term sections render exactly the terms the data supports; skipped terms are explained.
4. The block replaces the raw features JSON in the researcher prompt and is committed as an `ArtifactRef` next to the run.
5. Pure math layer: zero new runtime deps, fully deterministic, unit-covered.
6. No regression to fake/mastra adapters or existing researcher tests.

---

## 14. Risks & open questions

- **Demo fidelity gap:** until Sub-project 2 lands, the docker demo (real-top5, 1h, no taker) renders only the `long` term with CVD `n/a`. Accepted (engine-first decision); golden + real platform exercise full fidelity.
- **`queryRows` cadence:** assumed to return native canonical rows (1m real / synthesized 1h mock). If the mock’s `/historical/rows` paginates large windows slowly, bound the window/symbols; confirm in Phase B.
- **Token budget:** the block enlarges the prompt; `maxRows`×terms must stay within the research-cycle token budget. Tune `maxRows` in Phase E.
- **Precision/units:** USD-notional for oi/turnover/liq/taker, base-asset for volume, 8h-equiv funding — render with sensible rounding; document units in the block header.
- **Artifact write API:** exact `ArtifactStore.put` signature + Phoenix attach to be pinned in the plan (mechanism confirmed to exist).

---

## 15. Decisions log

| # | Decision | Choice |
|---|---|---|
| Q1 | Row schema given missing per-minute funding/taker (pre-audit) | Superseded — real data exists upstream; surface it, don't approximate |
| Q2 | Volatility measure | Real ATR from OHLC (data exists) + realizedVol; no proxy |
| Q3 | Multi-timeframe terms | Real multi-term, data-driven inclusion (source already multi-TF) |
| Q4 | Integration shape | Structured `marketContextMath` in `ResearcherInput` + format in adapter (à la `commit<Term>TermMath`); clean-room, no import |
| Q5 | Demo data gap | Engine-first + richer mock fixture as immediate fast-follow (Sub-project 2) |
| Q6 | GARCH timing | Core now; GARCH(1,1) as Phase F |
| Q7 | Indicator breadth | Strong core in v1; long tail (CCI/DEMA/WMA/…) in Phase E iteration |
