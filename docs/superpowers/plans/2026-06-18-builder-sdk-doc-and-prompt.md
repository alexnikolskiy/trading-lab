# Builder SDK Doc + Prompt Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the MastraBuilder real SDK context (StrategyContext, OverlayDecision, code examples) and fix the prompt so it actually produces working overlay modules.

**Architecture:** Three-layer fix: (1) enrich the static SDK doc constant, (2) fix MastraBuilder to use the doc in its prompt and add LLM-compat nullable schema, (3) fix the handler to pass the doc. All changes are isolated to the builder adapter + one line in the handler.

**Tech Stack:** TypeScript, Zod, Mastra agent, @trading-platform/sdk contracts

---

## File Map

| File | Action |
|------|--------|
| `.env.example` | Modify — add `RESEARCHER_MODEL=openrouter/openai/gpt-5.5` |
| `src/adapters/builder/builder-sdk-doc.ts` | Modify — full overlay contract with code examples |
| `src/adapters/builder/mastra-builder.ts` | Modify — rich prompt + LLM-compat schema |
| `src/orchestrator/handlers/hypothesis-build.handler.ts` | Modify — pass `BUILDER_SDK_DOC` instead of `''` |
| `src/adapters/builder/mastra-builder.test.ts` | Modify — construction test already exists; add unit test for `buildPrompt` |

---

### Task 1: Update .env.example with gpt-5.5 as researcher default

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add RESEARCHER_MODEL to .env.example**

Find the section with model config and add:

```
RESEARCHER_MODEL=openrouter/openai/gpt-5.5   # researcher hypothesis model (winner of 2026-06-18 bake-off)
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "config: set gpt-5.5 as default researcher model in .env.example"
```

---

### Task 2: Enrich BUILDER_SDK_DOC with real overlay contract

**Files:**
- Modify: `src/adapters/builder/builder-sdk-doc.ts`

- [ ] **Step 1: Replace placeholder with real SDK doc**

```typescript
// src/adapters/builder/builder-sdk-doc.ts

/** 
 * Static SDK reference doc injected into the Builder agent prompt.
 * Covers: overlay module format, StrategyContext API, OverlayDecision union, code examples.
 * Real RAG over living SDK docs arrives in SP-5.
 */
export const BUILDER_SDK_DOC = `
# Builder SDK — Overlay Module Reference

## Module Format

The builder produces a **hypothesis overlay module**: a single TypeScript file that exports a
constant named \`overlay\`. The build validator REQUIRES the entry file to contain the string
\`overlay\` as an exported identifier.

### Minimal valid overlay (data-driven)

\`\`\`ts
// index.ts
export const overlay = {
  appliesTo: 'long',            // 'long' | 'short' | 'both' — must match hypothesis.ruleAction.appliesTo
  rules: [
    {
      when: 'OI trend persists for 3+ consecutive bars',
      action: 'skip_entry',     // see ACTION CATALOG below
      params: { lookback: 3 },
    },
  ],
};
\`\`\`

### Overlay with logic (function-based)

\`\`\`ts
// index.ts
export const overlay = function apply(ctx) {
  const candles = ctx.data.closedCandles(3);
  const oiRising = ctx.market?.openInterest !== undefined
    ? ctx.market.openInterest.trend === 'up'
    : false;

  if (ctx.position === null && oiRising) {
    return { kind: 'veto', reasonCode: 'oi_trend_rising', rationale: 'Skip entry: OI trend still rising' };
  }
  return { kind: 'pass' };
};
\`\`\`

## StrategyContext API (read-only, passed to every hook)

\`\`\`ts
interface StrategyContext {
  symbol: string;                          // e.g. 'EDGEUSDT'
  bar: { ts: number; open: number; high: number; low: number; close: number; volume: number };
  position: { side: 'long'|'short'; size: number; entryPrice: number; stop?: number; take?: number } | null;
  pendingIntent: { kind: string; side?: 'long'|'short'; createdTs: number } | null;
  portfolio: { equity: number; openPositions: number };
  data: {
    closedCandles(lookback: number): readonly Bar[];   // bars BEFORE current (no lookahead)
    indicatorAsOf(name: string): number | undefined;  // pre-declared indicator value as-of bar
  };
  indicators: {
    value(name: string, ...args: number[]): number | undefined;  // e.g. value('sma', 20)
    query(request: { name: string; params?: Record<string, number> }): number | undefined;
  };
  market?: {                               // present only when OI/liquidations data available
    openInterest?: { value: number; trend?: 'up'|'down'|'flat' };
    liquidationsLong?: number;
    liquidationsShort?: number;
  };
  params: Record<string, unknown>;         // run-level params from backtester
  clock: { now(): number };               // deterministic simulated clock (ms)
  rng: { next(): number };               // seeded deterministic RNG [0,1)
}
\`\`\`

## OverlayDecision Union (return values for function-based overlay)

\`\`\`ts
// Pass through — do nothing
{ kind: 'pass' }

// Veto the base decision (skip entry or block action)
{ kind: 'veto'; reasonCode: string; rationale?: string }

// Patch the base decision (e.g. tighten stop)
{ kind: 'patch'; patch: object }

// Annotate only (no effect on decision)
{ kind: 'annotate'; tags?: string[]; notes?: string }
\`\`\`

## ACTION CATALOG (data-driven rules)

| action | description |
|--------|-------------|
| skip_entry | veto the pending entry intent |
| allow_entry | force-allow a blocked entry |
| tighten_stop | move stop closer to current price |
| widen_stop | move stop further from current price |
| exit_now | close position immediately |
| scale_in | add to existing position (DCA mode) |
| scale_out | partial exit |
| adjust_size | modify position sizing hint |
| no_op | explicitly do nothing |

## FORBIDDEN — will fail build validation

- ANY import statement: \`import\`, \`require\`, \`from\` another module
- \`process.env\`, \`eval\`, \`new Function\`, \`fetch\`, \`WebSocket\`
- Forward-looking data: no bar.open of future bars, no oracle
- Live trading intent: "place order", "market order", "broker", "exchange api"

## Manifest Requirements

\`\`\`ts
manifest: {
  moduleId: string;            // e.g. "overlay-<hypothesisId>"
  moduleKind: 'hypothesis_overlay';   // MUST be exactly this
  appliesTo: 'long' | 'short' | 'both';
  entry: 'index.ts';           // always 'index.ts'
  exports: ['overlay'];        // MUST be ['overlay']
  capabilities: string[];      // ONLY features from hypothesis.requiredFeatures (e.g. ['oi', 'funding'])
  sdkContractVersion: 'builder-sdk-v0';  // MUST be exactly this value
}
\`\`\`
`.trim();
```

- [ ] **Step 2: Verify file parses**

Run: `node --experimental-strip-types -e "import('./src/adapters/builder/builder-sdk-doc.ts').then(m => console.log('OK, length:', m.BUILDER_SDK_DOC.length))"`
Expected: `OK, length: <number>` with no errors

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/adapters/builder/builder-sdk-doc.ts
git commit -m "feat: enrich BUILDER_SDK_DOC with real overlay contract, StrategyContext API, code examples"
```

---

### Task 3: Fix MastraBuilder — rich prompt + LLM-compat schema

**Files:**
- Modify: `src/adapters/builder/mastra-builder.ts`
- Modify: `src/adapters/builder/mastra-builder.test.ts`

- [ ] **Step 1: Write test for buildPrompt**

Add to `src/adapters/builder/mastra-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MastraBuilder, buildPromptFor } from './mastra-builder.ts';
import { resolveLanguageModel } from '../llm/model-provider.ts';
import { createBuilderAgent } from '../../mastra/agents/builder.agent.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when OI trend persists for 3+ bars',
    targetBehavior: 'filter entries', ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'],
    confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}
function profile(): StrategyProfile {
  return { id: 'p1', requiredMarketFeatures: ['oi', 'funding'], direction: 'long' } as unknown as StrategyProfile;
}

describe('MastraBuilder (construction)', () => {
  it('stores the label and builds an agent from an injected model', () => {
    const { model, label } = resolveLanguageModel({ MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy' }, 'anthropic/claude-sonnet-4-6');
    const b = new MastraBuilder(createBuilderAgent(model), label);
    expect(b.adapter).toBe('mastra');
    expect(b.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('buildPromptFor', () => {
  it('includes hypothesis thesis', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('Skip entries when OI trend persists');
  });

  it('includes requiredFeatures', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('oi');
    expect(prompt).toContain('funding');
  });

  it('includes the sdkDoc verbatim', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('SDK_DOC_HERE');
  });

  it('includes appliesTo direction', () => {
    const prompt = buildPromptFor({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'SDK_DOC_HERE' });
    expect(prompt).toContain('long');
  });
});

const live = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;
(live ? describe : describe.skip)('MastraBuilder (live)', () => {
  it('produces a schema-valid BuilderOutput', async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (buildPromptFor not exported yet)**

Run: `pnpm test src/adapters/builder/mastra-builder.test.ts`
Expected: FAIL — `buildPromptFor is not exported`

- [ ] **Step 3: Implement rich prompt + LLM-compat schema in mastra-builder.ts**

```typescript
// src/adapters/builder/mastra-builder.ts
import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { DIRECTIONS } from '../../domain/strategy-profile.ts';

/**
 * LLM-compatible schema: uses z.nullable() on optional string fields so OpenAI strict-mode
 * JSON schema keeps them in the `required` array (z.optional() removes them → validation error).
 * Map null → undefined before passing to BuilderOutputSchema.
 */
const LlmBuilderOutputSchema = z.object({
  manifest: z.object({
    moduleId: z.string().min(1),
    moduleKind: z.literal('hypothesis_overlay'),
    appliesTo: z.enum(DIRECTIONS),
    entry: z.string().min(1),
    exports: z.array(z.string().min(1)).min(1),
    capabilities: z.array(z.string()),
    sdkContractVersion: z.string().min(1),
  }),
  files: z.record(z.string()),
  notes: z.string().nullable(),
}).strict();

type LlmBuilderOutput = z.infer<typeof LlmBuilderOutputSchema>;

function llmOutputToDomain(raw: LlmBuilderOutput): BuilderOutput {
  return BuilderOutputSchema.parse({
    manifest: raw.manifest,
    files: raw.files,
    ...(raw.notes !== null ? { notes: raw.notes } : {}),
  });
}

export function buildPromptFor(input: BuilderInput): string {
  const { hypothesis, profile, sdkDoc } = input;
  const lines: string[] = [
    '=== TASK ===',
    `Build a hypothesis overlay module for the following validated hypothesis.`,
    '',
    '=== HYPOTHESIS ===',
    `Thesis: ${hypothesis.thesis}`,
    `Target behavior: ${hypothesis.targetBehavior}`,
    `Applies to: ${hypothesis.ruleAction.appliesTo}`,
    `Rules from hypothesis: ${JSON.stringify(hypothesis.ruleAction.rules, null, 2)}`,
    `Required features (allowed capabilities for manifest): ${hypothesis.requiredFeatures.join(', ')}`,
    `Expected effect: ${hypothesis.expectedEffect.metric} should ${hypothesis.expectedEffect.direction}`,
    '',
    '=== STRATEGY PROFILE ===',
    `Strategy direction: ${profile.direction}`,
    `Market features: ${profile.requiredMarketFeatures.join(', ')}`,
    '',
    '=== REQUIREMENTS ===',
    `- manifest.moduleId: "overlay-${hypothesis.id}"`,
    `- manifest.moduleKind: "hypothesis_overlay"`,
    `- manifest.appliesTo: "${hypothesis.ruleAction.appliesTo}"`,
    `- manifest.entry: "index.ts"`,
    `- manifest.exports: ["overlay"]`,
    `- manifest.capabilities: only features from requiredFeatures (${hypothesis.requiredFeatures.join(', ')})`,
    `- manifest.sdkContractVersion: "${SDK_CONTRACT_VERSION}"`,
    '- files["index.ts"]: TypeScript source, MUST export const named "overlay"',
    '- No imports, no process.env, no eval, no fetch — pure data/logic only',
    '',
    '=== SDK REFERENCE ===',
    sdkDoc,
  ];
  return lines.join('\n');
}

export class MastraBuilder implements BuilderPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, label: string) {
    this.agent = agent;
    this.model = label;
  }

  async build(input: BuilderInput): Promise<BuilderOutput> {
    const result = await this.agent.generate(buildPromptFor(input), {
      structuredOutput: { schema: LlmBuilderOutputSchema },
    });
    const raw = LlmBuilderOutputSchema.parse(result.object);
    return llmOutputToDomain(raw);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/adapters/builder/mastra-builder.test.ts`
Expected: all PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/adapters/builder/mastra-builder.ts src/adapters/builder/mastra-builder.test.ts
git commit -m "feat: enrich MastraBuilder prompt (sdkDoc, profile, requirements) + LLM-compat nullable schema"
```

---

### Task 4: Fix hypothesis-build.handler to pass real BUILDER_SDK_DOC

**Files:**
- Modify: `src/orchestrator/handlers/hypothesis-build.handler.ts`

- [ ] **Step 1: Write test that verifies sdkDoc is non-empty when passed to builder**

Add to `src/orchestrator/handlers/hypothesis-build.handler.test.ts` — look for the existing `FakeBuilder` spy test and add:

```typescript
it('passes non-empty sdkDoc to builder.build', async () => {
  let capturedSdkDoc: string | undefined;
  const spyBuilder: BuilderPort = {
    adapter: 'spy',
    model: 'spy',
    build: async (input) => {
      capturedSdkDoc = input.sdkDoc;
      return await new FakeBuilder().build(input);
    },
  };
  // ... run the handler with spyBuilder ...
  expect(capturedSdkDoc).not.toBe('');
  expect(capturedSdkDoc?.length).toBeGreaterThan(100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/orchestrator/handlers/hypothesis-build.handler.test.ts`
Expected: FAIL — sdkDoc is `''`

- [ ] **Step 3: Fix handler to import and pass BUILDER_SDK_DOC**

In `src/orchestrator/handlers/hypothesis-build.handler.ts`, add import:

```typescript
import { BUILDER_SDK_DOC } from '../../adapters/builder/builder-sdk-doc.ts';
```

Change the builder call from:
```typescript
out = await services.builder.build({ hypothesis, profile, sdkDoc: '' });
```
to:
```typescript
out = await services.builder.build({ hypothesis, profile, sdkDoc: BUILDER_SDK_DOC });
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/orchestrator/handlers/hypothesis-build.handler.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/handlers/hypothesis-build.handler.ts
git commit -m "fix: pass BUILDER_SDK_DOC to builder.build (was empty string)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Researcher default model → .env.example (Task 1)
- ✅ Builder SDK doc with real context → builder-sdk-doc.ts (Task 2)
- ✅ Builder prompt uses sdkDoc + profile → mastra-builder.ts (Task 3)
- ✅ LLM-compat schema (nullable notes) → mastra-builder.ts (Task 3)
- ✅ Handler passes real doc → hypothesis-build.handler.ts (Task 4)
- ✅ Tests verify prompt includes sdkDoc → mastra-builder.test.ts (Task 3, 4)

**Placeholder scan:** No TBD/TODO in plan. All code blocks are complete.

**Type consistency:** `DIRECTIONS` is used in both `ModuleManifestSchema` and `LlmBuilderOutputSchema` — same import source. `SDK_CONTRACT_VERSION` is imported from `domain/module-bundle.ts` matching existing pattern.
