# Chat→hypothesis→backtest + dev-onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD; checkbox steps.

**Goal:** (1) chat `hypothesis.build` carries `platformRun`; (2) a legitimate no-loss backtest result is accepted (no `ambiguous_profit_factor`); (3-5) `make dev` onboards with no hidden steps. See `docs/superpowers/specs/2026-06-23-chat-hypothesis-backtest-and-dev-onboarding-design.md`.

## Global Constraints

- Runtime `node --experimental-strip-types` — **no TS parameter properties** (`src/` + `scripts/`).
- `tsc --noEmit` covers only `src/` — for any `scripts/` change, also `git grep` for broken refs.
- Do NOT touch any `docker-compose*.yml` (demo/GHCR wiring is off-limits). Dev-mode = Makefile/mprocs.yaml/.env.dev.example/README only.
- Defect 2: do NOT blindly weaken the guard — only the provably-no-loss (`win_rate===1 && total_trades>0`) case stops throwing; the `win_rate<1 + absent PF` case MUST still throw `ambiguous_profit_factor`.
- `NO_LOSS_PROFIT_FACTOR` already exists in `src/domain/platform-comparison.ts` (=1_000_000); reuse it.

---

### Task 1: Defect 1 — thread `defaultPlatformRun` into chat `hypothesis.build`

**Files:** Modify `src/chat/guard.ts`, `src/chat/chat-handler.ts`, `src/composition.ts`; Test `src/chat/guard.test.ts`.

**Interfaces:**
- `PlanArgs` (guard.ts) gains `defaultPlatformRun: PlatformRunConfig`.
- `PlatformRunConfig` = `NonNullable<z.infer<typeof HypothesisBuildPayloadSchema>['platformRun']>` (export it from guard.ts or hypothesis-build.handler.ts; do NOT re-type the fields inline). Shape: `{ datasetId: string; symbols: string[]; timeframe: string; period: { from: string; to: string }; seed: number }`.
- `ChatHandlerDeps` gains `defaultPlatformRun: PlatformRunConfig`.

- [ ] **Step 1: Failing test** — in `src/chat/guard.test.ts`, add a case for `case 'hypothesis'`: given a turn with `subject:'hypothesis'` (confidence ≥ minConfidence), a `deps` whose `resolveBuildableHypothesis` resolves to a validated hypothesis `{ id: 'hyp-1', … }`, and `args.defaultPlatformRun = { datasetId:'D:1h', symbols:['D'], timeframe:'1h', period:{from:'a',to:'b'}, seed:7 }`, `planChatAction` returns `{ kind:'propose_task', taskType:'hypothesis.build', payload }` where `payload.platformRun` deep-equals that `defaultPlatformRun` and `payload.hypothesisId === 'hyp-1'`. Follow the existing test's construction of `PlanArgs`/`deps` (read the file's existing hypothesis-case test if present; reuse its hypothesis-resolver stub). 

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/chat/guard.test.ts` → fails (payload has no `platformRun`).

- [ ] **Step 3: Implement**
  - `guard.ts`: export `type PlatformRunConfig = NonNullable<z.infer<typeof HypothesisBuildPayloadSchema>['platformRun']>;` (import `z`? — the schema is imported already; derive from it). Add `defaultPlatformRun: PlatformRunConfig` to `PlanArgs`. In `case 'hypothesis'`, change `const payload = { hypothesisId: hyp.id };` → `const payload = { hypothesisId: hyp.id, platformRun: args.defaultPlatformRun };`. (Keep the existing `validateWithSchema(HypothesisBuildPayloadSchema, payload)` gate.)
  - `chat-handler.ts`: add `defaultPlatformRun: PlatformRunConfig` to `ChatHandlerDeps` (import the type from `./guard.ts`); in the `planChatAction(turn, { … })` call add `defaultPlatformRun: deps.defaultPlatformRun`.
  - `composition.ts`: where `ChatHandlerDeps` is assembled (the chat runtime deps object), add `defaultPlatformRun: <the same value used for services.defaultPlatformRun>` (reuse the composed services value — search for how `services.defaultPlatformRun` / the chat deps are built; pass the existing config object, do not duplicate the literal).

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/chat/guard.test.ts` + `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add -p` the three src files + test; `git commit -m "fix(chat): include platformRun in hypothesis.build payload (Defect 1)"`. (Do NOT `git add -A` — avoid sweeping stray files.)

---

### Task 2: Defect 2 — accept no-loss runs in `resolveProfitFactors`

**Files:** Modify `src/domain/platform-comparison.ts`; Test `src/domain/platform-comparison.test.ts` (create if absent).

**Interfaces:** `resolveProfitFactors(baseline, variant, topMetrics)` unchanged signature; `mapPlatformComparison` unchanged. New behavior only.

- [ ] **Step 1: Failing tests** — in `src/domain/platform-comparison.test.ts`, exercise `mapPlatformComparison` (or `resolveProfitFactors` if exported — if not, test via `mapPlatformComparison` with a crafted `RunResultSummary`). Read the existing test file (if any) for the `RunResultSummary` fixture shape; otherwise build a minimal summary. Cases:
  1. **both no-loss:** `comparison.baseline` & `.variant` each have all REQUIRED metrics, `win_rate:1`, `total_trades>0`, NO `profit_factor`; `summary.metrics` (topMetrics) also has NO `profit_factor`. Expect `mapPlatformComparison` returns a `ComparisonSummary` with `baseline.profitFactor === NO_LOSS_PROFIT_FACTOR` and `variant.profitFactor === NO_LOSS_PROFIT_FACTOR` (NO throw).
  2. **regression — genuinely ambiguous still throws:** same but `comparison.variant.win_rate = 0.6` (has losses) and no `profit_factor` anywhere → expect `mapPlatformComparison` to throw `MetricMappingError` with code `ambiguous_profit_factor`.
  3. **case 1 unchanged:** PF present in both → those values used.
  4. **case 3 unchanged:** both `total_trades:0` → PFs 0, no throw.

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/domain/platform-comparison.test.ts` → case 1 fails (currently throws).

- [ ] **Step 3: Implement** — in `resolveProfitFactors`, before the final `throw`, insert no-loss detection. Define a helper `const noLoss = (m: Record<string, number>) => (m['total_trades'] ?? 0) > 0 && m['win_rate'] === 1;`. Resolve per side:
  ```ts
  // baseline PF
  const baselinePf =
    'profit_factor' in baseline ? (baseline['profit_factor'] ?? 0)
    : 'profit_factor' in topMetrics ? (topMetrics['profit_factor'] ?? 0)
    : noLoss(baseline) || noLoss(topMetrics) ? NO_LOSS_PROFIT_FACTOR
    : undefined;
  // variant PF
  const variantPf =
    'profit_factor' in variant ? (variant['profit_factor'] ?? 0)
    : 'profit_factor' in baseline && 'profit_factor' in variant ? (variant['profit_factor'] ?? 0)
    : noLoss(variant) ? NO_LOSS_PROFIT_FACTOR
    : undefined;
  ```
  Then: keep the existing case-2 behavior (PF in topMetrics → variant NO_LOSS) and case-3 (both zero trades → 0/0) as fallthroughs, and throw `ambiguous_profit_factor` only if a side's PF is still `undefined`. **Preserve the exact current results for cases 1-3.** Recommended concrete shape: keep the existing `if (case1) … if (case2) … if (case3) …` ladder, and insert a new branch BEFORE the throw: `if (noLoss(baseline) ... ) ...`. Implementer: choose the clearest form that (a) maps a provably-no-loss side to `NO_LOSS_PROFIT_FACTOR`, (b) leaves cases 1-3 byte-identical, (c) still throws for a trades-present/`win_rate<1`/no-PF side. Update the function's doc comment to describe the no-loss case.

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/domain/platform-comparison.test.ts` (all 4) + any existing platform-comparison/backtest tests + `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git commit -m "fix(platform): accept no-loss runs (win_rate==1) instead of ambiguous_profit_factor (Defect 2)"`.

---

### Task 3: Dev-mode onboarding (Gaps 3-5)

**Files:** Modify `Makefile`, `mprocs.yaml`, `.env.dev.example`, `README.md`. NO src changes, NO docker-compose changes.

- [ ] **Step 1: `.env.dev.example` tokens (Gap 5)** — set the four empty tokens:
  `TRADING_LAB_READ_TOKEN=demo-read-token`, `TRADING_LAB_CHAT_TOKEN=demo-chat-token`,
  `TRADING_LAB_TASK_TOKEN=demo-task-token`, `TRADING_LAB_CALLBACK_TOKEN=demo-callback-token`.

- [ ] **Step 2: `make dev` preflight + infra + migrate (Gaps 3, 4)** — rewrite the `dev` target so it (in order): (a) installs deps — `pnpm install --frozen-lockfile` in repo root AND `pnpm -C "$(TRADING_BACKTESTER_PATH)" install --frozen-lockfile` (read `TRADING_BACKTESTER_PATH` from `.env.dev`; default `../trading-backtester`); (b) brings infra up detached and waits — `docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev up -d --wait postgres redis mock-platform`; (c) runs migrations — `set -a && . ./.env.dev && pnpm db:migrate`; (d) launches `pnpm exec mprocs`. Keep the `.env.dev` auto-create dependency. Use the existing compose-file triple verbatim (do not edit the compose files). Example:
  ```makefile
  dev: .env.dev
  	pnpm install --frozen-lockfile
  	set -a && . ./.env.dev && pnpm -C "$${TRADING_BACKTESTER_PATH:-../trading-backtester}" install --frozen-lockfile
  	docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev up -d --wait postgres redis mock-platform
  	set -a && . ./.env.dev && pnpm db:migrate
  	pnpm exec mprocs
  ```

- [ ] **Step 3: `mprocs.yaml` — drop the `infra` proc (Gap 4)** — remove the `infra:` proc block (infra is now started detached by `make dev`); keep `ingress`, `worker`, `backtester`, `office-server`, `office-web`. Update the header comment to note infra + migrations are handled by `make dev` before mprocs launches.

- [ ] **Step 4: README onboarding (Gap 3)** — document the dev onboarding: prerequisites (sibling repos `../trading-backtester` (pnpm) + `../trading-office` (npm) present), `cp .env.dev.example .env.dev`, `npm --prefix ../trading-office install` (office uses npm), then `make dev` (which now installs lab+backtester deps, brings up infra, migrates, and launches mprocs). Note ports (ingress 3000, read-api 3100, mock 8839, backtester 8080, office-server 8787, office-web 5174) and that a live turn-interpreter needs `TURN_INTERPRETER_ADAPTER=mastra` + `OPENROUTER_API_KEY`.

- [ ] **Step 5: Validate + commit** — `make config` (demo/local/vps/dev) stays green; `git commit -m "chore(dev): make dev installs deps + migrates + fills .env.dev tokens; drop mprocs infra proc (Gaps 3-5)"`.

---

## Self-Review
- Defect 1: payload mirrors research-handler:186; type derived from the schema (DRY). ✓
- Defect 2: cases 1-3 preserved; only `win_rate===1` side stops throwing; ambiguous case still throws. ✓
- Gaps: dev-only files; no docker-compose/src edits; migrations race-free (before mprocs). ✓
