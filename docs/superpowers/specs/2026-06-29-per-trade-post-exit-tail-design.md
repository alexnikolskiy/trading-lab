# Design: per-trade post-exit tail + exit-quality framing

- **Date:** 2026-06-29
- **Status:** Approved design (brainstorming complete) → ready for plan
- **Owner:** Alexander Nikolskiy
- **Parent:** Slice A (per-trade context from ClosedTrades, on `main`). Extends the per-trade window to the right so the researcher can reason about **exit quality**, not just entry.
- **Scope:** Extend each losing trade's per-trade window with a post-exit tail (default 60 min), add a `@post` indicator snapshot + extend the micro table through the tail, and update `RESEARCHER_CAPABILITIES` so the researcher reasons about exits (premature exit / stop too tight / price reversed-or-continued after exit). **Losers-only** this slice; winning-trade context (exit-improvement for profit) is a deliberate follow-up.

---

## 1. Context & problem

Slice A gives the researcher, per losing trade, indicator snapshots at the **entry** bar (`@entry`) and **exit** bar (`@exit`) plus a micro table through exit. The window is `[entry − warmup, exit]` — it stops at the exit. So the researcher can see *why the trade was entered into a loss* but **not what happened after the exit**: did price keep falling (the stop was right) or reverse (exited too early / stop too tight)? That post-exit behaviour is exactly the signal for **exit-quality** hypotheses (`tighten_stop`/`widen_stop`/`exit_now` timing, trailing). Today it is absent.

**Decisions carried from brainstorming:**
- Tail size **60 min** default, env-configurable (`TRADE_CONTEXT_TAIL_MIN`).
- Render **both** a `@post` indicator snapshot (momentum after exit) **and** the micro table re-anchored to `[exit − ~10m, exit + tail]` (price/CVD/liq trajectory through and past the exit). Keep 1-minute granularity for now (A/B against a cheaper tail later if budget demands).
- **Losers-only.** Feeding winning trades (to propose bigger-TP / trailing exits for profit) is a separate next slice; the post-exit tail still benefits losers ("exited too early?", "stop too tight?").

---

## 2. Goals / non-goals

**Goals**
1. The per-trade window extends to `[entry − warmup, exit + tail]`; the researcher sees a `@post` snapshot and a micro table covering the exit transition and its aftermath.
2. `RESEARCHER_CAPABILITIES` tells the researcher it has a pre-entry (`@entry`), exit (`@exit`), and post-exit (`@post`) slice per losing trade, and to reason about **exit quality** (premature exit, stop too tight, price reversed/continued after exit → `tighten_stop`/`widen_stop`/trailing) in addition to entry filters.
3. Reuse the existing engine (no new indicator math); coverage-honest (`@post` degrades when the tail has no bars); fail-soft unchanged; both gates green.

**Non-goals**
- No winning-trade selection/context (next slice).
- No change to the symbol-level `marketContextMath`, the math engine internals, `term-config`'s shared `TERM_CONFIGS`, or Slice B's forensic path.
- No new overlay actions — exit hypotheses use the existing `tighten_stop`/`widen_stop`/`exit_now`/`scale_out` catalog.

---

## 3. Design

### 3.1 Handler — fetch the tail (`research-run-cycle.handler.ts`)
In the per-trade gather loop, extend the read window to the right:
```ts
const parsedTail = Number(process.env.TRADE_CONTEXT_TAIL_MIN ?? '60');
const tailMin = Number.isFinite(parsedTail) && parsedTail > 0 ? parsedTail : 60;   // mirrors the warmup guard
…
const rows = await services.marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs + tailMin * 60_000 });
```
(`fromMs` unchanged: `openedAtMs − warmupMin·60_000`.) Everything else in the loop unchanged. (`tailMin` computed once alongside `warmupMin`.)

### 3.2 `buildTradeContextMath` — `@post` snapshot + re-anchored micro table (`trade-context-math.ts`)
The rows now span `[entry − warmup, exit + tail]`. Add to `TradeContextMath`:
```ts
readonly atPostExit: readonly TermMath[];   // indicator snapshot at the post-exit bar (≈ exit + tail)
readonly postExitMs: number | null;         // ts of that bar (for the @post label); null when no post-exit bars
```
Mechanism (reuses `buildMarketContextMath`):
- `entryIdx`/`exitIdx` resolution unchanged (last row ≤ entry/exitMs).
- **`atPostExit`** = `buildMarketContextMath(rows, window:{fromMs, toMs: rows[last].minute_ts})` — the engine snapshots the **last** bar (= exit + tail). `postExitMs = rows[last].minute_ts`. When the last bar is at/before `exitMs` (no tail rows fetched), `atPostExit` equals `atExit` and a note records "no post-exit market data".
- **`microRows` re-anchored** to `[exitMs − preMs, postExitMs]` (`preMs = 10·60_000`): build the per-call micro term with enough retained bars (raise the micro config's `maxRows` for *this call* to ≥ the window's bar count — e.g. `maxRows: Math.max(microDefault, rows.length)`), then `microRows = postExitMicro.rows.filter(r => r.tsMs >= exitMs − preMs && r.tsMs <= postExitMs)`. This keeps `TERM_CONFIGS`/`TRADE_TERM_CONFIGS`'s shared defaults intact (the bump is local to the per-trade build) and is robust to any `tail`.
- `atEntry`/`atExit` unchanged. Notes: existing warmup notes + the "no post-exit market data" note when applicable.

`TradeContextMathInput` gains nothing required (the tail is implicit in the longer `rows`; `exitMs` already passed). The old `microTableRows` knob is superseded by the window filter and may be dropped.

### 3.3 Formatter — render `@post` + the exit transition (`format-trade-context-math.ts`)
- Add `@post` term-summary lines mirroring `@entry`/`@exit`: `@post ${term.label}: ${summaryLine(term)}` for `tc.atPostExit`, with the header noting the offset, e.g. `@post (exit+${Math.round((postExitMs − exitMs)/60_000)}m)`.
- The micro table now renders `tc.microRows` spanning `[exit−~10m, exit+tail]`; **mark the exit row** so the LLM sees the transition (e.g. append ` ← exit` to the `rowLine` whose `tsMs === exitMs`, via a small wrapper that takes `exitMs`; the table columns are otherwise unchanged).
- Coverage-honest: when `atPostExit` is empty / `postExitMs` is null, render `@post n/a` and no extra table tail.

### 3.4 `RESEARCHER_CAPABILITIES` — exit-quality framing (`researcher-capabilities.ts`)
Update the per-trade line from "snapshots at the entry bar and the exit bar" to include the post-exit slice and the exit-quality goal, e.g.:
> Per-trade context gives indicator snapshots at the **entry bar (@entry)**, the **exit bar (@exit)**, and a **post-exit bar (@post, ~N min after exit)** of each losing trade, plus a micro table spanning the exit. Use them to reason about both **entry quality** (what conditions preceded the loss → entry filters) and **exit quality** (was the stop too tight or the exit premature — did price reverse or keep moving favourably after exit → `tighten_stop`/`widen_stop`/`exit_now`-timing/trailing)?

(Keep the runner-owned guard. No winners mention — that is the follow-up slice.)

---

## 4. Testing

- **`buildTradeContextMath`** (unit): with rows extending past exit, `atPostExit` is present and `postExitMs === rows[last].minute_ts`; on a trending tail `atPostExit` micro `close` ≠ `atExit` micro `close`; `microRows` spans the exit (a row with `tsMs === exitMs` exists and the last row `tsMs === postExitMs`); a no-tail window (rows end at exit) → `atPostExit` equals `atExit`, `postExitMs === exitMs`, "no post-exit market data" note; determinism; no `NaN`.
- **`formatTradeContextMath`** (snapshot): renders the `@post …` summary lines with the `(exit+Nm)` label, the micro table marks the exit row (` ← exit`), and degrades to `@post n/a` when post-exit data is absent; sub-dollar precision still via `priceNum`.
- **`RESEARCHER_CAPABILITIES`** (unit): contains the `@post`/post-exit framing and the exit-quality terms (`tighten_stop`/`widen_stop`/premature exit); the runner-owned guard stays.
- **Handler** (unit): the per-trade `getRows` is called with `toMs === closedAtMs + tailMin·60_000` (default 60); env override respected; fail-soft + no-losers paths unchanged.
- **Both gates:** `npm run typecheck` exit 0 + `npx vitest run` green.

---

## 5. Risks & token budget

- **Token cost:** a 60-min 1-minute tail adds ≈ 65 micro rows + one `@post` summary line per losing trade (≤ 5). This is a real prompt-size increase, accepted for now; the planned follow-up is an A/B (standard tail → hypotheses, then a cheaper tail — 5-minute tail table or 30-min — → compare whether hypotheses change). The micro table is bounded by the `[exit−10m, exit+tail]` filter.
- **Demo data:** the extended fixture covers the trade windows; the post-exit tail for late-in-day trades may be short (fewer tail bars) → `@post` degrades honestly.

---

## 6. Success criteria

1. Each losing trade's per-trade block carries a `@post` indicator snapshot (~60 min after exit) and a micro table spanning the exit transition into the tail, with the exit row marked.
2. `RESEARCHER_CAPABILITIES` frames the three slices (@entry/@exit/@post) and the exit-quality goal.
3. Engine internals / shared `TERM_CONFIGS` / symbol-level block / Slice B untouched; reuse only.
4. Coverage-honest (`@post n/a` on no-tail); fail-soft preserved; typecheck exit 0; full suite green.
