# Source-Aware Critic + Chat HITL — Design

**Date:** 2026-06-27
**Status:** Approved (brainstorming)
**Branch:** `feat/critic-chat-hitl` (from main after PR #89 merge)

## Context

The pre-flight strategy critic (PR #88) + its eval (PR #89) settled the model decision: **single
mode + grok-4.3 + the structured combined prompt**. The remaining step is to make the critic live
by default — but NOT as a blind global auto-rewrite. For a **chat/telegram** strategy the user wants
to see the strategy's problems and **decide** whether to incorporate the critic's improvements; for a
**crawler/ingestion** strategy the improvement should be automatic. So "enable the critic by default"
must be **source-aware**, and for the human path it is a **human-in-the-loop (HITL)** confirm.

Recon confirmed the existing two-turn confirm flow is reusable end-to-end (propose → `/chat/confirm`
→ `executeConfirmedProposal` → enqueue), and trading-office already renders `assistant_message` +
action buttons — so this is a **trading-lab-only** slice (with one office verification point).

## Decisions

- **Source-aware behaviour:** chat (`manual_description`, via `chat-handler`) → **HITL**; crawler /
  direct-`/tasks` onboarding → **auto** (the existing worker-side critic, unchanged).
- **Chat HITL = one turn, three actions** (reuses the existing confirm flow): `confirm` ("Улучшить и
  анализировать"), `accept_as_is` ("Анализировать как есть"), `cancel` ("Отмена").
- **Enable by default in CODE:** `STRATEGY_PREFLIGHT_CRITIQUE` → `true`, `STRATEGY_CRITIC_MODE` →
  `single`, `STRATEGY_CRITIC_MODEL` → `openrouter/x-ai/grok-4.3` (the eval's verdict).
- **Fail-soft / disabled:** when the critic is null (flag off) or throws at chat time, chat falls
  back to today's simple onboard confirm (no critique, no improvement option). Onboarding never
  blocks.

## Architecture (all in trading-lab)

### 1. Critic at chat time (`src/chat/` + composition)

When a new strategy arrives in chat (turn subject = strategy → `buildOnboardDecision`, always
`kind: 'manual_description'`), the chat layer — if `deps.strategyCritic` is present — calls
`strategyCritic.refine(input)` **synchronously** (fail-soft) BEFORE building the proposal. This adds
one LLM call (grok-4.3, ~9s) to that chat turn; acceptable for an onboarding turn.

- Thread `strategyCritic: StrategyCriticPort | null` into `ChatHandlerDeps` / `ChatAppDeps` and wire
  it in `composition.ts` (reuse `buildStrategyCritic`; today it is built only for the worker
  `AppServices`).

### 2. Proposal carries both texts + critique (`src/chat/action-proposal.ts`, response)

The onboard `ActionProposal` (when a refinement was produced) stores:
- the **original** content (today's payload), and
- the **improvedStrategyText** (the refined alternative), and
- a compact **critique summary** for display.

The `assistant_message` shows a brief problem list — `verdict.severity` + `verdict.mainVulnerability`
+ the top-N `vulnerabilities` — and offers **three** `ProposedActionView`s: `confirm`,
`accept_as_is`, `cancel`. When no refinement was produced (critic off/failed), the proposal is the
existing two-action onboard confirm.

### 3. Confirm branching (`executeConfirmedProposal` + `/chat/confirm`)

`consumeConfirmation` / `/chat/confirm` accept the chosen action. In `executeConfirmedProposal`:
- `confirm` → enqueue `strategy.onboard` with `content = improvedStrategyText`.
- `accept_as_is` → enqueue with `content = original`.
- `cancel` → no enqueue (existing cancel behaviour).
Both enqueue paths set a payload flag **`skipPreflightCritique: true`** (the chat already resolved
the critic).

The `/chat/confirm` decision type is extended from `'confirm' | 'cancel'` to include `accept_as_is`
(or the chosen action id is threaded through). The lab side handles all three.

### 4. Worker skip (`src/orchestrator/handlers/strategy-onboard.handler.ts`)

If the task payload has `skipPreflightCritique: true`, the worker does NOT run its critic block (the
chat already applied/declined). Direct `/tasks` / crawler onboarding has no such flag → the worker
runs the auto-critic (existing behaviour, gated by `STRATEGY_PREFLIGHT_CRITIQUE`). This is the
source-aware split at the worker boundary.

### 5. Enable-by-default env (`src/config/env.ts` + `.env.example` + docker)

Change the code defaults: `STRATEGY_PREFLIGHT_CRITIQUE` → `true`, `STRATEGY_CRITIC_MODE` → `single`,
`STRATEGY_CRITIC_MODEL` → `openrouter/x-ai/grok-4.3`. Audit ripple: any test/composition asserting a
null critic or `two_stage` default must be updated to the new defaults (or pass explicit overrides).
`.env.example` + docker overlays reflect the new defaults.

## Cross-repo (trading-office)

The office already renders `assistant_message` + a generic `actions` list and routes `/chat/confirm`.
**Verify** the confirm UI/connector can render a THIRD action (`accept_as_is`) and send its id as the
decision. If the connector hardcodes `confirm | cancel`, a **small office fast-follow** is needed
(map the third button) — mirroring the prior 3-PR operator-confirmation slice. The lab side is built
complete regardless.

## Testing

- **chat-handler:** new strategy + critic present → `assistant_message` lists problems + 3 actions,
  proposal carries original + improved + critique; critic throws → fail-soft to the simple 2-action
  onboard confirm; critic null (flag off) → today's behaviour.
- **confirm branching:** `confirm` → enqueued payload `content === improvedStrategyText` +
  `skipPreflightCritique:true`; `accept_as_is` → `content === original` + `skipPreflightCritique:true`;
  `cancel` → no enqueue.
- **worker:** `skipPreflightCritique:true` → critic NOT called (analyst sees the payload content as-is);
  no flag (crawler/direct) + flag-on → auto-critic runs (existing tests).
- **env:** new defaults (`STRATEGY_PREFLIGHT_CRITIQUE=true`, `mode=single`, `model=…grok-4.3`).
- **composition:** `strategyCritic` provided to the chat app deps.
- Gate: `pnpm typecheck` + `pnpm test` (full suite green, including any ripple fixes from new defaults).

## Out of scope

- The crawler/ingestion source itself (not wired yet; the worker auto-path already handles it).
- The office UI change for the 3rd action (separate small fast-follow if verification shows it's
  needed).
- The backtest-period HITL (a later slice — see the backlog memory) and the analyst-model work.
- Removing `two_stage` (kept; just no longer the default mode).
