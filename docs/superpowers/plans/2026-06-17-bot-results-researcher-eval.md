# Bot Results Researcher Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed real bot trading results into the researcher workflow and evaluate which model best produces fact-grounded, falsifiable improvement hypotheses.

**Architecture:** Keep `BotResultsReadPort` as the source boundary and store VPS data as offline fixtures shaped like the ops-read contract. Add a compact performance digest for prompts and a researcher eval harness mirroring the existing StrategyAnalyst harness.

**Tech Stack:** TypeScript ESM, Mastra structured output, Vitest, `@trading-platform/sdk/ops-read` DTOs.

---

### Task 1: Per-Run Bot Results Fixtures

**Files:**
- Modify: `src/adapters/platform/fixture-bot-results.adapter.ts`
- Modify: `src/adapters/platform/fixture-bot-results.adapter.test.ts`
- Modify fixtures under `src/adapters/platform/__fixtures__/bot-results/`

- [ ] Write failing tests proving `getClosedTrades(runId)` and `getRunSummary(runId)` return data for the requested run, not a global file.
- [ ] Implement backward-compatible fixture loading from either legacy files or `trades-by-run.json` / `summary-by-run.json`.
- [ ] Run `pnpm vitest run src/adapters/platform/fixture-bot-results.adapter.test.ts`.

### Task 2: Performance Digest for Researcher Prompt

**Files:**
- Create: `src/adapters/researcher/bot-results-digest.ts`
- Create: `src/adapters/researcher/bot-results-digest.test.ts`
- Modify: `src/adapters/researcher/mastra-researcher.ts`
- Modify: `src/adapters/researcher/mastra-researcher.test.ts`

- [ ] Write failing tests for aggregate metrics: total trades, win-rate, total/average pnl, average holding time, exit reasons, worst losing trades.
- [ ] Implement a pure digest builder over `BotRunResultDetail[]`.
- [ ] Replace the prompt's shallow bot-results block with the digest text.
- [ ] Run targeted researcher adapter tests.

### Task 3: VPS Snapshot Fixture

**Files:**
- Create: `scripts/export-bot-results-fixture.ts`
- Create or update: `docs/fixtures/bot-results/vps-from-2026-06-01/`

- [ ] Add a read-only fixture exporter that writes ops-read-shaped `runs.json`, `trades-by-run.json`, `summary-by-run.json`.
- [ ] Prefer HTTP ops-read input. If unavailable, document the equivalent SQL query against `canonical.bot_run` and `canonical.trade`.
- [ ] Use SSH only for read-only extraction and avoid persisting secrets.

### Task 4: Researcher Eval Harness

**Files:**
- Create: `src/experiments/researcher/*`
- Create: `scripts/researcher-eval.ts`
- Modify: `package.json`

- [ ] Mirror StrategyAnalyst dry-run / `--run` pattern.
- [ ] Score researcher output deterministically for schema validity, factual use of bot results, falsifiability, allowed overlay actions, invalidation criteria, and research-only safety.
- [ ] Add optional judge support only after deterministic score is in place.
- [ ] Run researcher harness tests and a dry-run command.

### Task 5: Workflow Verification

**Files:**
- Modify or add e2e tests under `test/e2e/` or `src/orchestrator/handlers/`

- [ ] Add an e2e test from saved profile + bot results fixture to researcher output.
- [ ] Run targeted tests.
- [ ] Run `pnpm typecheck`.
