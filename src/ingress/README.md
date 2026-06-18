# Ingress (SP-1 / SP-6.2)

Service-to-service write/ingress on `INGRESS_PORT` (default 3000), served by `createIngressApp`. Each route below is a fail-closed boundary fed by its **own** token — if a token is unset, that route rejects every request with `503`; with a token set, a missing/wrong `Authorization: Bearer …` gets `401`. The gates run before JSON parsing / validation / task intake.

`/tasks` is **not** the office path — trading-office reaches the lab through `POST /chat/messages` (see `../chat/README.md`). `/tasks` is a low-level internal ingress; `/callbacks/backtest-completed` receives terminal backtest events from trading-backtester / platform.

| Route | Token | Unset behavior |
|---|---|---|
| `POST /tasks` | `TRADING_LAB_TASK_TOKEN` | `503` (route mounted, rejects all) |
| `POST /callbacks/backtest-completed` | `TRADING_LAB_CALLBACK_TOKEN` | `503` (route mounted, rejects all) |

Each token must be distinct from the others (`read` / `chat` / `task` / `callback` are separate boundaries); a token for one route never authorizes another (proven by the cross-token isolation tests in `app.test.ts`).

## `POST /tasks`

- **Auth:** `Authorization: Bearer <TRADING_LAB_TASK_TOKEN>`. `401` on missing/wrong token; `503` when unset.
- **Request** (`IngressTaskRequestSchema`): `{ taskType, source, payload?, correlationId?, dedupeKey? }`, `content-type: application/json`.
- **Response:** `202 { taskId, status }`. Invalid body → `400 { status: 'rejected', issues }`. A repeated `dedupeKey` returns the same `taskId` without re-enqueue.

## `POST /callbacks/backtest-completed`

- **Auth:** `Authorization: Bearer <TRADING_LAB_CALLBACK_TOKEN>` **or** query `?token=<TRADING_LAB_CALLBACK_TOKEN>` (backtester posts JSON only, no custom headers). `401` on missing/wrong token; `503` when unset.
- **Request** (`BacktestCompletionCallbackSchema`): terminal completion event from trading-backtester / platform (`eventType`, `jobId`, `runId`, `status`, `summary`, `emittedAtMs`, optional `correlationId` / `workflowId`).
- **Behavior:** validates payload, looks up the persisted `BacktestRun` by `runId`, and enqueues `backtest.resume` (dedupe key `backtest.resume:{runId}`) when the run is still `submitted`. Unknown or already-finalized runs return `202 { status: 'accepted', action: 'ignored', reason }` without error.
- **Submit wiring:** when `TRADING_LAB_CALLBACK_PUBLIC_URL` and `TRADING_LAB_CALLBACK_TOKEN` are both set, lab passes `{publicUrl}/callbacks/backtest-completed?token=…` as `callbackUrl` on platform/backtester submit so completion is push-driven instead of poll-only.

`INGRESS_PORT` must not be public without network protection (reverse proxy / firewall). See `docs/superpowers/specs/2026-06-14-trading-lab-sp6.2-task-ingress-boundary-design.md`.
