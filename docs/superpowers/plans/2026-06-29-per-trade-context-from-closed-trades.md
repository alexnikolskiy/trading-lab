# Per-trade context from ops-read ClosedTrades (Slice A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the researcher's per-trade context from the selected losing `ClosedTrade`s (real, via ops-read) instead of the stubbed `TradeEvidenceBundle`s, so it populates end-to-end.

**Architecture:** Handler-only change in `research-run-cycle.handler.ts`: select the worst-N losing trades as objects once (`selectSuspiciousTrades`), derive ids inline for the unchanged forensic `getTradeEvidence` call, and re-source the per-trade gather loop from those `ClosedTrade`s. `buildTradeContextMath`, the formatter, the engine, the capability menu, and `ResearcherInput` are untouched.

**Tech Stack:** TypeScript under `node --experimental-strip-types`; Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-per-trade-context-from-closed-trades-design.md`

## Global Constraints

- Pure handler refactor — only the *source* of per-trade inputs changes; no behavioural change to `buildTradeContextMath`, the formatter, the math engine, `RESEARCHER_CAPABILITIES`, or `ResearcherInput`.
- Forensic trade-evidence (`tradeEvidence` → `forensicBundleText`) behaviour is **unchanged** (its real wiring is Slice B). `getTradeEvidence` still runs with the same ids.
- Fail-soft preserved: a per-trade `getRows`/build failure emits `researcher.trade_context_unavailable` and never fails the cycle.
- Relative imports keep the `.ts` extension. `noUncheckedIndexedAccess` on. Zero new runtime deps.
- BOTH gates green: `npm run typecheck` (exit 0) AND `npx vitest run` (baseline 2373 passed / 0 failed on `main`).

---

### Task 1: Re-source per-trade context from selected losing ClosedTrades

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts`

**Interfaces:**
- Consumes: `buildTradeContextMath`/`TradeContextMath` (existing import), `ClosedTrade` (existing import), `services.marketHistory`, the selected losing trades, `profile`, `marketRegime`.
- Produces: a local `selectSuspiciousTrades(botResults, limit): ClosedTrade[]` (replaces `selectSuspiciousTradeIds`) and per-trade contexts sourced from it.

- [ ] **Step 1: Update the existing per-trade tests to the new source (RED)**

In `src/orchestrator/handlers/research-run-cycle.handler.test.ts`, in the `describe('researchRunCycleHandler per-trade context', …)` block, **change the `tradeEvidence` fake of the first test to return `[]`** (proving per-trade no longer depends on bundles) and rename it. Replace that first test with:

```ts
  it('builds per-trade contexts from the selected losing ClosedTrades even when trade-evidence is empty', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis ptc')], researchSummary: 's' });
    const tradeEvidence: TradeEvidenceReadPort = { async getTradeEvidence() { return []; } }; // mirrors the real stub
    const marketHistory: MarketHistoryReadPort = { async getRows() { return historyRows(); } };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    const ctxs = cap.captured()?.tradeContexts;
    expect(ctxs?.length).toBe(1);
    expect(ctxs?.[0]?.tradeId).toBe('t-loss-1');
    expect(ctxs?.[0]?.atExit.some((t) => t.config.key === 'micro')).toBe(true);
  });
```

(The `losingBotResults`/`historyRows` helpers already exist in this block from the prior slice; `losingBotResults().getClosedTrades()` returns the `t-loss-1` ClosedTrade with `openedAtMs: 200*MIN`, `closedAtMs: 240*MIN`, `symbol: 'BTCUSDT'`. Leave the existing "fail-soft" and "no losing trades" tests in this block unchanged — they remain valid: fail-soft drives `getRows` to throw for the selected `t-loss-1` trade; "no losing trades" uses the default empty `botResults`.)

- [ ] **Step 2: Run the tests to verify the rewritten one fails**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts`
Expected: FAIL on the rewritten test — with the current code the per-trade loop iterates `tradeEvidence` (now `[]`), so `tradeContexts` is `undefined` and `ctxs?.length` is not `1`.

- [ ] **Step 3: Refactor the selector to return trade objects**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`, replace the `selectSuspiciousTradeIds` function with `selectSuspiciousTrades` (drop the final `.map`):

```ts
function selectSuspiciousTrades(botResults: readonly BotRunResultDetail[], limit = TRADE_EVIDENCE_MAX): ClosedTrade[] {
  return botResults
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .slice()
    .sort((a: ClosedTrade, b: ClosedTrade) =>
      Number(a.realizedPnl) - Number(b.realizedPnl)
      || ((b.closedAtMs ?? 0) - b.openedAtMs) - ((a.closedAtMs ?? 0) - a.openedAtMs)
      || a.tradeId.localeCompare(b.tradeId))
    .slice(0, limit);
}
```

- [ ] **Step 4: Select once, derive ids for forensic, re-source the per-trade loop**

Replace the existing `tradeEvidence` block + the per-trade gather block with the following (the `marketContextMath` block and everything after stay unchanged):

```ts
  const suspicious = selectSuspiciousTrades(botResults);

  let tradeEvidence: readonly TradeEvidenceBundle[] = [];
  try {
    if (suspicious.length > 0) {
      tradeEvidence = await services.tradeEvidence.getTradeEvidence({
        tradeIds: suspicious.map((t) => t.tradeId),
        minuteWindowBefore: 20,
        minuteWindowAfter: 180,
      });
    }
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.trade_evidence_unavailable', { error: errMsg(err) }));
    tradeEvidence = [];
  }

  const tradeContexts: TradeContextMath[] = [];
  {
    const parsedWarmup = Number(process.env.TRADE_CONTEXT_WARMUP_MIN ?? '150');
    const warmupMin = Number.isFinite(parsedWarmup) && parsedWarmup > 0 ? parsedWarmup : 150;
    for (const t of suspicious) {
      if (t.closedAtMs == null) continue;
      try {
        const fromMs = t.openedAtMs - warmupMin * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs });
        const pnlPctNum = Number(t.pnlPct);
        const realizedPnlNum = Number(t.realizedPnl);
        tradeContexts.push(buildTradeContextMath({
          tradeId: t.tradeId, symbol: t.symbol, rows,
          entryMs: t.openedAtMs, exitMs: t.closedAtMs,
          realizedPnl: Number.isFinite(realizedPnlNum) ? realizedPnlNum : 0, pnlPct: Number.isFinite(pnlPctNum) ? pnlPctNum : null,
          closeReason: t.closeReason ?? null,
          direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures,
        }, Date.now()));
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.trade_context_unavailable', { tradeId: t.tradeId, error: errMsg(err) }));
      }
    }
  }
```

Notes:
- `ClosedTrade` fields used (`tradeId`, `symbol`, `openedAtMs`, `closedAtMs`, `realizedPnl`, `pnlPct`, `closeReason`) are the same ones `selectSuspiciousTrades`'s sort already reads (`closedAtMs`/`openedAtMs`/`realizedPnl`/`tradeId`) plus `symbol`/`pnlPct`/`closeReason` from the ops-read DTO.
- `closeReason` may be optional/null on `ClosedTrade`; `t.closeReason ?? null` normalises it to `string | null` (the `buildTradeContextMath` input type).
- The forensic `getTradeEvidence(tradeIds)` call keeps the exact same ids as before (`selectSuspiciousTrades(...).map((t) => t.tradeId)` === the old `selectSuspiciousTradeIds(...)`), so the existing forensic test is unaffected.

- [ ] **Step 5: Run handler tests + typecheck to verify pass**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts && npm run typecheck`
Expected: PASS — the rewritten per-trade test (populated from ClosedTrades with empty trade-evidence), the unchanged fail-soft + no-losers tests, and the unchanged "selects suspicious trades and passes forensic tradeEvidence" test all green; typecheck exit 0.

- [ ] **Step 6: Run the full suite (no regression)**

Run: `npx vitest run`
Expected: 0 failed; passed count ≥ baseline (`selectSuspiciousTradeIds` was a private local — no external references break).

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(research): source per-trade context from selected losing ClosedTrades (Slice A)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after Task 1)

- [ ] `npm run typecheck` → exit 0.
- [ ] `npx vitest run` → 0 failed.
- [ ] `git diff main -- src/research-math src/ports src/mastra src/adapters/researcher` is empty (engine/formatter/capability/port/prompt untouched — only the handler + its test change).
- [ ] `git grep -n "selectSuspiciousTradeIds" src` returns nothing (fully renamed); `git diff main -- package.json` empty.

## Task dependency graph

- Single task. No dependencies.
