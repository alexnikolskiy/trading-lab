# Per-trade post-exit tail + exit-quality framing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend each losing trade's per-trade window with a post-exit tail (default 60 min), surface a `@post` indicator snapshot + a micro table spanning the exit transition, and frame the researcher to reason about exit quality.

**Architecture:** Handler fetches the per-trade window through `exit + tail`; `buildTradeContextMath` adds an `atPostExit` snapshot (engine on the full rows) + re-anchors the micro table to `[exit−10m, exit+tail]`; the formatter renders `@post` lines + marks the exit row; `RESEARCHER_CAPABILITIES` gains the @entry/@exit/@post + exit-quality framing. Reuses the existing engine.

**Tech Stack:** TypeScript under `node --experimental-strip-types`; Vitest; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-29-per-trade-post-exit-tail-design.md`

## Global Constraints

- Reuse the engine — no new indicator/resample/format math; `buildTradeContextMath` orchestrates `buildMarketContextMath`.
- Do NOT change the symbol-level `marketContextMath`, the math engine internals, the shared `TERM_CONFIGS` export, or Slice B's forensic path. The per-call micro `maxRows` bump must be LOCAL to the per-trade build (do not mutate `TRADE_TERM_CONFIGS`/`TERM_CONFIGS`).
- Losers-only (no winning-trade selection); exit hypotheses use existing overlay actions (no new actions).
- Env `TRADE_CONTEXT_TAIL_MIN` default 60, guarded `Number.isFinite && >0` (mirrors the warmup guard). Pure/deterministic (`nowMs` injected); coverage-honest (`@post n/a` when no tail bars); fail-soft owned by the handler.
- Relative imports keep `.ts`. `noUncheckedIndexedAccess` on. Zero new runtime deps.
- BOTH gates green: `npm run typecheck` (exit 0) AND `npx vitest run` (baseline 2388 passed / 0 failed on `main`).

---

### Task 1: Handler — fetch the post-exit tail

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts`
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (append)

**Interfaces:**
- Consumes: existing per-trade gather loop (`suspicious` ClosedTrades, `services.marketHistory.getRows`).
- Produces: per-trade `getRows` window extended to `closedAtMs + tailMin·60_000`.

- [ ] **Step 1: Write the failing test**

Append to the `describe('researchRunCycleHandler per-trade context', …)` block in `research-run-cycle.handler.test.ts` (it already has `losingBotResults`/`historyRows` helpers; `losingBotResults().getClosedTrades()` returns `t-loss-1` with `openedAtMs: 200*MIN`, `closedAtMs: 240*MIN`):

The per-trade `getRows` and the symbol-level `marketContextMath` `getRows` both fire (different `toMs`), so capture ALL `toMs` and assert the array CONTAINS the per-trade tail value (avoids depending on call order):

```ts
  it('extends the per-trade getRows window by the post-exit tail (default 60m)', async () => {
    const cap = capturingResearcher({ hypotheses: [draft('thesis tail')], researchSummary: 's' });
    const toMsSeen: number[] = [];
    const marketHistory: MarketHistoryReadPort = {
      async getRows(q) { toMsSeen.push(q.toMs); return historyRows(); },
    };
    const services = makeServices({ researcher: cap.port, botResults: losingBotResults(), tradeEvidence: { async getTradeEvidence() { return []; } }, marketHistory });
    await seedProfile(services);
    await researchRunCycleHandler(task({ strategyProfileId: 'p1', symbol: 'BTCUSDT' }), services);
    expect(toMsSeen).toContain(240 * MIN + 60 * MIN); // per-trade window = closedAtMs + 60min tail
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "post-exit tail"`
Expected: FAIL — the per-trade `getRows` currently uses `toMs: t.closedAtMs` (no tail), so `240*MIN+60*MIN` is never seen.

- [ ] **Step 3: Add the tail to the per-trade window**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`, in the per-trade gather block, add a `tailMin` next to `warmupMin` and use it in `getRows`:

```ts
    const parsedWarmup = Number(process.env.TRADE_CONTEXT_WARMUP_MIN ?? '150');
    const warmupMin = Number.isFinite(parsedWarmup) && parsedWarmup > 0 ? parsedWarmup : 150;
    const parsedTail = Number(process.env.TRADE_CONTEXT_TAIL_MIN ?? '60');
    const tailMin = Number.isFinite(parsedTail) && parsedTail > 0 ? parsedTail : 60;
    for (const t of suspicious) {
      if (t.closedAtMs == null) continue;
      try {
        const fromMs = t.openedAtMs - warmupMin * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs + tailMin * 60_000 });
        // ...rest of the loop body unchanged (buildTradeContextMath call etc.)...
```

(Only the two `tailMin` lines and the `toMs:` expression change; the rest of the loop is unchanged.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts && npm run typecheck`
Expected: PASS (new tail test + existing per-trade/handler tests) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(research): fetch a post-exit tail for the per-trade window (TRADE_CONTEXT_TAIL_MIN)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `buildTradeContextMath` — `atPostExit` snapshot + re-anchored micro table

**Files:**
- Modify: `src/research-math/trade-context-math.ts`
- Test: `src/research-math/trade-context-math.test.ts`

**Interfaces:**
- Consumes: `buildMarketContextMath`/`TermMath`/`TermMathRow`, `TRADE_TERM_CONFIGS` (existing).
- Produces: `TradeContextMath` gains `readonly atPostExit: readonly TermMath[]` and `readonly postExitMs: number | null`; `microRows` now spans `[exit−10m, exit+tail]`.

- [ ] **Step 1: Update + add tests**

In `src/research-math/trade-context-math.test.ts`: the existing `series(n, withTaker)` builds 1m rows `minute_ts = i*MIN`. The existing test `'returns the last micro rows through exit as microRows (default 10)'` asserts `microRows.length === 10` and `at(-1).tsMs === 240*MIN` — that is now wrong (microRows re-anchors to `[exit−10m, postExitMs]`). Replace that test and add post-exit tests:

```ts
  it('re-anchors microRows to [exit−10m, exit+tail] (spans the exit through the tail)', () => {
    const rows = series(260, true); // 1m, ts 0..259*MIN; exit 240 → tail rows 241..259
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(tc.microRows.length).toBe(30);                 // [230*MIN .. 259*MIN] inclusive
    expect(tc.microRows[0]!.tsMs).toBe(230 * MIN);        // exit − 10m
    expect(tc.microRows.at(-1)!.tsMs).toBe(259 * MIN);    // last bar = exit + tail
    expect(tc.microRows.some((r) => r.tsMs === 240 * MIN)).toBe(true); // exit bar present
  });

  it('adds a post-exit snapshot distinct from the exit snapshot on a trending tail', () => {
    const rows = series(260, true);
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(tc.postExitMs).toBe(259 * MIN);
    const postMicro = tc.atPostExit.find((t) => t.config.key === 'micro')!;
    const exitMicro = tc.atExit.find((t) => t.config.key === 'micro')!;
    expect(postMicro).toBeDefined();
    expect(postMicro.indicators.close).toBeCloseTo(rows[259]!.close, 9); // snapshot at exit+tail bar
    expect(postMicro.indicators.close).not.toBeCloseTo(exitMicro.indicators.close, 9); // ≠ exit snapshot
  });

  it('marks no post-exit data when the window ends at the exit bar', () => {
    const rows = series(241, true); // ts 0..240*MIN; exit at 240 → last bar IS exit, no tail
    const tc = buildTradeContextMath({ ...base, rows, entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    expect(tc.postExitMs).toBe(240 * MIN);
    expect(tc.notes.some((n) => /no post-exit/i.test(n))).toBe(true);
  });
```

(The existing entry/exit-snapshot, warmup-note, no-taker, empty-rows, determinism tests stay — but the empty-rows test must also assert the new fields: add `expect(tc.atPostExit).toEqual([]); expect(tc.postExitMs).toBeNull();` to that test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/research-math/trade-context-math.test.ts`
Expected: FAIL — `atPostExit`/`postExitMs` don't exist; `microRows` still ends at exit (length 10).

- [ ] **Step 3: Implement**

In `src/research-math/trade-context-math.ts`, add the two fields to `TradeContextMath` (after `atExit`):

```ts
  readonly atPostExit: readonly TermMath[];
  readonly postExitMs: number | null;
```

Remove the `microTableRows?` field from `TradeContextMathInput` and the `const microTableRows = …` line (superseded by the window filter). Rewrite the body of `buildTradeContextMath`:

```ts
export function buildTradeContextMath(input: TradeContextMathInput, nowMs: number): TradeContextMath {
  const { rows } = input;
  const head = {
    tradeId: input.tradeId, symbol: input.symbol, entryMs: input.entryMs, exitMs: input.exitMs,
    realizedPnl: input.realizedPnl, pnlPct: input.pnlPct, closeReason: input.closeReason,
  };

  if (rows.length === 0) {
    return { ...head, atEntry: [], atExit: [], atPostExit: [], postExitMs: null, microRows: [], notes: ['No market history rows for this trade window.'] };
  }

  const fromMs = rows[0]!.minute_ts;
  const postExitMs = rows[rows.length - 1]!.minute_ts;
  // Retain enough micro bars (local to this call) for the [exit−10m, postExitMs] table window.
  const terms = TRADE_TERM_CONFIGS.map((c) =>
    c.key === 'micro' ? { ...c, maxRows: Math.max(c.maxRows, rows.length) } : c);
  const baseInput = {
    symbol: input.symbol, direction: input.direction, regime: input.regime,
    requiredFeatures: input.requiredFeatures, terms,
  };

  let entryIdx = 0;
  for (let i = 0; i < rows.length; i++) { if (rows[i]!.minute_ts <= input.entryMs) entryIdx = i; else break; }
  let exitIdx = 0;
  for (let i = 0; i < rows.length; i++) { if (rows[i]!.minute_ts <= input.exitMs) exitIdx = i; else break; }

  const atEntryMath = buildMarketContextMath({ ...baseInput, rows: rows.slice(0, entryIdx + 1), window: { fromMs, toMs: input.entryMs } }, nowMs);
  const atExitMath = buildMarketContextMath({ ...baseInput, rows: rows.slice(0, exitIdx + 1), window: { fromMs, toMs: input.exitMs } }, nowMs);
  const atPostExitMath = buildMarketContextMath({ ...baseInput, rows, window: { fromMs, toMs: postExitMs } }, nowMs);

  const preMs = 10 * 60_000;
  const microPost = atPostExitMath.terms.find((t) => t.config.key === 'micro');
  const microRows = microPost ? microPost.rows.filter((r) => r.tsMs >= input.exitMs - preMs && r.tsMs <= postExitMs) : [];

  const entryKeys = new Set(atEntryMath.terms.map((t) => t.config.key));
  const warmupNotes = atExitMath.terms
    .filter((t) => !entryKeys.has(t.config.key))
    .map((t) => `Term ${t.config.label} unavailable at entry: insufficient warmup before the trade.`);
  const postNotes = postExitMs <= input.exitMs ? ['No post-exit market data: tail window empty.'] : [];
  const notes = Array.from(new Set([...atEntryMath.notes, ...atExitMath.notes, ...atPostExitMath.notes, ...warmupNotes, ...postNotes]));

  return { ...head, atEntry: atEntryMath.terms, atExit: atExitMath.terms, atPostExit: atPostExitMath.terms, postExitMs, microRows, notes };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/research-math/trade-context-math.test.ts && npm run typecheck`
Expected: PASS (updated + new tests) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/trade-context-math.ts src/research-math/trade-context-math.test.ts
git commit -m "feat(research-math): per-trade post-exit snapshot + micro table re-anchored across exit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Formatter — `@post` lines + exit-row marker

**Files:**
- Modify: `src/research-math/format-trade-context-math.ts`
- Test: `src/research-math/format-trade-context-math.test.ts` (append)

**Interfaces:**
- Consumes: `TradeContextMath.atPostExit`/`postExitMs`/`exitMs`/`microRows` (Task 2); `rowLine`/`summaryLine`/`tableHeaderLines` (existing exports); `TermMathRow` type.
- Produces: `@post …` summary lines + a micro table whose exit row is marked ` ← exit`.

- [ ] **Step 1: Write the failing test**

Append to `src/research-math/format-trade-context-math.test.ts` (it already has `series`/`base`/`buildTradeContextMath`):

```ts
describe('formatTradeContextMath post-exit tail', () => {
  it('renders @post summaries with the exit-offset label and marks the exit row', () => {
    const tc = buildTradeContextMath({ ...base, rows: series(260, true), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const md = formatTradeContextMath(tc);
    expect(md).toMatch(/@post \(exit\+19m\) Micro \(1m\):/); // 259 − 240 = 19 min after exit
    expect(md).toContain(' ← exit'); // the exit row is marked in the micro table
  });

  it('renders @post n/a when there is no post-exit tail', () => {
    const tc = buildTradeContextMath({ ...base, rows: series(241, true), entryMs: 200 * MIN, exitMs: 240 * MIN }, 0);
    const md = formatTradeContextMath(tc);
    expect(md).toContain('@post n/a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/research-math/format-trade-context-math.test.ts`
Expected: FAIL — no `@post` rendering / no ` ← exit` marker yet.

- [ ] **Step 3: Implement**

In `src/research-math/format-trade-context-math.ts`: extend the type import to include `TermMathRow`:

```ts
import type { TermMath, TermMathRow } from './market-context-math.ts';
```

Add a marker helper and wire `@post` + the marked table into `formatTradeContextMath`:

```ts
function rowLineMarked(r: TermMathRow, exitMs: number): string {
  return r.tsMs === exitMs ? `${rowLine(r)} ← exit` : rowLine(r);
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
  if (tc.postExitMs != null && tc.postExitMs > tc.exitMs && tc.atPostExit.length > 0) {
    const tailMin = Math.round((tc.postExitMs - tc.exitMs) / 60_000);
    lines.push(...summariesFor(`@post (exit+${tailMin}m)`, tc.atPostExit));
  } else {
    lines.push('@post n/a');
  }
  const micro = tc.atPostExit.find((t) => t.config.key === 'micro') ?? tc.atExit.find((t) => t.config.key === 'micro');
  if (micro && tc.microRows.length > 0) {
    const [cols, sep] = tableHeaderLines(micro.config);
    lines.push(cols, sep, ...tc.microRows.map((r) => rowLineMarked(r, tc.exitMs)));
  }
  if (tc.notes.length > 0) lines.push(`> Notes: ${tc.notes.join(' ')}`);
  return lines.join('\n');
}
```

(`formatTradeContexts` is unchanged.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/research-math/format-trade-context-math.test.ts && npm run typecheck`
Expected: PASS (new post-exit format tests + the existing format tests) and typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/research-math/format-trade-context-math.ts src/research-math/format-trade-context-math.test.ts
git commit -m "feat(research-math): render @post summaries + mark the exit row in the per-trade table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `RESEARCHER_CAPABILITIES` — exit-quality framing

**Files:**
- Modify: `src/mastra/agents/researcher-capabilities.ts`
- Test: `src/mastra/agents/researcher-capabilities.test.ts` (append)

**Interfaces:**
- Consumes/Produces: `RESEARCHER_CAPABILITIES` string (existing export).

- [ ] **Step 1: Write the failing test**

Append to `src/mastra/agents/researcher-capabilities.test.ts`:

```ts
describe('RESEARCHER_CAPABILITIES exit-quality framing', () => {
  it('frames the @entry/@exit/@post per-trade slices and exit-quality reasoning', () => {
    for (const marker of ['@entry', '@exit', '@post', 'exit quality', 'tighten_stop', 'widen_stop']) {
      expect(RESEARCHER_CAPABILITIES).toContain(marker);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/mastra/agents/researcher-capabilities.test.ts`
Expected: FAIL — the current per-trade line says only "entry bar and the exit bar"; no `@post`/exit-quality terms.

- [ ] **Step 3: Update the capability line**

In `src/mastra/agents/researcher-capabilities.ts`, replace the existing per-trade line (`'Per-trade context gives indicator snapshots at the entry bar and the exit bar of each losing trade — use them to reason about what conditions preceded the loss.'`) with:

```ts
  'Per-trade context gives indicator snapshots at the entry bar (@entry), the exit bar (@exit), and a post-exit bar (@post, ~60m after exit) of each losing trade, plus a micro table spanning the exit. Use them to reason about both entry quality (what conditions preceded the loss → entry filters) and exit quality (was the stop too tight or the exit premature — did price reverse or keep moving favourably after exit → tighten_stop / widen_stop / exit-timing / trailing).',
```

(Leave the other capability lines, including the runner-owned guard, unchanged.)

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/mastra/agents/researcher-capabilities.test.ts && npm run typecheck`
Expected: PASS (the new framing test + the existing capability tests, which assert the data/indicator markers + runner-owned guard) and typecheck exit 0.

- [ ] **Step 5: Run the full suite (no regression)**

Run: `npx vitest run`
Expected: 0 failed; passed count ≥ baseline + the new tests.

- [ ] **Step 6: Commit**

```bash
git add src/mastra/agents/researcher-capabilities.ts src/mastra/agents/researcher-capabilities.test.ts
git commit -m "feat(research): frame @entry/@exit/@post slices + exit-quality reasoning for the researcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after Task 4)

- [ ] `npm run typecheck` → exit 0.
- [ ] `npx vitest run` → 0 failed.
- [ ] `git diff main -- src/research-math/market-context-math.ts src/research-math/term-config.ts` is empty (engine + shared configs untouched).
- [ ] `git diff main -- package.json` empty (no new deps).

## Task dependency graph

- **Task 1** (handler) and **Task 2** (math) touch disjoint files; Task 2 is the core.
- **Task 3** (formatter) depends on Task 2 (new `atPostExit`/`postExitMs` fields + re-anchored `microRows`).
- **Task 4** (capabilities) is independent.
- Suggested order: T1 → T2 → T3 → T4 (one implementer at a time).
