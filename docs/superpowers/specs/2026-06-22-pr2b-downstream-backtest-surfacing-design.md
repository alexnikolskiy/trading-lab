# PR2b — Downstream `backtest.completed` surfacing — Design

**Status:** Approved (brainstorm 2026-06-22)
**Repos:** trading-lab (one additive event) + trading-office (server watcher + gateway DTO + web rendering)
**Roadmap:** `docs/conversational-operator-roadmap.md` — "Slice 3 / PR2b (backlog)" and "Operator confirmation UI" follow-ups. This is the cross-layer complement that surfaces per-hypothesis backtest results into the operator chat after the `research.run_cycle` turn has already completed.

## Goal

After a user confirms a `research.run_cycle` turn, the office reply completes immediately ("N backtests enqueued"). Each hypothesis then builds + backtests asynchronously; the per-hypothesis `backtest.completed` tasks finish seconds-to-minutes later (same conversation `correlationId`, distinct `taskId`). The current `ConversationFollower` is one-turn-lived and has already torn down, so these results never reach the chat.

PR2b surfaces each per-hypothesis backtest result back into the same conversation as a **proactive assistant message** ("Гипотеза «…»: PASS · netPnl +12% · sharpe 1.4."), incrementally, as each result lands — until the conversation goes idle or a hard cap is reached.

## Decisions (from the 2026-06-22 brainstorm)

1. **Granularity — incremental, one proactive message per `backtest.completed`** (not an aggregated end-of-cycle rollup). Robust to retries (FAIL/MODIFY at `cycleDepth < 2` spawn more backtests); no need to know N upfront; N is typically small (1–5).
2. **Proactive-message home — a new first-class primitive**: a new `operator_assistant_message` office event + a new `assistant_turn` web reducer action that creates an assistant-only transcript turn. This does NOT overload `operator_message_completed` and does NOT weaken the Q4 `pendingCompleted` buffering invariant.
3. **Follower lifecycle — idle + hard cap.** A long-lived per-conversation watcher lives while correlated backtest events keep arriving; stops after an idle window of silence OR a hard `maxMs` cap. No N-counting, no retry-depth tracking.
4. **Lab signal — a new clean terminal event.** The lab's `backtestCompletedHandler` emits a single hand-authored `backtest.result_ready` event (symmetric with `research.run_cycle.completed`). The office watches that one type instead of the five decision-keyed `hypothesis.*` events (avoids coupling the office to the lab decision taxonomy and avoids the `hypothesis.failed`-vs-`isFailureType` suffix collision).
5. **Feature flag — `OPERATOR_DOWNSTREAM_BACKTESTS`, default OFF**, but the slice's Definition of Done includes a live-verify and flipping it ON (or an explicit recorded decision to leave it OFF). The flag is a kill-switch; enablement is NOT deferred behind an external dependency (unlike the reranker).
6. **Durability — best-effort, in-memory.** The per-conversation registry is process-lifetime; an office-server restart mid-cycle loses in-flight watchers (consistent with every existing fire-and-forget follower). No persistence.

## Architecture & data flow

```
confirm run_cycle  (or onboard→run_cycle chain)
  → lab: hypothesis.build × N → build + platform backtest → enqueue backtest.completed task
  → lab backtestCompletedHandler: hypothesis.* (unchanged) + NEW backtest.result_ready   ← LAB change
  → SSE GET /v1/stream  (LabAgentEvent: type, taskId, correlationId?)
  → office StreamBridge.subscribeAppended  (already always-on, multi-subscriber)
  → DownstreamBacktestWatcher (run_cycle taskId registered; correlationId resolved via bootstrap) ← office-server change
       · on backtest.result_ready & correlationId matches & taskId unseen:
            getCompletionSummary(taskId)  [bounded retry — absorbs the status race]
            → renderCompletionSummary → bus.publish(operator_assistant_message)        ← gateway DTO change
       · reset idle timer; teardown on idle / maxMs / shutdown
  → WS (bus broadcast) → web: dispatch assistant_turn → ChatTurn renders assistant-only turn ← office-web change
  ... repeats per result
```

### Correlation resolution (important)

The chat `task_created` response carries `taskId`, `taskType`, `conversationId` (`ids.conversationId`) — but **no lab `correlationId`** (it exists only on streamed `LabAgentEvent.correlationId?`). So the watcher registers by **run_cycle `taskId` + captured `conversationId`**, then resolves the `correlationId` exactly as the existing `ConversationFollower.bootstrap()` does: poll `GET /v1/agent-events?taskId=<runCycleTaskId>` until an event carries a `correlationId`. Because correlationId is propagated across the whole chain (onboard → run_cycle → hypothesis.build → backtest.completed all share one id — preserved by the Q2/Defect A fix), bootstrapping on the turn's first taskId yields the id under which the downstream `backtest.result_ready` events arrive.

## Changes

### Change 1 — LAB: `backtest.result_ready` terminal event (additive)

`src/orchestrator/handlers/backtest-completed.handler.ts` (handler ~`:53`). After the existing `switch (decision)` that emits the five `hypothesis.*` events, append one unconditional terminal event mirroring the existing call shape:

```ts
await services.events.append(event(task.id, 'backtest.result_ready', {
  decision, profileId: strategyProfileId, hypothesisId, backtestRunId,
}));
```

- All four values are already destructured in scope at handler top (`const { backtestRunId, hypothesisId, strategyProfileId, decision, reasons, cycleDepth } = parsed.data;` ~`:57`). Note the in-scope field is `strategyProfileId`; the event payload key is `profileId` (the read layer does the same remap at `completion-summary.ts:114`).
- The five `hypothesis.*` events are **kept** (consumed by projections); this is purely additive.
- The handler is `Promise<void>` and has no explicit `return` — one more trailing `await append` is safe and does not change the success/throw contract. The worker sets `status: 'completed'` only after dispatch resolves (`worker.ts:24`), so this event fires **before** the status flip (see the race note).
- `event(taskId, type, payload)` helper: `backtest-support.ts:14`. `append` takes a single `AgentEvent` and is awaited.
- strip-types: no new parameter properties.

**Acceptance:** for each of the five decisions, `backtestCompletedHandler` appends exactly one `backtest.result_ready` as its final event, carrying `{decision, profileId, hypothesisId, backtestRunId}`; the existing `hypothesis.*` emissions are unchanged.

### Change 2 — OFFICE-GATEWAY: `operator_assistant_message` event variant

`packages/office-gateway/src/schemas.ts` — add a member to `officeEventSchema` (the discriminated union ~`:127-139`):

```ts
z.object({
  type: z.literal('operator_assistant_message'),
  ts: z.string(),
  operatorMessageId: z.string(),
  conversationId: z.string(),
  reply: operatorReplySchema,
}),
```

- Reuses `operatorReplySchema` (`:112-122`) — which requires `replyMessageId`, `operatorMessageId`, `conversationId`, `text`, `ts` (+ optional `evidence`/`actions`/`pendingInteractionId`/`sessionId`). The proactive backtest reply has no `actions`/`pendingInteractionId`; `evidence` is optional and omitted for v1 (text-first via `renderCompletionSummary`).
- This is the **first** assistant-initiated office event; every other `operator_*` event is bound to a user-submitted turn. It is intentionally a distinct type so the turn-bound semantics (and the Q4 reducer invariants) stay untouched.
- `events.ts` re-exports the inferred `OfficeEvent` type automatically.

### Change 3 — OFFICE-SERVER: `DownstreamBacktestWatcher` + wiring

New file `apps/server/src/operator/DownstreamBacktestWatcher.ts`. A process-lifetime component, constructed in `apps/server/src/index.ts` alongside the responders (only when the flag is ON and `chatToken` is set), sharing `wiring.bridge`, `wiring.client`, and receiving `bus`, guard config, `completionSummaryEnabled`, and an id-minter.

Shape:

- **`register(runCycleTaskId: string, conversationId: string): void`** — starts (or refreshes) a per-registration entry: resolves `correlationId` via bootstrap (poll `client.getAgentEvents({taskId: runCycleTaskId})` up to `bootstrapRetries`), records `{ correlationId, conversationId, seen: Set<taskId> }`, and arms an idle timer + a hard `maxMs` timer. Idempotent per `runCycleTaskId`.
- **One** subscription to `bridge.subscribeAppended((e: LabAgentEvent) => …)` for the whole watcher. On each event:
  - ignore unless `e.type === 'backtest.result_ready'`.
  - find the registration whose resolved `correlationId === e.correlationId`; ignore if none.
  - dedup: ignore if `e.taskId` is already in that registration's `seen` set (guards `StreamBridge` Last-Event-ID replay on reconnect); else add it.
  - `summary = await client.getCompletionSummary(e.taskId)` with a **bounded retry** (reuse the bootstrap cadence) to absorb the status race; on a non-null summary → `text = renderCompletionSummary(summary)`; on persistent null → a generic minimal fallback text (does NOT depend on `payloadSummary`, which is an optional projection, not the full payload).
  - mint fresh `operatorMessageId` + `replyMessageId`; reuse the registration's captured `conversationId`; `bus.publish({ type:'operator_assistant_message', ts, operatorMessageId, conversationId, reply: { replyMessageId, operatorMessageId, conversationId, text, ts } })`.
  - reset the registration's idle timer.
- **Teardown** of a registration on idle, on `maxMs`, or on `shutdown()` (unsubscribes its bridge interest / clears timers; the single bridge subscription is released at process shutdown).
- A throw while handling one event is logged and swallowed (one hypothesis must not kill the subscription).

**Registration hook:** in `apps/server/src/operator/TradingLabOperatorResponder.ts`, the `task_created` case (`:64-67`) and/or the default `startFollow` closure (where `deps` is in scope). Register when `resp.taskType === 'research.run_cycle' || resp.plannedNextStep?.taskType === 'research.run_cycle'`, passing `resp.taskId` and `ids.conversationId`. A `watcher` (or a `register` callback) is threaded into the responder deps the same way `startFollow` already is. When the flag is OFF the watcher is absent and `register` is a no-op.

**Config** (`apps/server/src/config.ts`): `OPERATOR_DOWNSTREAM_BACKTESTS` (bool, default false) gating construction; `OFFICE_BACKTEST_WATCH_MAX_MS` (hard cap, generous — backtests are slow), `OFFICE_BACKTEST_WATCH_IDLE_MS` (idle window), and a bounded completion-summary retry count/interval (may reuse the existing `chatFollow.bootstrapRetries`/`bootstrapIntervalMs`).

**Reuse:** `renderCompletionSummary` (`apps/server/src/operator/completionSummaryRender.ts:23`, pure `(LabCompletionSummary) => string`, already handles the `backtest.completed` kind at `:41-48`); `client.getCompletionSummary` (`TradingLabHttpClient.ts:68`, returns null on any error); `bridge.subscribeAppended` (`TradingLabStreamBridge.ts:68`).

### Change 4 — OFFICE-WEB: `assistant_turn` reducer action + rendering

`apps/web/src/floor/panels/operatorTranscript.ts` — add an action:

```ts
{ type: 'assistant_turn', operatorMessageId, conversationId, reply }
```

→ appends a new turn `{ localId: operatorMessageId, operatorMessageId, conversationId, userText: '', replyText: reply.text, status: 'completed', evidence: reply.evidence, actions: reply.actions, resolved: true, kind: 'assistant' }`. `mapById` / `pendingCompleted` are **not** touched (Q4 preserved). The existing `OperatorTurn` shape gains an optional `kind?: 'assistant'` discriminator (default user).

- The WS-event dispatcher (where `OfficeEvent` is routed into the reducer) maps `operator_assistant_message` → `assistant_turn`.
- `ChatTurn.tsx` renders an assistant-only turn: no user bubble (gated on `kind === 'assistant'` / empty `userText`), the reply rendered via the same markdown path as completed replies.

## Error handling / graceful degradation

- `getCompletionSummary` null after bounded retry → generic minimal proactive text (e.g. "Бэктест гипотезы завершён."); the watcher never goes fully silent and never throws out of the subscription.
- `StreamBridge` reconnect/replay → per-registration `seen` `Set<taskId>` suppresses duplicate `operator_assistant_message`.
- Watcher idle / `maxMs` → silent teardown (no event, no error).
- Flag OFF → watcher not constructed; `register` is a no-op; zero behavior change.
- Per-event handler exception → logged + swallowed; subscription survives for the other hypotheses.

## Known, accepted limitations (scope / YAGNI)

- **No new lab read endpoint** — reuse `/v1/stream` (trigger) + `/v1/tasks/:id/completion-summary` (detail).
- **No persistence** — best-effort in-memory; office-server restart mid-cycle loses in-flight watchers.
- **No aggregation / rollup, no N-counting, no retry-depth tracking** — purely incremental + idle/cap.
- **Bus is broadcast** — `bus.subscribe` (`app.ts:75`) fans every event to every WS client with no per-conversation scoping. For the single-user demo this is acceptable and consistent with the existing `operator_*` events; with `assistant_turn` (create-on-receipt) the proactive turn would appear in every open tab. Per-conversation bus scoping is a separate, out-of-scope concern.
- **Not a general proactive framework** — but `operator_assistant_message` + `assistant_turn` are a reusable primitive for future proactive surfaces (e.g. a later cycle-complete rollup).

## Invariants preserved

- **Research-only / confirmation gate** — the watcher only READS (stream + completion-summary) and surfaces; it creates no tasks and triggers no compute. The confirmation gate is untouched.
- **Audit-safe** — the proactive reply carries the same projection as `completion-summary` (ids / metrics / decision / reasons / counts), never raw strategy text, bodies, or embeddings.
- **No false absence** — a null summary is disclosed as a minimal known fact, not "nothing found".
- **Q4 reducer invariant** — `assistant_turn` is a separate action; `mapById` and `pendingCompleted` are unchanged.
- **strip-types (lab)** — the new lab code uses no TS parameter properties.
- **Mastra boundary** — not applicable (no new `Agent`).

## Testing

- **Lab** (vitest): `backtest-completed.handler` — `backtest.result_ready` is the final append for each of the five decisions, with the `{decision, profileId, hypothesisId, backtestRunId}` payload; the five `hypothesis.*` emissions are unchanged. Full lab suite + typecheck + the strip-types AST guard.
- **Office-server** (vitest, fake bridge + fake client): `register` → resolve correlationId via fake agent-events → feed a `backtest.result_ready` → exactly one `operator_assistant_message` with the rendered reply; dedup on replay (same taskId → no second event); idle-teardown and maxMs-teardown; flag-off → `register` no-op; summary-null after retries → fallback reply; foreign correlationId → ignored. Full server suite + typecheck.
- **Office-web** (vitest, reducer-only): `assistant_turn` creates an assistant-only completed turn (`userText: ''`, `kind: 'assistant'`) and does not disturb existing turns or `pendingCompleted` (Q4 regression guard); two `assistant_turn`s → two turns in arrival order. No `.tsx` test (web convention) — `ChatTurn` is covered by typecheck/build. Full web suite + typecheck.
- No new test infrastructure. npm workspaces (office), not pnpm.

## PR sequencing

1. **Lab PR** — `backtest.result_ready` (purely additive; dormant until office consumes it; safe to merge first).
2. **Office PR** — gateway DTO + server watcher + web rendering (one office PR; the three office layers are coupled by the new DTO).

## Definition of Done

Both PRs green and merged → live-verify on the demo stack (a real confirmed `run_cycle` produces a visible proactive assistant message per backtest result) → flip `OPERATOR_DOWNSTREAM_BACKTESTS` to ON (or record an explicit decision to leave it OFF with a reason). The slice is not closed until this step is done.

## Out of scope

- Per-conversation bus scoping; persistence/durable watchers; aggregated end-of-cycle rollups; counting expected N or tracking retry depth; a general proactive-message framework; any change to task creation, the confirmation gate, or live execution.
