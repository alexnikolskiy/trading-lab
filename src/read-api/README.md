# Read API (SP-5)

Read-only, service-to-service HTTP boundary for trading-office. Separate Hono app on `READ_API_PORT` (same process as ingress). Starts only when `TRADING_LAB_READ_TOKEN` is set.

Auth: `Authorization: Bearer <TRADING_LAB_READ_TOKEN>` on every `/v1/*` route. `/healthz` + `/readyz` are open.

Endpoints:
- `GET /v1/hypotheses` (`status?`, `profileId?`, `limit?`, `cursor?`) · `GET /v1/hypotheses/:id`
- `GET /v1/backtests` (`hypothesisId?`, `status?`, `limit?`, `cursor?`) · `GET /v1/backtests/:id`
- `GET /v1/agent-events` (`taskId?`, `type?`, `since?`, `correlationId?`, `limit?`, `cursor?`)
- `GET /healthz` · `GET /readyz` (DB readiness only — no queue/worker)

Pagination is keyset (opaque `cursor`); `limit` default 20, max 100. DTOs are deny-by-default projections; internal schema is never exposed; no `trading-platform` calls. See `docs/superpowers/specs/2026-06-13-trading-lab-sp5-read-api-design.md`.
