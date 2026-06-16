# mock-platform — cross-repo discovery (reference only)

> **STATUS: REFERENCE NOTES. Implementation moved to `trading-platform` (`@trading-platform/mock`).**
> See [`mock-platform-ownership-decision.md`](./mock-platform-ownership-decision.md).
> This file preserves the discovery done on 2026-06-16 **before** the ownership pivot. It is **not**
> a build directive for `trading-lab`. The authoritative `/ops/*` contract shapes live in
> `trading-platform` — **do not copy them into `trading-lab`.** Where shapes are mentioned below,
> they are pointers to the platform source of truth, for whoever builds `@trading-platform/mock`.

## Two unrelated "platform" surfaces

| Surface | Consumer | Transport | Demo switch today |
|---|---|---|---|
| **A. Research lifecycle** (`submit_run`, `get_run_result`, `discover_research_contract`) | trading-**lab** (`ResearchPlatformPort`) | **MCP stdio gateway** (not HTTP) | `TRADING_PLATFORM_INTEGRATION=mock` → in-memory `MockResearchPlatformAdapter` |
| **B. Ops Read API** (`/ops/*`) | trading-**office** (`PlatformHttpClient`) | **HTTP Bearer**, port **8839** | `TRADING_PLATFORM_READ_URL` + `OFFICE_PLATFORM_ENABLED` |

`@trading-platform/mock` concerns **Surface B** (the Ops Read HTTP/WS read API). Surface A already
has its own in-memory mock in lab and is out of scope.

Key fact: `TRADING_PLATFORM_READ_URL` / `TRADING_PLATFORM_READ_TOKEN` are **never read by
trading-lab source** — only by `trading-office`. trading-lab passes them through in compose/docs.

## Real Ops Read API contract — source of truth (trading-platform)

Contract version **`ops.3`**, base path **`/ops`**, default port **8839**, **GET-only**, Bearer auth
(sha256-hex token allowlist via `OPS_READ_TOKENS`; empty allowlist ⇒ anonymous loopback). The real
server binds loopback-only and rejects `0.0.0.0` — a docker mock must consciously diverge to bind on
the container network. Authoritative files in `trading-platform`:

- Routes: `src/operations/adapters/http-snapshot.ts`
- Dispatch: `src/operations/dispatch.ts`
- Resource catalog / discover: `src/operations/handlers/discover.ts`
- Wire DTOs: `src/operations/dto.ts`
- Auth: `src/operations/access/auth.ts`
- Bootstrap (port/env): `src/operations/bin/start-ops-read.ts`
- Spec home: `specs/033-platform-ops-read-api/` (035 runtime-health collection + execution-health; 036 paper-candidates)

Endpoint index (shapes: see `dto.ts`): `GET /ops/discover`, `/ops/runs`, `/ops/runs/:id/state`,
`/ops/runs/:id/trades` (+ `/ops/trades`), `/ops/runs/:id/summary`, `/ops/positions`, `/ops/events`,
`/ops/decisions`, `/ops/health/{runtime,market,execution}`, `/ops/coverage`, `/ops/log-refs`,
`/ops/candidates`, and `WS /ops/events`.

**Metric gap to note for the package:** the real Ops Read contract has **no** `profit_factor`,
`sharpe`, `max_drawdown`, `net_pnl`, DCA-count, or per-run liquidation/OI fields. The richest
per-run data is `/ops/runs/:id/trades` (trade list) + `/ops/runs/:id/summary` (aggregate:
`closedTrades/wins/losses/winratePct/pnlUsd/avgPnl/exitReasons`). Liquidations/openInterest appear
only as `/ops/coverage` `kind`s. Money fields are **string-typed**.

## What trading-office actually consumes (Surface B contract in practice)

`trading-office/apps/server/src/connector/platform/PlatformHttpClient.ts` calls six endpoints:
`/ops/runs?mode={live,paper}`, `/ops/health/{runtime,market,execution}`, `/ops/coverage`,
`/ops/discover`. DTOs are hand-mirrored in `.../platform/platformDtos.ts` (the consumer's view of
the platform shapes — exactly the duplication the ownership decision wants to eliminate).

- **Minimal subset to render the dashboard:** only `/ops/runs` needs realistic data; each endpoint
  is fetched independently and degrades on its own InfraStatus row (one failure never crashes the
  page). `/ops/discover` body is **not parsed** — reachability only.
- **Auth:** `authorization: Bearer <TRADING_PLATFORM_READ_TOKEN>`; 401/403 → `upstream_unauthorized`.
- **Boot fail-fast:** `OFFICE_PLATFORM_ENABLED=true` + `OFFICE_CONNECTOR_MODE=trading-lab` without
  URL+token ⇒ office refuses to start.

## trading-lab-side facts (these ARE lab's own; kept for the future integration)

- **`results.trading` is a single hardcoded arm** at `src/chat/guard.ts:85` returning
  `capabilityNotAvailable` — no capabilities registry, no env flag. Lab has **no** code path that
  fetches live bot trading results today.
- **Chat ingress:** `POST /chat/messages` (`src/chat/chat-app.ts`), bearer-gated by
  `TRADING_LAB_CHAT_TOKEN`. The fake rule-based classifier maps `результаты торговли`/`торговл`/
  `trading` → `results.trading` (`src/adapters/intent/fake-intent-classifier.ts`).
- **Office chat-reply union** (`trading-office .../tradinglab/labDtos.ts`,
  `LabChatResponse`) has **no generic "assistant answer" kind**:
  `task_created | task_status | needs_clarification | out_of_scope | capability_not_available |
  help | rejected | error`. Office's `TradingLabOperatorResponder.runTurn` renders by `kind`.
  (Relevant only if/when lab later surfaces analysis text — a separate follow-up decision.)
- **Eager LLM boot constraint:** `composeMastra` (`src/mastra/compose-mastra.ts`) calls
  `resolveLanguageModel` at boot for every `*_ADAPTER=mastra`, which **throws** when the provider
  key is empty. Any demo that flips adapters to `mastra`+`openai` must gate on key presence or it
  crashes the lab ingress at boot. `MODEL_PROVIDER ∈ {anthropic, openai, openrouter}`.

## Docker integration shape (for the future follow-up)

- Demo stack: single shared `trading-lab:local` image; services differ only by `command`. Internal
  bridge network `trading`; base publishes no host ports (mode overlays add them). Adding a service
  to `docker-compose.demo.yml` only does not affect local/vps. `make config` validates all stacks.
- Future: run `@trading-platform/mock` as a demo service (`expose: ["8839"]`, internal-only),
  set office `TRADING_PLATFORM_READ_URL=http://<mock-service>:8839`, `OFFICE_PLATFORM_ENABLED=true`.

## VPS fixture sourcing (deferred to the package, kept for reference)

Fixture data was to be sourced read-only from the VPS (`trading-vps` SSH alias — **note: did not
resolve at discovery time; `~/.ssh/config` has `trading-server`** — reconcile before any export),
under: no mutations, raw exports gitignored under `.tmp/mock-platform/raw/`, sanitize before commit
(strip account/order/exec ids, secrets, hosts/paths, raw logs; mask symbols → `DEMO1USDT…`; round
money). This sourcing/sanitizing now belongs to `@trading-platform/mock` in `trading-platform`.
