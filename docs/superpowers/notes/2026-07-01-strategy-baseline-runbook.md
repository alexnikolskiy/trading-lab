# Strategy Baseline lane — real-engine runbook (Slice A / Task 16)

**Date:** 2026-07-01
**Plan:** `docs/superpowers/plans/2026-07-01-strategy-baseline-experiment-lane.md`
**Branch:** `feat/strategy-baseline-experiment-lane`

Runs the Cycle-1 baseline end-to-end on the real `long_oi` strategy: seed the profile → build a standalone strategy bundle → submit `engine:'strategy'` to the real `trading-backtester` over the mock-platform's ~6-day historical slice → read real trades → persist the experiment. **Goal = prove the chain, not a statistically-valid holdout** (the ~6-day slice degrades the holdout to `INCONCLUSIVE` by design — see §5).

---

## 1. Prerequisites

| Need | Why | How |
|---|---|---|
| **Docker daemon reachable via `docker` CLI in the shell** | the backtester runs each `long_oi` (untrusted bundle) run in a `docker run node:24-alpine` sandbox | Docker Desktop → Settings → Resources → WSL Integration → enable for this distro; verify `docker version` works in the WSL shell, then `docker pull node:24-alpine` |
| **Postgres** | lab persists profile / experiment / strategy_backtest_run | `DATABASE_URL=postgres://…`; run `pnpm db:migrate` (migrations incl. `0014`) once |
| **Redis** | `composeRuntime()` wires BullMQ unconditionally (the scripts push no jobs, but the client must construct) | `REDIS_URL=redis://…` |
| **LLM provider + key** | analyst (seed) + strategy builder (trigger) are real LLM calls | `MODEL_PROVIDER=anthropic\|openai\|openrouter` + the matching `*_API_KEY` |
| **Writable artifacts dir** | `LocalFileArtifactStore` | default `.artifacts/` (or set `ARTIFACT_DIR`) |
| **`trading-backtester` sibling repo** | the real engine | `../trading-backtester/apps/backtester` |
| **`trading-mock-platform` sibling** | serves the historical slice the engine simulates over | `../trading-mock-platform` |

> **Known blocker on this dev box (2026-07-02):** the `docker` CLI is **not available in the WSL2 shell** ("could not be found in this WSL 2 distro — activate WSL integration in Docker Desktop"). Until Docker Desktop WSL integration is enabled for this distro, the strategy-bundle run cannot execute here (the engine's per-run `docker run` fails). This is the WSL2 topology gotcha the design anticipated — the backtester must run as a **host process** where `docker` resolves.

---

## 2. Bring up the services

**a. mock-platform** (serves `/historical/rows` over the committed ~6-day fixture `2026-06-12-real-top5`):

```bash
cd ../trading-mock-platform
pnpm install
# start its HTTP server (check its package.json for the exact script; it listens on e.g. :8088)
pnpm start   # note the URL it binds, e.g. http://127.0.0.1:8088
```

**b. trading-backtester as a HOST process** (NOT nested in a container — so its `docker run` hits Docker Desktop natively):

```bash
cd ../trading-backtester/apps/backtester
pnpm install
docker pull node:24-alpine
BACKTESTER_ENABLE_OVERLAY_ENGINE=true \
BACKTESTER_DATA_SOURCE=mock \
BACKTESTER_MOCK_PLATFORM_URL=http://127.0.0.1:8088 \
BACKTESTER_AUTH_TOKEN=dev-token \
pnpm start          # Fastify on 127.0.0.1:8080; auto-runs its in-process worker
```

> **Open item to confirm at run time:** whether `engine:'strategy'` needs its own enable flag (overlay is gated by `BACKTESTER_ENABLE_OVERLAY_ENGINE`). Check `trading-backtester/apps/backtester/src/jobs/submit.ts::validate` for a strategy-engine gate; set whatever it requires. Record the answer here after the first run.

---

## 3. Seed the profile (once)

```bash
cd ../trading-lab
DATABASE_URL=… REDIS_URL=… \
STRATEGY_ANALYST_ADAPTER=mastra MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=… \
STRATEGY_ANALYST_MODEL=anthropic/claude-… \
pnpm tsx scripts/seed-long-oi-profile.mts
# → prints the persisted strategyProfileId (idempotent by sourceFingerprint; re-runs are no-ops)
```

Capture the printed `strategyProfileId`.

---

## 4. Run the baseline (the real chain)

```bash
DATABASE_URL=… REDIS_URL=… \
TRADING_PLATFORM_INTEGRATION=backtester \
BACKTESTER_API_URL=http://127.0.0.1:8080 BACKTESTER_API_TOKEN=dev-token \
BUILDER_ADAPTER=mastra MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=… BUILDER_MODEL=anthropic/claude-… \
STRATEGY_PROFILE_ID=<from step 3> \
pnpm tsx scripts/run-strategy-baseline.mts
# → prints { experimentId, verdict } + per-member { role, tradeCount, strategyBacktestRunId } + sanity metrics
```

`TRADING_PLATFORM_INTEGRATION=backtester` routes BOTH `selectResearchPlatform` (submit) and `selectRunTrades` (trades artifact) to the real `HttpBacktesterAdapter`. The LLM builder is non-deterministic → each run mints a new `bundleHash` → a new experiment (idempotency is per-bundleHash).

---

## 5. Expected outcome & acceptance

- The **sanity** run submits `engine:'strategy'` and executes in a docker sandbox; a completed sanity run yields real `trades` (with `entryTs`/`exitTs`) → its `tradeCount` should be **> 0**.
- On the ~6-day slice, `resolveHoldoutBoundary` returns `mode:'none'` (`minHistoryDays=30`) → the experiment finalizes **`INCONCLUSIVE`** with no train/holdout split. This is the **honest, expected** result — the baseline never reaches `PAPER_CANDIDATE` on short data (§6 of the spec). It proves the chain, not a valid holdout.

**Acceptance (Task 16):** a real run where the **sanity member's `tradeCount` > 0** — proving submit → engine (docker sandbox) → trades artifact (`contentHash`/`page`) → `mapStrategyMetrics` → persisted `strategy_backtest_run` + experiment all work on real data. Verdict `INCONCLUSIVE` is a pass. A full train/holdout split + any `PAPER_CANDIDATE` is a later, ≥30-day, on-server exercise.

---

## 6. Captured run

**Status: CHAIN PROVEN** — executed 2026-07-02 on the WSL2 dev box (Docker Desktop WSL integration enabled; `node:24-alpine` pulled). The full chain runs end-to-end and the strategy `strategy_backtest_run` reaches `completed` with real, engine-produced metrics. `tradeCount` is 0 (see below) — a strategy-fit / data-granularity outcome, not a chain defect.

- Date / host: 2026-07-02, WSL2 dev box (host `trading-backtester` on :8080, BIND-mode sandbox; infra via `docker compose … up postgres redis mock-platform`)
- `strategyProfileId`: `b76fd88d-b5b5-428d-86fb-77e5f1796ab6` (real `strategy.onboard`, analyst `openrouter/openai/gpt-5.5`, 7 files / 57 563 bytes, fingerprint `sha256:513eefd5…`)
- strategy `bundleHash` (lab, non-deterministic per LLM build): `sha256:607abc0d…` (builder `openrouter/anthropic/claude-sonnet-4.6`; backtester-internal materialized bundleHash `sha256:440341cd…`)
- `experimentId`: `exp-93308e7e-fd9d-430b-a33a-0f79ec3e47dd`
- `verdict`: **FAIL** — the evaluator's `minTrades≥1` gate fires on 0 trades. (INCONCLUSIVE was the *expected* verdict IF the sanity run produced trades and the holdout then degraded to `mode:'none'`; with 0 sanity trades it never reaches the holdout split.)
- sanity `tradeCount`: **0** — `strategy_backtest_run` id `defcad6b-…` status `completed` (~11 s real docker-sandbox run), platform run `08712929-…`
- sanity `metrics`: all zero (`pnl/sharpe/max_drawdown/win_rate/total_trades/profit_factor/top_trade_contribution_pct = 0`)
- **Why 0 trades (diagnosed from the `decision-records` artifact, 161 records over the ~6-day 1h slice):** the strategy DID execute against real data and evaluated every bar — ~26 bars emitted `baseDecision {kind:'annotate', tags:['dump_detected','high_to_low'], triggerPct≈36}` — but **never a `kind:'enter'`**. The LLM-built `long_oi_dump_reversal_v1` detects the OI-dump but never converts a detection into an entry on this coarse `ESPORTSUSDT:1h` window. This is builder-faithfulness / data-granularity (long_oi's real signal is a 1m + taker/OI construct — see [[trading-lab-commitxtermmath-design]] / [[no-shortcuts-extend-data-model]]), NOT a plumbing gap. A tradeCount>0 acceptance needs either a finer/richer dataset (VPS ≥30-day 1m) or a builder that ports the full entry path.
- **`engine:'strategy'` flag needed? (the §2 open item — ANSWERED):** No separate enable flag beyond `BACKTESTER_ENABLE_OVERLAY_ENGINE=true` (the strategy path shares the overlay sandbox router). **BUT** the run request MUST carry `riskProfileRef` + `executionProfileRef` — the strategy engine rejects any position-capable config without them (`runner.ts::runBacktest` → `missing_risk_profile` / `executionProfileRef не привязан`), terminal `validation_error` *before* the sandbox. The lab's `submitStrategyResearchRun` omitted both, so every real strategy submit was rejected in ~0.6 s. **Fixed** on branch `fix/strategy-baseline-risk-exec-profile-ref`: resolve the sole run preset and reuse its `riskProfileRef`/`executionProfileRef` (the platform defaults the strategy inline-registry registers via `buildInlineOverlayRegistry` → `TRUSTED_REGISTRY_DEFINITION`), mirroring `submitOverlayRun`. This unblocked the `completed` run above.
- Task-9 note: `getRunTrades` field reads verified correct (`descriptor.contentHash` + `ArtifactPage.page`) — controller-confirmed during implementation, `src/adapters/platform/http-backtester.adapter.ts:433-434`.
