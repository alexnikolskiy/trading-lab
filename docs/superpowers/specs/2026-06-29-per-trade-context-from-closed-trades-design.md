# Design: source per-trade context from ops-read ClosedTrades (Slice A)

- **Date:** 2026-06-29
- **Status:** Approved approach (chosen during live-demo verification) → ready for plan
- **Owner:** Alexander Nikolskiy
- **Parent:** PR #107 (per-trade market-context math, on `main`). Live-demo verification on the real LLM (gpt-5.5) showed the per-trade context never populated.
- **Scope:** Re-source the per-trade context from the selected losing **`ClosedTrade`** records (real, already fetched via ops-read) instead of the `TradeEvidenceBundle`s. Decouples the just-shipped per-trade feature from the unwired trade-evidence path so it populates end-to-end. Forensic trade-evidence (lifecycle + minute context) stays as-is — its real wiring is **Slice B** (separate).

---

## 1. Problem (verified on the live demo)

In the real research cycle, `buildPrompt` carried the symbol-level `marketContextMath` (all 4 terms, all indicators) and the `RESEARCHER_CAPABILITIES` menu — and gpt-5.5 visibly used them (hypotheses referencing Pivots `pivot_pp`/`r1`, `squeeze == 'ON'` + `squeeze_momentum_trend`, ATR, Bollinger %B, ADX/DI, CVD, OI delta, EMA, funding). **But the per-trade context (and forensic evidence) was empty:** `INPUT SUMMARY` showed `selected losers=5` yet `tradeEvidence bundles=0 → tradeContexts=0`.

**Root cause:** `composition.ts` wires `tradeEvidence: new MockTradeEvidenceAdapter()` — a hardcoded stub that returns a bundle only for the magic `tradeId === 'mock_trade_001'`, and `[]` for any real id. There is no real/HTTP `TradeEvidenceReadPort` at all. The handler's per-trade gather iterates those (empty) bundles, so `tradeContexts` is always empty with real trades — independent of the mock-platform (whose ops-read `/ops/trades` *does* serve the 5 real losers, 3 on ESPORTSUSDT, with fixture history).

**Key insight:** `buildTradeContextMath` only needs `symbol`, `entryMs`, `exitMs`, `realizedPnl`, `pnlPct`, `closeReason` — **all present on the ops-read `ClosedTrade`** the handler already fetches (`symbol`, `openedAtMs`, `closedAtMs`, `realizedPnl`, `pnlPct`, `closeReason`). The bundle was just a convenient carrier; the `ClosedTrade` is the authoritative, real source.

---

## 2. Goals / non-goals

**Goals**
1. Build per-trade context from the **selected worst-N losing `ClosedTrade`s** (the same set `selectSuspiciousTradeIds` already picks), not from the trade-evidence bundles.
2. Per-trade context populates end-to-end on the demo (real ops-read losers → real history windows → real indicator snapshots), with no dependency on the unwired trade-evidence path.
3. No change to `buildTradeContextMath`, the formatter, the engine, `RESEARCHER_CAPABILITIES`, or `ResearcherInput.tradeContexts` — only the handler's *source* of per-trade inputs changes.
4. Fail-soft preserved; both gates green.

**Non-goals**
- Forensic trade-evidence (`tradeEvidence` → `forensicBundleText`) stays exactly as today (stubbed-empty in the demo). Wiring a real `TradeEvidenceReadPort` (lifecycle + minute context) is **Slice B**.
- No change to `getTradeEvidence` / `selectSuspiciousTradeIds`'s id semantics (the forensic path keeps fetching the same ids).
- No mock-platform change.

---

## 3. Design (handler-only change)

In `src/orchestrator/handlers/research-run-cycle.handler.ts`:

1. **Select the losing trades once, as objects.** Refactor `selectSuspiciousTradeIds(botResults, limit)` → `selectSuspiciousTrades(botResults, limit): ClosedTrade[]` (same filter `realizedPnl < 0`, same sort: pnl asc, then holding-duration desc, then `tradeId`, same `slice(0, limit)`) returning the `ClosedTrade[]`. At the `getTradeEvidence` call site derive ids inline: `suspicious.map((t) => t.tradeId)` — the forensic path's behaviour is byte-unchanged.

2. **Drive the per-trade gather from the selected `ClosedTrade`s, not the bundles.** Replace `for (const b of tradeEvidence)` with `for (const t of suspicious)`:
   - skip when `t.closedAtMs == null` (open trade — no exit bar to anchor the @exit snapshot);
   - window = `[t.openedAtMs − warmupMin·60_000, t.closedAtMs]`;
   - `rows = marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs })`;
   - `buildTradeContextMath({ tradeId: t.tradeId, symbol: t.symbol, rows, entryMs: t.openedAtMs, exitMs: t.closedAtMs, realizedPnl: <finite Number(t.realizedPnl) else 0>, pnlPct: <finite Number(t.pnlPct) else null>, closeReason: t.closeReason ?? null, direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures }, Date.now())`.
   - per-trade `try/catch` emitting `researcher.trade_context_unavailable` (unchanged); never fails the cycle.

3. **Everything else unchanged:** `tradeEvidence = getTradeEvidence(ids)` still runs and is still passed to `propose` (forensic path, Slice B); the `marketContextMath` block; the conditional `tradeContexts` spread; the env `TRADE_CONTEXT_WARMUP_MIN` (150).

`ClosedTrade` fields used (from `@trading-platform/sdk/ops-read`, re-exported through `bot-results-read.port.ts`): `tradeId`, `symbol`, `openedAtMs`, `closedAtMs: number | null`, `realizedPnl: string`, `pnlPct: string`, `closeReason: string | null` — all already referenced by the existing selection sort.

---

## 4. Testing

- **Handler — per-trade now populates from ClosedTrades even when the trade-evidence stub is empty:** wire `botResults` with losing closed trades (the existing test's fakes), a `marketHistory` fake returning a 1m series spanning the trade window, and a `tradeEvidence` fake returning `[]` (mirrors the real stub). Assert `cap.captured()?.tradeContexts` length = number of closed losers, `tradeId`/`symbol` correct, micro term present in `atExit`.
- **Fail-soft unchanged:** per-trade `getRows` throw → that trade skipped + `researcher.trade_context_unavailable` event + cycle reaches `research.run_cycle.completed`.
- **No losers → no `tradeContexts`.**
- **Forensic path intact:** the existing "selects suspicious trades and passes forensic tradeEvidence" test still passes (ids derived from `selectSuspiciousTrades` match the previous `selectSuspiciousTradeIds` output).
- **Both gates:** `npm run typecheck` exit 0 + `npx vitest run` green.

---

## 5. Success criteria

1. With real ops-read losers + fixture history (and the trade-evidence stub returning `[]`), `tradeContexts` is non-empty and carries real indicator snapshots per losing trade.
2. `buildTradeContextMath` / formatter / engine / capability menu / `ResearcherInput` shape are untouched.
3. Forensic trade-evidence behaviour is unchanged (Slice B will wire it).
4. Fail-soft holds; typecheck exit 0; full suite green.
