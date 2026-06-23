# Chat→hypothesis→backtest green + dev-mode onboarding — Design

**Status:** Approved (investigation + brainstorm 2026-06-23; Defect-2 resolution chosen: NO_LOSS sentinel, lab-only)
**Repo:** trading-lab (dev-run may touch ../trading-backtester, ../trading-office)

## Goal

Make the chat path "сообщение → проверка гипотезы → бэктест" reach a meaningful terminal, and make
`make dev` onboard with no hidden manual steps. Five items found during E2E.

## Defect 1 — chat `hypothesis.build` is missing `platformRun`

**Root cause (confirmed):** `src/chat/guard.ts` `planChatAction` `case 'hypothesis'` builds
`payload = { hypothesisId: hyp.id }` — no `platformRun`. `HypothesisBuildPayloadSchema.platformRun`
is `.optional()`, so it validates, then `hypothesisBuildHandler` hits
`if (payload.platformRun === undefined) → build_failed { code: 'missing_platform_run_config' }`.
The correct auto-chain from research does it right: `research-run-cycle.handler.ts:186` sets
`platformRun: services.defaultPlatformRun`. `defaultPlatformRun` lives on `AppServices`
(`app-services.ts:69`), constructed in `composition.ts:236`.

**Fix (lab-only):** thread `defaultPlatformRun` into the chat planner and put it in the
`hypothesis.build` payload (mirror line 186).
- `src/chat/guard.ts`: add `defaultPlatformRun: PlatformRunConfig` to `PlanArgs`; in `case 'hypothesis'`
  build `payload = { hypothesisId: hyp.id, platformRun: args.defaultPlatformRun }` before schema-validating.
  Type `PlatformRunConfig` = the `platformRun` object shape (datasetId, symbols, timeframe, period{from,to}, seed);
  reuse the existing structural type — derive from the schema (`NonNullable<z.infer<typeof HypothesisBuildPayloadSchema>['platformRun']>`) or the `AppServices['defaultPlatformRun']` type. Do NOT redefine the fields inline twice.
- `src/chat/chat-handler.ts`: add `defaultPlatformRun` to `ChatHandlerDeps`; pass it in the
  `planChatAction(turn, { …, defaultPlatformRun: deps.defaultPlatformRun })` call.
- `src/composition.ts`: pass `defaultPlatformRun: <the services value>` into the `ChatHandlerDeps` construction
  (the value already exists in the composed `services`).

**Acceptance:** a chat "проверь последнюю гипотезу" (same session, after a research cycle produced a
validated hypothesis) creates a `hypothesis.build` that proceeds past `build.started` with NO
`missing_platform_run_config`.

## Defect 2 — `ambiguous_profit_factor` on a legitimate no-loss run

**Root cause (confirmed, nuanced):** the backtester omits `profit_factor` when `absGrossLoss === 0`
(no losing trades — FR-002). When BOTH baseline and variant are no-loss, `profit_factor` is absent
from `comparison.baseline`, `comparison.variant`, AND `summary.metrics` (baseline's full set). The lab's
`resolveProfitFactors` (`src/domain/platform-comparison.ts:46`) covers PF-in-both (case 1),
PF-in-topMetrics → variant NO_LOSS (case 2), and both-zero-trades → {0,0} (case 3), then **throws
`ambiguous_profit_factor`** (case 4). A valid completed all-winning run thus gets misclassified as
`result_invalid` (`backtest-support.ts:152` emits `backtest.failed`). The demo's `real-top5` fixture is
entirely no-loss, so EVERY dev/demo backtest hits this.

**Fix (lab-only, principled — NOT a blind loosening):** extend `resolveProfitFactors` to treat a side
as no-loss when its `profit_factor` is absent AND it has trades with **no losses**, using the sound
signal **`win_rate === 1 && total_trades > 0`** (a losing trade ⟹ `win_rate < 1`, so this never
false-positives a side that actually had losses). Such a side maps to the existing
`NO_LOSS_PROFIT_FACTOR` sentinel (1_000_000 — already used by case 2; passes the evaluator's
`minProfitFactor` gate). Resolution becomes per-side:
- baselinePf: `'profit_factor' in baseline` → its value; else `'profit_factor' in topMetrics` → that;
  else baseline no-loss (`win_rate===1 && total_trades>0` on the baseline/top metrics) → `NO_LOSS_PROFIT_FACTOR`;
  else `total_trades===0` → 0; else throw.
- variantPf: `'profit_factor' in variant` → its value; else variant no-loss (`win_rate===1 && total_trades>0`
  on variant) → `NO_LOSS_PROFIT_FACTOR`; else `total_trades===0` → 0; else throw.

The genuinely-ambiguous case (a side with trades, `win_rate < 1`, and no `profit_factor`) **still throws** —
the guard is preserved where PF is truly undeterminable. Cases 1-3 keep their current results.

**Acceptance:** a both-sides no-loss completed run maps to a valid `ComparisonSummary` (both PFs =
`NO_LOSS_PROFIT_FACTOR`) and the path reaches a non-error terminal (evaluation completes) instead of
`backtest.failed{ambiguous_profit_factor}`. A run with trades, `win_rate<1`, and absent PF still throws.

## Gap 3 — `make dev` silently breaks on stale SDK deps

`make dev` fails `ERR_MODULE_NOT_FOUND: '@trading-platform/sdk' / '@trading-backtester/sdk'` — node_modules
is stale vs the lockfile (SDKs are GitHub-Release tarballs). **Fix:** add a preflight to `make dev` that
runs `pnpm install --frozen-lockfile` in trading-lab and `pnpm -C "$TRADING_BACKTESTER_PATH" install
--frozen-lockfile` (and documents the office `npm install`), so the dev path reconciles node_modules
before launching. Document the full onboarding in README.

## Gap 4 — dev path never runs migrations

`mprocs.yaml` has no `migrate` proc (demo has a `migrate` service; dev does not), so ingress/worker start
against an un-migrated DB. **Fix:** `make dev` brings infra up detached and runs `pnpm db:migrate` BEFORE
launching mprocs (race-free — migrations complete before app procs). Drop the `infra` proc from
`mprocs.yaml` (infra is now make-managed, detached); mprocs runs only the host app procs
(ingress/worker/backtester/office-*). `make down` already tears infra down.

## Gap 5 — `.env.dev.example` ships empty service tokens

`TRADING_LAB_{READ,CHAT,TASK,CALLBACK}_TOKEN=` are empty → read-API doesn't start, `/tasks` and `/chat`
return 503. **Fix:** fill with the same safe dev values the demo example uses:
`TRADING_LAB_READ_TOKEN=demo-read-token`, `TRADING_LAB_CHAT_TOKEN=demo-chat-token`,
`TRADING_LAB_TASK_TOKEN=demo-task-token`, `TRADING_LAB_CALLBACK_TOKEN=demo-callback-token`.

## Testing

- Defect 1: `src/chat/guard.test.ts` — `case 'hypothesis'` (with a resolvable buildable hypothesis)
  produces a `propose_task` whose payload includes `platformRun` equal to the injected `defaultPlatformRun`.
- Defect 2: `src/domain/platform-comparison.test.ts` — (a) both-sides no-loss (`win_rate===1`, trades>0,
  no PF anywhere) → both PFs `NO_LOSS_PROFIT_FACTOR`, valid `ComparisonSummary`; (b) regression: a side with
  `win_rate<1` and absent PF still throws `ambiguous_profit_factor`; (c) existing cases 1-3 unchanged.
- Gaps 3-5: no unit tests; verified by `make config` staying green + the dev stand booting + the E2E.
- **Gates:** `pnpm check` + the touched-area `vitest` suites green.
- **E2E (with `OPENROUTER_API_KEY` + a live mastra turn-interpreter):** on the dev stand, a chat message
  to research a strategy then "проверь гипотезу" runs the full workflow with no `missing_platform_run_config`
  and the backtest reaches a non-error terminal.

## Invariants / scope

- strip-types: no TS parameter properties.
- Defect 2 does NOT blindly weaken the guard — only the provably-no-loss (`win_rate===1`) case stops throwing.
- Out of scope: seeding loss-bearing mock data (that lives in trading-mock-platform — not an allowed edit
  target, and would touch the demo data path); any docker-compose demo/GHCR change; the backtester's own
  `fixture` data-source path.
