# Source-Aware Critic + Chat HITL Implementation Plan

> **REQUIRED SUB-SKILL:** Before executing this plan you MUST read and follow
> `superpowers:test-driven-development` (RED → GREEN → commit per task) and, when running tasks in
> this session, `superpowers:subagent-driven-development`.

**Source of truth:** `docs/superpowers/specs/2026-06-27-source-aware-critic-chat-hitl-design.md` (Approved).

## Goal

Make the pre-flight strategy critic (PR #88, eval PR #89) **live by default**, but **source-aware**:

- **Chat / Telegram** strategy (always `manual_description`, via `chat-handler`) → **human-in-the-loop (HITL)**:
  the chat layer runs the critic synchronously, shows the operator the strategy's problems, and offers
  **three** choices — *improve & analyze* (`confirm`), *analyze as-is* (`accept_as_is`), *cancel*
  (`cancel`). The chosen onboard task carries a `skipPreflightCritique: true` flag so the worker does
  **not** re-run the critic.
- **Crawler / direct `/tasks`** onboarding → **auto** (the existing worker-side critic block, gated by
  `STRATEGY_PREFLIGHT_CRITIQUE`, **unchanged**).

Plus: flip the code defaults so the critic is **on** (`STRATEGY_PREFLIGHT_CRITIQUE=true`,
`STRATEGY_CRITIC_MODE=single`, `STRATEGY_CRITIC_MODEL=openrouter/x-ai/grok-4.3` — the eval's verdict).

## Architecture

All changes are in **trading-lab**. Reuse the existing two-turn confirm flow end-to-end
(propose → `POST /chat/confirm` (or typed reply) → `consumeConfirmation` → `executeConfirmedProposal`
→ `createAndEnqueueTask`). No new endpoint.

| Layer | File | Change |
|-------|------|--------|
| Env defaults | `src/config/env.ts`, `.env.example`, `docker-compose.yml` | defaults flip on |
| Worker skip | `src/orchestrator/handlers/strategy-onboard.handler.ts`, `src/domain/strategy-source.ts` | honor `skipPreflightCritique` |
| Chat deps | `src/chat/chat-handler.ts` (`ChatHandlerDeps`), `src/composition.ts` | thread `strategyCritic` |
| Chat critic + 3-action proposal | `src/chat/chat-handler.ts`, `src/chat/action-proposal.ts`, `src/chat/response.ts`, `src/domain/action-proposal.ts` | run critic, store both texts, 3 actions |
| Confirm branching | `src/chat/chat-handler.ts`, `src/chat/confirmation-resolver.ts`, `src/chat/request.ts` | resolve `confirm` / `accept_as_is` / `cancel` |

The alternative payload (`improvedStrategyText` + critique summary) rides **inside the existing JSONB
`task` column** (`ProposedTaskSnapshot.preflightCritique`). The `action_proposal.task` column is
`jsonb('task').notNull().$type<ProposedTaskSnapshot>()` and `DrizzleActionProposalRepository.rowToDomain`
already maps `task: row.task` as one blob; `InMemoryActionProposalRepository` `structuredClone`s the
whole object — so adding an optional field inside the snapshot round-trips through **both** repositories
with **no migration and no repository-code change**.

## Tech Stack

- Node `--experimental-strip-types` (production) / `--experimental-transform-types` (docker); Vitest for tests.
- TypeScript, Zod schemas (`validateWithSchema`), Hono (chat app), Drizzle (JSONB columns), BullMQ / in-memory queue.

## Global Constraints

1. **NO TS parameter-properties.** Production runs under `node --experimental-strip-types`, which does
   **not** support `constructor(private x: T)`. New classes use explicit field declarations + assignment
   in the constructor body. The AST guard `src/strip-types-no-param-properties.test.ts` enforces this —
   it runs as part of `pnpm test`. (This slice adds no classes, but adapters/edits must not introduce
   param-properties.)
2. **`.ts` import extensions everywhere.** Every relative import ends in `.ts` (e.g.
   `import { StrategyAnalystInputSchema } from '../domain/strategy-source.ts';`). Type-only imports use
   `import type`.
3. **Test gate:** the slice is done only when **`pnpm typecheck` AND `pnpm test`** are both green
   (full suite, including the ripple fixes from the new env defaults).
4. **RED is never a "type error".** `pnpm vitest run` strips types, so a failing test fails with an
   **unresolved import**, a **runtime error**, or an **assertion mismatch** — never `tsc`. Type-only
   guarantees (e.g. a new required deps field) are verified by the **`pnpm typecheck`** gate, not by a
   RED. Each task names which mechanism proves the change.
5. **Fail-soft.** A critic failure (null critic, thrown `refine`, or invalid critic input) at chat time
   **never blocks onboarding** — the chat falls back to today's simple two-action onboard confirm
   (`['confirm','cancel']`, no critique, no improvement option).
6. **Source-aware.** Chat = HITL (this slice). Crawler / direct-`/tasks` = the existing worker auto-critic
   block, **UNCHANGED** except for the new `skipPreflightCritique` short-circuit.
7. **Office is NOT modified in this slice.** trading-office already renders `assistant_message` + a generic
   `actions` list. Whether its connector can send a third decision id (`accept_as_is`) is a **separate
   small office fast-follow** (see spec "Cross-repo") — out of scope here. The lab side is built complete.
8. **Reuse the two-turn confirm flow.** Do **not** invent a new endpoint. The third action is an additive
   value on the existing `/chat/confirm` decision enum + `consumeConfirmation`.
9. **Privacy.** Chat events log severity / counts / `mainVulnerability` (a short critic verdict label) only —
   **never** the raw strategy text or `improvedStrategyText` (mirrors the worker's `strategy_critic.completed`
   event which already logs `mainVulnerability`).
10. **Commits.** Each task ends with one `git commit`. Every commit message ends with the trailer:
    `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (omitted from the one-line
    templates below for brevity — append it on each commit).
11. **Deployment note — the default-on critic is FAKE in keyless dev.** With the critic enabled by default,
    `STRATEGY_CRITIC_ADAPTER` resolves through `resolveAdapter(...)` and so inherits the `LAB_AGENTS_ADAPTER`
    agent family (Task 1). In a keyless dev env it lands on the **FAKE echo** adapter. The **real** grok-4.3
    critic requires the agent family on `mastra` — set `LAB_AGENTS_ADAPTER=mastra` (or an explicit
    `STRATEGY_CRITIC_ADAPTER=mastra`) **plus** `OPENROUTER_API_KEY`. Without `resolveAdapter` the
    "enabled by default" promise would be hollow (the standalone parse ignored `LAB_AGENTS_ADAPTER`).

---

## Tricky bits (the design risks — read before coding)

- **(a) Two candidate payloads on one proposal.** Resolved by `ProposedTaskSnapshot.preflightCritique`
  (new optional field inside the JSONB `task` blob): the **original** content already lives in
  `task.payload.content`; the **improved** text + critique summary live in `task.preflightCritique`.
  Zero migration, zero repo change (Task 4).
- **(b) Extending `/chat/confirm` beyond `confirm | cancel`.** `ChatConfirmRequestSchema.decision` and
  `ConsumeConfirmationArgs.decision` gain `'accept_as_is'` as an **additive** enum value. Existing callers
  sending `confirm`/`cancel` keep validating; the office connector (unchanged) keeps working. `consumeConfirmation`
  routes the new value through the same `confirmPending` → `executeConfirmedProposal` path (Task 5).
- **(c) The env-default-true ripple (biggest churn).** Flipping `STRATEGY_PREFLIGHT_CRITIQUE` to default-on
  changes the parse semantics (default true → only the literal `'false'` disables; default mode single →
  only the literal `'two_stage'` selects two_stage; default model → grok-4.3). The touched test files are
  **`src/config/env.test.ts`** (the `pre-flight strategy critic env` describe block) and
  **`src/composition.strategy-critic.test.ts`** (the `returns null …(default)` case must pass an explicit
  `STRATEGY_PREFLIGHT_CRITIQUE: 'false'`). All other critic tests pass **explicit** env overrides
  (`makeServices` sets `strategyCritic: null` directly; `compose-mastra.test.ts` builds a literal
  `MastraCompositionEnv`; `experiments/**/real-*-factory.ts` build literal envs) and are therefore
  unaffected. Enumerated in Task 1.

---

## Task 1 — Enable the critic by default (env + .env.example + docker) and fix the ripple

**Goal:** `loadEnv({})` returns `STRATEGY_PREFLIGHT_CRITIQUE=true`, `STRATEGY_CRITIC_MODE='single'`,
`STRATEGY_CRITIC_MODEL='openrouter/x-ai/grok-4.3'`, and `STRATEGY_CRITIC_ADAPTER` keyless-defaults to
`'fake'` but now **inherits the `LAB_AGENTS_ADAPTER` agent family** via `resolveAdapter(...)` (like every
other agent), so a `LAB_AGENTS_ADAPTER=mastra` deployment gets the real grok critic instead of the fake
echo. Update `.env.example` + `docker-compose.yml`. Fix the two test files that asserted the old defaults.

### Step 1 — Replace the env test block (RED)

In `src/config/env.test.ts`, replace the entire `describe('pre-flight strategy critic env', …)` block
(currently the last describe) with:

```ts
describe('pre-flight strategy critic env', () => {
  it('defaults the critic ON with fake adapter + single mode + grok-4.3 model', () => {
    const env = loadEnv({} as NodeJS.ProcessEnv);
    expect(env.STRATEGY_PREFLIGHT_CRITIQUE).toBe(true);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('fake');
    expect(env.STRATEGY_CRITIC_MODE).toBe('single');
    expect(env.STRATEGY_CRITIC_MODEL).toBe('openrouter/x-ai/grok-4.3');
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/x-ai/grok-4.3'); // defaults to critic model
  });

  it('STRATEGY_PREFLIGHT_CRITIQUE=false disables it; any other value keeps it on', () => {
    expect(loadEnv({ STRATEGY_PREFLIGHT_CRITIQUE: 'false' } as unknown as NodeJS.ProcessEnv).STRATEGY_PREFLIGHT_CRITIQUE).toBe(false);
    expect(loadEnv({ STRATEGY_PREFLIGHT_CRITIQUE: '1' } as unknown as NodeJS.ProcessEnv).STRATEGY_PREFLIGHT_CRITIQUE).toBe(true);
  });

  it('STRATEGY_CRITIC_MODE=two_stage selects two_stage; any other value falls back to single', () => {
    expect(loadEnv({ STRATEGY_CRITIC_MODE: 'two_stage' } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_MODE).toBe('two_stage');
    expect(loadEnv({ STRATEGY_CRITIC_MODE: 'bogus' } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_MODE).toBe('single');
  });

  it('reads overrides; refiner model defaults to the critic model when unset', () => {
    const env = loadEnv({
      STRATEGY_CRITIC_ADAPTER: 'mastra',
      STRATEGY_CRITIC_MODEL: 'anthropic/claude-sonnet-4-6',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('mastra');
    expect(env.STRATEGY_CRITIC_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.STRATEGY_REFINER_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  it('reads an explicit refiner model and treats a non-mastra adapter as fake', () => {
    const env = loadEnv({
      STRATEGY_CRITIC_ADAPTER: 'bogus',
      STRATEGY_REFINER_MODEL: 'openrouter/google/gemini-3.5-flash',
    } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_CRITIC_ADAPTER).toBe('fake');
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/google/gemini-3.5-flash');
  });

  it('collapses to critic model when STRATEGY_REFINER_MODEL is empty string (docker passthrough pattern)', () => {
    const env = loadEnv({ STRATEGY_REFINER_MODEL: '' } as unknown as NodeJS.ProcessEnv);
    expect(env.STRATEGY_REFINER_MODEL).toBe('openrouter/x-ai/grok-4.3');
  });

  it('STRATEGY_CRITIC_ADAPTER inherits the LAB_AGENTS_ADAPTER family; an explicit value overrides it', () => {
    // keyless → fake (family default, LAB_AGENTS_ADAPTER unset)
    expect(loadEnv({} as NodeJS.ProcessEnv).STRATEGY_CRITIC_ADAPTER).toBe('fake');
    // NEW: inherits the family when LAB_AGENTS_ADAPTER=mastra — exactly like analyst/researcher/etc.
    expect(
      loadEnv({ LAB_AGENTS_ADAPTER: 'mastra' } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_ADAPTER,
    ).toBe('mastra');
    // per-agent override wins: explicit STRATEGY_CRITIC_ADAPTER=fake beats LAB_AGENTS_ADAPTER=mastra
    expect(
      loadEnv({
        LAB_AGENTS_ADAPTER: 'mastra',
        STRATEGY_CRITIC_ADAPTER: 'fake',
      } as unknown as NodeJS.ProcessEnv).STRATEGY_CRITIC_ADAPTER,
    ).toBe('fake');
  });
});
```

Also update the unrelated `composition.strategy-critic.test.ts` first case now (it shares the same
default-ON ripple) — replace:

```ts
  it('returns null when STRATEGY_PREFLIGHT_CRITIQUE is false (default)', () => {
    const env = envWith({});
    expect(buildStrategyCritic(env, composeMastra(env))).toBeNull();
  });
```

with:

```ts
  it('returns null when STRATEGY_PREFLIGHT_CRITIQUE=false', () => {
    const env = envWith({ STRATEGY_PREFLIGHT_CRITIQUE: 'false' });
    expect(buildStrategyCritic(env, composeMastra(env))).toBeNull();
  });
```

### Step 2 — Run, expect FAIL (RED)

```
pnpm vitest run src/config/env.test.ts src/composition.strategy-critic.test.ts
```

Expected: runtime assertion failures under `pnpm vitest run` (NOT a type error) — `env.STRATEGY_PREFLIGHT_CRITIQUE`
is `false` (expected `true`), `STRATEGY_CRITIC_MODE` is `'two_stage'` (expected `'single'`),
`STRATEGY_CRITIC_MODEL` is `'anthropic/claude-sonnet-4-6'` (expected `'openrouter/x-ai/grok-4.3'`); the new
family-inherit case fails — with `LAB_AGENTS_ADAPTER: 'mastra'` the old standalone parse returns `'fake'`
(expected `'mastra'`), because the current `STRATEGY_CRITIC_ADAPTER` line does not read `LAB_AGENTS_ADAPTER`;
and `buildStrategyCritic` returns a `FakeStrategyCritic` instead of `null`.

### Step 3 — Flip the defaults in `src/config/env.ts` (GREEN)

(a) The model default const — replace:

```ts
  const strategyCriticModel = source.STRATEGY_CRITIC_MODEL || 'anthropic/claude-sonnet-4-6';
```

with:

```ts
  const strategyCriticModel = source.STRATEGY_CRITIC_MODEL || 'openrouter/x-ai/grok-4.3';
```

(b) The three parse lines in the returned object — replace:

```ts
    STRATEGY_PREFLIGHT_CRITIQUE: source.STRATEGY_PREFLIGHT_CRITIQUE === 'true',
    STRATEGY_CRITIC_ADAPTER: source.STRATEGY_CRITIC_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    STRATEGY_CRITIC_MODE: source.STRATEGY_CRITIC_MODE === 'single' ? 'single' : 'two_stage',
```

with (note: `STRATEGY_CRITIC_ADAPTER` now routes through `resolveAdapter(...)` — **exactly** like every
other agent in `loadEnv` (`STRATEGY_ANALYST_ADAPTER: resolveAdapter(source.STRATEGY_ANALYST_ADAPTER)`,
`RESEARCHER_ADAPTER`, `CRITIC_ADAPTER`, `BUILDER_ADAPTER`, `TURN_INTERPRETER_ADAPTER`). So it inherits the
`LAB_AGENTS_ADAPTER` family default, with the explicit `STRATEGY_CRITIC_ADAPTER` env var as the per-agent
override and a keyless default of `'fake'`. This makes the default-on critic actually use the real grok
critic when a deployment sets `LAB_AGENTS_ADAPTER=mastra` — instead of silently staying on the fake echo):

```ts
    STRATEGY_PREFLIGHT_CRITIQUE: source.STRATEGY_PREFLIGHT_CRITIQUE !== 'false',
    STRATEGY_CRITIC_ADAPTER: resolveAdapter(source.STRATEGY_CRITIC_ADAPTER),
    STRATEGY_CRITIC_MODE: source.STRATEGY_CRITIC_MODE === 'two_stage' ? 'two_stage' : 'single',
```

(c) Update the two `Env` interface JSDoc comments to match (defaults only; types unchanged) — replace:

```ts
  /** Feature flag: run the pre-flight strategy critic before the analyst (default: false). */
  STRATEGY_PREFLIGHT_CRITIQUE: boolean;
```

with:

```ts
  /** Feature flag: run the pre-flight strategy critic before the analyst (default: true; set 'false' to disable). */
  STRATEGY_PREFLIGHT_CRITIQUE: boolean;
```

and replace:

```ts
  /** Critic mode: 'two_stage' (default; critic agent → refiner agent) or 'single' (one combined agent). */
  STRATEGY_CRITIC_MODE: 'single' | 'two_stage';
```

with:

```ts
  /** Critic mode: 'single' (default; one combined agent) or 'two_stage' (critic agent → refiner agent). */
  STRATEGY_CRITIC_MODE: 'single' | 'two_stage';
```

### Step 4 — Update `.env.example` (lines ~113–119)

Replace the pre-flight critic block:

```
# --- Pre-flight Strategy Critic (off by default; zero behavior change) ---
# When enabled, a "ruthless market opponent" critiques a NEW strategy's raw text and the analyst
# then profiles the IMPROVED text. A critic failure never blocks onboarding (fail-soft).
STRATEGY_PREFLIGHT_CRITIQUE=false
STRATEGY_CRITIC_ADAPTER=fake          # fake | mastra
STRATEGY_CRITIC_MODE=two_stage        # two_stage (critic→refiner, 2 LLM calls) | single (1 combined call)
STRATEGY_CRITIC_MODEL=anthropic/claude-sonnet-4-6
```

with:

```
# --- Pre-flight Strategy Critic (ON by default; single + grok-4.3, the eval verdict) ---
# A "ruthless market opponent" critiques a NEW strategy's raw text. Chat onboarding is HITL (the
# operator chooses to apply the improvements or analyze as-is); crawler/direct-/tasks onboarding is
# auto. A critic failure never blocks onboarding (fail-soft). Set STRATEGY_PREFLIGHT_CRITIQUE=false to disable.
STRATEGY_PREFLIGHT_CRITIQUE=true
# Adapter follows LAB_AGENTS_ADAPTER (the agent-family default) unless set explicitly. The default-on critic
# uses the FAKE echo adapter in keyless dev; the real grok-4.3 critic needs mastra + OPENROUTER_API_KEY.
STRATEGY_CRITIC_ADAPTER=fake          # fake | mastra (inherits LAB_AGENTS_ADAPTER when unset; mastra needs OPENROUTER_API_KEY)
STRATEGY_CRITIC_MODE=single           # single (1 combined call) | two_stage (critic→refiner, 2 LLM calls)
STRATEGY_CRITIC_MODEL=openrouter/x-ai/grok-4.3
```

(Leave the `STRATEGY_REFINER_MODEL=` line and its comment unchanged.)

### Step 5 — Update `docker-compose.yml` (ingress block ~111–115 AND worker block ~191–195)

In **both** the `ingress` and `worker` `environment:` maps, replace:

```yaml
      # Pre-flight strategy critic (off by default; zero behavior change).
      STRATEGY_PREFLIGHT_CRITIQUE: ${STRATEGY_PREFLIGHT_CRITIQUE:-false}
      STRATEGY_CRITIC_ADAPTER: ${STRATEGY_CRITIC_ADAPTER:-fake}
      STRATEGY_CRITIC_MODE: ${STRATEGY_CRITIC_MODE:-two_stage}
      STRATEGY_CRITIC_MODEL: ${STRATEGY_CRITIC_MODEL:-anthropic/claude-sonnet-4-6}
```

with:

```yaml
      # Pre-flight strategy critic (ON by default; single + grok-4.3). Chat=HITL, crawler/-/tasks=auto.
      STRATEGY_PREFLIGHT_CRITIQUE: ${STRATEGY_PREFLIGHT_CRITIQUE:-true}
      # Adapter follows LAB_AGENTS_ADAPTER unless set; the default-on critic is the FAKE echo in keyless dev —
      # the real grok-4.3 critic needs LAB_AGENTS_ADAPTER=mastra (or STRATEGY_CRITIC_ADAPTER=mastra) + OPENROUTER_API_KEY.
      STRATEGY_CRITIC_ADAPTER: ${STRATEGY_CRITIC_ADAPTER:-fake}
      STRATEGY_CRITIC_MODE: ${STRATEGY_CRITIC_MODE:-single}
      STRATEGY_CRITIC_MODEL: ${STRATEGY_CRITIC_MODEL:-openrouter/x-ai/grok-4.3}
```

(The `STRATEGY_REFINER_MODEL: ${STRATEGY_REFINER_MODEL:-}` line stays unchanged in both blocks.)

### Step 6 — Run, expect PASS (GREEN)

```
pnpm vitest run src/config/env.test.ts src/composition.strategy-critic.test.ts
```

Expected: both files green.

### Step 7 — Commit

```
git commit -am "feat(strategy-critic): enable pre-flight critic by default (single + grok-4.3); fix env-default ripple"
```

---

## Task 2 — Worker honors `skipPreflightCritique`

**Goal:** when the onboard task payload carries `skipPreflightCritique: true`, `strategyOnboardHandler`
does **not** run its critic block (the analyst sees the payload content as-is). Absent flag + a present
critic → the auto-critic runs (existing behavior).

### Step 1 — Add the failing test (RED)

In `src/orchestrator/handlers/strategy-onboard.handler.test.ts`, inside the
`describe('strategyOnboardHandler — pre-flight critic', …)` block, add:

```ts
  it('skipPreflightCritique:true → critic NOT called; analyst sees the payload content as-is', async () => {
    const { analyst, seen } = spyAnalyst();
    let refineCalls = 0;
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => { refineCalls += 1; return cannedRefinement(`IMPROVED: ${input.content}`); },
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task({ ...validPayload, skipPreflightCritique: true }), services);
    expect(refineCalls).toBe(0);
    expect(seen).toEqual([validPayload.content]); // original, never improved
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).not.toContain('strategy_critic.started');
    expect(types).not.toContain('strategy_critic.completed');
  });

  it('absent flag + critic present → the auto-critic runs (analyst sees improvedStrategyText)', async () => {
    const { analyst, seen } = spyAnalyst();
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => cannedRefinement(`IMPROVED: ${input.content}`),
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services); // no skip flag
    expect(seen).toEqual([`IMPROVED: ${validPayload.content}`]);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('strategy_critic.completed');
  });
```

(`spyAnalyst`, `cannedRefinement`, `task`, `validPayload`, `makeServices`, and the `StrategyCriticPort`
import already exist in this file.)

### Step 2 — Run, expect FAIL (RED)

```
pnpm vitest run src/orchestrator/handlers/strategy-onboard.handler.test.ts
```

Expected: the `skipPreflightCritique:true` test FAILS — `refineCalls` is `1` (the handler still runs the
critic), `seen` is `['IMPROVED: …']`, and `strategy_critic.started/completed` events are present. The
"absent flag" test passes (existing behavior). NOT a type error.

### Step 3 — Implement (GREEN)

(a) In `src/domain/strategy-source.ts`, extend the schema with the optional flag — replace:

```ts
export const StrategyAnalystInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  content: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
```

with:

```ts
export const StrategyAnalystInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  content: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  /**
   * Chat HITL already resolved the pre-flight critic for this onboard — the worker MUST NOT re-run it.
   * Absent (crawler / direct /tasks) → the worker auto-critic runs (gated by STRATEGY_PREFLIGHT_CRITIQUE).
   * Not part of the source fingerprint (dedupe keys on kind+content only).
   */
  skipPreflightCritique: z.boolean().optional(),
});
```

(b) In `src/orchestrator/handlers/strategy-onboard.handler.ts`, gate the critic block — replace:

```ts
  let analyzeInput = input;
  if (services.strategyCritic) {
```

with:

```ts
  let analyzeInput = input;
  if (services.strategyCritic && !input.skipPreflightCritique) {
```

### Step 4 — Run, expect PASS (GREEN)

```
pnpm vitest run src/orchestrator/handlers/strategy-onboard.handler.test.ts
```

Expected: green (both new tests + all existing).

### Step 5 — Commit

```
git commit -am "feat(strategy-onboard): skip worker critic when payload carries skipPreflightCritique"
```

---

## Task 3 — Thread `strategyCritic` into chat deps + composition

**Goal:** `ChatHandlerDeps` (and therefore `ChatAppDeps`, which extends it) carries
`strategyCritic: StrategyCriticPort | null`; `composeRuntime` provides it from the already-built
`services.strategyCritic`. No behavior change yet (the handler does not consume it until Task 4).

### Step 1 — Add the failing test (RED)

In `src/chat/chat-handler.test.ts`, add a test that the base fixture now exposes the field defaulting to
`null` (this forces the fixture update; the `pnpm typecheck` gate forces the type + composition wiring):

```ts
describe('ChatHandlerDeps strategyCritic plumbing', () => {
  it('the base fixture exposes strategyCritic, defaulting to null', () => {
    const { d } = deps();
    expect(d.strategyCritic).toBeNull();
  });
});
```

### Step 2 — Run, expect FAIL (RED)

```
pnpm vitest run src/chat/chat-handler.test.ts
```

Expected: the new test FAILS — `d.strategyCritic` is `undefined` (the base fixture does not set it),
so `toBeNull()` mismatches. NOT a type error.

### Step 3 — Implement (GREEN)

(a) In `src/chat/chat-handler.ts`, add the import (after the existing `ActionProposal` import):

```ts
import type { ActionProposal } from '../domain/action-proposal.ts';
import type { StrategyCriticPort } from '../ports/strategy-critic.port.ts';
```

(b) Add the field to `ChatHandlerDeps` — insert after `proposals: ActionProposalRepository;`:

```ts
  proposals: ActionProposalRepository;
  /** Pre-flight strategy critic for chat HITL; null when STRATEGY_PREFLIGHT_CRITIQUE=false. */
  strategyCritic: StrategyCriticPort | null;
```

(c) In `src/composition.ts`, inside the `const chat: ChatAppDeps = { … }` literal, add the field after
`proposals: services.actionProposals,`:

```ts
    proposals: services.actionProposals,
    strategyCritic: services.strategyCritic,
```

(d) Set `strategyCritic: null` in every direct chat fixture so `pnpm typecheck` passes:

- `src/chat/chat-handler.test.ts` — in the `base: ChatHandlerDeps` object inside `deps()`, add to the
  `proposals, proposalTtlMs` line area:

  ```ts
    proposals, proposalTtlMs: 600_000,
    strategyCritic: null,
  ```

- `src/chat/chat-app.test.ts` — in `appDeps()`'s returned object, after `proposals: new InMemoryActionProposalRepository(),`:

  ```ts
    proposals: new InMemoryActionProposalRepository(),
    strategyCritic: null,
  ```

- `test/e2e/chat-to-task.test.ts` — in the `createChatApp({ … })` literal, after
  `proposals: services.actionProposals, proposalTtlMs: 600_000,`:

  ```ts
      proposals: services.actionProposals, proposalTtlMs: 600_000,
      strategyCritic: null,
  ```

- `test/e2e/operator-rag-to-proposal.test.ts` — in `buildApp`'s `createChatApp({ … })` literal, after
  `proposals: services.actionProposals,`:

  ```ts
    proposals: services.actionProposals,
    strategyCritic: null,
  ```

> **Composition verification:** `composeRuntime` is DB/Redis-bound (no unit test). The wiring is proven
> by the `pnpm typecheck` gate: the `chat: ChatAppDeps` object literal in `composition.ts` now must
> include the required `strategyCritic` field, and `services.strategyCritic` (built by
> `buildStrategyCritic`, already in `AppServices`) supplies it. The fixture test above proves the deps
> shape at runtime.

### Step 4 — Run, expect PASS (GREEN)

```
pnpm vitest run src/chat/chat-handler.test.ts src/chat/chat-app.test.ts test/e2e/chat-to-task.test.ts test/e2e/operator-rag-to-proposal.test.ts
```

Expected: green.

### Step 5 — Commit

```
git commit -am "feat(chat): thread strategyCritic into ChatHandlerDeps and composition"
```

---

## Task 4 — Chat-time critic + 3-action proposal

**Goal:** when `deps.strategyCritic` is present and the onboard subject is a strategy
(`decision.taskType === 'strategy.onboard'`), call `refine(input)` synchronously (fail-soft) BEFORE
building the proposal. On success: build an `assistant_message` listing the problems (`verdict.severity`
+ `verdict.mainVulnerability` + top-N `vulnerabilities`) with **three** actions
(`confirm`, `accept_as_is`, `cancel`); the proposal stores BOTH the original content (already in
`task.payload.content`) and the `improvedStrategyText` + critique summary (in `task.preflightCritique`).
On critic-null / critic-throw / invalid-input → fall back to the existing two-action onboard confirm.

### Step 1 — Add the failing tests (RED)

In `src/chat/chat-handler.test.ts`, add a critic helper near the top (after `cannedInterpreter`):

```ts
import type { StrategyCriticPort } from '../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../domain/strategy-critic.ts';

function cannedRefinement(improved: string): StrategyRefinement {
  return {
    vulnerabilities: ['нет инвалидации сделки', 'не учтён режим BTC', 'тонкая ликвидность'],
    selfDeception: [],
    risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
    earlyBreakSigns: [],
    preEntryChecks: [],
    verdict: { mainVulnerability: 'нет стопа', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'добавить фильтр' },
    improvedStrategyText: improved,
    changeLog: ['добавлен фильтр режима'],
  };
}

function cannedCritic(improved: string): StrategyCriticPort {
  return { adapter: 'fake', mode: 'single', model: 'fake', refine: async () => cannedRefinement(improved) };
}

function throwingCritic(): StrategyCriticPort {
  return { adapter: 'fake', mode: 'single', model: 'fake', refine: async () => { throw new Error('critic exploded'); } };
}
```

Then add a describe block (use the existing `strategyMsg`-style standalone strategy description):

```ts
describe('handleChatMessage — chat-time critic (HITL)', () => {
  const strategyMsg =
    'Стратегия только в лонг. Работаем на 1m свечах. После резкого пролива цены ищем подтверждённый отскок от локального минимума. Входим в лонг, когда цена начинает восстанавливаться, open interest восстанавливается, и на рынке видны long-ликвидации. Первый тейк на +3.5%, второй тейк на +5%, стоп -12%, выход по времени через 180 минут.';

  it('critic present → 3-action proposal; stores original content + improvedStrategyText + critique summary', async () => {
    const { d, sessions, proposals } = deps({ strategyCritic: cannedCritic('УЛУЧШЕННЫЙ ТЕКСТ СТРАТЕГИИ') });
    const r = await handleChatMessage({ message: strategyMsg, session: session(), source: 'web' }, d);
    expect(r.kind).toBe('assistant_message');
    if (r.kind === 'assistant_message') {
      expect(r.actions.map((a) => a.id)).toEqual(['confirm', 'accept_as_is', 'cancel']);
    }
    const saved = await proposals.findById((await sessions.get('s1'))!.pendingInteraction!.proposalId);
    expect(saved?.task.taskType).toBe('strategy.onboard');
    // Original content stays in the payload…
    expect((saved?.task.payload as { content: string }).content).toContain('Стратегия только в лонг');
    // …the improved alternative + critique summary ride on the snapshot.
    expect(saved?.task.preflightCritique?.improvedStrategyText).toBe('УЛУЧШЕННЫЙ ТЕКСТ СТРАТЕГИИ');
    expect(saved?.task.preflightCritique?.severity).toBe('high');
    expect(saved?.task.preflightCritique?.mainVulnerability).toBe('нет стопа');
    expect(saved?.task.preflightCritique?.vulnerabilities.length).toBeGreaterThan(0);
  });

  it('critic throws → fail-soft to the simple two-action onboard confirm (no critique stored)', async () => {
    const { d, sessions, proposals } = deps({ strategyCritic: throwingCritic() });
    const r = await handleChatMessage({ message: strategyMsg, session: session(), source: 'web' }, d);
    expect(r.kind).toBe('assistant_message');
    if (r.kind === 'assistant_message') {
      expect(r.actions.map((a) => a.id)).toEqual(['confirm', 'cancel']);
    }
    const saved = await proposals.findById((await sessions.get('s1'))!.pendingInteraction!.proposalId);
    expect(saved?.task.preflightCritique).toBeUndefined();
  });

  it('critic null (flag off) → today’s two-action behavior, no critique', async () => {
    const { d, sessions, proposals } = deps(); // strategyCritic: null
    const r = await handleChatMessage({ message: strategyMsg, session: session(), source: 'web' }, d);
    expect(r.kind).toBe('assistant_message');
    if (r.kind === 'assistant_message') {
      expect(r.actions.map((a) => a.id)).toEqual(['confirm', 'cancel']);
    }
    const saved = await proposals.findById((await sessions.get('s1'))!.pendingInteraction!.proposalId);
    expect(saved?.task.preflightCritique).toBeUndefined();
  });
});
```

### Step 2 — Run, expect FAIL (RED)

```
pnpm vitest run src/chat/chat-handler.test.ts
```

Expected: the "critic present" test FAILS — actions are `['confirm','cancel']` (no third action) and
`saved.task.preflightCritique` is `undefined`. NOT a type error.

### Step 3 — Implement (GREEN)

(a) `src/domain/action-proposal.ts` — add the summary type and the optional snapshot field. Insert
before `export interface ProposedTaskSnapshot`:

```ts
export interface PreflightCritiqueSummary {
  /** The refined strategy text the analyst receives if the operator picks "improve & analyze". */
  improvedStrategyText: string;
  severity: 'low' | 'medium' | 'high';
  mainVulnerability: string;
  /** Top critic-found vulnerabilities, for the problem list shown to the operator. */
  vulnerabilities: string[];
}
```

and extend `ProposedTaskSnapshot`:

```ts
export interface ProposedTaskSnapshot {
  taskType: AgentTaskType;
  payload: Record<string, unknown>;
  dedupeKey: string;
  chain?: ProposedChain;
  userGoal: string;
  /**
   * Chat HITL pre-flight critique. Present only when a chat-time critic produced a refinement; rides
   * inside the JSONB `task` column (no migration). The confirm step picks improvedStrategyText vs the
   * original payload.content based on the chosen action.
   */
  preflightCritique?: PreflightCritiqueSummary;
}
```

(b) `src/chat/response.ts` — extend `ProposedActionView.id` to include the third action:

```ts
export interface ProposedActionView {
  id: 'confirm' | 'accept_as_is' | 'cancel';
  label: string;
  style: 'primary' | 'secondary';
}
```

(c) `src/chat/action-proposal.ts` — accept the refinement and store the summary. Replace the whole
`buildActionProposal` with:

```ts
import type { TaskSource } from '../domain/types.ts';
import type { ActionProposal } from '../domain/action-proposal.ts';
import type { OperatorEvidence } from '../domain/strategy-retrieval.ts';
import type { StrategyRefinement } from '../domain/strategy-critic.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { PlanDecision } from './guard.ts';

export function buildActionProposal(input: {
  id: string;
  sessionId: string;
  source: TaskSource;
  message: string;
  decision: Extract<PlanDecision, { kind: 'propose_task' }>;
  /** Operator evidence gathered before the proposal; its refs/warnings ride on the proposal. */
  evidence?: OperatorEvidence;
  /** Chat-time pre-flight refinement; when present, both candidate texts ride on the snapshot. */
  refinement?: StrategyRefinement;
  now: string;
  expiresAt: string;
}): ActionProposal {
  const { id, sessionId, source, message, decision, evidence, refinement, now, expiresAt } = input;

  return {
    id,
    sessionId,
    // Prefer the retrieval's subjectHash so proposal + evidence agree on subject identity.
    subjectHash: evidence?.subjectHash ?? sourceFingerprint('manual_description', message.trim()),
    action: decision.action,
    source,
    task: {
      taskType: decision.taskType,
      payload: decision.payload,
      dedupeKey: `chat-proposal:${id}`,
      chain: decision.chain,
      userGoal: decision.userGoal,
      ...(refinement
        ? {
            preflightCritique: {
              improvedStrategyText: refinement.improvedStrategyText,
              severity: refinement.verdict.severity,
              mainVulnerability: refinement.verdict.mainVulnerability,
              vulnerabilities: refinement.vulnerabilities,
            },
          }
        : {}),
    },
    status: 'pending',
    // Typed evidence references that justified this proposal — never raw retrieved bodies.
    evidenceRefs: evidence ? [...evidence.evidenceRefs] : [],
    evidenceWarnings: evidence ? [...evidence.warningCodes] : [],
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}
```

(d) `src/chat/chat-handler.ts` — add imports (after the existing `validateWithSchema`-free imports;
place near the top with the other imports):

```ts
import { validateWithSchema } from '../validation/validator.ts';
import { StrategyAnalystInputSchema } from '../domain/strategy-source.ts';
import type { StrategyRefinement } from '../domain/strategy-critic.ts';
```

(e) `src/chat/chat-handler.ts` — run the critic in `handleChatMessage` AFTER the
`chat.retrieval.completed` event and BEFORE `const proposalId = randomUUID();`. Insert:

```ts
  // Source-aware HITL: for a chat onboard of a strategy, run the pre-flight critic synchronously
  // (fail-soft) so the operator can choose to apply its improvements. Crawler/direct-/tasks onboarding
  // never reaches this path — that critique stays on the worker (auto). Adds one LLM call to this turn.
  let refinement: StrategyRefinement | undefined;
  if (deps.strategyCritic && decision.taskType === 'strategy.onboard') {
    const criticInput = validateWithSchema(StrategyAnalystInputSchema, decision.payload);
    if (criticInput.status === 'valid') {
      await ev('chat.strategy_critic.started', {
        chatRequestId, sessionId: sid, mode: deps.strategyCritic.mode, model: deps.strategyCritic.model,
      });
      try {
        refinement = await deps.strategyCritic.refine(criticInput.data);
        // Privacy: severity / count / mainVulnerability (a short verdict label) only — never raw text.
        await ev('chat.strategy_critic.completed', {
          chatRequestId, sessionId: sid,
          severity: refinement.verdict.severity,
          mainVulnerability: refinement.verdict.mainVulnerability,
          vulnerabilityCount: refinement.vulnerabilities.length,
        });
      } catch (err) {
        await ev('chat.strategy_critic.failed', {
          chatRequestId, sessionId: sid, error: err instanceof Error ? err.message : String(err),
        });
        refinement = undefined; // fail-soft: fall back to the simple two-action onboard confirm
      }
    }
  }
```

(f) `src/chat/chat-handler.ts` — pass `refinement` to `buildActionProposal`. Replace:

```ts
  const proposal = buildActionProposal({
    id: proposalId, sessionId: sid, source: input.source, message: input.message, decision, evidence, now: now(), expiresAt,
  });
```

with:

```ts
  const proposal = buildActionProposal({
    id: proposalId, sessionId: sid, source: input.source, message: input.message, decision, evidence, refinement, now: now(), expiresAt,
  });
```

(g) `src/chat/chat-handler.ts` — branch the reply. Replace the final block of `handleChatMessage`:

```ts
  const interpretation = interpretProposal(decision);
  const evidenceCards = buildEvidenceCards(interpretation, evidence);
  return assistantMessage(sid, interpretation, { evidence: evidenceCards, actions: PENDING_ACTIONS, pendingInteractionId: proposalId });
}
```

with:

```ts
  if (refinement) {
    const message = buildCritiqueMessage(refinement);
    const evidenceCards = buildEvidenceCards(message, evidence);
    return assistantMessage(sid, message, { evidence: evidenceCards, actions: CRITIQUE_ACTIONS, pendingInteractionId: proposalId });
  }
  const interpretation = interpretProposal(decision);
  const evidenceCards = buildEvidenceCards(interpretation, evidence);
  return assistantMessage(sid, interpretation, { evidence: evidenceCards, actions: PENDING_ACTIONS, pendingInteractionId: proposalId });
}
```

(h) `src/chat/chat-handler.ts` — add the three-action view + the critique-message builder next to the
existing `PENDING_ACTIONS` const:

```ts
/** The three-action view offered after a chat-time pre-flight critique. */
const CRITIQUE_ACTIONS: ProposedActionView[] = [
  { id: 'confirm', label: 'Улучшить и анализировать', style: 'primary' },
  { id: 'accept_as_is', label: 'Анализировать как есть', style: 'secondary' },
  { id: 'cancel', label: 'Отмена', style: 'secondary' },
];

/** Deterministic operator-facing problem list: severity + main vulnerability + top-N vulnerabilities. */
function buildCritiqueMessage(refinement: StrategyRefinement, topN = 3): string {
  const sev = { low: 'низкая', medium: 'средняя', high: 'высокая' }[refinement.verdict.severity];
  const lines = [
    `Проверил стратегию перед анализом. Критичность найденных проблем: ${sev}.`,
    `Главная уязвимость: ${refinement.verdict.mainVulnerability}.`,
  ];
  const top = refinement.vulnerabilities.slice(0, topN);
  if (top.length > 0) {
    lines.push('Что ещё нашёл:');
    for (const v of top) lines.push(`• ${v}`);
  }
  lines.push('Улучшить стратегию и анализировать, анализировать как есть, или отменить?');
  return lines.join('\n');
}
```

### Step 4 — Run, expect PASS (GREEN)

```
pnpm vitest run src/chat/chat-handler.test.ts
```

Expected: green (3 new tests + all existing chat-handler tests — the existing ones use `strategyCritic: null`,
so they keep the two-action behavior).

### Step 5 — Commit

```
git commit -am "feat(chat): chat-time pre-flight critic with 3-action HITL proposal (carries original + improved text)"
```

---

## Task 5 — Confirm branching + skip flag

**Goal:** the three actions resolve so:
- `confirm` → enqueue `strategy.onboard` with `content = improvedStrategyText`,
- `accept_as_is` → enqueue with `content = original` (`payload.content`),
- `cancel` → no enqueue (existing behavior).
Both enqueue paths set payload `skipPreflightCritique: true` (read by Task 2's worker). Extend the typed
reply resolver, the `ConsumeConfirmationArgs` decision union, and the `/chat/confirm` schema to carry the
third action.

### Step 1 — Add the failing tests (RED)

(a) In `src/chat/chat-handler.test.ts`, add (it imports `consumeConfirmation`? no — add it):

```ts
import { handleChatMessage, consumeConfirmation, type ChatHandlerDeps } from './chat-handler.ts';
```

Then add a describe block (reuses `cannedCritic`/`strategyMsg` from Task 4):

```ts
describe('confirm branching — critique proposal', () => {
  const strategyMsg =
    'Стратегия только в лонг. Работаем на 1m свечах. После резкого пролива цены ищем подтверждённый отскок от локального минимума. Входим в лонг, когда цена начинает восстанавливаться, open interest восстанавливается, long-ликвидации. Тейк +3.5%, стоп -12%.';
  const noop = async () => { /* event sink */ };
  const now = () => new Date().toISOString();

  async function proposeWithCritic(improved: string) {
    const ctx = deps({ strategyCritic: cannedCritic(improved) });
    await handleChatMessage({ message: strategyMsg, session: session(), source: 'web' }, ctx.d);
    const saved = (await ctx.sessions.get('s1'))!;
    return { ctx, saved };
  }

  it('confirm → enqueues onboard with content = improvedStrategyText AND skipPreflightCritique:true', async () => {
    const { ctx, saved } = await proposeWithCritic('УЛУЧШЕННЫЙ ТЕКСТ');
    const proposalId = saved.pendingInteraction!.proposalId;
    const r = await consumeConfirmation({ proposalId, decision: 'confirm', session: saved }, ctx.d, noop, now);
    expect(r.kind).toBe('task_created');
    if (r.kind !== 'task_created') return;
    expect(ctx.queue.queued).toHaveLength(1);
    const t = await ctx.researchTasks.findById(r.taskId);
    expect((t!.payload as { content: string }).content).toBe('УЛУЧШЕННЫЙ ТЕКСТ');
    expect((t!.payload as { skipPreflightCritique?: boolean }).skipPreflightCritique).toBe(true);
  });

  it('accept_as_is → enqueues onboard with content = original AND skipPreflightCritique:true', async () => {
    const { ctx, saved } = await proposeWithCritic('УЛУЧШЕННЫЙ ТЕКСТ');
    const proposalId = saved.pendingInteraction!.proposalId;
    const r = await consumeConfirmation({ proposalId, decision: 'accept_as_is', session: saved }, ctx.d, noop, now);
    expect(r.kind).toBe('task_created');
    if (r.kind !== 'task_created') return;
    expect(ctx.queue.queued).toHaveLength(1);
    const t = await ctx.researchTasks.findById(r.taskId);
    expect((t!.payload as { content: string }).content).toContain('Стратегия только в лонг'); // original
    expect((t!.payload as { content: string }).content).not.toBe('УЛУЧШЕННЫЙ ТЕКСТ');
    expect((t!.payload as { skipPreflightCritique?: boolean }).skipPreflightCritique).toBe(true);
  });

  it('cancel → no enqueue, proposal cancelled', async () => {
    const { ctx, saved } = await proposeWithCritic('УЛУЧШЕННЫЙ ТЕКСТ');
    const proposalId = saved.pendingInteraction!.proposalId;
    const r = await consumeConfirmation({ proposalId, decision: 'cancel', session: saved }, ctx.d, noop, now);
    expect(r.kind).toBe('assistant_message');
    expect(ctx.queue.queued).toHaveLength(0);
    expect((await ctx.proposals.findById(proposalId))?.status).toBe('cancelled');
  });
});
```

(b) In `src/chat/chat-app.test.ts`, add to `describe('POST /chat/confirm', …)`:

```ts
  it('accepts decision=accept_as_is -> task_created', async () => {
    const deps = appDeps();
    const app = createChatApp(deps);
    const firstRes = await app.request('/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'исследуй эту стратегию: лонг при росте OI', sessionId: 'sess-accept-1' }),
    });
    const proposal = await firstRes.json() as { sessionId: string; pendingInteractionId?: string };
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHAT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pendingInteractionId: proposal.pendingInteractionId,
        sessionId: proposal.sessionId,
        decision: 'accept_as_is',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string };
    expect(body.kind).toBe('task_created');
  });
```

> Note: `appDeps()` uses `strategyCritic: null` (Task 3), so this proposal has no `preflightCritique`;
> `accept_as_is` still enqueues the original payload (the branch is exercised; the skip flag is only set
> when a critique is present — verified by the chat-handler tests above).

### Step 2 — Run, expect FAIL (RED)

```
pnpm vitest run src/chat/chat-handler.test.ts src/chat/chat-app.test.ts
```

Expected: the `confirm`/`accept_as_is` chat-handler tests FAIL — the enqueued payload `content` is the
original (not `'УЛУЧШЕННЫЙ ТЕКСТ'`) and `skipPreflightCritique` is `undefined`; the `accept_as_is`
app-test FAILS at the `/confirm` schema (400, `decision` not in the enum). NOT a type error.

### Step 3 — Implement (GREEN)

(a) `src/chat/confirmation-resolver.ts` — add the third reply value:

```ts
export type ConfirmationReply = 'confirm' | 'accept_as_is' | 'cancel' | 'unresolved';

const CONFIRM_PHRASES = new Set(['да', 'подтверждаю', 'подтвердить', 'подтвердить анализ', 'улучшить', 'улучшить и анализировать', '1']);
const ACCEPT_AS_IS_PHRASES = new Set(['как есть', 'анализировать как есть', 'оставить как есть', '2']);
const CANCEL_PHRASES = new Set(['нет', 'отмена', 'отменить', '0']);

function normalize(message: string): string {
  return message.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function resolveConfirmationReply(message: string): ConfirmationReply {
  const normalized = normalize(message);
  if (CONFIRM_PHRASES.has(normalized)) return 'confirm';
  if (ACCEPT_AS_IS_PHRASES.has(normalized)) return 'accept_as_is';
  if (CANCEL_PHRASES.has(normalized)) return 'cancel';
  return 'unresolved';
}
```

(b) `src/chat/request.ts` — extend the confirm schema enum:

```ts
export const ChatConfirmRequestSchema = z.object({
  pendingInteractionId: z.string().min(1),
  sessionId: z.string().min(1),
  decision: z.enum(['confirm', 'accept_as_is', 'cancel']),
});
```

(c) `src/chat/chat-handler.ts` — extend the `ConsumeConfirmationArgs` decision union:

```ts
export interface ConsumeConfirmationArgs {
  proposalId: string;
  decision: 'confirm' | 'accept_as_is' | 'cancel' | 'unresolved';
  session: ChatSessionContext;
}
```

(d) `src/chat/chat-handler.ts` — in `consumeConfirmation`, pass the chosen action through. The `cancel`
and `unresolved` early-returns are unchanged; after them, `decision` narrows to `'confirm' | 'accept_as_is'`.
Replace:

```ts
  const result = await deps.proposals.confirmPending(proposalId, sid, now());
  switch (result.kind) {
    case 'confirmed_now':
      return executeConfirmedProposal(result.proposal, session, deps, ev, now);
```

with:

```ts
  const result = await deps.proposals.confirmPending(proposalId, sid, now());
  switch (result.kind) {
    case 'confirmed_now':
      return executeConfirmedProposal(result.proposal, session, deps, ev, now, decision);
```

(e) `src/chat/chat-handler.ts` — `executeConfirmedProposal` takes the chosen action and resolves the
payload. Replace the signature:

```ts
async function executeConfirmedProposal(
  proposal: ActionProposal,
  session: ChatSessionContext,
  deps: ChatHandlerDeps,
  ev: (type: string, payload: Record<string, unknown>) => Promise<void>,
  now: () => string,
): Promise<ChatResponse> {
```

with:

```ts
async function executeConfirmedProposal(
  proposal: ActionProposal,
  session: ChatSessionContext,
  deps: ChatHandlerDeps,
  ev: (type: string, payload: Record<string, unknown>) => Promise<void>,
  now: () => string,
  chosenAction: 'confirm' | 'accept_as_is' = 'confirm',
): Promise<ChatResponse> {
```

and, inside `executeConfirmedProposal`, replace the `createAndEnqueueTask` call:

```ts
  const intake = await createAndEnqueueTask(
    {
      taskType: proposal.task.taskType,
      source: proposal.source,
      payload: proposal.task.payload,
      correlationId,
      dedupeKey: proposal.task.dedupeKey,
    },
    { repo: deps.researchTasks, queue: deps.queue },
  );
```

with:

```ts
  // Resolve which candidate text the analyst sees. A chat-time critique means the chat already ran the
  // critic, so set skipPreflightCritique:true (Task 2's worker honors it). confirm → improved text;
  // accept_as_is → the original payload.content. No critique → enqueue the payload unchanged.
  const critique = proposal.task.preflightCritique;
  const payload = critique
    ? {
        ...proposal.task.payload,
        content: chosenAction === 'accept_as_is' ? proposal.task.payload.content : critique.improvedStrategyText,
        skipPreflightCritique: true,
      }
    : proposal.task.payload;

  const intake = await createAndEnqueueTask(
    {
      taskType: proposal.task.taskType,
      source: proposal.source,
      payload,
      correlationId,
      dedupeKey: proposal.task.dedupeKey,
    },
    { repo: deps.researchTasks, queue: deps.queue },
  );
```

### Step 4 — Run, expect PASS (GREEN)

```
pnpm vitest run src/chat/chat-handler.test.ts src/chat/chat-app.test.ts
```

Expected: green.

### Step 5 — Full gate

```
pnpm typecheck && pnpm test
```

Expected: full suite green (includes `strip-types-no-param-properties.test.ts`).

### Step 6 — Commit

```
git commit -am "feat(chat): resolve confirm/accept_as_is/cancel for critique proposals; set skipPreflightCritique on enqueue"
```

---

## Self-Review

**Spec coverage** (every spec requirement → task):

| Spec item | Task |
|-----------|------|
| Critic at chat time (sync, fail-soft, before proposal) | 4 |
| Thread `strategyCritic` into `ChatHandlerDeps`/`ChatAppDeps` + composition | 3 |
| Proposal carries original + `improvedStrategyText` + critique summary | 4 (domain `preflightCritique` + `buildActionProposal`) |
| `assistant_message` lists severity + mainVulnerability + top-N vulnerabilities | 4 (`buildCritiqueMessage`) |
| Three `ProposedActionView`s `confirm`/`accept_as_is`/`cancel` | 4 (`CRITIQUE_ACTIONS`, `ProposedActionView.id`) |
| Fail-soft / disabled → existing two-action confirm | 4 (critic null/throw/invalid → `PENDING_ACTIONS`) |
| Confirm branching (`confirm`→improved, `accept_as_is`→original, `cancel`→none) | 5 |
| Both enqueue paths set `skipPreflightCritique:true` | 5 |
| `/chat/confirm` decision extended beyond `confirm`/`cancel` | 5 (`ChatConfirmRequestSchema`, `ConsumeConfirmationArgs`, resolver) |
| Worker skip on `skipPreflightCritique:true`; auto otherwise (unchanged) | 2 |
| Source-aware split at the worker boundary | 2 (flag) + 4 (chat sets `manual_description`, decision gate) |
| Enable-by-default env (`PREFLIGHT=true`, `MODE=single`, `MODEL=grok-4.3`) + `.env.example` + docker | 1 |
| Env ripple audit (tests asserting old defaults) | 1 (`env.test.ts`, `composition.strategy-critic.test.ts`) |
| Composition provides `strategyCritic` to chat deps | 3 (typecheck-gated + fixture test) |

**Out-of-scope (correctly excluded):** crawler/ingestion source (worker auto-path already handles it);
the office UI change for the third action (separate fast-follow); backtest-period HITL; analyst-model
work; removing `two_stage` (kept, just no longer default). **No spec requirement is unmapped.**

**Minor follow-ups (deferred — NOT tasks in this slice):**
- **Chat-critic cost / token accounting.** The chat-time `refine()` is called with **no `AgentCallOpts`**, so
  the chat critic's tokens / `$` cost are **not** accrued (no task / `correlationId` exists pre-enqueue). A
  follow-up if cost-aware accounting of the chat critic is wanted (ties to token-budget #86 / cost #87).
- **Office third-action (`accept_as_is`) send.** The office UI emitting the 3rd action is a deferred
  fast-follow; `confirm` / `cancel` already work today and `accept_as_is` is reachable via the lab API /
  typed reply even before the office UI catches up.

**Placeholder scan:** every step contains complete code — no "similar to Task N", no `…` ellipses in
code blocks, no TODO stubs. (Ellipses appear only in prose.)

**Type-consistency (identical spelling everywhere):**
- `skipPreflightCritique` — `StrategyAnalystInputSchema` (Task 2), handler gate `!input.skipPreflightCritique`
  (Task 2), `executeConfirmedProposal` payload (Task 5), tests (Tasks 2, 5). ✔ camelCase, identical.
- `accept_as_is` — `ProposedActionView.id` (Task 4), `CRITIQUE_ACTIONS` (Task 4), `ConfirmationReply`
  (Task 5), `ChatConfirmRequestSchema` enum (Task 5), `ConsumeConfirmationArgs.decision` (Task 5),
  `executeConfirmedProposal` `chosenAction` (Task 5), tests. ✔ snake_case, identical everywhere.
- `strategyCritic` — `ChatHandlerDeps` (Task 3), `composition.ts` chat literal + fixtures (Task 3),
  handler use `deps.strategyCritic` (Task 4); matches existing `AppServices.strategyCritic` /
  `services.strategyCritic`. ✔
- Proposal fields — `preflightCritique` + `PreflightCritiqueSummary{ improvedStrategyText, severity,
  mainVulnerability, vulnerabilities }` defined once in `domain/action-proposal.ts` (Task 4), read in
  `buildActionProposal` (Task 4), `executeConfirmedProposal` (Task 5), tests. ✔ Round-trips via JSONB
  `task` column — no migration, no repo edit (verified against `drizzle-action-proposal.repository.ts`
  `task: row.task` and `in-memory-action-proposal.repository.ts` `structuredClone`).
- Decision enum — `'confirm' | 'accept_as_is' | 'cancel'` (request schema) ⊂
  `'confirm' | 'accept_as_is' | 'cancel' | 'unresolved'` (`ConsumeConfirmationArgs` / `ConfirmationReply`).
  ✔ `/chat/confirm` never emits `unresolved` (structured); the typed reply path produces all four.

**Constraint conformance:** no TS parameter-properties introduced; all relative imports carry `.ts`;
every RED is an unresolved-import / runtime / assertion failure (vitest strip-types), never a tsc error;
type-only guarantees ride the `pnpm typecheck` gate; fail-soft preserved; office untouched; two-turn
flow reused (no new endpoint).
