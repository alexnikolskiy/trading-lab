# Design: market-context-math — price-aware precision + small fixes

- **Date:** 2026-06-29
- **Status:** Approved design (brainstorming complete) → ready for implementation plan
- **Owner:** Alexander Nikolskiy
- **Parent:** `commitXTermMath` engine (PR #99 + Phase E #103, both on `main`). Found during live-demo verification of Phase E on the `2026-06-16-to-18-extended` fixture (ESPORTSUSDT ~$0.05).
- **Scope:** Fix the fixed-2-decimal rounding that collapses price-scale indicator values for low-priced instruments, plus two small follow-ups (M1 `takerPressure` window guard, M3 `momentumState` test coverage). No new runtime dependency; no per-row-table column changes.

---

## 1. Problem

The market-context block formats every numeric via `num(v, digits = 2)` (fixed 2 decimals). For a sub-dollar instrument (ESPORTSUSDT ≈ $0.05, observed live) all **price-scale** fields collapse to noise:

```
ATR 0.00 · MACD -0.00/0.00/-0.00 · Fib 0.618=0.04
Pivots PP=0.05 R1/2/3=0.05/0.05/0.05 S1/2/3=0.05/0.05/0.04   ← 7 levels indistinguishable
| close | … | atr14 |  →  | 0.05 | … | 0.00 |
```

The seven pivot levels, ATR, MACD, EMA, and the per-row OHLC cells all read as `0.05`/`0.00`, carrying zero signal to the researcher LLM. This is engine-wide (the per-row table and the summary both use `num`), but Phase E's Pivots are the most visibly damaged (all levels equal).

Two small items logged during the Phase E review are folded in:
- **M1:** `takerPressure(buys, sells, window)` with `window === 0` falls through to `start = 0` and sums **all** bars instead of none (unreachable in production — `pressureWindow` is a positive const — but incorrect for the stated "trailing window" contract).
- **M3:** no test exercises `momentumState` `'rising'`/`'falling'` (only `on: boolean` is asserted).

Out of scope (not bugs): `bias: unknown` / `Required features: (none)` in the header — those come from a fake-onboarded profile with no direction/required features, not from the formatter.

---

## 2. Goals / non-goals

**Goals**
1. Price-scale fields render with magnitude-adaptive precision so values stay distinguishable across instrument price scales (sub-dollar to five-figure), without scientific notation.
2. Bounded fields (RSI/Stoch/ADX/BB %B, liq imbalance, Pressure bias), percentage fields, and large-integer fields are unchanged.
3. The per-row table's **column set** is unchanged — only cell *precision* changes (a strict improvement, not a structural change).
4. M1 + M3 fixed.
5. Both gates green: `npm run typecheck` (exit 0) and `npx vitest run` (no regression; net new tests increase the count). Zero new runtime dependencies.

**Non-goals**
- No instrument-tick-size lookup (data not surfaced; per-value magnitude is sufficient and deterministic).
- No trailing-zero trimming (keeps column widths stable; trailing zeros are harmless and convey available precision).
- No change to which fields appear, the table columns, the notes, or any non-formatting logic.
- No change to bounded/percentage/integer formatting.

---

## 3. Design

### 3.1 `priceNum(v)` — magnitude-adaptive price formatter (`format-market-context-math.ts`)

```ts
function priceNum(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a === 0) return '0';
  const decimals = a >= 1 ? 2 : Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(a))));
  return v.toFixed(decimals);
}
```

Behaviour:
- `|v| >= 1` → 2 decimals (normal/high prices stay clean: `105.3 → "105.30"`, `42173.5 → "42173.50"`).
- `0 < |v| < 1` → enough decimals for ~4 significant figures: `decimals = clamp(3 − floor(log10|v|), 2, 8)`.
  - `0.05234 → "0.05234"` (floor(log10)=−2 → 5 dp); `0.5 → "0.5000"` (−1 → 4 dp); `0.00012 → "0.0001200"` (floor(log10)=−4 → 7 dp); `-0.0001 → "-0.0001000"` (7 dp).
- `v === 0` → `"0"`. `null`/non-finite → `"n/a"` (same contract as `num`).
- Never scientific notation (`toFixed` only); upper clamp 8 dp bounds width.

`num(v, digits)` is **kept as-is** for bounded/integer/percent fields.

### 3.2 Apply `priceNum` to price-scale fields only

**`rowLine` (per-row table cells):** `open`, `high`, `low`, `close`, `emaFast`, `emaSlow`, `atr` → `priceNum`. Unchanged: `volume`/`oi`/`oiDelta`/`cvd`/`liqLong`/`liqShort` (stay `num(_, 0)` integer), `rsi` (stays `num(_, 2)`, bounded 0–100). **The column header / separator strings are byte-unchanged.**

**`summaryLine` (per-term summary):** `emaFast`, `emaSlow`, `atr`, `macd.line`/`macd.signal`/`macd.hist`, `fibonacci.levels['0.618']`, `pivots.pp`/`r1`/`r2`/`r3`/`s1`/`s2`/`s3`, `squeeze.momentum` → `priceNum`. Unchanged: `rsi`/`stoch.k`/`stoch.d`/`adx.*`/`bollinger.pctB` (bounded → `num(_, 2)`), `liqImbalance`/`pressure.bias` (bounded → `num`), `realizedVol`/`bollinger.bandwidth`/`oiChangePct`/`buyShare` (percentage formats), `cvdNet`/`liqLongTotal`/`liqShortTotal` (large magnitudes → `num(_, 2)`), `funding` (raw).

Rationale: only fields whose magnitude tracks the instrument price need adaptivity; bounded oscillators and percentages are already legible at 2 decimals; the squeeze momentum is a price-unit deviation, so it is price-scale.

### 3.3 M1 — `takerPressure` window guard (`indicators/levels.ts`)

Change the window start so a non-positive window yields no bars (→ `null`s), honoring the "trailing `window`" contract:

```ts
const start = window > 0 ? Math.max(0, n - window) : n;  // window<=0 → start=n → loop is empty → {bias:null, buyShare:null}
```

No other change; the `!any || total === 0 → nulls` guard already covers the empty-loop case.

### 3.4 M3 — extract & test `momentumStateOf` (`market-context-math.ts`)

Extract the inline momentum-direction logic from `buildTerm` into a small exported pure helper, used by `buildTerm` unchanged in behaviour:

```ts
export function momentumStateOf(cur: number | null, prev: number | null): 'rising' | 'falling' | 'flat' {
  if (cur == null || prev == null) return 'flat';
  const diff = cur - prev;
  return Math.abs(diff) < 1e-9 ? 'flat' : diff > 0 ? 'rising' : 'falling';
}
```

`buildTerm`'s `squeeze` IIFE calls `momentumStateOf(cur.momentum, prev?.momentum ?? null)` instead of the inlined comparison. Direct unit tests cover `rising` / `falling` / `flat` (within epsilon) / `flat`-when-null.

---

## 4. Testing

- **`priceNum`** (new unit tests, `format-market-context-math.test.ts`): `0.05234 → "0.05234"`; `105.3 → "105.30"`; `0.5 → "0.5000"`; `-0.0001 → "-0.0001000"`; `0 → "0"`; `null → "n/a"`; `Infinity → "n/a"`; a high price `42173.5 → "42173.50"`. Assert no value contains `e`/`E` (no scientific notation).
- **`momentumStateOf`** (new unit tests): `(5, 3) → 'rising'`; `(3, 5) → 'falling'`; `(5, 5) → 'flat'`; `(5+5e-10, 5) → 'flat'` (epsilon); `(5, null) → 'flat'`; `(null, 5) → 'flat'`.
- **`takerPressure(window <= 0)`** (new unit test, `levels.test.ts`): `takerPressure([6,4],[4,6], 0)` → `{ bias: null, buyShare: null }`.
- **Regression check:** the existing format tests assert structure (`### Micro`, `| ts |`, `Pivots PP=`, `/Pressure [+-]?\d/`, `'% buy)'`, `'n/a'`) — all survive `priceNum` (it still emits digits after `PP=`). Confirm no existing test asserts a literal rounded price string; if one does, update it to the new precision. Determinism (byte-identical markdown for same input + `nowMs`) preserved.
- **Both gates:** `npm run typecheck` exit 0 and `npx vitest run` green.

---

## 5. Success criteria

1. For a sub-dollar instrument, ATR / MACD / Fib / EMA / the seven Pivot levels / OHLC cells render distinguishable values (not all `0.00`/`0.05`).
2. High-priced instruments stay at 2 decimals (no trailing-zero noise).
3. Bounded/percentage/integer fields and the per-row table **columns** are unchanged.
4. M1 and M3 closed; their tests pass.
5. Zero new runtime deps; typecheck exit 0; full suite green.
