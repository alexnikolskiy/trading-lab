# `trading-lab` → retire the MCP research-platform integration; move `@trading-platform/sdk` to 0.5.0 (ops-read only) — Design

**Status:** proposed design

**Date:** 2026-06-23

**Owning repository:** `trading-lab`

**Depends on:** `@trading-platform/sdk@0.5.0` (published GitHub Release, `trading-platform-sdk`); `@trading-backtester/sdk@0.2.0` (already a release-URL dependency)

**Part of:** Инициатива #2 (SDK extraction). Platform Stage 4 (retire in-repo `packages/sdk`) is merged (`trading-platform#11`). This is the lab-side tail: lab stops consuming the platform SDK's `/agent` + `/builder` surfaces (cut in 0.5.0) and keeps only `/ops-read`.

## 1. Context

`trading-lab` selects a research-platform backend at composition time via
`selectResearchPlatform(integration: 'mock' | 'mcp' | 'backtester')`
(`src/composition.ts:213`, env `TRADING_PLATFORM_INTEGRATION`). Three adapters implement the common
`ResearchPlatformPort` (`src/ports/research-platform.port.ts`):

- **`mock`** — `MockResearchPlatformAdapter` (in-process test double).
- **`backtester`** — `HttpBacktesterAdapter` over `@trading-backtester/sdk` (the real backtest backend; cutover landed in `feat/sdk-cutover`).
- **`mcp`** — `LazyMcpResearchPlatformAdapter`, a client of the **platform research-gateway (feature 031)** over `@trading-platform/sdk/agent` + `/builder`.

The platform SDK was extracted to the standalone `trading-platform-sdk` repo and published as
`sdk-v0.5.0`, whose surface is **`/ops-read`, `/intake`, `/intake/http-transport`, `/historical`,
`/conformance`** — the `/agent` (gateway) and `/builder` (overlay-manifest) subpaths are **cut**.
lab is therefore frozen on a vendored `0.3.0` tarball, the last version that still carried `/agent`
and `/builder`.

**Decision (user, 2026-06-23):** the `mcp` integration is no longer needed. The backtester service is
lab's backtest backend. Retire `mcp`, drop the dead `/agent` + `/builder` usage, and move
`@trading-platform/sdk` to the published `0.5.0` consumed for `/ops-read` only.

> Note: the platform research-gateway (031) is *not* deleted by this change — lab simply stops being
> a client of it. Whether the platform later retires the gateway + its overlay-builder/agent surfaces
> (now consumer-less) is a separate platform-side decision.

## 2. Goal

Remove the `mcp` research-platform path from lab end to end, re-home the shared run-lifecycle
vocabulary the surviving adapters need, and repoint `@trading-platform/sdk` from the vendored `0.3.0`
tarball to the published `0.5.0` GitHub Release (ops-read only) — with the full test suite green and a
clean (cold, frozen) install.

## 3. Scope

### In scope (`trading-lab`, branch `feat/lab-retire-mcp-research-platform`)

- Delete the mcp adapter, its lazy wrapper test, the gateway transport, and the overlay/submitted-bundle layer that exists solely for the mcp path (and is the sole consumer of `@trading-platform/sdk/builder`).
- Drop the `'mcp'` branch from `selectResearchPlatform` and the `TRADING_PLATFORM_INTEGRATION` union/env validation.
- Re-home the `ResearchPlatformPort` vocabulary currently imported from `@trading-platform/sdk/agent` into a new local module `src/ports/research-run-lifecycle.ts` (byte-identical type closure + `isTerminal`); the adapters' mapping logic and the mock stay unchanged (§5).
- Re-home `GatewayError` (used by the surviving backtester adapter) onto that local module.
- Repoint `@trading-platform/sdk`: vendored `file:./vendor/...0.3.0.tgz` → release-URL `0.5.0`; delete the vendored tarball + `vendor/trading-platform-sdk/`; update the vendored-SDK guard.
- Revise/remove the SDK tests that assert cut-0.5.0 surfaces.

### Out of scope

- The mock adapter stays (port remains multi-backend: `'mock' | 'backtester'`).
- No change to the backtester integration behaviour or the `@trading-backtester/sdk` version.
- No change to `/ops-read` consumers (`src/ports/bot-results-read.port.ts`, ops-read client/adapters) beyond the dependency repoint.
- No platform-side change (gateway/overlay-builder retirement is a separate initiative).

## 4. Inventory (verified against `origin/main`)

**DELETE — mcp/overlay/builder path:**

| File | Reason |
|---|---|
| `src/adapters/platform/mcp-research-platform.adapter.ts` (+`.test.ts`) | the mcp adapter |
| `src/adapters/platform/lazy-mcp-research-platform.adapter.test.ts` | lazy-wrapper test |
| `src/adapters/platform/mcp-research-transport.ts` (+`.test.ts`) | gateway transport |
| `src/adapters/platform/submitted-bundle.ts` (+`.test.ts`, +`.preflight.test.ts`) | imported **only** by the mcp adapter; **sole consumer of `@trading-platform/sdk/builder`** |
| `src/adapters/platform/sdk-overlay-surface.test.ts` | acceptance test for the cut `/agent` overlay (ModuleSelector/SubmittedBundle) + `/builder` |
| `src/adapters/platform/discovery.integration.test.ts` | imports `mcp-research-transport` + `McpResearchPlatformAdapter` (mcp-only) |

> **Correction to the dependency scan:** an earlier automated pass marked `submitted-bundle.ts` as
> "kept — backtester needs it." That is wrong. `submitted-bundle.ts` is imported only by
> `mcp-research-platform.adapter.ts`; the backtester path builds its bundle via
> `backtester-bundle.ts` → `@trading-backtester/sdk/builder`, which is independent. Deleting the mcp
> path therefore removes **all** `@trading-platform/sdk/builder` usage, which is what makes the 0.5.0
> move (no `/builder`) possible.

**EDIT — drop the `'mcp'` branch:**

| File | Change |
|---|---|
| `src/adapters/platform/select-research-platform.ts` | remove the `'mcp'` branch + its imports (`LazyMcpResearchPlatformAdapter`, `loadResearchPlatformConfig`, `createGatewayTransport`); narrow the param union to `'mock' \| 'backtester'`; drop the now-unused `CONTRACT_VERSION` import if it falls out |
| `src/adapters/platform/select-research-platform.test.ts` | remove the "returns a lazy mcp adapter" case + its imports |
| env config (`TRADING_PLATFORM_INTEGRATION` schema) | narrow allowed values to `'mock' \| 'backtester'` |

**RE-HOME — shared vocabulary (§5):**

| File | Change |
|---|---|
| `src/ports/research-run-lifecycle.ts` (NEW) | vendor the platform-flavoured type closure + `isTerminal` (byte-identical to the former SDK `/agent` DTOs) |
| `src/ports/research-platform.port.ts` | import/re-export the vocabulary from `./research-run-lifecycle.ts` instead of `@trading-platform/sdk/agent` — same names, same shapes |
| `src/adapters/platform/gateway-errors.ts` | `GatewayError` import → `../../ports/research-run-lifecycle.ts` |
| `src/adapters/platform/http-backtester.adapter.ts` | `GatewayError` import → `../../ports/research-run-lifecycle.ts`; **mapping logic unchanged** |
| `src/adapters/platform/mock-research-platform.adapter.ts` | **unchanged** — its port types come via the port; root `CONTRACT_VERSION` import stays valid in 0.5.0 |

**REVISE/REMOVE — SDK-surface tests:**

| File | Change |
|---|---|
| `src/adapters/platform/sdk-smoke.test.ts` | asserts `/agent` `discover`/`listDatasets` are functions — those are cut in 0.5.0. Reduce to the surviving root + `/ops-read` smoke, or delete. |
| `src/adapters/platform/sdk-metric-catalog.test.ts` | asserts the vendored SDK dist carries the feature-038 7-metric catalog (an `/agent` artefact) — not in 0.5.0. **Delete.** |
| `src/adapters/platform/vendored-sdk.guard.test.ts` | update `SPEC_RE` from the vendored-tgz pattern to the release-URL pattern; keep `EXPECTED_OPS_VERSION = 'ops.3'` (0.5.0 still publishes `OPS_READ_CONTRACT_VERSION = 'ops.3'`) |
| `src/adapters/platform/sdk-import-boundary.guard.test.ts` | no edit — it is a static allowlist constraint; it stays green (fewer imports remain) |

**KEEP — unaffected:** `bot-results-read.port.ts` (`/ops-read`), the ops-read client/adapters,
`backtester-bundle.ts`, `http-backtester.adapter.ts` behaviour, the probes
(`discovery-probe`/`run-probe`/`validate-probe` — generic over `ResearchPlatformPort`),
`cross-repo-e2e.integration.test.ts` (not mcp-coupled).

## 5. Re-homing the port vocabulary (the load-bearing design point)

`research-platform.port.ts` today imports and re-exports, from `@trading-platform/sdk/agent`:

`ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult, ValidationReport,
ValidationIssueDTO, RunResultSummary, ComparisonSummaryDTO, RunJobHandle, RunStatusView,
RunResultResult, Ref` + the value `isTerminal`.

### Why "alias from `@trading-backtester/sdk`" is NOT viable (self-review finding)

The first instinct — re-export these from `@trading-backtester/sdk/contracts` under lab's alias names
— **does not compile**, because the port vocabulary is a **distinct, platform-flavoured shape that the
backtester adapter deliberately translates INTO**, not a copy of the backtester types. Evidence in
`http-backtester.adapter.ts`:

- `RunStatusView`: backtester `timeline` is an **array** of `{status, atMs}`; the port's `RunStatusView.timeline` is an **object** `{acceptedAtMs, queuedAtMs?, startedAtMs?, terminalAtMs?}`. `toSdkStatusView` (lines 68–83) performs this reshape.
- `RunResultSummary`: backtester is baseline-only; `toSdkSummary` (lines 112–134) synthesizes `runKind`, a `comparison{baseline,variant,deltas}`, `coverage`, `artifactRefs.availability`, and `evidence`.
- `RunResultResult` / `RunResultView` (`{ok:true, kind:'summary'|'status', ...}`) is a platform-flavoured union with no backtester equivalent.

If the port's `RunStatusView` *became* the backtester's array-timeline type, `toSdkStatusView` (which
builds the object-timeline) would fail to compile — and so would the rest of the mapping layer. The
adapter exists **because** the shapes differ. Aliasing them would force a rewrite of
`toSdkStatusView`/`toSdkSummary`/`toSdkComparison`/`toSdkValidationReport` **plus** the mock adapter
**plus** a redefinition of `RunResultView` — a large refactor in the wrong direction.

### Decision: vendor the vocabulary locally (option A)

The port is **lab's own contract**, historically modelled on the platform gateway (031) DTOs. After
mcp retirement lab no longer talks to that gateway, so lab simply **owns** this vocabulary. Move the
type *definitions* (the transitive closure the port + surviving adapters use) from
`@trading-platform/sdk/agent` into a new local module **`src/ports/research-run-lifecycle.ts`**,
byte-identical to the former SDK `/agent` DTOs, plus the `isTerminal` predicate. Then:

- `research-platform.port.ts` imports/re-exports from `./research-run-lifecycle.ts` instead of the SDK — **same names, same shapes**.
- `gateway-errors.ts` + `http-backtester.adapter.ts` source `GatewayError` from the local module.
- **The backtester adapter's mapping logic and the mock adapter are UNCHANGED** — only the source of the type definitions moves. This is the smallest possible diff that removes the `/agent` dependency.

The closure to vendor: `ContentHash, Ref, ArtifactType, RunKind, MarketDataKind,
MarketDataCoverageState, MarketDataAccess, MarketDataKindDescriptor, RunMode, RunModeDescriptor,
ResearchCapabilityDescriptor, CoveredKind, DatasetDescriptor, ListDatasetsFilter, ListDatasetsResult,
RunJobHandle, NonTerminalRunStatus, TerminalRunStatus, RunStatus, RunTimeline, RunStatusView,
ArtifactReference, CoverageEntryDTO, ComparisonSummaryDTO, ValidationIssueDTO, ValidationReport,
RunResultSummary, GatewayErrorCategory, GatewayError, RunResultResult` + `isTerminal`. The mcp-only
DTOs (`SubmittedBundle`, `ModuleSelector`, `ControlledRunRequest`, `ValidateModuleRequest`,
`CompletionEvent`, the `*Result` envelopes, etc.) are **not** vendored — they die with the mcp path.

**Verification is `tsc --noEmit`** — since the local module is byte-identical to the former SDK types,
the project compiles unchanged.

> Why not "from backtester SDK + shims" (the earlier choice): the self-review above showed it breaks
> the adapter mapping layer. The user confirmed switching to the local-vocabulary option (A).

## 6. Dependency repoint (0.5.0) and the pnpm integrity gotcha

- `package.json`: `@trading-platform/sdk` →
  `https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.5.0/trading-platform-sdk-0.5.0.tgz`
- Delete `vendor/trading-platform-sdk/` (the `0.3.0` tarball + its README) — lab joins mock/backtester on release-URL consumption (no vendored tarball).
- `vendored-sdk.guard.test.ts` `SPEC_RE` → the release-URL pattern; the `^0.3.0` negative case still fails (good); the runtime `import('@trading-platform/sdk/ops-read')` → `OPS_READ_CONTRACT_VERSION === 'ops.3'` is unchanged.
- **pnpm https-tarball lockfile-integrity gotcha** (seen in `trading-backtester#39`/`mock#13`): with a warm store, pnpm may write the lockfile `resolution` without `integrity`, and a CI `--frozen-lockfile` then fails `ERR_PNPM_MISSING_TARBALL_INTEGRITY`. Mitigation: ensure the lockfile entry carries the asset sha512 (`sha512-RJlvkRlzvZ73DzoPEf+xfJBUXV+kuXKeRFcQdOCHA6GQJec0tbJ0YxhYb9qjbb9M2Vg+ECuUOd1Te5nliRWeZg==`, byte-identical asset across consumers) and verify with a **cold frozen install** (`rm -rf node_modules`, prune the SDK from the store/cache, `pnpm install --frozen-lockfile`). A warm frozen install gives a false pass.

## 7. Coordination risk (concurrent worktrees)

Five lab worktrees are active in the same `src/adapters/platform/` area: `feat/6b-c-sp4-mock-retirement`,
`feat/f5-cross-repo-e2e`, `feat/f6-operations`, `feat/sandbox-dood-lab-wiring`, `feat/sdk-cutover`.
This change deletes several files and edits `research-platform.port.ts`, `select-research-platform.ts`,
and the mock adapter — high conflict potential. Mitigations: branch off the latest `origin/main`;
land after (or coordinate with) the mock-retirement branch since it touches the same port/adapters;
keep the diff mechanical and reviewable.

## 8. Verification / success criteria

1. `tsc --noEmit` clean (the re-home compiles; no residual `@trading-platform/sdk/{agent,builder}` import).
2. `grep -r "@trading-platform/sdk/agent\|@trading-platform/sdk/builder" src test` → no matches.
3. Full lab test suite (vitest) green, including `vendored-sdk.guard`, `sdk-import-boundary.guard`, the probes, mock + backtester adapter tests, and `cross-repo-e2e` (opt-in).
4. `@trading-platform/sdk` usage reduced to root (`CONTRACT_VERSION`/`SDK_VERSION`/`SDK_CAPABILITIES`) + `/ops-read` only.
5. Cold `pnpm install --frozen-lockfile` succeeds with the 0.5.0 release tarball (integrity present).
6. `vendor/trading-platform-sdk/` removed.
