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
