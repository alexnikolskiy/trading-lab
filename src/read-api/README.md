# Read API (SP-5)

Read-only, service-to-service HTTP boundary for trading-office. Separate Hono app on `READ_API_PORT` (same process as ingress). Starts only when `TRADING_LAB_READ_TOKEN` is set.

Auth: `Authorization: Bearer <TRADING_LAB_READ_TOKEN>` on every `/v1/*` route. `/healthz` + `/readyz` are open.

Readiness vs. credentials — two distinct probes:
- `/readyz` is **open** and reports process/DB readiness only. It says nothing about whether a caller's read token is valid.
- `GET /v1/authz` is **credential-gated** (same `readAuthMiddleware` as the rest of `/v1/*`): a valid `TRADING_LAB_READ_TOKEN` → `200 { "status": "ok" }`; a missing/invalid token → the same `401 { error: { code: "unauthorized" } }` as any other read route. Consumers use it to confirm the credentials they will actually use for `/v1/*` reads, not just that the process is up.

Endpoints:
- `GET /v1/hypotheses` (`status?`, `profileId?`, `limit?`, `cursor?`) · `GET /v1/hypotheses/:id`
- `GET /v1/backtests` (`hypothesisId?`, `status?`, `limit?`, `cursor?`) · `GET /v1/backtests/:id`
- `GET /v1/agent-events` (`taskId?`, `type?`, `since?`, `correlationId?`, `limit?`, `cursor?`)
- `GET /v1/authz` (credential probe — `200` with a valid read token, `401` otherwise)
- `GET /healthz` · `GET /readyz` (process/DB readiness only — open, no token, no queue/worker)

Pagination is keyset (opaque `cursor`); `limit` default 20, max 100. DTOs are deny-by-default projections; internal schema is never exposed; no `trading-platform` calls. See `docs/superpowers/specs/2026-06-13-trading-lab-sp5-read-api-design.md`.

## SP-6 — Agent activity + internal realtime stream

Read-only Agent Activity Projection + an internal server-to-server SSE stream for the trading-office backend.

- `GET /v1/agents` — snapshot of logical agents (`analyst`, `researcher`, `critic`, `builder`, `system`) with `status`, `currentTaskId`, and last event; plus an opaque `cursor` to open the stream from.
- `GET /v1/agents/:agentId` — agent activity (`status`, `currentTask`, sanitized `trace` tail).
- `GET /v1/stream` — SSE, server→client only (no command channel). Resume via `Last-Event-ID` (preferred) or `?cursor=`; events `agent_status_changed` + `agent_event_appended`; `: ping` heartbeat.

Delivery: a Postgres `AFTER INSERT` trigger on `agent_event` fires `pg_notify('trading_lab_agent_event', …)` as a wake-up; the read process `LISTEN`s and does a keyset catch-up read (the source of truth & ordering). The projection is in-memory (rebuilt from the tail on boot); the read API never writes a table. v1 assumes a single read instance. Knobs: `AGENT_ACTIVITY_REBUILD_WINDOW_HOURS`, `AGENT_ACTIVITY_TRACE_LIMIT`, `AGENT_EVENT_STREAM_SAFETY_TICK_MS`, `AGENT_EVENT_STREAM_HEARTBEAT_MS`. See `docs/superpowers/specs/2026-06-13-trading-lab-sp6-agent-activity-stream-design.md`.
