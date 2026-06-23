# trading-lab → retire MCP research-platform + `@trading-platform/sdk` 0.5.0 (ops-read only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `mcp` research-platform integration from trading-lab, re-home the shared run-lifecycle vocabulary onto `@trading-backtester/sdk` + local shims, and repoint `@trading-platform/sdk` from the vendored `0.3.0` tarball to the published `0.5.0` GitHub Release (ops-read only). Full test suite green; cold frozen install passes.

**Architecture:** Delete the mcp adapter + transport + the overlay/submitted-bundle layer (sole consumer of `@trading-platform/sdk/builder`); drop the `'mcp'` branch from `selectResearchPlatform`; move the `ResearchPlatformPort` vocabulary off `@trading-platform/sdk/agent` onto `@trading-backtester/sdk/contracts` (aliased) + a new local `src/ports/run-lifecycle.ts` shim (for `ListDatasetsFilter`/`ListDatasetsResult`/`RunResultResult`/`isTerminal`); repoint the dependency + delete the vendored tarball + fix the guard. The mock and backtester adapters stay; the port becomes backtester-flavoured (mock conforms).

**Tech Stack:** TypeScript ESM, Node >=22, pnpm, Vitest. `@trading-platform/sdk@0.5.0` ships `dist` + a subpath `exports` map (`/ops-read`, `/intake`, `/intake/http-transport`, `/historical`, `/conformance` — NO `/agent`, NO `/builder`).

**Spec:** `docs/superpowers/specs/2026-06-23-trading-lab-retire-mcp-research-platform-design.md`

**WORKING DIRECTORY (CRITICAL):** All work happens in the worktree
`/home/alexxxnikolskiy/projects/trading-lab/.worktrees/lab-retire-mcp` (branch
`feat/lab-retire-mcp-research-platform`). Do NOT use the shared checkout
`/home/alexxxnikolskiy/projects/trading-lab` — another session uses it. Five other lab worktrees
touch the same `src/adapters/platform/` area (mock-retirement, f5-cross-repo-e2e, f6-operations,
sandbox-dood-lab-wiring, sdk-cutover) — coordinate before landing.

---

## File map

```text
package.json                                                  # dep repoint 0.3.0(vendored) → 0.5.0(release-URL); remove vendor
pnpm-lock.yaml                                                # regenerate; ensure 0.5.0 tarball integrity present
vendor/trading-platform-sdk/                                  # DELETE (tarball + README)
src/ports/research-run-lifecycle.ts                          # NEW — vendor the full platform-flavoured vocabulary closure + isTerminal (byte-identical to former /agent DTOs)
src/ports/research-platform.port.ts                           # import/re-export vocabulary from ./research-run-lifecycle.ts (same names/shapes)
src/adapters/platform/gateway-errors.ts                       # GatewayError → ../../ports/research-run-lifecycle.ts
src/adapters/platform/http-backtester.adapter.ts             # GatewayError → ../../ports/research-run-lifecycle.ts; mapping UNCHANGED
# mock-research-platform.adapter.ts                           # UNCHANGED (port types via the port)
src/adapters/platform/select-research-platform.ts            # drop 'mcp' branch + imports; union → 'mock'|'backtester'
src/adapters/platform/select-research-platform.test.ts       # drop the mcp case; add a backtester case
src/config/env.ts + src/orchestrator/app-services.ts         # TRADING_PLATFORM_INTEGRATION / researchIntegration → 'mock'|'backtester'
src/adapters/platform/{discovery,validate}-probe.test.ts     # stale 'mcp' label → 'backtester'
Dockerfile, README.md                                         # drop `COPY vendor` + stale vendor/ tree entry
# DELETE:
src/adapters/platform/mcp-research-platform.adapter.ts (+.test.ts)
src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts
src/adapters/platform/mcp-research-transport.ts (+.test.ts)
src/adapters/platform/submitted-bundle.ts (+.test.ts, +.preflight.test.ts)
src/adapters/platform/sdk-overlay-surface.test.ts
src/adapters/platform/discovery.integration.test.ts
src/adapters/platform/sdk-metric-catalog.test.ts
# REVISE:
src/adapters/platform/sdk-smoke.test.ts                       # reduce to surviving root + /ops-read smoke (or delete)
src/adapters/platform/vendored-sdk.guard.test.ts             # SPEC_RE → release-URL; keep ops.3
```

---

## Phase 0 — Baseline

- [ ] From the worktree root, install deps and capture a green baseline: `pnpm install`, then `pnpm test` (or the repo's check script). Record the passing set so the diff is measured against it.
- [ ] Confirm no residual sibling/path assumptions: `grep -rn "@trading-platform/sdk" src test` to snapshot the starting consumer set.

## Phase 1 — Re-home the port vocabulary (compile-green first, no deletions yet)

Self-review changed the mechanism from "alias from `@trading-backtester/sdk`" to **vendor locally**:
the backtester adapter deliberately *maps* its types INTO the platform-flavoured port shapes (e.g.
array-timeline → object-timeline in `toSdkStatusView`), so aliasing would break the mapping layer.
See the design §5.

- [ ] Create `src/ports/research-run-lifecycle.ts` with the **full platform-flavoured type closure** (see design §5 for the list) + `TERMINAL_STATUSES` + `isTerminal(status)`, byte-identical to the former `@trading-platform/sdk/agent` DTOs. mcp-only DTOs are NOT vendored.
- [ ] Edit `src/ports/research-platform.port.ts`: replace the two `@trading-platform/sdk/agent` import lines with imports from `./research-run-lifecycle.ts` — **same names, same re-export surface**.
- [ ] Edit `src/adapters/platform/gateway-errors.ts` and `http-backtester.adapter.ts`: `GatewayError` import → `../../ports/research-run-lifecycle.ts`. **No mapping changes.** The mock adapter is untouched (it gets port types via the port).
- [ ] `pnpm tsc --noEmit` → clean with no churn beyond the import swaps (shapes are identical). **Checkpoint: `tsc --noEmit` clean.**

## Phase 2 — Drop the `'mcp'` branch

- [ ] Edit `src/adapters/platform/select-research-platform.ts`: remove the `if (integration === 'mcp')` block and the `LazyMcpResearchPlatformAdapter` / `loadResearchPlatformConfig` / `createGatewayTransport` imports; narrow the param union to `'mock' | 'backtester'`. Remove the now-unused `CONTRACT_VERSION` import if it falls out.
- [ ] Edit `src/adapters/platform/select-research-platform.test.ts`: delete the "returns a lazy mcp adapter" case and its imports.
- [ ] Narrow the `TRADING_PLATFORM_INTEGRATION` env schema/validation to `'mock' | 'backtester'`.
- [ ] `pnpm tsc --noEmit` clean.

## Phase 3 — Delete the mcp / overlay / builder files

- [ ] `git rm` the DELETE set: `mcp-research-platform.adapter.ts(+.test)`, `lazy-mcp-research-platform.adapter.test.ts`, `mcp-research-transport.ts(+.test)`, `submitted-bundle.ts(+.test,+.preflight.test)`, `sdk-overlay-surface.test.ts`, `discovery.integration.test.ts`, `sdk-metric-catalog.test.ts`.
- [ ] Verify the `/builder` usage is gone: `grep -rn "@trading-platform/sdk/builder\|@trading-platform/sdk/agent" src test` → **no matches**.
- [ ] `pnpm tsc --noEmit` clean (no dangling imports).

## Phase 4 — SDK-surface tests

- [ ] `sdk-smoke.test.ts`: drop the `/agent` `discover`/`listDatasets` assertions; keep (or reduce to) the surviving root (`CONTRACT_VERSION`/`SDK_VERSION`/`SDK_CAPABILITIES`) + `/ops-read` smoke. Delete the file only if nothing meaningful remains.
- [ ] `sdk-import-boundary.guard.test.ts`: no edit expected — confirm it still passes (allowlist of import sites; fewer remain).

## Phase 5 — Dependency repoint to 0.5.0 (release-URL)

- [ ] `package.json`: set `@trading-platform/sdk` to the release-URL `.../sdk-v0.5.0/trading-platform-sdk-0.5.0.tgz`.
- [ ] `git rm -r vendor/trading-platform-sdk/` (tarball + README).
- [ ] `vendored-sdk.guard.test.ts`: update `SPEC_RE` to the release-URL pattern (e.g. `^https://github\.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v\d+\.\d+\.\d+/trading-platform-sdk-\d+\.\d+\.\d+\.tgz$`); keep `EXPECTED_OPS_VERSION = 'ops.3'`; confirm the negative `^0.3.0` case still fails. Update the failure message text.
- [ ] `pnpm install` to regenerate `pnpm-lock.yaml`. **Verify the lockfile entry for the SDK carries `integrity` (sha512).** If pnpm omitted it (warm-store gotcha), write the asset sha512 (`sha512-RJlvkRlzvZ73DzoPEf+xfJBUXV+kuXKeRFcQdOCHA6GQJec0tbJ0YxhYb9qjbb9M2Vg+ECuUOd1Te5nliRWeZg==`) into the resolution.

## Phase 6 — Verify

- [ ] **Cold frozen install:** `rm -rf node_modules`, prune the SDK from the pnpm store/cache, `pnpm install --frozen-lockfile` → succeeds (downloads + verifies the 0.5.0 tarball). A warm frozen install is a false pass.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] `grep -rn "@trading-platform/sdk/agent\|@trading-platform/sdk/builder" src test` → no matches; `grep -rn "@trading-platform/sdk" src test` → only root + `/ops-read`.
- [ ] Full `pnpm test` green (vitest), incl. `vendored-sdk.guard`, `sdk-import-boundary.guard`, probes, mock + backtester adapter tests, `cross-repo-e2e` (opt-in) — matches the Phase 0 baseline minus the deleted suites.
- [ ] `vendor/trading-platform-sdk/` gone; `git status` clean except intended changes.

## Phase 7 — Land

- [ ] Rebase/merge against the latest `origin/main` (coordinate with `feat/6b-c-sp4-mock-retirement` — it touches the same port/adapters).
- [ ] Commit, PR, merge per the repo flow (author authorization required for merge).

---

## Risks / notes

- **Port shape change** (platform-flavoured → backtester-flavoured) is the real risk; `tsc` is the gate. The mock adapter is the main churn point.
- **pnpm integrity** false-pass on warm install — the cold frozen install in Phase 6 is mandatory.
- **Concurrent worktrees** — high conflict potential in `src/adapters/platform/`; land in coordination with mock-retirement.
- The platform research-gateway (031) becomes consumer-less from lab after this; its platform-side retirement (overlay-builder + agent-gateway client) is a separate decision, not part of this plan.
