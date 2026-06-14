# trading-lab

Research-only multi-agent system over trading-platform. Research brain; no live authority.

## Dev

    pnpm install
    docker compose up -d
    cp .env.example .env
    pnpm db:generate && pnpm db:migrate
    pnpm test

## Run (SP-1 foundation slice)

    pnpm ingress   # POST /tasks
    pnpm worker    # consumes queue, dispatches via WorkflowRouter

Design: docs/superpowers/specs/2026-06-10-trading-lab-design.md

## Platform capability discovery (SP-7 slice 1)

Read-only probe of the `trading-platform` research gateway over MCP — no execution, no DB, no
runtime boot. It spawns the gateway over stdio (anonymous, zero secrets), calls
`discover_research_contract` + `list_datasets`, audits the five `platform.*` AgentEvents to stdout,
prints the capability descriptor + datasets, and exits non-zero on a contract mismatch / timeout /
unreachable gateway (fail-closed).

```bash
TRADING_PLATFORM_GATEWAY_COMMAND=node \
TRADING_PLATFORM_GATEWAY_ARGS="--experimental-strip-types ../trading-platform/src/research/mcp-gateway/bin/start-gateway.ts" \
pnpm platform:discover
```

The contract-version handshake is mandatory and fail-closed, but on-demand only: it never blocks
`pnpm worker` / `pnpm ingress` boot. The runtime gate is `TRADING_PLATFORM_INTEGRATION` (`mock`
default); the SDK import is confined to `src/ports/research-platform.port.ts` + `src/adapters/platform/`.

### Dependency note (temporary local-integration workaround)

`@trading-platform/sdk` is consumed via a `file:` dependency plus a `pnpm.overrides` entry
(`"trading-bot-platform@workspace:*": "link:../trading-platform"`) in `package.json`, because the
SDK currently declares a `workspace:*` dependency on the platform that trading-lab is not part of.
This is a **temporary local-integration workaround**: it requires the sibling `trading-platform`
checked out next to this repo with its build output present (`packages/sdk/dist` and the root
`dist`, both gitignored), and it pulls the platform's runtime tree into `node_modules`. A follow-up
on the `trading-platform` side should make the SDK independently published/workspace-consumable so
this override can be removed.
