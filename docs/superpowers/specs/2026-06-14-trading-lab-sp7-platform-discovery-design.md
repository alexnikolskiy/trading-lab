# SP-7 (slice 1) — Read-only platform capability discovery — Design Document

**Date:** 2026-06-14
**Status:** Approved (design); ready for implementation plan
**Repo:** `trading-lab`
**Depends on:** SP-6.2 (ingress auth boundaries), `trading-platform` research gateway MCP-031 + `@trading-platform/sdk` (feature 032)

---

## 1. Goal

Give `trading-lab` its **first real connection** to the `trading-platform` research gateway over MCP — scoped to **read-only capability discovery only**: `discover_research_contract` + `list_datasets`.

This slice deliberately carries no execution authority. Its value is the **load-bearing scaffolding** that every later research-platform slice reuses:

- a new `ResearchPlatformPort` (research-platform lifecycle, separate from the existing gateway),
- an MCP/SDK adapter + a mock adapter,
- a transport factory that owns the MCP stdio client lifecycle,
- the `@trading-platform/sdk/agent` dependency confined to the port/adapter boundary,
- config gating (`mock` vs `mcp`) with `mock` as the safe default,
- AgentEvent audit of every platform call,
- a **mandatory, fail-closed contract-version handshake**.

## 2. Boundary & authority

`trading-lab` = research orchestration (decides *what* to research). `trading-platform` = execution / data authority (owns runs, market data, artifacts, credentials). The SDK enforces this asymmetry: the consumer supplies the transport, the SDK core opens no network, owns no credentials, and never starts a gateway. Discovery touches **zero** execution surface.

The original `trading-lab` design (`2026-06-10-trading-lab-design.md`) already anticipated this terminal adapter (`McpPlatformGatewayAdapter`, "after platform feature 030/031"). SP-7 realizes it, now that the platform's MCP-031 gateway and typed SDK exist.

## 3. Scope

### In scope (slice 1)

`ResearchPlatformPort` + MCP/SDK adapter + mock adapter + transport factory + `TRADING_PLATFORM_*` env config + `platform:discover` CLI probe + AgentEvent audit + mandatory contract-version check.

### Out of scope (slice 1)

- Any execution / module-run surface (`validate_module`, `submit_run`, `get_run_status`, `get_run_result`, `read_artifact`, `cancel_run`).
- Any change to `PlatformGatewayPort`, the worker, the orchestrator handlers, or the existing mock backtest path.
- Any read-API / `trading-office` surface for capabilities (CLI/probe-only for now).
- Any startup handshake. **Runtime boot must not depend on `trading-platform` availability.**
- Outbound credentials. Slice 1 uses anonymous stdio (the gateway starts with zero secrets; stdio permits anonymous access).

## 4. Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | First vertical slice | Read-only discovery (`discover_research_contract` + `list_datasets`) |
| D2 | Boundary shape | **New** `ResearchPlatformPort`; old `PlatformGatewayPort` untouched (keeps market-context + mock backtest) |
| D3 | Contract source | Depend on `@trading-platform/sdk/agent` (official contract package); import confined to port/adapter boundary |
| D4 | Surface / lifecycle | Probe-on-demand: **one MCP client/session per CLI probe**, reused across `discover` + `listDatasets`, closed in `finally` |
| D5 | Contract handshake | Mandatory + fail-closed in slice 1; never blocks runtime boot (discovery is on-demand only) |

## 5. New port — `ResearchPlatformPort`

`src/ports/research-platform.port.ts`

```ts
import type {
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
} from '@trading-platform/sdk/agent';

export interface ResearchPlatformPort {
  discover(): Promise<ResearchCapabilityDescriptor>;
  listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult>;
}
```

- Return/argument types are **re-used from `@trading-platform/sdk/agent`** — single source of truth, no local re-declaration, no contract drift.
- The existing `PlatformGatewayPort` (4 methods: `getMarketContext`, `getMarketRegime`, `submitBacktest`, `getBacktestResult`) is **not extended and not modified**. Clean split:
  - `PlatformGatewayPort` — market-context read + the current (mock) backtest path.
  - `ResearchPlatformPort` — real research-gateway lifecycle; grows in SP-7.1/7.2/7.3 with `validate`, then `submit`/`status`/`result`/`artifacts`/`cancel`.
- The port name describes the **role of the platform for research orchestration**, not the transport or the gateway.

## 6. Adapters (`src/adapters/platform/`)

### `McpResearchPlatformAdapter implements ResearchPlatformPort`

- Receives a ready `GatewayTransport` (from the transport factory, §7) — it does **not** build the MCP client itself, keeping the adapter transport-agnostic and unit-testable against a fake transport.
- `discover()` → SDK `discover(transport)` → `ResearchCapabilityDescriptor`, then runs the contract-version check (§9).
- `listDatasets(filter?)` → SDK `listDatasets(transport, filter)` → `ListDatasetsResult`.
- Stateless beyond the injected transport; the **session lifecycle is owned by the caller / factory**, not the adapter (so one session serves both calls within a probe — D4).
- **Boot-safety:** constructing the adapter opens nothing. The CLI passes a single live transport (one session per probe). For the runtime `mcp` gate the adapter is given a transport *factory* and connects lazily **per call**, closing after — so `composeRuntime` never spawns the gateway at boot (D5). In slice 1 the only live consumer is the CLI; the runtime `mcp` path has no caller yet.

### `MockResearchPlatformAdapter implements ResearchPlatformPort`

- Deterministic fake mirroring the existing `MockPlatformGatewayAdapter` / `FixturePlatformGatewayAdapter` pattern.
- Returns a fixed, contract-compatible `ResearchCapabilityDescriptor` and a small `ListDatasetsResult`.
- Used as the **default runtime wiring** and in unit tests. Keeps the test suite green and boot independent of `trading-platform`.

## 7. Transport factory (`src/adapters/platform/mcp-research-transport.ts`)

Isolated factory owning the MCP stdio client lifecycle, so SP-7.1+ (and a future HTTP transport) reuse it:

```ts
createGatewayTransport(config): Promise<{ transport: GatewayTransport; close(): Promise<void> }>
```

- Builds an MCP `Client` (`@modelcontextprotocol/sdk`) over `StdioClientTransport` that spawns the gateway process from `config.command` + `config.args`.
- Wraps the client with `createMcpTransport` (the SDK reference adapter, `@trading-platform/sdk/agent/mcp-transport`).
- Applies the discovery/gateway timeout (§8.B) to connect + calls so an unreachable or hung gateway cannot block forever.
- Maps `config.gatewayConfigPath` into the **child process env** as `MCP_GATEWAY_CONFIG` (the gateway's own operator-config var). `trading-lab`'s outward-facing config stays in the `TRADING_PLATFORM_*` namespace; the legacy var name only crosses the process boundary into the child.
- `close()` tears down client + transport; callers invoke it in `finally`.

`trading-lab` owns the network/process; the SDK core is untouched.

## 8. Config & env

Extend the existing env loader. All `trading-lab`-facing vars use the **`TRADING_PLATFORM_` prefix** (single boundary namespace).

| Env var | Purpose | Default |
|---------|---------|---------|
| `TRADING_PLATFORM_INTEGRATION` | Runtime adapter select: `mock` \| `mcp` | `mock` |
| `TRADING_PLATFORM_GATEWAY_COMMAND` | Executable to launch the stdio gateway | — (required when `mcp`) |
| `TRADING_PLATFORM_GATEWAY_ARGS` | Args for the gateway command | — |
| `TRADING_PLATFORM_GATEWAY_CONFIG` | Path to the gateway operator-config; factory passes it to the child as `MCP_GATEWAY_CONFIG` | — (optional) |
| `TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS` | Timeout for the discovery probe (connect + calls); guards against a hung/unreachable gateway | `15000` |
| `TRADING_PLATFORM_EXPECTED_CONTRACT` | Override the contract version `trading-lab` accepts | SDK `CONTRACT_VERSION` |

**Future (not slice 1):** `TRADING_PLATFORM_GATEWAY_URL` + `TRADING_PLATFORM_AGENT_TOKEN` for an HTTP transport — the outbound mirror of the inbound `TRADING_LAB_*_TOKEN` gates from SP-6.x.

## 9. Contract-version handshake (mandatory, fail-closed)

On `discover()`, the MCP adapter validates the returned `ResearchCapabilityDescriptor` against the version `trading-lab` accepts (`TRADING_PLATFORM_EXPECTED_CONTRACT`, default = SDK `CONTRACT_VERSION`):

- **Compatible** when the expected version equals `descriptor.contractVersion` **or** is listed in `descriptor.supportedContractVersions`.
- **Incompatible** → emit `platform.contract.incompatible` (expected vs actual), throw a clear error, **no fallback / no "try anyway"**.

Effect on the CLI probe: incompatibility (or any discovery failure) → **non-zero exit** with a readable message.

Effect on runtime boot: **none**. Discovery runs on-demand only; `composeRuntime` never calls it, so an incompatible or unavailable platform cannot break `trading-lab` startup.

## 10. Audit (AgentEvent stream)

Reuse the existing `services.events.append(event(<id>, '<name>', {...}))` pattern. The CLI probe uses a **synthetic probe id** (no real task).

| Event | Payload |
|-------|---------|
| `platform.discover.started` | `{ integration, command }` |
| `platform.discover.completed` | `{ contractVersion, marketDataKinds, runModes, metricCatalog, robustnessCatalog }` (counts) |
| `platform.discover.failed` | `{ error }` |
| `platform.contract.incompatible` | `{ expected, actual, supported }` |
| `platform.datasets.listed` | `{ count }` |

## 11. Trigger surface — `platform:discover` CLI

`scripts/platform-discover.ts`, wired as `package.json` script `platform:discover`. No public API / task / persistence change.

Flow (single MCP session per probe — D4):

1. Load `TRADING_PLATFORM_*` config from env.
2. `createGatewayTransport(config)` → spawns the stdio gateway, builds the transport.
3. Build `McpResearchPlatformAdapter` over that transport.
4. `discover()` → emit `platform.discover.started` / `completed`; run the contract check (emit `platform.contract.incompatible` + throw on mismatch).
5. `listDatasets()` → emit `platform.datasets.listed`; pretty-print the descriptor + datasets.
6. `finally` → `close()` the transport/client.
7. Exit 0 on success; non-zero on any failure (incl. timeout, incompatibility).

Both calls reuse one client/session; the process exits after both.

## 12. Composition gating (`src/composition.ts`)

- Add `researchPlatform: ResearchPlatformPort` to the runtime services.
- Select by `TRADING_PLATFORM_INTEGRATION`: `mcp` → `McpResearchPlatformAdapter` (constructed with a transport **factory**, lazy connect-per-call — no live transport at boot), else → `MockResearchPlatformAdapter` (**default**).
- **Boot opens no transport and spawns no gateway**, regardless of the flag (D5). In slice 1 the runtime never calls `researchPlatform`; the port is exercised only by the `platform:discover` CLI. Runtime transport pooling/lifecycle is deferred to SP-7.1, when a handler first calls the port.
- `platform: new MockPlatformGatewayAdapter()` stays unchanged.
- Worker / handlers are untouched — nothing calls the new port yet.

## 13. Decoupling guard & dependencies

- The only existing import guard, `src/read-api/read-boundary.guard.test.ts` (FORBIDDEN includes `/trading-platform/`), is **read-api-scoped** and stays **unchanged**. The SDK import lives only on the write/adapter side and must never enter the read boundary. Add/keep an assertion that the read-api imports nothing from `@trading-platform/*`.
- **SDK import discipline (D3):** `@trading-platform/sdk/agent` (+ `/agent/mcp-transport`) may be imported **only** in `src/ports/research-platform.port.ts` and `src/adapters/platform/*`. It must not leak into `orchestrator/handlers`, `domain`, or `read-api`. A small import-boundary test enforces this.
- Dependencies: add `@trading-platform/sdk` (`workspace:*` or a `link:`/`file:` reference to the sibling `packages/sdk`) and `@modelcontextprotocol/sdk`. The SDK is TypeScript and must be built before use. Document the link in README and `.env.example`.

## 14. Testing

- **Unit — port contract:** `ResearchPlatformPort` behavior verified against `MockResearchPlatformAdapter`.
- **Unit — MCP adapter:** `McpResearchPlatformAdapter` against a fake `GatewayTransport` / `McpClientLike`; assert it dispatches `discover_research_contract` and `list_datasets`, maps results, and that the contract check throws + emits `platform.contract.incompatible` on a mismatched/unsupported version. No process spawn.
- **Unit — timeout:** factory/probe rejects when the gateway does not respond within `TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS`.
- **Integration (opt-in, tagged):** spawn the real gateway over stdio (anonymous, zero secrets), run `discover()`, assert a `ResearchCapabilityDescriptor` with a compatible `contractVersion`. This is the end-to-end verification gate.
- **Boot independence:** `composeRuntime` with default config wires the mock and never contacts `trading-platform`.

## 15. Verification (definition of done)

1. `pnpm test` green (unit + import-boundary + read-boundary guards).
2. `platform:discover` against a locally spawned gateway prints a `ResearchCapabilityDescriptor` + datasets, emits the five AgentEvents, exits 0.
3. `platform:discover` against an incompatible/unreachable gateway exits non-zero with a clear message and emits `platform.contract.incompatible` / `platform.discover.failed`.
4. Default `TRADING_PLATFORM_INTEGRATION=mock` boot makes no outbound platform call.
5. Read-api imports nothing from `@trading-platform/*`; SDK import appears only in the port/adapter boundary.

## 16. Files

**Add**

- `src/ports/research-platform.port.ts`
- `src/adapters/platform/mcp-research-platform.adapter.ts`
- `src/adapters/platform/mock-research-platform.adapter.ts`
- `src/adapters/platform/mcp-research-transport.ts`
- `scripts/platform-discover.ts`
- Tests: research-platform port contract, MCP adapter (fake transport), timeout, import-boundary.

**Change**

- `src/composition.ts` — wire + gate `researchPlatform`.
- env loader — `TRADING_PLATFORM_*` vars.
- `package.json` — deps (`@trading-platform/sdk`, `@modelcontextprotocol/sdk`) + `platform:discover` script.
- `.env.example`, `README.md` — config + SDK link docs.
- `src/read-api/read-boundary.guard.test.ts` — keep/assert no `@trading-platform/*` import in the read boundary (note only; FORBIDDEN unchanged).

## 17. SP-7 roadmap (later slices, out of scope now)

- **SP-7.1 — `validate_module` dry-run:** marshal `ModuleBundle` → `ValidationReport`. Proves bundle/manifest serialization and contract drift without running anything.
- **SP-7.2 — submit / status / result / artifacts:** `submit_run` → `awaitCompletion` / `get_run_status` → `get_run_result` → `read_artifact`, ingested into `ResearchRunEnvelope`; real `submitBacktest` replacing the mock; wired into `hypothesis-build.handler`. First execution authority.
- **SP-7.3 — callback resume wiring:** connect the platform `CompletionEvent` (delivered via the gateway's operator-allowlisted callback → `trading-lab`'s `/callbacks/backtest-completed`) to suspend/resume — closing the SP-6.2 "callback real resume wiring still pending" gap.
