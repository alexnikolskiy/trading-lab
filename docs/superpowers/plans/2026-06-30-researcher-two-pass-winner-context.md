# Two-Pass Researcher + Winning-Trade Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the strategy researcher into two focused LLM passes — loss-reduction over losing trades and profit-improvement over winning trades — give winners the same per-trade `@entry`/`@exit`/`@post` context, and frame both passes to treat the strategy profile critically (relax/remove/replace existing overlay checks, not only add).

**Architecture:** The split lives in the handler (`research-run-cycle.handler.ts`) via a `focus` discriminator on `ResearcherInput`; the handler builds two inputs and calls `services.researcher.propose()` twice (profit pass gated on ≥1 winner), then merges both passes' drafts into the existing dedup→validate→build loop. Winner selection keys off `ClosedTrade.isWin`, prioritizing left-on-the-table exits via the typed `CloseReason` enum when present and a vocabulary-free post-exit-headroom ranking otherwise. `buildPrompt` branches on `focus` for the capability framing, the ask line, and which sections render.

**Tech Stack:** TypeScript run under `node --experimental-strip-types`; Vitest; Zod; Mastra agent; `@trading-platform/sdk` (`ops-read` DTOs, `historical` `CanonicalRowV2`).

**Spec:** `docs/superpowers/specs/2026-06-30-researcher-two-pass-winner-context-design.md`

## Global Constraints

- **Prerequisite:** rebase this branch onto a `main` that includes PR #111 (per-trade post-exit tail). Winner contexts rely on the `@post` tail and the capability edits compose with #111's per-trade line. If #111 is not yet merged at execution time, STOP and surface it — do not re-implement #111.
- Runs under `node --experimental-strip-types`: **no TypeScript parameter properties** (`constructor(private x)` breaks at runtime); all relative imports keep the `.ts` extension.
- `noUncheckedIndexedAccess` is on: guard every indexed access (`arr[i]!` only when provably in-bounds, else a guard); never produce `NaN`.
- **Both gates green per task:** `npm run typecheck` exits 0 AND `npx vitest run` is green. `npx vitest run` does NOT type-check — run `npm run typecheck` separately every task.
- **Reuse only — do NOT modify:** the per-trade math engine (`src/research-math/trade-context-math.ts`, `market-context-math.ts`), the per-trade formatter (`format-trade-context-math.ts`), the symbol-level `marketContextMath`, the `OVERLAY_ACTIONS` catalog (`src/domain/hypothesis-rules.ts`), or the critic/refiner.
- Pure functions stay deterministic (no `Date.now`/`Math.random` inside them; the handler passes `Date.now()` in).
- Losers path (`selectSuspiciousTrades`, forensic evidence, loss-pass context) stays byte-unchanged except where a task explicitly edits it.

---

### Task 1: Winner selection + post-exit-headroom ranking (pure functions)

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (add pure functions near `selectSuspiciousTrades` at line 47; add `TRADE_EVIDENCE_MAX`-style consts at top)
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (add a `describe('winner selection', ...)` block)

**Interfaces:**
- Consumes: `ClosedTrade` (from `'../../ports/bot-results-read.port.ts'`: `{ tradeId, symbol, side: 'long'|'short', openedAtMs, closedAtMs: number|null, realizedPnl: string, pnlPct: string, isWin: boolean|null, closeReason: string|null }`); `BotRunResultDetail` (`{ trades: readonly ClosedTrade[] }`); `CanonicalRowV2` (from `'@trading-platform/sdk/historical'`: `{ minute_ts, high, low, close }` are `number`).
- Produces:
  - `const CANONICAL_CLOSE_REASONS: readonly string[]` — the canonical enum values lab recognizes.
  - `function isTypedCloseReason(reason: string | null): boolean`
  - `function selectWinningTrades(botResults: readonly BotRunResultDetail[]): ClosedTrade[]` — all winners (`isWin===true`, or `isWin==null && Number(realizedPnl)>0`), deterministic recency order, NOT yet capped.
  - `function rankWinnersTyped(winners: readonly ClosedTrade[], cap: number): ClosedTrade[]`
  - `function postExitHeadroomPct(trade: ClosedTrade, rows: readonly CanonicalRowV2[]): number`
  - `function rankWinnersByHeadroom(winners: readonly ClosedTrade[], rowsByTradeId: ReadonlyMap<string, readonly CanonicalRowV2[]>, cap: number): ClosedTrade[]`

- [ ] **Step 1: Write the failing test for `selectWinningTrades`**

Add to `src/orchestrator/handlers/research-run-cycle.handler.test.ts`. First check the file's existing import of the handler module and how `ClosedTrade` fixtures are built there (reuse any local `makeTrade` helper; if none, define one in the new describe block). Use this test:

```ts
import { describe, it, expect } from 'vitest';
import {
  selectWinningTrades, isTypedCloseReason, rankWinnersTyped,
  postExitHeadroomPct, rankWinnersByHeadroom,
} from './research-run-cycle.handler.ts';

function trade(over: Partial<import('../../ports/bot-results-read.port.ts').ClosedTrade>): import('../../ports/bot-results-read.port.ts').ClosedTrade {
  return {
    tradeId: 't', runId: 'r', symbol: 'ESPORTSUSDT', side: 'long',
    openedAtMs: 1_000_000, closedAtMs: 2_000_000,
    realizedPnl: '1', pnlPct: '1', isWin: true, closeReason: 'take_profit_final',
    ...over,
  };
}

describe('winner selection', () => {
  it('selectWinningTrades picks isWin===true and the realizedPnl>0 fallback, excludes losers/breakeven', () => {
    const details = [{ run: {} as any, summary: {} as any, trades: [
      trade({ tradeId: 'win-flag', isWin: true, realizedPnl: '5' }),
      trade({ tradeId: 'win-fallback', isWin: null, realizedPnl: '3' }),
      trade({ tradeId: 'loser', isWin: false, realizedPnl: '-2' }),
      trade({ tradeId: 'breakeven', isWin: null, realizedPnl: '0' }),
    ] }];
    const ids = selectWinningTrades(details).map((t) => t.tradeId).sort();
    expect(ids).toEqual(['win-fallback', 'win-flag']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "winner selection"`
Expected: FAIL — `selectWinningTrades` is not exported.

- [ ] **Step 3: Implement the pure functions**

In `src/orchestrator/handlers/research-run-cycle.handler.ts`, near `selectSuspiciousTrades` (line 47), add. Note `selectSuspiciousTrades` is currently NOT exported — export the new functions for the unit test:

```ts
/** Canonical close-reason vocabulary lab recognizes once the platform ships the typed CloseReason enum. */
export const CANONICAL_CLOSE_REASONS = [
  'take_profit_final', 'take_profit_partial', 'stop_loss', 'breakeven',
  'trailing_stop', 'signal_exit', 'time_exit', 'liquidation', 'manual', 'other',
] as const;

/** True once closeReason carries a recognized canonical member (i.e. the SDK enum has shipped). */
export function isTypedCloseReason(reason: string | null): boolean {
  return reason != null && (CANONICAL_CLOSE_REASONS as readonly string[]).includes(reason);
}

/** "Exited early / left headroom" close reasons — prime profit-improvement candidates. */
const HEADROOM_CLOSE_REASONS = new Set(['take_profit_partial', 'breakeven', 'signal_exit', 'time_exit']);

/** Winners = isWin===true, or (isWin==null && realizedPnl>0) fallback. Recency order (closedAt DESC). Uncapped. */
export function selectWinningTrades(botResults: readonly BotRunResultDetail[]): ClosedTrade[] {
  return botResults
    .flatMap((detail) => detail.trades)
    .filter((t) => t.isWin === true || (t.isWin == null && Number(t.realizedPnl) > 0))
    .slice()
    .sort((a, b) =>
      ((b.closedAtMs ?? 0) - (a.closedAtMs ?? 0)) || a.tradeId.localeCompare(b.tradeId));
}

/** Typed path: headroom-class reasons first, then by recency; tiebreak tradeId. */
export function rankWinnersTyped(winners: readonly ClosedTrade[], cap: number): ClosedTrade[] {
  return winners.slice().sort((a, b) => {
    const ah = HEADROOM_CLOSE_REASONS.has(a.closeReason ?? '') ? 0 : 1;
    const bh = HEADROOM_CLOSE_REASONS.has(b.closeReason ?? '') ? 0 : 1;
    return (ah - bh)
      || ((b.closedAtMs ?? 0) - (a.closedAtMs ?? 0))
      || a.tradeId.localeCompare(b.tradeId);
  }).slice(0, cap);
}

/** Favourable continuation after exit, as a fraction of the exit-bar close. Vocabulary-free.
 *  Long: (max high after exit − exitClose)/exitClose. Short: (exitClose − min low after exit)/exitClose.
 *  0 when no post-exit bars or no usable exit bar. Never NaN. */
export function postExitHeadroomPct(trade: ClosedTrade, rows: readonly CanonicalRowV2[]): number {
  const exitMs = trade.closedAtMs;
  if (exitMs == null || rows.length === 0) return 0;
  let exitIdx = -1;
  for (let i = 0; i < rows.length; i += 1) { if (rows[i]!.minute_ts <= exitMs) exitIdx = i; else break; }
  if (exitIdx < 0) return 0;
  const exitClose = rows[exitIdx]!.close;
  if (!(exitClose > 0)) return 0;
  const tail = rows.slice(exitIdx + 1);
  if (tail.length === 0) return 0;
  if (trade.side === 'long') {
    const hi = Math.max(...tail.map((r) => r.high));
    return Math.max(0, (hi - exitClose) / exitClose);
  }
  const lo = Math.min(...tail.map((r) => r.low));
  return Math.max(0, (exitClose - lo) / exitClose);
}

/** Fallback path: rank by post-exit headroom DESC; tiebreak recency then tradeId. */
export function rankWinnersByHeadroom(
  winners: readonly ClosedTrade[],
  rowsByTradeId: ReadonlyMap<string, readonly CanonicalRowV2[]>,
  cap: number,
): ClosedTrade[] {
  return winners.slice().sort((a, b) => {
    const ha = postExitHeadroomPct(a, rowsByTradeId.get(a.tradeId) ?? []);
    const hb = postExitHeadroomPct(b, rowsByTradeId.get(b.tradeId) ?? []);
    return (hb - ha)
      || ((b.closedAtMs ?? 0) - (a.closedAtMs ?? 0))
      || a.tradeId.localeCompare(b.tradeId);
  }).slice(0, cap);
}
```

Ensure `CanonicalRowV2` is imported in the handler (it already imports from `'@trading-platform/sdk/historical'` indirectly via the math modules — add `import type { CanonicalRowV2 } from '@trading-platform/sdk/historical';` if not already present at the top).

- [ ] **Step 4: Add the remaining test cases**

Append inside `describe('winner selection', ...)`:

```ts
it('isTypedCloseReason recognizes canonical members only', () => {
  expect(isTypedCloseReason('take_profit_partial')).toBe(true);
  expect(isTypedCloseReason('TP2_hit_raw_strategy_string')).toBe(false);
  expect(isTypedCloseReason(null)).toBe(false);
});

it('rankWinnersTyped puts headroom-class reasons first and caps', () => {
  const ws = [
    trade({ tradeId: 'final', closeReason: 'take_profit_final', closedAtMs: 9 }),
    trade({ tradeId: 'partial', closeReason: 'take_profit_partial', closedAtMs: 8 }),
    trade({ tradeId: 'be', closeReason: 'breakeven', closedAtMs: 7 }),
  ];
  expect(rankWinnersTyped(ws, 2).map((t) => t.tradeId)).toEqual(['partial', 'be']);
});

it('postExitHeadroomPct measures favourable continuation after exit for a long', () => {
  const rows = [
    { minute_ts: 1, open: 0, high: 100, low: 100, close: 100 } as any,
    { minute_ts: 2, open: 0, high: 110, low: 90, close: 100 } as any, // after-exit bar, high 110
  ];
  // exit at ts 1 -> exitClose 100, tail high 110 -> 0.10
  expect(postExitHeadroomPct(trade({ side: 'long', closedAtMs: 1 }), rows)).toBeCloseTo(0.10, 6);
  expect(postExitHeadroomPct(trade({ side: 'long', closedAtMs: 2 }), rows)).toBe(0); // no tail
});

it('rankWinnersByHeadroom orders by left-on-table and caps', () => {
  const big = trade({ tradeId: 'big', side: 'long', closedAtMs: 1 });
  const small = trade({ tradeId: 'small', side: 'long', closedAtMs: 1 });
  const map = new Map<string, readonly CanonicalRowV2[]>([
    ['big', [{ minute_ts: 1, high: 100, low: 100, close: 100 } as any, { minute_ts: 2, high: 130, low: 100, close: 120 } as any]],
    ['small', [{ minute_ts: 1, high: 100, low: 100, close: 100 } as any, { minute_ts: 2, high: 102, low: 100, close: 101 } as any]],
  ]);
  expect(rankWinnersByHeadroom([small, big], map, 1).map((t) => t.tradeId)).toEqual(['big']);
});
```

(Import `CanonicalRowV2` as a type in the test: `import type { CanonicalRowV2 } from '@trading-platform/sdk/historical';`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "winner selection"` → Expected: PASS (5 assertions).
Run: `npm run typecheck` → Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(research): winner selection + post-exit-headroom ranking (pure)"
```

---

### Task 2: Capability menu — profit-improvement + profile-critical framing

**Files:**
- Modify: `src/mastra/agents/researcher-capabilities.ts`
- Test: `src/mastra/agents/researcher-capabilities.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: nothing.
- Produces: two new exported constants alongside `RESEARCHER_CAPABILITIES`:
  - `export const RESEARCHER_PROFIT_FRAMING: string`
  - `export const RESEARCHER_PROFILE_CRITICAL_FRAMING: string`

  `RESEARCHER_CAPABILITIES` stays the shared base (data/indicators/per-trade/guard lines). The per-pass framings are separate constants so `buildPrompt` (Task 3) composes them by `focus`.

- [ ] **Step 1: Write the failing test**

Create `src/mastra/agents/researcher-capabilities.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  RESEARCHER_CAPABILITIES, RESEARCHER_PROFIT_FRAMING, RESEARCHER_PROFILE_CRITICAL_FRAMING,
} from './researcher-capabilities.ts';

describe('researcher capability framings', () => {
  it('profit framing names exit-improvement levers', () => {
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/take-profit|take profit/i);
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/trail/i);
    expect(RESEARCHER_PROFIT_FRAMING).toMatch(/@post|after exit|left on the table/i);
  });

  it('profile-critical framing permits relaxing/removing/replacing checks', () => {
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/relax|remove|replace/i);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/allow_entry/);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/no_op/);
    expect(RESEARCHER_PROFILE_CRITICAL_FRAMING).toMatch(/not (only|just) add/i);
  });

  it('base capabilities still carry the runner-owned guard', () => {
    expect(RESEARCHER_CAPABILITIES).toMatch(/runner-owned/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/mastra/agents/researcher-capabilities.test.ts`
Expected: FAIL — `RESEARCHER_PROFIT_FRAMING` is not exported.

- [ ] **Step 3: Add the two framing constants**

In `src/mastra/agents/researcher-capabilities.ts`, after the `RESEARCHER_CAPABILITIES` definition add:

```ts
// Profit-improvement pass framing — used when focus === 'profit_improvement'. The @post tail shows
// whether price kept moving favourably after exit; if so, the exit left profit on the table.
export const RESEARCHER_PROFIT_FRAMING = [
  'TASK — PROFIT IMPROVEMENT: these are WINNING trades. For each, the @post tail shows what price did after the exit.',
  'When price continued favourably after exit, the exit left profit on the table — propose adjustments that capture it: a larger take-profit, a trailing stop, holding longer, or a partial scale-out instead of a full close (scale_out / widen_stop / exit_now-timing).',
  'Anchor each proposal in the per-trade @entry/@exit/@post evidence, not generic advice.',
].join('\n');

// Applied to BOTH passes — the profile is a revisable hypothesis, not a fixed baseline.
export const RESEARCHER_PROFILE_CRITICAL_FRAMING = [
  'BE CRITICAL OF THE PROFILE: treat the strategy profile as a revisable hypothesis, not a fixed baseline to only add to.',
  'You may propose to relax, remove, or replace existing checks/filters and retire stale rules — e.g. allow_entry / no_op to counter an over-restrictive baked-in skip_entry, or change an exit rule — not only adding new constraints, whenever you judge it improves trading.',
  'The profile\'s currently-active overlay rules are listed below (when present) — critique them.',
].join('\n');
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/mastra/agents/researcher-capabilities.test.ts` → Expected: PASS.
Run: `npm run typecheck` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/agents/researcher-capabilities.ts src/mastra/agents/researcher-capabilities.test.ts
git commit -m "feat(research): profit + profile-critical capability framings"
```

---

### Task 3: `ResearcherFocus` + `activeOverlayRules` on the port; `buildPrompt` branches on `focus`

**Files:**
- Modify: `src/ports/researcher.port.ts` (add `ResearcherFocus`, `ActiveOverlayRuleSummary`, `ResearcherInput.focus`, `ResearcherInput.activeOverlayRules?`)
- Modify: `src/adapters/researcher/mastra-researcher.ts` (`buildPrompt` branch)
- Test: `src/adapters/researcher/mastra-researcher.test.ts` (append; reuse its existing `ResearcherInput` fixture builder)

**Interfaces:**
- Consumes: `RESEARCHER_PROFIT_FRAMING`, `RESEARCHER_PROFILE_CRITICAL_FRAMING` (Task 2); `RuleAction` (from `'../../domain/hypothesis.ts'`).
- Produces:
  - `export type ResearcherFocus = 'loss_reduction' | 'profit_improvement';`
  - `export interface ActiveOverlayRuleSummary { readonly thesis: string; readonly ruleAction: RuleAction; readonly status: 'validated' | 'rejected'; }`
  - `ResearcherInput.focus: ResearcherFocus` (required) and `ResearcherInput.activeOverlayRules?: readonly ActiveOverlayRuleSummary[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/adapters/researcher/mastra-researcher.test.ts`. Reuse the file's existing helper that builds a minimal `ResearcherInput` (find it; if it's inline, copy its shape and set `focus`). The test pins the focus branching:

```ts
import { buildPrompt } from './mastra-researcher.ts';
// ... reuse existing baseInput(...) helper from this file; add focus + the new fields.

describe('buildPrompt focus branching', () => {
  it('loss_reduction renders similar hypotheses + forensic; profit_improvement omits them', () => {
    const loss = buildPrompt({ ...baseInput(), focus: 'loss_reduction',
      similarHypotheses: [{ hypothesisId: 'h', thesis: 'old idea', status: 'validated', score: 1 }] });
    expect(loss).toMatch(/Similar past hypotheses/);

    const profit = buildPrompt({ ...baseInput(), focus: 'profit_improvement',
      similarHypotheses: [{ hypothesisId: 'h', thesis: 'old idea', status: 'validated', score: 1 }] });
    expect(profit).not.toMatch(/Similar past hypotheses/);
    expect(profit).toMatch(/PROFIT IMPROVEMENT/);
    expect(profit).toMatch(/trail/i);
  });

  it('both passes carry the profile-critical framing and render active overlay rules', () => {
    const rules = [{ thesis: 'skip when oi flat', ruleAction: { appliesTo: 'long' as const,
      rules: [{ when: 'oi flat', action: 'skip_entry' as const, params: {} }] }, status: 'validated' as const }];
    for (const focus of ['loss_reduction', 'profit_improvement'] as const) {
      const p = buildPrompt({ ...baseInput(), focus, activeOverlayRules: rules });
      expect(p).toMatch(/BE CRITICAL OF THE PROFILE/);
      expect(p).toMatch(/Active overlay rules/);
      expect(p).toMatch(/skip when oi flat/);
    }
  });

  it('degrades to no active overlay rules', () => {
    const p = buildPrompt({ ...baseInput(), focus: 'loss_reduction', activeOverlayRules: [] });
    expect(p).toMatch(/no active overlay rules yet/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts -t "buildPrompt focus branching"`
Expected: FAIL — `focus` is not a known property / branch absent (and a typecheck error once `baseInput()` lacks `focus`; add `focus: 'loss_reduction'` to the shared `baseInput()` helper's default so the file's other tests keep compiling).

- [ ] **Step 3: Add the port types**

In `src/ports/researcher.port.ts`, add the import and types, and extend `ResearcherInput`:

```ts
import type { RuleAction } from '../domain/hypothesis.ts';

export type ResearcherFocus = 'loss_reduction' | 'profit_improvement';

export interface ActiveOverlayRuleSummary {
  readonly thesis: string;
  readonly ruleAction: RuleAction;
  readonly status: 'validated' | 'rejected';
}
```

and inside `ResearcherInput` add:

```ts
  focus: ResearcherFocus;
  activeOverlayRules?: readonly ActiveOverlayRuleSummary[];
```

- [ ] **Step 4: Branch `buildPrompt` on `focus`**

Replace the body of `buildPrompt` in `src/adapters/researcher/mastra-researcher.ts` with a focus-aware version (keep `profileDetailsText`, `forensicBundleText`, `formatTradeContexts`, `formatMarketContextMath`, `buildBotResultsDigestText` imports as-is; add the two framing imports):

```ts
import { RESEARCHER_PROFIT_FRAMING, RESEARCHER_PROFILE_CRITICAL_FRAMING } from '../../mastra/agents/researcher-capabilities.ts';

function activeOverlayRulesText(input: ResearcherInput): string {
  const rules = input.activeOverlayRules ?? [];
  if (rules.length === 0) return 'Active overlay rules on this profile: (no active overlay rules yet — critique the base profile)';
  const lines = rules.map((r) => `- [${r.status}] ${r.thesis} :: ${JSON.stringify(r.ruleAction)}`).join('\n');
  return `Active overlay rules on this profile (critique these):\n${lines}`;
}

export function buildPrompt(input: ResearcherInput): string {
  const botPerf = buildBotResultsDigestText(input.botResults);
  const head = [
    `Strategy core idea: ${input.profile.coreIdea}`,
    `Direction: ${input.profile.direction}`,
    `Profile required features: ${input.profile.requiredMarketFeatures.join(', ') || '(none)'}`,
    ...profileDetailsText(input),
    `Market regime: ${input.marketRegime}`,
    input.marketContextMath
      ? formatMarketContextMath(input.marketContextMath)
      : `Market context features: ${JSON.stringify(input.marketContext.features)}`,
    RESEARCHER_PROFILE_CRITICAL_FRAMING,
    activeOverlayRulesText(input),
    ...(botPerf ? [botPerf] : []),
  ];

  const tradeBlock = input.tradeContexts && input.tradeContexts.length > 0
    ? [formatTradeContexts(input.tradeContexts)] : [];

  if (input.focus === 'profit_improvement') {
    return [
      ...head,
      RESEARCHER_PROFIT_FRAMING,
      ...tradeBlock,
      `Produce at most ${input.maxHypotheses} profit-improvement hypotheses.`,
    ].join('\n');
  }

  // loss_reduction (default): similar hypotheses + forensic evidence + losers' context
  const similar = input.similarHypotheses.length > 0
    ? input.similarHypotheses.map((s) => `- [${s.status}] ${s.thesis}`).join('\n')
    : '(none)';
  return [
    ...head,
    `Similar past hypotheses (advisory, avoid duplicating):\n${similar}`,
    ...forensicBundleText(input.tradeEvidence),
    ...tradeBlock,
    `Produce at most ${input.maxHypotheses} loss-reduction hypotheses.`,
  ].join('\n');
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/adapters/researcher/mastra-researcher.test.ts` → Expected: PASS (new + existing tests; existing tests now need `focus` on their input — fix the shared `baseInput()` default).
Run: `npm run typecheck` → Expected: exit 0. (This will surface every `ResearcherInput` literal missing `focus` — the handler and other tests; the handler is fixed in Task 7, other tests/fixtures get `focus: 'loss_reduction'`.)

> If typecheck flags `ResearcherInput` literals outside the files this task owns (e.g. eval harness fixtures), add `focus: 'loss_reduction'` to each — it is the backward-compatible default. List them in your report.

- [ ] **Step 6: Commit**

```bash
git add src/ports/researcher.port.ts src/adapters/researcher/mastra-researcher.ts src/adapters/researcher/mastra-researcher.test.ts
git commit -m "feat(research): focus discriminator + activeOverlayRules; buildPrompt branches on focus"
```

---

### Task 4: `FakeResearcher` honors `focus`

**Files:**
- Modify: `src/adapters/researcher/fake-researcher.ts`
- Test: `src/adapters/researcher/fake-researcher.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `ResearcherInput.focus`.
- Produces: distinct deterministic output per focus (so the fake-adapter demo exercises both passes). The `researchSummary` names the focus; profit-pass theses mention exit improvement.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { FakeResearcher } from './fake-researcher.ts';
// reuse / build a minimal ResearcherInput with focus.

describe('FakeResearcher focus', () => {
  it('tags its summary with the focus and varies profit theses', async () => {
    const r = new FakeResearcher();
    const loss = await r.propose({ ...minimalInput(), focus: 'loss_reduction' });
    const profit = await r.propose({ ...minimalInput(), focus: 'profit_improvement' });
    expect(loss.researchSummary).toMatch(/loss_reduction/);
    expect(profit.researchSummary).toMatch(/profit_improvement/);
    expect(profit.hypotheses[0]?.thesis ?? '').toMatch(/exit|profit/i);
  });
});
```

(Build `minimalInput()` from the existing `ResearcherInput` shape with `focus` defaulted; reuse a helper from another researcher test if present.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/adapters/researcher/fake-researcher.test.ts`
Expected: FAIL — summary lacks the focus token.

- [ ] **Step 3: Make `FakeResearcher.propose` focus-aware**

In `src/adapters/researcher/fake-researcher.ts`, vary the thesis and summary by `input.focus`:

```ts
async propose(input: ResearcherInput): Promise<ResearcherOutput> {
  const n = Math.max(0, Math.min(2, input.maxHypotheses));
  const profit = input.focus === 'profit_improvement';
  const hypotheses = Array.from({ length: n }, (_unused, i) => ({
    thesis: profit
      ? `Hypothesis ${i + 1}: improve exit on winning ${input.profile.coreIdea} trades (larger take-profit)`
      : `Hypothesis ${i + 1}: ${input.profile.coreIdea} conditioned on ${input.marketRegime} regime`,
    targetBehavior: profit ? 'Widen take-profit / trail the stop on confirmed continuation' : 'Adjust entry filtering using open interest trend',
    ruleAction: {
      appliesTo: input.profile.direction,
      rules: [{ when: profit ? `price continues ${i + 1} bars past exit` : `oi trend persists for ${i + 1} bars`,
        action: (profit ? 'widen_stop' : 'skip_entry') as const, params: { bars: i + 1 } }],
    },
    requiredFeatures: ['oi', 'funding'],
    validationPlan: 'Backtest baseline vs variant over the last 90 days',
    expectedEffect: { metric: profit ? 'profit_factor' : 'win_rate', direction: 'increase' as const },
    invalidationCriteria: [profit ? 'No profit_factor improvement vs baseline' : 'No win_rate improvement vs baseline'],
    confidence: 0.5,
  }));
  return { hypotheses, researchSummary: `Fake researcher (${input.focus}) produced ${n} hypotheses (botResults: ${input.botResults?.length ?? 0})` };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/adapters/researcher/fake-researcher.test.ts` → Expected: PASS.
Run: `npm run typecheck` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/researcher/fake-researcher.ts src/adapters/researcher/fake-researcher.test.ts
git commit -m "feat(research): FakeResearcher honors focus"
```

---

### Task 5: `origin` on `HypothesisProposal` (additive, optional)

**Files:**
- Modify: `src/domain/hypothesis.ts` (add `origin?: ResearcherFocus` to the `HypothesisProposal` interface)
- Test: `src/domain/hypothesis.test.ts` (append a minimal type-shape test; create if absent)

**Interfaces:**
- Consumes: `ResearcherFocus` (from `'../ports/researcher.port.ts'`).
- Produces: `HypothesisProposal.origin?: ResearcherFocus` — optional, so existing single-pass create sites and the Drizzle/in-memory repos compile unchanged (no DB migration this slice; persistence of `origin` is deferred to the ③ sub-project that needs it). The handler (Task 7) sets it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import type { HypothesisProposal } from './hypothesis.ts';

describe('HypothesisProposal.origin', () => {
  it('accepts an optional researcher-focus origin', () => {
    const p = { origin: 'profit_improvement' } as Pick<HypothesisProposal, 'origin'>;
    expect(p.origin).toBe('profit_improvement');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/domain/hypothesis.test.ts -t "origin"` then `npm run typecheck`.
Expected: typecheck FAIL — `origin` is not a property of `HypothesisProposal`.

- [ ] **Step 3: Add the field**

In `src/domain/hypothesis.ts`, add the import at the top and the field on `HypothesisProposal`:

```ts
import type { ResearcherFocus } from '../ports/researcher.port.ts';
```

and inside `interface HypothesisProposal { ... }`, after `contractVersion: string;`:

```ts
  origin?: ResearcherFocus; // which research pass produced this; undefined for legacy single-pass
```

> Check for an import cycle: `ports/researcher.port.ts` imports from `domain/hypothesis.ts` (for `RuleAction`, Task 3). A `type`-only import the other way is fine under `--experimental-strip-types` (types are erased). If `npm run typecheck` reports a real cycle error, instead define `ResearcherFocus` in `src/domain/hypothesis.ts` and re-export it from the port. Note which you did in your report.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/domain/hypothesis.test.ts` → Expected: PASS.
Run: `npm run typecheck` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/hypothesis.ts src/domain/hypothesis.test.ts
git commit -m "feat(research): optional origin (researcher focus) on HypothesisProposal"
```

---

### Task 6: Two-pass orchestration in the handler

**Files:**
- Modify: `src/orchestrator/handlers/research-run-cycle.handler.ts` (replace the single `propose()` call + the drafts setup with two-pass orchestration; add the winner per-trade context loop; add the active-overlay-rules fetch; add env consts)
- Test: `src/orchestrator/handlers/research-run-cycle.handler.test.ts` (append a `describe('two-pass', ...)` block)

**Interfaces:**
- Consumes: `selectWinningTrades`, `rankWinnersTyped`, `rankWinnersByHeadroom`, `isTypedCloseReason`, `postExitHeadroomPct` (Task 1); `ResearcherFocus`, `ActiveOverlayRuleSummary` (Task 3); `buildTradeContextMath` (existing); `services.researcher.propose`, `services.hypotheses.listByStrategyProfile` (existing port method); env `TRADE_CONTEXT_WINNERS_MAX`, `RESEARCHER_MAX_PER_PASS`.
- Produces: two `propose()` calls (loss then profit-when-winners), merged origin-tagged drafts into the existing dedup→validate→build loop; per-pass `researcher.pass_completed { focus, count }` events.

This task assumes the env/per-trade loop currently reads `TRADE_CONTEXT_WARMUP_MIN` (line 123) and, post-#111, `TRADE_CONTEXT_TAIL_MIN`. Reuse those exact reads.

- [ ] **Step 1: Write the failing handler test**

Append to `src/orchestrator/handlers/research-run-cycle.handler.test.ts`. Reuse the file's existing harness (`reportingResearcher`, fake services, `makeServices()`/equivalent). The test records the `focus` of each `propose` call and asserts gating + merge. Model it on the existing handler tests in that file (match their service-double construction):

```ts
describe('two-pass research', () => {
  it('runs loss then profit when winners exist, skips profit with none, merges drafts', async () => {
    const calls: string[] = [];
    const researcher = {
      adapter: 'fake' as const, model: 'fake',
      async propose(input: any) { calls.push(input.focus); return {
        hypotheses: [{ thesis: `t-${input.focus}`, targetBehavior: 'b',
          ruleAction: { appliesTo: 'long', rules: [{ when: 'x', action: 'skip_entry', params: {} }] },
          requiredFeatures: ['oi'], validationPlan: 'p',
          expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['none'], confidence: 0.5 }],
        researchSummary: 's' }; },
    };
    // services with botResults yielding 1 loser + 1 winner (isWin true); see the existing harness for the builder.
    const services = makeServices({ researcher, trades: [
      loserTrade({ tradeId: 'L1' }), winnerTrade({ tradeId: 'W1' }),
    ] });
    await researchRunCycleHandler(runCycleTask(), services as any);
    expect(calls).toEqual(['loss_reduction', 'profit_improvement']);

    // no winners -> profit skipped
    const calls2: string[] = [];
    const services2 = makeServices({ researcher: { ...researcher, async propose(i: any) { calls2.push(i.focus); return { hypotheses: [], researchSummary: 's' }; } },
      trades: [loserTrade({ tradeId: 'L2' })] });
    await researchRunCycleHandler(runCycleTask(), services2 as any);
    expect(calls2).toEqual(['loss_reduction']);
  });
});
```

> Adapt `makeServices`/`loserTrade`/`winnerTrade`/`runCycleTask` to the actual helpers in this test file. `loserTrade` sets `realizedPnl: '-5', isWin: false`; `winnerTrade` sets `realizedPnl: '5', isWin: true, closeReason: 'take_profit_partial'`. Ensure the fake `marketHistory.getRows` returns a small non-empty row set so the per-trade loop and headroom fallback don't throw.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts -t "two-pass"`
Expected: FAIL — only one `propose` call / `focus` undefined.

- [ ] **Step 3: Add env consts + active-rules fetch + winner context, and split the propose call**

At the top of `src/orchestrator/handlers/research-run-cycle.handler.ts` (near `TRADE_EVIDENCE_MAX`), add:

```ts
const RESEARCHER_MAX_PER_PASS_DEFAULT = 5;
const TRADE_CONTEXT_WINNERS_MAX_DEFAULT = 5;
```

After the losers' `tradeContexts` loop (currently ends at line 143), add winner selection + context. Compute `winnersMax` and select; on the typed path rank cheaply, on the fallback fetch rows (reusing them for context):

```ts
  // --- Winning-trade context (profit-improvement pass) ---
  const parsedWinnersMax = Number(process.env.TRADE_CONTEXT_WINNERS_MAX ?? String(TRADE_CONTEXT_WINNERS_MAX_DEFAULT));
  const winnersMax = Number.isFinite(parsedWinnersMax) && parsedWinnersMax > 0 ? Math.floor(parsedWinnersMax) : TRADE_CONTEXT_WINNERS_MAX_DEFAULT;
  const winnerContexts: TradeContextMath[] = [];
  {
    const allWinners = selectWinningTrades(botResults).filter((t) => t.closedAtMs != null);
    const typed = allWinners.length > 0 && allWinners.every((t) => isTypedCloseReason(t.closeReason));
    const parsedWarmup2 = Number(process.env.TRADE_CONTEXT_WARMUP_MIN ?? '150');
    const warmupMin2 = Number.isFinite(parsedWarmup2) && parsedWarmup2 > 0 ? parsedWarmup2 : 150;
    const parsedTail2 = Number(process.env.TRADE_CONTEXT_TAIL_MIN ?? '60');
    const tailMin2 = Number.isFinite(parsedTail2) && parsedTail2 > 0 ? parsedTail2 : 60;

    // Fetch rows once per candidate (bounded pool), reused for both ranking and context.
    const pool = typed ? rankWinnersTyped(allWinners, winnersMax) : allWinners.slice(0, winnersMax * 2);
    const rowsByTradeId = new Map<string, readonly CanonicalRowV2[]>();
    for (const t of pool) {
      if (t.closedAtMs == null) continue;
      try {
        const fromMs = t.openedAtMs - warmupMin2 * 60_000;
        const rows = await services.marketHistory.getRows({ symbol: t.symbol, fromMs, toMs: t.closedAtMs + tailMin2 * 60_000 });
        rowsByTradeId.set(t.tradeId, rows);
      } catch (err) {
        await services.events.append(event(task.id, 'researcher.trade_context_unavailable', { tradeId: t.tradeId, error: errMsg(err) }));
      }
    }
    const selectedWinners = typed ? pool : rankWinnersByHeadroom(pool, rowsByTradeId, winnersMax);
    for (const t of selectedWinners) {
      const rows = rowsByTradeId.get(t.tradeId);
      if (t.closedAtMs == null || !rows || rows.length === 0) continue;
      const pnlPctNum = Number(t.pnlPct);
      const realizedPnlNum = Number(t.realizedPnl);
      winnerContexts.push(buildTradeContextMath({
        tradeId: t.tradeId, symbol: t.symbol, rows,
        entryMs: t.openedAtMs, exitMs: t.closedAtMs,
        realizedPnl: Number.isFinite(realizedPnlNum) ? realizedPnlNum : 0, pnlPct: Number.isFinite(pnlPctNum) ? pnlPctNum : null,
        closeReason: t.closeReason ?? null,
        direction: profile.direction, regime: marketRegime, requiredFeatures: profile.requiredMarketFeatures,
      }, Date.now()));
    }
  }

  // Active overlay rules for both passes' critical framing.
  let activeOverlayRules: ActiveOverlayRuleSummary[] = [];
  try {
    const validatedProposals = (await services.hypotheses.listByStrategyProfile(profile.id))
      .filter((p) => p.status === 'validated');
    activeOverlayRules = validatedProposals.map((p) => ({ thesis: p.thesis, ruleAction: p.ruleAction, status: p.status }));
  } catch { activeOverlayRules = []; }
```

Now replace the single `propose()` + drafts setup (lines 181-203) with the two-pass orchestration. Define a local `runPass` and merge:

```ts
  const parsedPerPass = Number(process.env.RESEARCHER_MAX_PER_PASS ?? String(RESEARCHER_MAX_PER_PASS_DEFAULT));
  const maxPerPass = Number.isFinite(parsedPerPass) && parsedPerPass > 0 ? Math.floor(parsedPerPass) : RESEARCHER_MAX_PER_PASS_DEFAULT;

  await services.events.append(event(task.id, 'researcher.started', { strategyProfileId: profile.id }));

  const runPass = async (
    focus: ResearcherFocus,
    extra: Partial<ResearcherInput>,
  ): Promise<{ draft: HypothesisProposalDraft; origin: ResearcherFocus }[]> => {
    const input: ResearcherInput = {
      profile, marketContext, marketRegime, similarHypotheses: focus === 'loss_reduction' ? similarHypotheses : [],
      botResults, maxHypotheses: maxPerPass, focus, activeOverlayRules,
      ...(marketContextMath && marketContextMath.terms.length > 0 ? { marketContextMath } : {}),
      ...extra,
    };
    const out = await services.researcher.propose(input, {
      ...makeOnUsage(task, services),
      ...(marketContextArtifactId ? { tracingMetadata: { research_market_context_artifact_id: marketContextArtifactId } } : {}),
    });
    const parsedPass = validateWithSchema(ResearcherOutputSchema, out);
    if (parsedPass.status === 'invalid') {
      throw new Error(`researcher returned invalid output (${focus}): ${JSON.stringify(parsedPass.issues)}`);
    }
    const passDrafts = parsedPass.data.hypotheses.slice(0, maxPerPass);
    await services.events.append(event(task.id, 'researcher.pass_completed', { focus, count: passDrafts.length }));
    return passDrafts.map((draft) => ({ draft, origin: focus }));
  };

  let taggedDrafts: { draft: HypothesisProposalDraft; origin: ResearcherFocus }[] = [];
  try {
    taggedDrafts = await runPass('loss_reduction', {
      tradeEvidence,
      ...(tradeContexts.length > 0 ? { tradeContexts } : {}),
    });
    if (winnerContexts.length > 0) {
      const profitDrafts = await runPass('profit_improvement', { tradeContexts: winnerContexts });
      taggedDrafts = [...taggedDrafts, ...profitDrafts];
    }
  } catch (err) {
    await services.events.append(event(task.id, 'researcher.failed', { error: errMsg(err) }));
    throw err;
  }
  await services.events.append(event(task.id, 'researcher.completed', { count: taggedDrafts.length }));
```

> Import `HypothesisProposalDraft` from `'../../domain/hypothesis.ts'` and ensure `ResearcherInput` is imported as a type from `'../../ports/researcher.port.ts'` (the handler already constructs the propose input, so it likely is). Drop the old `effectiveMax`-based `drafts` slice; `effectiveMax` may remain only in the `research.run_cycle.started` event.

Then change the drafts loop header to iterate the tagged drafts and set `origin`:

```ts
  const drafts = taggedDrafts; // [{ draft, origin }]
  // ... allowedFeatures, seen, counters unchanged ...
  for (const { draft, origin } of drafts) {
    // fingerprint, validate, etc. — unchanged, but on the hypothesis record add:
    //   origin,
  }
```

Inside the `hypothesis: HypothesisProposal = { ... }` literal add `origin,` (after `contractVersion`). Update the final `research.run_cycle.completed` event's `proposed: drafts.length` (now the merged count).

- [ ] **Step 4: Add imports**

Ensure these are imported at the top of the handler: `selectWinningTrades, rankWinnersTyped, rankWinnersByHeadroom, isTypedCloseReason` are local (same file). Add type imports: `ResearcherFocus, ActiveOverlayRuleSummary` from `'../../ports/researcher.port.ts'`; `HypothesisProposalDraft` from `'../../domain/hypothesis.ts'`; `CanonicalRowV2` from `'@trading-platform/sdk/historical'` (if not already from Task 1).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/orchestrator/handlers/research-run-cycle.handler.test.ts` → Expected: PASS (two-pass block + existing handler tests; existing tests may need a winner/loser trade tweak — keep their behavior by giving their fake `botResults` only losers so they stay single-pass, or update expectations).
Run: `npm run typecheck` → Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/research-run-cycle.handler.ts src/orchestrator/handlers/research-run-cycle.handler.test.ts
git commit -m "feat(research): two-pass orchestration (loss + profit) with winner context"
```

---

### Task 7: Env documentation + full-suite green sweep

**Files:**
- Modify: `.env.example` (document the two new env vars)
- Modify: `docker-compose.demo.yml` / `.env.demo.example` (add the two vars with defaults, mirroring `TRADE_CONTEXT_WARMUP_MIN`/`TRADE_CONTEXT_TAIL_MIN`)
- Test: none new — this task is the full-suite gate.

**Interfaces:**
- Consumes: env `TRADE_CONTEXT_WINNERS_MAX`, `RESEARCHER_MAX_PER_PASS` (Task 6).
- Produces: documented operator surface; a green full suite.

- [ ] **Step 1: Locate the existing per-trade env docs**

Run: `grep -rn "TRADE_CONTEXT_WARMUP_MIN\|TRADE_CONTEXT_TAIL_MIN" .env.example .env.demo.example docker-compose*.yml`
Expected: shows where the warmup/tail vars are declared (post-#111). If `TRADE_CONTEXT_TAIL_MIN` is absent, #111 is not merged — STOP (see Global Constraints).

- [ ] **Step 2: Add the two vars beside warmup/tail**

In each file where `TRADE_CONTEXT_WARMUP_MIN` is documented, add adjacent lines:

```
# Max winning trades surfaced to the profit-improvement researcher pass (default 5)
TRADE_CONTEXT_WINNERS_MAX=5
# Max hypotheses each researcher pass proposes (loss + profit) (default 5)
RESEARCHER_MAX_PER_PASS=5
```

- [ ] **Step 3: Run the FULL suite + typecheck**

Run: `npm run typecheck` → Expected: exit 0.
Run: `npx vitest run` → Expected: all green (no failures). Investigate any researcher/handler fixture that breaks on the new required `focus` field and add `focus: 'loss_reduction'`.

- [ ] **Step 4: Commit**

```bash
git add .env.example .env.demo.example docker-compose.demo.yml
git commit -m "docs(research): document TRADE_CONTEXT_WINNERS_MAX + RESEARCHER_MAX_PER_PASS"
```

---

## Notes for the implementer

- **`focus` is required on `ResearcherInput`.** After Task 3, every `ResearcherInput` literal in the repo must set it. `npm run typecheck` is your finder; the backward-compatible value is `focus: 'loss_reduction'`. The eval harness (`src/experiments/researcher/*`) and any researcher tests are the likely sites.
- **Do not double-fetch winner rows.** The fallback path fetches rows once into `rowsByTradeId` and reuses them for context; the typed path fetches only the capped, already-ranked set.
- **The losers path is untouched** apart from the propose-call refactor — `selectSuspiciousTrades`, forensic evidence, and the losers' `tradeContexts` loop keep their exact behavior; the loss pass receives them.
- **Token budget:** two `propose()` calls share the cumulative token kill-switch via `makeOnUsage`; no new budget logic.
