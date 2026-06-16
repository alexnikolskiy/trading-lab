# mock-platform — ownership decision

**Date:** 2026-06-16
**Status:** Decided. In-lab implementation **abandoned**.
**Branch:** `mock-platform` (this worktree holds reference notes only — no implementation, no spec, no plan).

## Decision

`mock-platform` will **not** be built inside `trading-lab`. It becomes a **platform-owned
package** in the `trading-platform` repo, working name **`@trading-platform/mock`**.

## Why

`mock-platform` is **not** trading-lab business logic and **not** a demo-only stub. It is the
official **read-only stand-in for the real Ops Read API**. The `/ops/*` contract, fixture
export/sanitizer, HTTP/WS replay, and contract parity must belong to `trading-platform` so that
downstream projects do **not** hand-copy platform response shapes and drift from the real API.

**trading-lab must not own platform contract shapes.**

## Target state

- `trading-platform` owns the real Ops Read API contract.
- `trading-platform` publishes `@trading-platform/mock`.
- The package serves a read-only HTTP + WebSocket/replay mock Ops Read from fixture/snapshot data.
- `trading-lab` later consumes the package as a dependency and runs it in docker demo/tests.
- `trading-office` keeps talking to an Ops Read URL and stays unaware whether it is the real
  platform or the mock.

## Explicitly NOT done in trading-lab (now or as part of this line of work)

- No `src/mock-platform/**`.
- No demo-only endpoints (e.g. `/ops/demo/bot-results`).
- No changes to the chat / `results.trading` flow for an in-lab mock.
- No implementation plan for an in-lab mock-platform.

## Future integration point (separate follow-up)

Once `@trading-platform/mock` is implemented/published:

1. Add it as a `trading-lab` dependency.
2. Run it as a service in `docker-compose.demo.yml` (and integration/e2e tests), pointing
   `TRADING_PLATFORM_READ_URL` at it.
3. Any `results.trading` enablement is a **separate** decision, made against the real package
   contract — not against an in-lab stub.

See the cross-repo discovery captured for reference in
[`mock-platform-discovery-reference.md`](./mock-platform-discovery-reference.md).
