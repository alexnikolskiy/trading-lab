# SP-4 Build & Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `validated` hypothesis into a `ModuleBundle` candidate, fast-fail-validate it, submit a mock backtest (Orchestrator-owned), and deterministically evaluate the comparison — all persisted.

**Architecture:** A synchronous `hypothesis.build` `WorkflowHandler` mirrors SP-3's `research.run_cycle`. Builder (fake+mastra) emits a draft bundle; `assembleBundle` computes the hash; a pure `validateBundle` fast-fails; the Orchestrator stores the artifact, submits via the Mock `PlatformGatewayPort`, normalizes a narrowed `ComparisonSummary`, and runs a pure `evaluateBacktest` ladder. Three new tables (`hypothesis_build`, `backtest_run`, `evaluation`) carry the lifecycle; `HypothesisProposal.status` is untouched. The lab NEVER executes generated code.

**Tech Stack:** TypeScript (ESM/NodeNext, `node --experimental-strip-types`), Zod, Drizzle ORM + drizzle-kit (Postgres), Vitest, Mastra `@mastra/core` + `@ai-sdk/anthropic`.

**Conventions (from SP-1…SP-3 — follow exactly):**
- NO TypeScript parameter properties (`constructor(private x)`) — explicit field + body assignment.
- All relative imports use explicit `.ts` extensions.
- `strict` + `noUncheckedIndexedAccess` ON — array index access needs `!` or a guard.
- Pure validators/evaluators are imported functions, not injected services.
- Run `pnpm typecheck` (must stay green) and `pnpm test` after each task before committing.
- `sha256:<hex>` content-addressing. Deterministic, locale-independent sorting via a `compareStrings` helper.

---

## File Structure

**Create:**
- `src/domain/module-bundle.ts` — `ModuleManifest`(+Schema), `ModuleBundle`, `assembleBundle`, contract versions.
- `src/validation/build-validator.ts` — pure `validateBundle` + `RESTRICTED_MODULE_SPECIFIERS` / `RESTRICTED_CODE_TOKENS`.
- `src/validation/evaluator.ts` — pure `evaluateBacktest`, `EvaluatorThresholds`, `DEFAULT_EVALUATOR_THRESHOLDS`.
- `src/ports/builder.port.ts` — `BuilderPort`, `BuilderInput`, `BuilderOutput`(+strict Schema).
- `src/adapters/builder/builder-sdk-doc.ts` — static `BUILDER_SDK_DOC` RAG fixture.
- `src/adapters/builder/fake-builder.ts` — deterministic `FakeBuilder`.
- `src/adapters/builder/mastra-builder.ts` — `MastraBuilder` (LLM).
- `src/domain/hypothesis-build.ts` — `HypothesisBuild`, `HypothesisBuildStatus`.
- `src/domain/backtest-run.ts` — `BacktestRun`, `BacktestRunStatus`, `BacktestCompletion`.
- `src/domain/evaluation.ts` — `Evaluation`.
- `src/ports/hypothesis-build.repository.ts`, `src/ports/backtest-run.repository.ts`, `src/ports/evaluation.repository.ts`.
- `src/adapters/repository/in-memory-hypothesis-build.repository.ts`, `…/in-memory-backtest-run.repository.ts`, `…/in-memory-evaluation.repository.ts`.
- `src/adapters/repository/drizzle-hypothesis-build.repository.ts`, `…/drizzle-backtest-run.repository.ts`, `…/drizzle-evaluation.repository.ts`.
- `src/orchestrator/handlers/hypothesis-build.handler.ts`.
- Test files alongside each (`*.test.ts`); `test/e2e/hypothesis-build.test.ts`.

**Modify:**
- `src/ports/platform-gateway.port.ts` — add `BacktestMetricBlock`, `ComparisonSummary`, `comparison?` on `ResearchRunEnvelope`.
- `src/adapters/platform/mock-platform-gateway.adapter.ts`, `…/fixture-platform-gateway.adapter.ts` — return `comparison`.
- `src/db/schema.ts` — 3 tables (+ `migrations/0003_*.sql`).
- `src/config/env.ts` — `BUILDER_ADAPTER`, `BUILDER_MODEL`, `evaluatorThresholds`.
- `src/orchestrator/app-services.ts` — `builder`, `builds`, `backtests`, `evaluations`, `evaluatorThresholds`.
- `src/composition.ts` — `buildBuilder`, drizzle repos, register `hypothesis.build`.
- `test/support/make-services.ts` — provide the new services.

---

## Task 1: ModuleBundle domain + assembleBundle

**Files:**
- Create: `src/domain/module-bundle.ts`
- Test: `src/domain/module-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/domain/module-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { assembleBundle, ModuleManifestSchema, MODULE_BUNDLE_CONTRACT_VERSION, SDK_CONTRACT_VERSION, type ModuleManifest } from './module-bundle.ts';

function manifest(over: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
    entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'],
    sdkContractVersion: SDK_CONTRACT_VERSION, ...over,
  };
}

describe('assembleBundle', () => {
  it('produces a sha256 bundleHash and the contract version', () => {
    const b = assembleBundle(manifest(), { 'index.ts': 'export const overlay = {};' });
    expect(b.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.bundleContractVersion).toBe(MODULE_BUNDLE_CONTRACT_VERSION);
  });

  it('is independent of manifest/files key order (canonical)', () => {
    const filesA = { 'a.ts': 'x', 'b.ts': 'y' };
    const filesB = { 'b.ts': 'y', 'a.ts': 'x' };
    const mA = manifest({ capabilities: ['oi', 'funding'] });
    const mB: ModuleManifest = { sdkContractVersion: SDK_CONTRACT_VERSION, capabilities: ['oi', 'funding'], exports: ['overlay'], entry: 'index.ts', appliesTo: 'long', moduleKind: 'hypothesis_overlay', moduleId: 'm1' };
    expect(assembleBundle(mA, filesA).bundleHash).toBe(assembleBundle(mB, filesB).bundleHash);
  });

  it('changes the hash when a file changes', () => {
    const h1 = assembleBundle(manifest(), { 'index.ts': 'export const overlay = {a:1};' }).bundleHash;
    const h2 = assembleBundle(manifest(), { 'index.ts': 'export const overlay = {a:2};' }).bundleHash;
    expect(h1).not.toBe(h2);
  });

  it('ignores any caller-supplied bundleHash (only manifest+files drive it)', () => {
    // assembleBundle has no hash parameter; the manifest schema forbids extra keys,
    // so a sneaked hash cannot reach the canonical input.
    const parsed = ModuleManifestSchema.safeParse({ ...manifest(), bundleHash: 'sha256:deadbeef' });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/domain/module-bundle.test.ts`
Expected: FAIL — `Cannot find module './module-bundle.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/module-bundle.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DIRECTIONS } from './strategy-profile.ts';

export const MODULE_BUNDLE_CONTRACT_VERSION = 'module-bundle-v1';
export const SDK_CONTRACT_VERSION = 'builder-sdk-v0';

export const ModuleManifestSchema = z.object({
  moduleId: z.string().min(1),
  moduleKind: z.literal('hypothesis_overlay'),
  appliesTo: z.enum(DIRECTIONS),
  entry: z.string().min(1),
  exports: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string()),
  sdkContractVersion: z.string().min(1),
}).strict();
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export interface ModuleBundle {
  manifest: ModuleManifest;
  files: Record<string, string>;
  bundleHash: string;
  bundleContractVersion: string;
}

/** Deterministic JSON with sorted object keys (so file paths and manifest keys
 *  canonicalize regardless of insertion order). No NUL separator needed — structural JSON is unambiguous. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Lab computes the hash; any caller-supplied hash is impossible to pass (no hash param). */
export function assembleBundle(manifest: ModuleManifest, files: Record<string, string>): ModuleBundle {
  const canonical = stableStringify({ manifest, files });
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { manifest, files, bundleHash: `sha256:${hex}`, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/domain/module-bundle.test.ts && pnpm typecheck`
Expected: PASS (4 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/module-bundle.ts src/domain/module-bundle.test.ts
git commit -m "feat(sp4): ModuleBundle domain + assembleBundle (lab-computed bundleHash)"
```

---

## Task 2: ComparisonSummary + envelope.comparison + gateway adapters

**Files:**
- Modify: `src/ports/platform-gateway.port.ts`
- Modify: `src/adapters/platform/mock-platform-gateway.adapter.ts`, `src/adapters/platform/fixture-platform-gateway.adapter.ts`
- Test: `src/adapters/platform/platform-gateway.adapter.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to the existing describe block)

```typescript
// add to src/adapters/platform/platform-gateway.adapter.test.ts
import { MockPlatformGatewayAdapter } from './mock-platform-gateway.adapter.ts';

describe('comparison summary (SP-4)', () => {
  it('mock getBacktestResult returns a typed ComparisonSummary with baseline+variant blocks', async () => {
    const mock = new MockPlatformGatewayAdapter();
    const ref = await mock.submitBacktest({ correlationId: 'c1', baselineModuleId: 'b', variantModuleId: 'v', params: {} });
    const env = await mock.getBacktestResult(ref);
    expect(env.comparison).toBeDefined();
    expect(env.comparison!.variant.netPnlUsd).toBeGreaterThan(env.comparison!.baseline.netPnlUsd);
    expect(env.comparison!.sampleSize.variantTrades).toBeGreaterThan(0);
    expect(typeof env.comparison!.variant.winRate).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/platform/platform-gateway.adapter.test.ts`
Expected: FAIL — `comparison` is `undefined` / not on type.

- [ ] **Step 3: Write minimal implementation**

In `src/ports/platform-gateway.port.ts`, add above `ResearchRunEnvelope` and extend it:

```typescript
export interface BacktestMetricBlock {
  netPnlUsd: number;
  netPnlPct: number;
  totalTrades: number;
  winRate: number;                 // 0..1
  profitFactor: number;
  maxDrawdownPct: number;          // positive magnitude; larger = worse
  expectancyUsd: number;
  sharpe: number;
  topTradeContributionPct: number; // 0..100
}

export interface ComparisonSummary {
  baseline: BacktestMetricBlock;
  variant: BacktestMetricBlock;
  sampleSize: { baselineTrades: number; variantTrades: number };
  platformContractVersion: string;
}
```

Add the optional field to `ResearchRunEnvelope`:

```typescript
export interface ResearchRunEnvelope {
  platformRunId: string;
  runStatus: 'completed' | 'rejected';
  metrics: Record<string, number>;
  artifactRefs: string[];
  platformContractVersion: string;
  comparison?: ComparisonSummary;   // SP-4 lab-side mock/fixture shape (aligned to platform in SP-5)
}
```

In `mock-platform-gateway.adapter.ts`, import `ComparisonSummary` (add to the existing type import) and return it from `getBacktestResult`. Define a private helper and use it:

```typescript
  private comparison(): ComparisonSummary {
    // Deterministic, strongly-improving variant → drives the e2e happy path to PAPER_CANDIDATE.
    return {
      baseline: { netPnlUsd: 100, netPnlPct: 1.0, totalTrades: 28, winRate: 0.50, profitFactor: 1.2, maxDrawdownPct: 7, expectancyUsd: 3.5, sharpe: 0.8, topTradeContributionPct: 20 },
      variant: { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.60, profitFactor: 2.0, maxDrawdownPct: 8, expectancyUsd: 8.3, sharpe: 1.4, topTradeContributionPct: 22 },
      sampleSize: { baselineTrades: 28, variantTrades: 30 },
      platformContractVersion: 'mock-0',
    };
  }

  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 250, total_trades: 30, win_rate: 0.6 },
      artifactRefs: [],
      platformContractVersion: 'mock-0',
      comparison: this.comparison(),
    };
  }
```

In `fixture-platform-gateway.adapter.ts`, similarly import `ComparisonSummary` and add `comparison` to the returned envelope (deterministic fixed values):

```typescript
  async getBacktestResult(ref: BacktestRunRef): Promise<ResearchRunEnvelope> {
    return {
      platformRunId: ref.platformRunId,
      runStatus: 'completed',
      metrics: { net_pnl_usd: 42, total_trades: 10, win_rate: 0.6 },
      artifactRefs: [],
      platformContractVersion: 'fixture-0',
      comparison: {
        baseline: { netPnlUsd: 30, netPnlPct: 0.3, totalTrades: 10, winRate: 0.5, profitFactor: 1.1, maxDrawdownPct: 6, expectancyUsd: 3, sharpe: 0.7, topTradeContributionPct: 25 },
        variant: { netPnlUsd: 42, netPnlPct: 0.42, totalTrades: 11, winRate: 0.6, profitFactor: 1.4, maxDrawdownPct: 6.5, expectancyUsd: 3.8, sharpe: 0.9, topTradeContributionPct: 28 },
        sampleSize: { baselineTrades: 10, variantTrades: 11 },
        platformContractVersion: 'fixture-0',
      },
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/platform/platform-gateway.adapter.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ports/platform-gateway.port.ts src/adapters/platform/mock-platform-gateway.adapter.ts src/adapters/platform/fixture-platform-gateway.adapter.ts src/adapters/platform/platform-gateway.adapter.test.ts
git commit -m "feat(sp4): typed ComparisonSummary + comparison on ResearchRunEnvelope (mock/fixture)"
```

---

## Task 3: Build Validator (pure, static-structural)

**Files:**
- Create: `src/validation/build-validator.ts`
- Test: `src/validation/build-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/validation/build-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateBundle } from './build-validator.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest, type ModuleBundle } from '../domain/module-bundle.ts';

const allowed = { allowedImports: new Set<string>(), allowedCapabilities: new Set<string>(['oi', 'funding']) };

function man(over: Partial<ModuleManifest> = {}): ModuleManifest {
  return { moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION, ...over };
}
function bundle(m: ModuleManifest, files: Record<string, string>): ModuleBundle {
  return assembleBundle(m, files);
}
const goodFiles = { 'index.ts': 'export const overlay = { rules: [] };' };

function codes(b: ModuleBundle) { return validateBundle(b, allowed).issues.map((i) => i.code); }

describe('validateBundle', () => {
  it('passes a clean bundle', () => {
    const r = validateBundle(bundle(man(), goodFiles), allowed);
    expect(r.status).toBe('built');
    expect(r.issues).toEqual([]);
  });

  it('manifest_invalid when a required field is empty', () => {
    expect(codes(bundle(man({ moduleId: '' }), goodFiles))).toContain('manifest_invalid');
  });

  it('disallowed_module_kind when kind is wrong', () => {
    const b = bundle({ ...man(), moduleKind: 'other' as unknown as 'hypothesis_overlay' }, goodFiles);
    expect(codes(b)).toContain('disallowed_module_kind');
  });

  it('missing_entry when entry file absent', () => {
    expect(codes(bundle(man({ entry: 'nope.ts' }), goodFiles))).toContain('missing_entry');
  });

  it('missing_export when export not present in entry source', () => {
    expect(codes(bundle(man({ exports: ['ghost'] }), goodFiles))).toContain('missing_export');
  });

  it('restricted_import on a code token (process.env)', () => {
    expect(codes(bundle(man(), { 'index.ts': 'export const overlay = {}; const x = process.env.SECRET;' }))).toContain('restricted_import');
  });

  it('restricted_import on a builtin module specifier (import from fs)', () => {
    expect(codes(bundle(man(), { 'index.ts': "import { readFileSync } from 'fs';\nexport const overlay = {};" }))).toContain('restricted_import');
  });

  it('restricted_import on a require of a builtin', () => {
    expect(codes(bundle(man(), { 'index.ts': "const cp = require('child_process');\nexport const overlay = {};" }))).toContain('restricted_import');
  });

  it('restricted_import on an import specifier outside the allowlist', () => {
    expect(codes(bundle(man(), { 'index.ts': "import x from 'left-pad';\nexport const overlay = {};" }))).toContain('restricted_import');
  });

  it('does NOT false-positive on a builtin substring inside an identifier or object key', () => {
    // 'offset' contains 'fs' and 'https' is a bare key — neither is an import, so neither is restricted.
    const r = validateBundle(bundle(man(), { 'index.ts': 'export const overlay = { offset: 1, https: false };' }), allowed);
    expect(r.status).toBe('built');
  });

  it('capability_violation when a declared capability is not allowed', () => {
    expect(codes(bundle(man({ capabilities: ['oi', 'leverage'] }), goodFiles))).toContain('capability_violation');
  });

  it('bundle_hash_mismatch when the hash does not match content', () => {
    const b = bundle(man(), goodFiles);
    const tampered: ModuleBundle = { ...b, bundleHash: 'sha256:0000' };
    expect(codes(tampered)).toContain('bundle_hash_mismatch');
  });

  it('sdk_contract_mismatch on a wrong sdk contract version', () => {
    expect(codes(bundle(man({ sdkContractVersion: 'builder-sdk-v9' }), goodFiles))).toContain('sdk_contract_mismatch');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/validation/build-validator.test.ts`
Expected: FAIL — `Cannot find module './build-validator.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/validation/build-validator.ts
import { assembleBundle, ModuleManifestSchema, SDK_CONTRACT_VERSION, type ModuleBundle } from '../domain/module-bundle.ts';
import type { ValidationIssue } from '../domain/schemas.ts';

export interface BuildValidation {
  status: 'built' | 'build_failed';
  issues: ValidationIssue[];
}

/** Non-authoritative fast-fail scan (the platform sandbox 019 is the real boundary).
 *  Builtins are matched on import / dynamic-import / require SPECIFIERS only — NOT a whole-file
 *  substring scan — so 'fs' inside 'offset' or a bare 'https' key never false-positives.
 *  The global-ish tokens below stay a text scan (per spec refinement). */
export const RESTRICTED_MODULE_SPECIFIERS = [
  'fs', 'node:fs', 'child_process', 'node:child_process', 'net', 'node:net',
  'http', 'node:http', 'https', 'node:https',
];
export const RESTRICTED_CODE_TOKENS = ['process.env', 'eval', 'new Function', 'fetch', 'WebSocket'];
const RESTRICTED_MODULE_SET = new Set<string>(RESTRICTED_MODULE_SPECIFIERS);

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateBundle(
  bundle: ModuleBundle,
  ctx: { allowedImports: Set<string>; allowedCapabilities: Set<string> },
): BuildValidation {
  const issues: ValidationIssue[] = [];
  const m = bundle.manifest;

  const parsed = ModuleManifestSchema.safeParse(m);
  if (!parsed.success) {
    issues.push({ code: 'manifest_invalid', severity: 'error', path: 'manifest', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  if (m.moduleKind !== 'hypothesis_overlay') {
    issues.push({ code: 'disallowed_module_kind', severity: 'error', path: 'manifest.moduleKind', message: `moduleKind '${m.moduleKind}' is not allowed` });
  }

  const entrySource = bundle.files[m.entry];
  if (entrySource === undefined) {
    issues.push({ code: 'missing_entry', severity: 'error', path: 'manifest.entry', message: `entry file '${m.entry}' not present in bundle files` });
  } else {
    m.exports.forEach((exp, i) => {
      if (!entrySource.includes(exp)) {
        issues.push({ code: 'missing_export', severity: 'error', path: `manifest.exports.${i}`, message: `export '${exp}' not found in entry source` });
      }
    });
  }

  for (const [path, source] of Object.entries(bundle.files)) {
    const tokenHits = RESTRICTED_CODE_TOKENS.filter((t) => source.includes(t));
    if (tokenHits.length > 0) {
      issues.push({ code: 'restricted_import', severity: 'error', path: `files.${path}`, message: `restricted code tokens: ${tokenHits.join(', ')}` });
    }
    // Builtins + allowlist are matched on module SPECIFIERS only (import / dynamic import / require).
    const re = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g;
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(source)) !== null) {
      const spec = mt[1]!;
      if (RESTRICTED_MODULE_SET.has(spec)) {
        issues.push({ code: 'restricted_import', severity: 'error', path: `files.${path}`, message: `restricted module import: ${spec}` });
      } else if (!ctx.allowedImports.has(spec)) {
        issues.push({ code: 'restricted_import', severity: 'error', path: `files.${path}`, message: `import not allowed: ${spec}` });
      }
    }
  }

  m.capabilities.forEach((cap, i) => {
    if (!ctx.allowedCapabilities.has(cap)) {
      issues.push({ code: 'capability_violation', severity: 'error', path: `manifest.capabilities.${i}`, message: `capability '${cap}' is not allowed` });
    }
  });

  const recomputed = assembleBundle(m, bundle.files).bundleHash;
  if (recomputed !== bundle.bundleHash) {
    issues.push({ code: 'bundle_hash_mismatch', severity: 'error', path: 'bundleHash', message: 'bundleHash does not match content' });
  }
  if (m.sdkContractVersion !== SDK_CONTRACT_VERSION) {
    issues.push({ code: 'sdk_contract_mismatch', severity: 'error', path: 'manifest.sdkContractVersion', message: `expected ${SDK_CONTRACT_VERSION}, got ${m.sdkContractVersion}` });
  }

  issues.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.code, b.code));
  const status = issues.some((i) => i.severity === 'error') ? 'build_failed' : 'built';
  return { status, issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/validation/build-validator.test.ts && pnpm typecheck`
Expected: PASS (13 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/validation/build-validator.ts src/validation/build-validator.test.ts
git commit -m "feat(sp4): static-structural Build Validator (fast-fail, not a security boundary)"
```

---

## Task 4: Evaluator (pure ladder)

**Files:**
- Create: `src/validation/evaluator.ts`
- Test: `src/validation/evaluator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/validation/evaluator.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateBacktest, DEFAULT_EVALUATOR_THRESHOLDS } from './evaluator.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../ports/platform-gateway.port.ts';

function block(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return { netPnlUsd: 100, netPnlPct: 1, totalTrades: 30, winRate: 0.5, profitFactor: 1.2, maxDrawdownPct: 7, expectancyUsd: 3, sharpe: 0.8, topTradeContributionPct: 20, ...over };
}
function summary(baseline: BacktestMetricBlock, variant: BacktestMetricBlock): ComparisonSummary {
  return { baseline, variant, sampleSize: { baselineTrades: baseline.totalTrades, variantTrades: variant.totalTrades }, platformContractVersion: 'test-0' };
}
const T = DEFAULT_EVALUATOR_THRESHOLDS;

describe('evaluateBacktest', () => {
  it('INCONCLUSIVE when variant trades below minTrades', () => {
    const r = evaluateBacktest(summary(block(), block({ totalTrades: T.minTrades - 1, netPnlUsd: 9999 })), T);
    expect(r.decision).toBe('INCONCLUSIVE');
  });

  it('FAIL when no improvement over baseline', () => {
    const r = evaluateBacktest(summary(block({ netPnlUsd: 100 }), block({ netPnlUsd: 100 })), T);
    expect(r.decision).toBe('FAIL');
  });

  it('MODIFY on drawdown regression beyond tolerance', () => {
    const r = evaluateBacktest(summary(block({ maxDrawdownPct: 7 }), block({ netPnlUsd: 200, maxDrawdownPct: 7 + T.maxDrawdownTolerancePct + 0.1 })), T);
    expect(r.decision).toBe('MODIFY');
    expect(r.reasons).toContain('drawdown_regression');
  });

  it('MODIFY on fragile pnl (top-trade contribution at/over threshold)', () => {
    const r = evaluateBacktest(summary(block(), block({ netPnlUsd: 200, topTradeContributionPct: T.fragilityTopTradePct })), T);
    expect(r.decision).toBe('MODIFY');
    expect(r.reasons).toContain('fragile_pnl');
  });

  it('PAPER_CANDIDATE on a strong, robust edge', () => {
    const r = evaluateBacktest(summary(block({ winRate: 0.5 }), block({ netPnlUsd: 100 + T.strongPnlDeltaUsd, profitFactor: T.minProfitFactor, winRate: 0.6 })), T);
    expect(r.decision).toBe('PAPER_CANDIDATE');
  });

  it('PASS on a modest positive edge', () => {
    const r = evaluateBacktest(summary(block({ netPnlUsd: 100 }), block({ netPnlUsd: 150, profitFactor: 1.3 })), T);
    expect(r.decision).toBe('PASS');
  });

  it('strong-edge but lower winRate than baseline → PASS, not PAPER_CANDIDATE', () => {
    const r = evaluateBacktest(summary(block({ winRate: 0.7 }), block({ netPnlUsd: 100 + T.strongPnlDeltaUsd, profitFactor: T.minProfitFactor, winRate: 0.6 })), T);
    expect(r.decision).toBe('PASS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/validation/evaluator.test.ts`
Expected: FAIL — `Cannot find module './evaluator.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/validation/evaluator.ts
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';

export type EvaluationDecision = 'PASS' | 'MODIFY' | 'FAIL' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface EvaluatorThresholds {
  minTrades: number;
  minPnlDeltaUsd: number;
  maxDrawdownTolerancePct: number;
  fragilityTopTradePct: number;
  strongPnlDeltaUsd: number;
  minProfitFactor: number;
}

export const DEFAULT_EVALUATOR_THRESHOLDS: EvaluatorThresholds = {
  minTrades: 20,
  minPnlDeltaUsd: 0,
  maxDrawdownTolerancePct: 2.0,
  fragilityTopTradePct: 50,
  strongPnlDeltaUsd: 100,
  minProfitFactor: 1.5,
};

export interface EvaluationOutcome {
  decision: EvaluationDecision;
  reasons: string[];
}

/** Deterministic first-match ladder. Math: positive maxDrawdownPct = worse. */
export function evaluateBacktest(summary: ComparisonSummary, t: EvaluatorThresholds): EvaluationOutcome {
  const { baseline, variant } = summary;
  const deltaNetPnlUsd = variant.netPnlUsd - baseline.netPnlUsd;
  const deltaMaxDrawdownPct = variant.maxDrawdownPct - baseline.maxDrawdownPct;
  const fragile = variant.topTradeContributionPct >= t.fragilityTopTradePct;

  if (variant.totalTrades < t.minTrades) return { decision: 'INCONCLUSIVE', reasons: ['insufficient_sample'] };
  if (deltaNetPnlUsd <= t.minPnlDeltaUsd) return { decision: 'FAIL', reasons: ['no_improvement_over_baseline'] };
  if (deltaMaxDrawdownPct > t.maxDrawdownTolerancePct) return { decision: 'MODIFY', reasons: ['drawdown_regression'] };
  if (fragile) return { decision: 'MODIFY', reasons: ['fragile_pnl'] };
  if (deltaNetPnlUsd >= t.strongPnlDeltaUsd && variant.profitFactor >= t.minProfitFactor && variant.winRate >= baseline.winRate) {
    return { decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'] };
  }
  return { decision: 'PASS', reasons: ['positive_edge'] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/validation/evaluator.test.ts && pnpm typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/validation/evaluator.ts src/validation/evaluator.test.ts
git commit -m "feat(sp4): deterministic Evaluator ladder + thresholds"
```

---

## Task 5: Builder port + FakeBuilder + SDK-doc fixture

**Files:**
- Create: `src/ports/builder.port.ts`, `src/adapters/builder/builder-sdk-doc.ts`, `src/adapters/builder/fake-builder.ts`
- Test: `src/adapters/builder/fake-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/adapters/builder/fake-builder.test.ts
import { describe, it, expect } from 'vitest';
import { FakeBuilder } from './fake-builder.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';
import { assembleBundle, SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { validateBundle } from '../../validation/build-validator.ts';
import { LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';

function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when oi trend persists',
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

describe('FakeBuilder', () => {
  it('produces a strict-schema-valid BuilderOutput', async () => {
    const out = await new FakeBuilder().build({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'doc' });
    expect(BuilderOutputSchema.safeParse(out).success).toBe(true);
  });

  it('produces a bundle that passes the Build Validator', async () => {
    const out = await new FakeBuilder().build({ hypothesis: hypothesis(), profile: profile(), sdkDoc: 'doc' });
    const bundle = assembleBundle(out.manifest, out.files);
    const allowed = { allowedImports: new Set<string>(), allowedCapabilities: new Set<string>([...LAB_FEATURE_CATALOG, 'oi', 'funding']) };
    const r = validateBundle(bundle, allowed);
    expect(r.status).toBe('built');
    expect(out.manifest.sdkContractVersion).toBe(SDK_CONTRACT_VERSION);
  });

  it('strict schema rejects an extra top-level key (no trusted LLM hash)', () => {
    const bad = { manifest: { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: [], sdkContractVersion: SDK_CONTRACT_VERSION }, files: {}, bundleHash: 'sha256:evil' };
    expect(BuilderOutputSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/builder/fake-builder.test.ts`
Expected: FAIL — `Cannot find module '../../ports/builder.port.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ports/builder.port.ts
import { z } from 'zod';
import { ModuleManifestSchema } from '../domain/module-bundle.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';

export interface BuilderInput {
  hypothesis: HypothesisProposal;
  profile: StrategyProfile;
  sdkDoc: string;
}

/** Strict: an LLM cannot smuggle extra trusted fields (e.g. a bundleHash). */
export const BuilderOutputSchema = z.object({
  manifest: ModuleManifestSchema,
  files: z.record(z.string()),
  notes: z.string().optional(),
}).strict();
export type BuilderOutput = z.infer<typeof BuilderOutputSchema>;

export interface BuilderPort {
  readonly adapter: string;
  readonly model: string;
  build(input: BuilderInput): Promise<BuilderOutput>;
}
```

```typescript
// src/adapters/builder/builder-sdk-doc.ts
/** Static RAG fixture (placeholder for Builder SDK 021 docs; real RAG arrives in SP-5). */
export const BUILDER_SDK_DOC = [
  'Builder SDK (overlay modules):',
  '- Export a const named `overlay` with { appliesTo, rules } from the entry file.',
  '- rules: array of { when, action, params } where action is an allowed overlay action.',
  '- No imports, no network, no filesystem, no process access. Pure data + logic only.',
  '- The module is research-only and never places live orders.',
].join('\n');
```

```typescript
// src/adapters/builder/fake-builder.ts
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { normalizeFeature } from '../../domain/hypothesis-rules.ts';

/** Deterministic stub: templates a clean overlay module from the hypothesis ruleAction.
 *  Emits no imports / denylist tokens, so it always passes the Build Validator. No network. */
export class FakeBuilder implements BuilderPort {
  readonly adapter = 'fake' as const;
  readonly model = 'fake';

  async build(input: BuilderInput): Promise<BuilderOutput> {
    const { hypothesis } = input;
    const overlay = { appliesTo: hypothesis.ruleAction.appliesTo, rules: hypothesis.ruleAction.rules };
    const source = `export const overlay = ${JSON.stringify(overlay)};\n`;
    return {
      manifest: {
        moduleId: `overlay-${hypothesis.id}`,
        moduleKind: 'hypothesis_overlay',
        appliesTo: hypothesis.ruleAction.appliesTo,
        entry: 'index.ts',
        exports: ['overlay'],
        capabilities: hypothesis.requiredFeatures.map(normalizeFeature),
        sdkContractVersion: SDK_CONTRACT_VERSION,
      },
      files: { 'index.ts': source },
      notes: 'fake builder template',
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/builder/fake-builder.test.ts && pnpm typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ports/builder.port.ts src/adapters/builder/builder-sdk-doc.ts src/adapters/builder/fake-builder.ts src/adapters/builder/fake-builder.test.ts
git commit -m "feat(sp4): BuilderPort + strict BuilderOutput + FakeBuilder + SDK-doc fixture"
```

---

## Task 6: MastraBuilder (LLM)

**Files:**
- Create: `src/adapters/builder/mastra-builder.ts`
- Test: `src/adapters/builder/mastra-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/adapters/builder/mastra-builder.test.ts
import { describe, it, expect } from 'vitest';
import { MastraBuilder } from './mastra-builder.ts';

describe('MastraBuilder (construction)', () => {
  it('exposes adapter/model and rejects non-Anthropic models', () => {
    const b = new MastraBuilder('anthropic/claude-sonnet-4-6');
    expect(b.adapter).toBe('mastra');
    expect(b.model).toBe('anthropic/claude-sonnet-4-6');
    expect(() => new MastraBuilder('openai/gpt-4o')).toThrow(/only supports Anthropic/);
  });
});

const live = process.env.RUN_LLM_TESTS === 'true' && !!process.env.ANTHROPIC_API_KEY;
(live ? describe : describe.skip)('MastraBuilder (live)', () => {
  it('produces a schema-valid BuilderOutput', async () => {
    // Live smoke test; only runs with RUN_LLM_TESTS=true + ANTHROPIC_API_KEY.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/builder/mastra-builder.test.ts`
Expected: FAIL — `Cannot find module './mastra-builder.ts'`.

- [ ] **Step 3: Write minimal implementation** (mirrors `MastraResearcher`)

```typescript
// src/adapters/builder/mastra-builder.ts
import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import { BuilderOutputSchema } from '../../ports/builder.port.ts';
import { SDK_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { BUILDER_SDK_DOC } from './builder-sdk-doc.ts';

const INSTRUCTIONS = [
  'You are a module builder for a research-only trading lab.',
  'Given a validated hypothesis, emit a hypothesis_overlay ModuleBundle draft (manifest + files).',
  'The entry file MUST export a const named `overlay`. Use NO imports, NO network, NO filesystem,',
  'NO process access, NO eval. Pure data and logic only. This code is never executed in the lab.',
  `Set manifest.sdkContractVersion to '${SDK_CONTRACT_VERSION}' and manifest.moduleKind to 'hypothesis_overlay'.`,
  'Declare only capabilities that appear in the hypothesis required features.',
  'Do NOT include a bundleHash — the lab computes it.',
  `SDK reference:\n${BUILDER_SDK_DOC}`,
].join(' ');

function buildPrompt(input: BuilderInput): string {
  return [
    `Hypothesis thesis: ${input.hypothesis.thesis}`,
    `Applies to: ${input.hypothesis.ruleAction.appliesTo}`,
    `Rules: ${JSON.stringify(input.hypothesis.ruleAction.rules)}`,
    `Required features (allowed capabilities): ${input.hypothesis.requiredFeatures.join(', ')}`,
    'Produce manifest.entry = "index.ts" and manifest.exports = ["overlay"].',
  ].join('\n');
}

export class MastraBuilder implements BuilderPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(model: string) {
    this.model = model;
    const bareModelId = model.replace(/^anthropic\//, '');
    if (bareModelId.includes('/')) {
      throw new Error(`MastraBuilder only supports Anthropic models; got '${model}'`);
    }
    this.agent = new Agent({ id: 'builder', name: 'Builder', instructions: INSTRUCTIONS, model: anthropic(bareModelId) });
  }

  async build(input: BuilderInput): Promise<BuilderOutput> {
    const result = await this.agent.generate(buildPrompt(input), { structuredOutput: { schema: BuilderOutputSchema } });
    return BuilderOutputSchema.parse(result.object);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/builder/mastra-builder.test.ts && pnpm typecheck`
Expected: PASS (1 run, 1 skipped), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/builder/mastra-builder.ts src/adapters/builder/mastra-builder.test.ts
git commit -m "feat(sp4): MastraBuilder (LLM, Anthropic-only, structured output)"
```

---

## Task 7: HypothesisBuild domain + repository (port + in-memory)

**Files:**
- Create: `src/domain/hypothesis-build.ts`, `src/ports/hypothesis-build.repository.ts`, `src/adapters/repository/in-memory-hypothesis-build.repository.ts`
- Test: `src/adapters/repository/in-memory-hypothesis-build.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/adapters/repository/in-memory-hypothesis-build.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisBuildRepository } from './in-memory-hypothesis-build.repository.ts';
import { SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ArtifactRef } from '../../domain/types.ts';

function build(id: string): HypothesisBuild {
  const now = '2026-01-01T00:00:00Z';
  return {
    id, hypothesisId: 'h1', strategyProfileId: 'p1', status: 'generating',
    builderAdapter: 'fake', builderModel: 'fake', bundleHash: null, bundleArtifactRef: null,
    manifest: null, sdkContractVersion: SDK_CONTRACT_VERSION, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION,
    issues: [], attempt: 1, createdAt: now, updatedAt: now,
  };
}
const manifest: ModuleManifest = { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION };
const ref: ArtifactRef = { artifact_id: 'a1', uri: 'file://a', content_hash: 'sha256:x', kind: 'module_bundle', size_bytes: 1, mime_type: 'application/json', created_at: '2026-01-01T00:00:00Z', producer: 'builder', metadata: {} };

describe('InMemoryHypothesisBuildRepository', () => {
  it('createGenerating then findById returns the row', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    expect((await repo.findById('b1'))?.status).toBe('generating');
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await expect(repo.createGenerating(build('b1'))).rejects.toThrow(/already exists/);
  });

  it('markBuildFailed sets status + issues', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await repo.markBuildFailed('b1', [{ code: 'builder_failed', severity: 'error', path: 'builder', message: 'boom' }]);
    const row = await repo.findById('b1');
    expect(row?.status).toBe('build_failed');
    expect(row?.issues[0]?.code).toBe('builder_failed');
  });

  it('markCandidate sets candidate + bundle fields', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await repo.markCandidate('b1', { bundleHash: 'sha256:zz', bundleArtifactRef: ref, manifest });
    const row = await repo.findById('b1');
    expect(row?.status).toBe('candidate');
    expect(row?.bundleHash).toBe('sha256:zz');
    expect(row?.manifest?.moduleId).toBe('m');
  });

  it('markSubmitted sets submitted', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await repo.markSubmitted('b1');
    expect((await repo.findById('b1'))?.status).toBe('submitted');
  });

  it('listByHypothesis filters by hypothesisId', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    expect(await repo.listByHypothesis('h1')).toHaveLength(1);
    expect(await repo.listByHypothesis('other')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/in-memory-hypothesis-build.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/hypothesis-build.ts
import type { ModuleManifest } from './module-bundle.ts';
import type { ArtifactRef } from './types.ts';
import type { ValidationIssue } from './schemas.ts';

export type HypothesisBuildStatus = 'generating' | 'build_failed' | 'candidate' | 'submitted';

export interface HypothesisBuild {
  id: string;
  hypothesisId: string;
  strategyProfileId: string;
  status: HypothesisBuildStatus;
  builderAdapter: string;
  builderModel: string;
  bundleHash: string | null;
  bundleArtifactRef: ArtifactRef | null;
  manifest: ModuleManifest | null;
  sdkContractVersion: string;
  bundleContractVersion: string;
  issues: ValidationIssue[];
  attempt: number;
  createdAt: string;
  updatedAt: string;
}
```

```typescript
// src/ports/hypothesis-build.repository.ts
import type { HypothesisBuild } from '../domain/hypothesis-build.ts';
import type { ModuleManifest } from '../domain/module-bundle.ts';
import type { ArtifactRef } from '../domain/types.ts';
import type { ValidationIssue } from '../domain/schemas.ts';

export interface HypothesisBuildRepository {
  createGenerating(build: HypothesisBuild): Promise<void>;
  markBuildFailed(id: string, issues: ValidationIssue[]): Promise<void>;
  markCandidate(id: string, fields: { bundleHash: string; bundleArtifactRef: ArtifactRef; manifest: ModuleManifest }): Promise<void>;
  markSubmitted(id: string): Promise<void>;
  findById(id: string): Promise<HypothesisBuild | null>;
  listByHypothesis(hypothesisId: string): Promise<HypothesisBuild[]>;
}
```

```typescript
// src/adapters/repository/in-memory-hypothesis-build.repository.ts
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ModuleManifest } from '../../domain/module-bundle.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisBuildRepository } from '../../ports/hypothesis-build.repository.ts';

export class InMemoryHypothesisBuildRepository implements HypothesisBuildRepository {
  private readonly byId = new Map<string, HypothesisBuild>();

  async createGenerating(build: HypothesisBuild): Promise<void> {
    if (this.byId.has(build.id)) throw new Error(`hypothesis_build already exists: ${build.id}`);
    this.byId.set(build.id, { ...build });
  }

  private patch(id: string, patch: Partial<HypothesisBuild>): void {
    const row = this.byId.get(id);
    if (!row) throw new Error(`hypothesis_build not found: ${id}`);
    this.byId.set(id, { ...row, ...patch, updatedAt: new Date().toISOString() });
  }

  async markBuildFailed(id: string, issues: ValidationIssue[]): Promise<void> {
    this.patch(id, { status: 'build_failed', issues });
  }

  async markCandidate(id: string, fields: { bundleHash: string; bundleArtifactRef: ArtifactRef; manifest: ModuleManifest }): Promise<void> {
    this.patch(id, { status: 'candidate', bundleHash: fields.bundleHash, bundleArtifactRef: fields.bundleArtifactRef, manifest: fields.manifest });
  }

  async markSubmitted(id: string): Promise<void> {
    this.patch(id, { status: 'submitted' });
  }

  async findById(id: string): Promise<HypothesisBuild | null> {
    return this.byId.get(id) ?? null;
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisBuild[]> {
    return [...this.byId.values()].filter((b) => b.hypothesisId === hypothesisId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/repository/in-memory-hypothesis-build.repository.test.ts && pnpm typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/hypothesis-build.ts src/ports/hypothesis-build.repository.ts src/adapters/repository/in-memory-hypothesis-build.repository.ts src/adapters/repository/in-memory-hypothesis-build.repository.test.ts
git commit -m "feat(sp4): HypothesisBuild domain + repository port + in-memory adapter"
```

---

## Task 8: BacktestRun domain + repository (port + in-memory)

**Files:**
- Create: `src/domain/backtest-run.ts`, `src/ports/backtest-run.repository.ts`, `src/adapters/repository/in-memory-backtest-run.repository.ts`
- Test: `src/adapters/repository/in-memory-backtest-run.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/adapters/repository/in-memory-backtest-run.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryBacktestRunRepository } from './in-memory-backtest-run.repository.ts';
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';

function metricBlock(over: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock {
  return { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22, ...over };
}
function run(id: string, over: Partial<BacktestRun> = {}): BacktestRun {
  const now = '2026-01-01T00:00:00Z';
  return {
    id, hypothesisBuildId: 'b1', hypothesisId: 'h1', strategyProfileId: 'p1',
    platformRunId: 'mock-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh',
    status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1',
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: 'builder-sdk-v0',
    submittedAt: now, finishedAt: null, createdAt: now, updatedAt: now, ...over,
  };
}
function completion(): BacktestCompletion {
  return { metrics: metricBlock(), baselineMetrics: metricBlock({ netPnlUsd: 100, winRate: 0.5, maxDrawdownPct: 7 }), deltaNetPnlUsd: 150, deltaMaxDrawdownPct: 1, isFragile: false, artifactRefs: [], platformContractVersion: 'mock-0', finishedAt: '2026-01-02T00:00:00Z' };
}

describe('InMemoryBacktestRunRepository', () => {
  it('createSubmitted then findById', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    expect((await repo.findById('r1'))?.status).toBe('submitted');
  });

  it('throws on duplicate (hypothesisId, paramsHash, bundleHash)', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await expect(repo.createSubmitted(run('r2'))).rejects.toThrow(/already exists for/);
  });

  it('allows a new bundle_hash for the same hypothesis + params', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await repo.createSubmitted(run('r2', { bundleHash: 'sha256:other' }));
    expect(await repo.listByHypothesis('h1')).toHaveLength(2);
  });

  it('markCompleted writes metrics + deltas', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await repo.markCompleted('r1', completion());
    const row = await repo.findById('r1');
    expect(row?.status).toBe('completed');
    expect(row?.metrics?.netPnlUsd).toBe(250);
    expect(row?.deltaNetPnlUsd).toBe(150);
    expect(row?.isFragile).toBe(false);
  });

  it('markEvaluated / markRejected / markFailed set status', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    await repo.markEvaluated('r1');
    expect((await repo.findById('r1'))?.status).toBe('evaluated');
    await repo.createSubmitted(run('r2', { bundleHash: 'sha256:b2' }));
    await repo.markRejected('r2');
    expect((await repo.findById('r2'))?.status).toBe('rejected');
    await repo.createSubmitted(run('r3', { bundleHash: 'sha256:b3' }));
    await repo.markFailed('r3');
    expect((await repo.findById('r3'))?.status).toBe('failed');
  });

  it('findByIdentity returns the matching run or null', async () => {
    const repo = new InMemoryBacktestRunRepository();
    await repo.createSubmitted(run('r1'));
    expect((await repo.findByIdentity('h1', 'sha256:p', 'sha256:bh'))?.id).toBe('r1');
    expect(await repo.findByIdentity('h1', 'sha256:p', 'sha256:other')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/in-memory-backtest-run.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/backtest-run.ts
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';

export type BacktestRunStatus = 'queued' | 'submitted' | 'running' | 'completed' | 'rejected' | 'failed' | 'evaluated';

export interface BacktestRun {
  id: string;
  hypothesisBuildId: string;
  hypothesisId: string;
  strategyProfileId: string;
  platformRunId: string;
  correlationId: string;
  params: Record<string, unknown>;
  paramsHash: string;
  bundleHash: string;
  status: BacktestRunStatus;
  baselineModuleId: string;
  variantModuleId: string;
  metrics: BacktestMetricBlock | null;          // variant
  baselineMetrics: BacktestMetricBlock | null;
  deltaNetPnlUsd: number | null;
  deltaMaxDrawdownPct: number | null;
  isFragile: boolean | null;
  artifactRefs: string[];                        // opaque platform refs (SP-4)
  platformContractVersion: string;
  sdkContractVersion: string;
  submittedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BacktestCompletion {
  metrics: BacktestMetricBlock;
  baselineMetrics: BacktestMetricBlock;
  deltaNetPnlUsd: number;
  deltaMaxDrawdownPct: number;
  isFragile: boolean;
  artifactRefs: string[];
  platformContractVersion: string;
  finishedAt: string;
}
```

```typescript
// src/ports/backtest-run.repository.ts
import type { BacktestRun, BacktestCompletion } from '../domain/backtest-run.ts';

export interface BacktestRunRepository {
  createSubmitted(run: BacktestRun): Promise<void>;
  markCompleted(id: string, completion: BacktestCompletion): Promise<void>;
  markRejected(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  markEvaluated(id: string): Promise<void>;
  findById(id: string): Promise<BacktestRun | null>;
  /** Identity lookup powering pre-submit idempotency (matches the DB unique key). */
  findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null>;
  listByHypothesis(hypothesisId: string): Promise<BacktestRun[]>;
}
```

```typescript
// src/adapters/repository/in-memory-backtest-run.repository.ts
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { BacktestRunRepository } from '../../ports/backtest-run.repository.ts';

export class InMemoryBacktestRunRepository implements BacktestRunRepository {
  private readonly byId = new Map<string, BacktestRun>();

  async createSubmitted(run: BacktestRun): Promise<void> {
    if (this.byId.has(run.id)) throw new Error(`backtest_run already exists: ${run.id}`);
    // Mirror the DB unique (hypothesis_id, params_hash, bundle_hash) idempotency guard.
    for (const r of this.byId.values()) {
      if (r.hypothesisId === run.hypothesisId && r.paramsHash === run.paramsHash && r.bundleHash === run.bundleHash) {
        throw new Error(`backtest_run already exists for (${run.hypothesisId}, ${run.paramsHash}, ${run.bundleHash})`);
      }
    }
    this.byId.set(run.id, { ...run });
  }

  private patch(id: string, patch: Partial<BacktestRun>): void {
    const row = this.byId.get(id);
    if (!row) throw new Error(`backtest_run not found: ${id}`);
    this.byId.set(id, { ...row, ...patch, updatedAt: new Date().toISOString() });
  }

  async markCompleted(id: string, c: BacktestCompletion): Promise<void> {
    this.patch(id, {
      status: 'completed', metrics: c.metrics, baselineMetrics: c.baselineMetrics,
      deltaNetPnlUsd: c.deltaNetPnlUsd, deltaMaxDrawdownPct: c.deltaMaxDrawdownPct, isFragile: c.isFragile,
      artifactRefs: c.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: c.finishedAt,
    });
  }

  async markRejected(id: string): Promise<void> { this.patch(id, { status: 'rejected', finishedAt: new Date().toISOString() }); }
  async markFailed(id: string): Promise<void> { this.patch(id, { status: 'failed', finishedAt: new Date().toISOString() }); }
  async markEvaluated(id: string): Promise<void> { this.patch(id, { status: 'evaluated' }); }

  async findById(id: string): Promise<BacktestRun | null> { return this.byId.get(id) ?? null; }

  async findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null> {
    for (const r of this.byId.values()) {
      if (r.hypothesisId === hypothesisId && r.paramsHash === paramsHash && r.bundleHash === bundleHash) return { ...r };
    }
    return null;
  }

  async listByHypothesis(hypothesisId: string): Promise<BacktestRun[]> {
    return [...this.byId.values()].filter((r) => r.hypothesisId === hypothesisId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/repository/in-memory-backtest-run.repository.test.ts && pnpm typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/backtest-run.ts src/ports/backtest-run.repository.ts src/adapters/repository/in-memory-backtest-run.repository.ts src/adapters/repository/in-memory-backtest-run.repository.test.ts
git commit -m "feat(sp4): BacktestRun domain + repository port + in-memory adapter (idempotency guard)"
```

---

## Task 9: Evaluation domain + repository (port + in-memory)

**Files:**
- Create: `src/domain/evaluation.ts`, `src/ports/evaluation.repository.ts`, `src/adapters/repository/in-memory-evaluation.repository.ts`
- Test: `src/adapters/repository/in-memory-evaluation.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/adapters/repository/in-memory-evaluation.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryEvaluationRepository } from './in-memory-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../validation/evaluator.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';

const summary: ComparisonSummary = {
  baseline: { netPnlUsd: 100, netPnlPct: 1, totalTrades: 28, winRate: 0.5, profitFactor: 1.2, maxDrawdownPct: 7, expectancyUsd: 3, sharpe: 0.8, topTradeContributionPct: 20 },
  variant: { netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22 },
  sampleSize: { baselineTrades: 28, variantTrades: 30 }, platformContractVersion: 'mock-0',
};
function evaluation(id: string): Evaluation {
  return { id, backtestRunId: 'r1', hypothesisId: 'h1', decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'], metricsSnapshot: summary, thresholds: DEFAULT_EVALUATOR_THRESHOLDS, createdAt: '2026-01-01T00:00:00Z' };
}

describe('InMemoryEvaluationRepository', () => {
  it('create then findById', async () => {
    const repo = new InMemoryEvaluationRepository();
    await repo.create(evaluation('e1'));
    expect((await repo.findById('e1'))?.decision).toBe('PAPER_CANDIDATE');
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryEvaluationRepository();
    await repo.create(evaluation('e1'));
    await expect(repo.create(evaluation('e1'))).rejects.toThrow(/already exists/);
  });

  it('listByBacktestRun returns matches', async () => {
    const repo = new InMemoryEvaluationRepository();
    await repo.create(evaluation('e1'));
    expect(await repo.listByBacktestRun('r1')).toHaveLength(1);
    expect(await repo.listByBacktestRun('other')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/in-memory-evaluation.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/domain/evaluation.ts
import type { ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { EvaluationDecision, EvaluatorThresholds } from '../validation/evaluator.ts';

export interface Evaluation {
  id: string;
  backtestRunId: string;
  hypothesisId: string;
  decision: EvaluationDecision;
  reasons: string[];
  metricsSnapshot: ComparisonSummary;
  thresholds: EvaluatorThresholds;
  createdAt: string;
}
```

```typescript
// src/ports/evaluation.repository.ts
import type { Evaluation } from '../domain/evaluation.ts';

export interface EvaluationRepository {
  create(evaluation: Evaluation): Promise<void>;
  findById(id: string): Promise<Evaluation | null>;
  listByBacktestRun(backtestRunId: string): Promise<Evaluation[]>;
}
```

```typescript
// src/adapters/repository/in-memory-evaluation.repository.ts
import type { Evaluation } from '../../domain/evaluation.ts';
import type { EvaluationRepository } from '../../ports/evaluation.repository.ts';

export class InMemoryEvaluationRepository implements EvaluationRepository {
  private readonly byId = new Map<string, Evaluation>();

  async create(evaluation: Evaluation): Promise<void> {
    if (this.byId.has(evaluation.id)) throw new Error(`evaluation already exists: ${evaluation.id}`);
    this.byId.set(evaluation.id, { ...evaluation });
  }

  async findById(id: string): Promise<Evaluation | null> {
    return this.byId.get(id) ?? null;
  }

  async listByBacktestRun(backtestRunId: string): Promise<Evaluation[]> {
    return [...this.byId.values()].filter((e) => e.backtestRunId === backtestRunId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/adapters/repository/in-memory-evaluation.repository.test.ts && pnpm typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/evaluation.ts src/ports/evaluation.repository.ts src/adapters/repository/in-memory-evaluation.repository.ts src/adapters/repository/in-memory-evaluation.repository.test.ts
git commit -m "feat(sp4): Evaluation domain + repository port + in-memory adapter"
```

---

## Task 10: DB schema (3 tables) + migration 0003

**Files:**
- Modify: `src/db/schema.ts`
- Create: `migrations/0003_*.sql` (generated)

- [ ] **Step 1: Add the tables to `src/db/schema.ts`** (append; extend the top import to include `boolean` and `doublePrecision`)

Change the first import line to:

```typescript
import { pgTable, text, jsonb, timestamp, index, uniqueIndex, integer, real, boolean, doublePrecision } from 'drizzle-orm/pg-core';
```

Add these imports near the existing domain-type imports:

```typescript
import type { ModuleManifest } from '../domain/module-bundle.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../ports/platform-gateway.port.ts';
import type { EvaluatorThresholds } from '../validation/evaluator.ts';
```

Append the tables:

```typescript
export const hypothesisBuild = pgTable('hypothesis_build', {
  id: text('id').primaryKey(),
  hypothesisId: text('hypothesis_id').notNull(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  status: text('status').notNull(),
  builderAdapter: text('builder_adapter').notNull(),
  builderModel: text('builder_model').notNull(),
  bundleHash: text('bundle_hash'),
  bundleArtifactRef: jsonb('bundle_artifact_ref').$type<ArtifactRef>(),
  manifest: jsonb('manifest').$type<ModuleManifest>(),
  sdkContractVersion: text('sdk_contract_version').notNull(),
  bundleContractVersion: text('bundle_contract_version').notNull(),
  issues: jsonb('issues').notNull().$type<ValidationIssue[]>(),
  attempt: integer('attempt').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  hypothesisIdx: index('hypothesis_build_hypothesis_idx').on(t.hypothesisId),
  statusIdx: index('hypothesis_build_status_idx').on(t.status),
}));

export const backtestRun = pgTable('backtest_run', {
  id: text('id').primaryKey(),
  hypothesisBuildId: text('hypothesis_build_id').notNull(),
  hypothesisId: text('hypothesis_id').notNull(),
  strategyProfileId: text('strategy_profile_id').notNull(),
  platformRunId: text('platform_run_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  params: jsonb('params').notNull().$type<Record<string, unknown>>(),
  paramsHash: text('params_hash').notNull(),
  bundleHash: text('bundle_hash').notNull(),
  status: text('status').notNull(),
  baselineModuleId: text('baseline_module_id').notNull(),
  variantModuleId: text('variant_module_id').notNull(),
  // normalized variant metric columns (real columns per master design §11):
  netPnlUsd: doublePrecision('net_pnl_usd'),
  netPnlPct: doublePrecision('net_pnl_pct'),
  totalTrades: integer('total_trades'),
  winRate: doublePrecision('win_rate'),
  profitFactor: doublePrecision('profit_factor'),
  maxDrawdownPct: doublePrecision('max_drawdown_pct'),
  expectancyUsd: doublePrecision('expectancy_usd'),
  sharpe: doublePrecision('sharpe'),
  topTradeContributionPct: doublePrecision('top_trade_contribution_pct'),
  isFragile: boolean('is_fragile'),
  baselineMetrics: jsonb('baseline_metrics').$type<BacktestMetricBlock>(),
  deltaNetPnlUsd: doublePrecision('delta_net_pnl_usd'),
  deltaMaxDrawdownPct: doublePrecision('delta_max_drawdown_pct'),
  artifactRefs: jsonb('artifact_refs').notNull().$type<string[]>(),
  platformContractVersion: text('platform_contract_version').notNull(),
  sdkContractVersion: text('sdk_contract_version').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Idempotency: same hypothesis + same params + same bundle never duplicates; a new
  // build attempt (new bundle_hash) is allowed.
  idemUq: uniqueIndex('backtest_run_idem_uq').on(t.hypothesisId, t.paramsHash, t.bundleHash),
  hypothesisIdx: index('backtest_run_hypothesis_idx').on(t.hypothesisId),
  statusIdx: index('backtest_run_status_idx').on(t.status),
}));

export const evaluation = pgTable('evaluation', {
  id: text('id').primaryKey(),
  backtestRunId: text('backtest_run_id').notNull(),
  hypothesisId: text('hypothesis_id').notNull(),
  decision: text('decision').notNull(),
  reasons: jsonb('reasons').notNull().$type<string[]>(),
  metricsSnapshot: jsonb('metrics_snapshot').notNull().$type<ComparisonSummary>(),
  thresholds: jsonb('thresholds').notNull().$type<EvaluatorThresholds>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Append-only audit row (no FK) — allows re-evaluation history.
  backtestRunIdx: index('evaluation_backtest_run_idx').on(t.backtestRunId),
}));
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `migrations/0003_*.sql` is created containing `CREATE TABLE "hypothesis_build"`, `"backtest_run"`, `"evaluation"` and the indexes.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Sanity-check the generated SQL**

Run: `ls migrations/ && grep -l 'CREATE TABLE "backtest_run"' migrations/0003_*.sql`
Expected: the 0003 file is listed and matches.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts migrations/
git commit -m "feat(sp4): hypothesis_build + backtest_run + evaluation tables and migration 0003"
```

---

## Task 11: Drizzle repositories (3) + integration test

**Files:**
- Create: `src/adapters/repository/drizzle-hypothesis-build.repository.ts`, `…/drizzle-backtest-run.repository.ts`, `…/drizzle-evaluation.repository.ts`
- Test: `src/adapters/repository/drizzle-build-backtest.repository.test.ts`

- [ ] **Step 1: Write the failing integration test** (gated on `DATABASE_URL`, mirrors SP-3)

```typescript
// src/adapters/repository/drizzle-build-backtest.repository.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { createDbClient } from '../../db/client.ts';
import { DrizzleHypothesisBuildRepository } from './drizzle-hypothesis-build.repository.ts';
import { DrizzleBacktestRunRepository } from './drizzle-backtest-run.repository.ts';
import { DrizzleEvaluationRepository } from './drizzle-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../validation/evaluator.ts';
import { SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { BacktestMetricBlock, ComparisonSummary } from '../../ports/platform-gateway.port.ts';

const url = process.env.DATABASE_URL;
const uid = () => `sp4-${Math.random().toString(36).slice(2)}`;
const manifest: ModuleManifest = { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION };
const ref: ArtifactRef = { artifact_id: 'a1', uri: 'file://a', content_hash: 'sha256:x', kind: 'module_bundle', size_bytes: 1, mime_type: 'application/json', created_at: '2026-01-01T00:00:00Z', producer: 'builder', metadata: {} };
const block = (o: Partial<BacktestMetricBlock> = {}): BacktestMetricBlock => ({ netPnlUsd: 250, netPnlPct: 2.5, totalTrades: 30, winRate: 0.6, profitFactor: 2, maxDrawdownPct: 8, expectancyUsd: 8, sharpe: 1.4, topTradeContributionPct: 22, ...o });

(url ? describe : describe.skip)('Drizzle SP-4 repositories (integration)', () => {
  let pool: Pool;
  let builds: DrizzleHypothesisBuildRepository;
  let runs: DrizzleBacktestRunRepository;
  let evals: DrizzleEvaluationRepository;

  beforeAll(() => {
    const client = createDbClient(url!);
    pool = client.pool;
    builds = new DrizzleHypothesisBuildRepository(client.db);
    runs = new DrizzleBacktestRunRepository(client.db);
    evals = new DrizzleEvaluationRepository(client.db);
  });
  afterAll(async () => { await pool.end(); });

  it('hypothesis_build lifecycle round-trips', async () => {
    const id = uid(); const hid = uid(); const now = new Date().toISOString();
    const b: HypothesisBuild = { id, hypothesisId: hid, strategyProfileId: 'p1', status: 'generating', builderAdapter: 'fake', builderModel: 'fake', bundleHash: null, bundleArtifactRef: null, manifest: null, sdkContractVersion: SDK_CONTRACT_VERSION, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION, issues: [], attempt: 1, createdAt: now, updatedAt: now };
    await builds.createGenerating(b);
    await builds.markCandidate(id, { bundleHash: 'sha256:zz', bundleArtifactRef: ref, manifest });
    const row = await builds.findById(id);
    expect(row?.status).toBe('candidate');
    expect(row?.manifest?.moduleId).toBe('m');
  });

  it('backtest_run completes + enforces idempotency', async () => {
    const hid = uid(); const now = new Date().toISOString();
    const base: BacktestRun = { id: uid(), hypothesisBuildId: 'b1', hypothesisId: hid, strategyProfileId: 'p1', platformRunId: 'mock-run-1', correlationId: 'c1', params: {}, paramsHash: 'sha256:p', bundleHash: 'sha256:bh', status: 'submitted', baselineModuleId: 'strategy:p1', variantModuleId: 'overlay-h1', metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null, artifactRefs: [], platformContractVersion: 'mock-0', sdkContractVersion: SDK_CONTRACT_VERSION, submittedAt: now, finishedAt: null, createdAt: now, updatedAt: now };
    await runs.createSubmitted(base);
    const completion: BacktestCompletion = { metrics: block(), baselineMetrics: block({ netPnlUsd: 100, winRate: 0.5, maxDrawdownPct: 7 }), deltaNetPnlUsd: 150, deltaMaxDrawdownPct: 1, isFragile: false, artifactRefs: [], platformContractVersion: 'mock-0', finishedAt: new Date().toISOString() };
    await runs.markCompleted(base.id, completion);
    const row = await runs.findById(base.id);
    expect(row?.status).toBe('completed');
    expect(row?.metrics?.netPnlUsd).toBe(250);
    expect(row?.deltaNetPnlUsd).toBe(150);
    expect((await runs.findByIdentity(hid, 'sha256:p', 'sha256:bh'))?.id).toBe(base.id);
    await expect(runs.createSubmitted({ ...base, id: uid() })).rejects.toThrow();
  });

  it('evaluation round-trips', async () => {
    const summary: ComparisonSummary = { baseline: block({ netPnlUsd: 100 }), variant: block(), sampleSize: { baselineTrades: 28, variantTrades: 30 }, platformContractVersion: 'mock-0' };
    const e: Evaluation = { id: uid(), backtestRunId: uid(), hypothesisId: uid(), decision: 'PAPER_CANDIDATE', reasons: ['strong_robust_edge'], metricsSnapshot: summary, thresholds: DEFAULT_EVALUATOR_THRESHOLDS, createdAt: new Date().toISOString() };
    await evals.create(e);
    const list = await evals.listByBacktestRun(e.backtestRunId);
    expect(list[0]?.decision).toBe('PAPER_CANDIDATE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/adapters/repository/drizzle-build-backtest.repository.test.ts`
Expected: FAIL — modules not found (or all skipped if no `DATABASE_URL`; bring up Postgres + apply migrations to actually exercise it: `docker compose up -d postgres && pnpm db:migrate`).

- [ ] **Step 3: Write the three Drizzle repositories**

```typescript
// src/adapters/repository/drizzle-hypothesis-build.repository.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { hypothesisBuild } from '../../db/schema.ts';
import type { HypothesisBuild, HypothesisBuildStatus } from '../../domain/hypothesis-build.ts';
import type { ModuleManifest } from '../../domain/module-bundle.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisBuildRepository } from '../../ports/hypothesis-build.repository.ts';

type Row = typeof hypothesisBuild.$inferSelect;

function toDomain(row: Row): HypothesisBuild {
  return {
    id: row.id, hypothesisId: row.hypothesisId, strategyProfileId: row.strategyProfileId,
    status: row.status as HypothesisBuildStatus, builderAdapter: row.builderAdapter, builderModel: row.builderModel,
    bundleHash: row.bundleHash, bundleArtifactRef: (row.bundleArtifactRef as ArtifactRef | null) ?? null,
    manifest: (row.manifest as ModuleManifest | null) ?? null,
    sdkContractVersion: row.sdkContractVersion, bundleContractVersion: row.bundleContractVersion,
    issues: row.issues as ValidationIssue[], attempt: row.attempt,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleHypothesisBuildRepository implements HypothesisBuildRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createGenerating(b: HypothesisBuild): Promise<void> {
    await this.db.insert(hypothesisBuild).values({
      id: b.id, hypothesisId: b.hypothesisId, strategyProfileId: b.strategyProfileId, status: b.status,
      builderAdapter: b.builderAdapter, builderModel: b.builderModel, bundleHash: b.bundleHash,
      bundleArtifactRef: b.bundleArtifactRef, manifest: b.manifest, sdkContractVersion: b.sdkContractVersion,
      bundleContractVersion: b.bundleContractVersion, issues: b.issues, attempt: b.attempt,
      createdAt: new Date(b.createdAt), updatedAt: new Date(b.updatedAt),
    });
  }

  async markBuildFailed(id: string, issues: ValidationIssue[]): Promise<void> {
    await this.db.update(hypothesisBuild).set({ status: 'build_failed', issues, updatedAt: new Date() }).where(eq(hypothesisBuild.id, id));
  }

  async markCandidate(id: string, fields: { bundleHash: string; bundleArtifactRef: ArtifactRef; manifest: ModuleManifest }): Promise<void> {
    await this.db.update(hypothesisBuild).set({ status: 'candidate', bundleHash: fields.bundleHash, bundleArtifactRef: fields.bundleArtifactRef, manifest: fields.manifest, updatedAt: new Date() }).where(eq(hypothesisBuild.id, id));
  }

  async markSubmitted(id: string): Promise<void> {
    await this.db.update(hypothesisBuild).set({ status: 'submitted', updatedAt: new Date() }).where(eq(hypothesisBuild.id, id));
  }

  async findById(id: string): Promise<HypothesisBuild | null> {
    const rows = await this.db.select().from(hypothesisBuild).where(eq(hypothesisBuild.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisBuild[]> {
    const rows = await this.db.select().from(hypothesisBuild).where(eq(hypothesisBuild.hypothesisId, hypothesisId));
    return rows.map(toDomain);
  }
}
```

```typescript
// src/adapters/repository/drizzle-backtest-run.repository.ts
import { eq, and } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { backtestRun } from '../../db/schema.ts';
import type { BacktestRun, BacktestRunStatus, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { BacktestRunRepository } from '../../ports/backtest-run.repository.ts';

type Row = typeof backtestRun.$inferSelect;

function metricsFromRow(row: Row): BacktestMetricBlock | null {
  if (row.netPnlUsd === null) return null;
  return {
    netPnlUsd: row.netPnlUsd, netPnlPct: row.netPnlPct!, totalTrades: row.totalTrades!, winRate: row.winRate!,
    profitFactor: row.profitFactor!, maxDrawdownPct: row.maxDrawdownPct!, expectancyUsd: row.expectancyUsd!,
    sharpe: row.sharpe!, topTradeContributionPct: row.topTradeContributionPct!,
  };
}

function toDomain(row: Row): BacktestRun {
  return {
    id: row.id, hypothesisBuildId: row.hypothesisBuildId, hypothesisId: row.hypothesisId, strategyProfileId: row.strategyProfileId,
    platformRunId: row.platformRunId, correlationId: row.correlationId, params: row.params, paramsHash: row.paramsHash, bundleHash: row.bundleHash,
    status: row.status as BacktestRunStatus, baselineModuleId: row.baselineModuleId, variantModuleId: row.variantModuleId,
    metrics: metricsFromRow(row), baselineMetrics: (row.baselineMetrics as BacktestMetricBlock | null) ?? null,
    deltaNetPnlUsd: row.deltaNetPnlUsd, deltaMaxDrawdownPct: row.deltaMaxDrawdownPct, isFragile: row.isFragile,
    artifactRefs: row.artifactRefs, platformContractVersion: row.platformContractVersion, sdkContractVersion: row.sdkContractVersion,
    submittedAt: row.submittedAt.toISOString(), finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export class DrizzleBacktestRunRepository implements BacktestRunRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async createSubmitted(run: BacktestRun): Promise<void> {
    await this.db.insert(backtestRun).values({
      id: run.id, hypothesisBuildId: run.hypothesisBuildId, hypothesisId: run.hypothesisId, strategyProfileId: run.strategyProfileId,
      platformRunId: run.platformRunId, correlationId: run.correlationId, params: run.params, paramsHash: run.paramsHash, bundleHash: run.bundleHash,
      status: run.status, baselineModuleId: run.baselineModuleId, variantModuleId: run.variantModuleId,
      artifactRefs: run.artifactRefs, platformContractVersion: run.platformContractVersion, sdkContractVersion: run.sdkContractVersion,
      submittedAt: new Date(run.submittedAt), createdAt: new Date(run.createdAt), updatedAt: new Date(run.updatedAt),
    });
  }

  async markCompleted(id: string, c: BacktestCompletion): Promise<void> {
    await this.db.update(backtestRun).set({
      status: 'completed', netPnlUsd: c.metrics.netPnlUsd, netPnlPct: c.metrics.netPnlPct, totalTrades: c.metrics.totalTrades,
      winRate: c.metrics.winRate, profitFactor: c.metrics.profitFactor, maxDrawdownPct: c.metrics.maxDrawdownPct,
      expectancyUsd: c.metrics.expectancyUsd, sharpe: c.metrics.sharpe, topTradeContributionPct: c.metrics.topTradeContributionPct,
      isFragile: c.isFragile, baselineMetrics: c.baselineMetrics, deltaNetPnlUsd: c.deltaNetPnlUsd, deltaMaxDrawdownPct: c.deltaMaxDrawdownPct,
      artifactRefs: c.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: new Date(c.finishedAt), updatedAt: new Date(),
    }).where(eq(backtestRun.id, id));
  }

  async markRejected(id: string): Promise<void> { await this.db.update(backtestRun).set({ status: 'rejected', finishedAt: new Date(), updatedAt: new Date() }).where(eq(backtestRun.id, id)); }
  async markFailed(id: string): Promise<void> { await this.db.update(backtestRun).set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() }).where(eq(backtestRun.id, id)); }
  async markEvaluated(id: string): Promise<void> { await this.db.update(backtestRun).set({ status: 'evaluated', updatedAt: new Date() }).where(eq(backtestRun.id, id)); }

  async findById(id: string): Promise<BacktestRun | null> {
    const rows = await this.db.select().from(backtestRun).where(eq(backtestRun.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async findByIdentity(hypothesisId: string, paramsHash: string, bundleHash: string): Promise<BacktestRun | null> {
    const rows = await this.db.select().from(backtestRun)
      .where(and(eq(backtestRun.hypothesisId, hypothesisId), eq(backtestRun.paramsHash, paramsHash), eq(backtestRun.bundleHash, bundleHash)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByHypothesis(hypothesisId: string): Promise<BacktestRun[]> {
    const rows = await this.db.select().from(backtestRun).where(eq(backtestRun.hypothesisId, hypothesisId));
    return rows.map(toDomain);
  }
}
```

```typescript
// src/adapters/repository/drizzle-evaluation.repository.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { evaluation } from '../../db/schema.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import type { EvaluationDecision, EvaluatorThresholds } from '../../validation/evaluator.ts';
import type { EvaluationRepository } from '../../ports/evaluation.repository.ts';

type Row = typeof evaluation.$inferSelect;

function toDomain(row: Row): Evaluation {
  return {
    id: row.id, backtestRunId: row.backtestRunId, hypothesisId: row.hypothesisId,
    decision: row.decision as EvaluationDecision, reasons: row.reasons,
    metricsSnapshot: row.metricsSnapshot as ComparisonSummary, thresholds: row.thresholds as EvaluatorThresholds,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleEvaluationRepository implements EvaluationRepository {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async create(e: Evaluation): Promise<void> {
    await this.db.insert(evaluation).values({
      id: e.id, backtestRunId: e.backtestRunId, hypothesisId: e.hypothesisId, decision: e.decision,
      reasons: e.reasons, metricsSnapshot: e.metricsSnapshot, thresholds: e.thresholds, createdAt: new Date(e.createdAt),
    });
  }

  async findById(id: string): Promise<Evaluation | null> {
    const rows = await this.db.select().from(evaluation).where(eq(evaluation.id, id)).limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async listByBacktestRun(backtestRunId: string): Promise<Evaluation[]> {
    const rows = await this.db.select().from(evaluation).where(eq(evaluation.backtestRunId, backtestRunId));
    return rows.map(toDomain);
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run (with infra): `docker compose up -d postgres && pnpm db:migrate && pnpm vitest run src/adapters/repository/drizzle-build-backtest.repository.test.ts && pnpm typecheck`
Expected: PASS (3 integration tests), typecheck clean. Without `DATABASE_URL`: 3 skipped, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/repository/drizzle-hypothesis-build.repository.ts src/adapters/repository/drizzle-backtest-run.repository.ts src/adapters/repository/drizzle-evaluation.repository.ts src/adapters/repository/drizzle-build-backtest.repository.test.ts
git commit -m "feat(sp4): Drizzle build/backtest/evaluation repositories + integration test"
```

---

## Task 12: env additions + thresholds loader

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append)

```typescript
// add to src/config/env.test.ts
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../validation/evaluator.ts';

describe('SP-4 env', () => {
  it('defaults builder + thresholds', () => {
    const env = loadEnv({});
    expect(env.BUILDER_ADAPTER).toBe('fake');
    expect(env.BUILDER_MODEL).toBe('anthropic/claude-sonnet-4-6');
    expect(env.evaluatorThresholds).toEqual(DEFAULT_EVALUATOR_THRESHOLDS);
  });

  it('reads builder + threshold overrides', () => {
    const env = loadEnv({ BUILDER_ADAPTER: 'mastra', EVAL_MIN_TRADES: '40', EVAL_STRONG_PNL_DELTA_USD: '500', EVAL_MIN_PROFIT_FACTOR: '1.8' });
    expect(env.BUILDER_ADAPTER).toBe('mastra');
    expect(env.evaluatorThresholds.minTrades).toBe(40);
    expect(env.evaluatorThresholds.strongPnlDeltaUsd).toBe(500);
    expect(env.evaluatorThresholds.minProfitFactor).toBe(1.8);
  });
});
```

(Ensure `loadEnv` is imported at the top of the existing test file; it already is.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL — `BUILDER_ADAPTER` / `evaluatorThresholds` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/config/env.ts`, add the import at the top:

```typescript
import { DEFAULT_EVALUATOR_THRESHOLDS, type EvaluatorThresholds } from '../validation/evaluator.ts';
```

Add fields to the `Env` interface:

```typescript
  BUILDER_ADAPTER: 'fake' | 'mastra';
  BUILDER_MODEL: string;
  evaluatorThresholds: EvaluatorThresholds;
```

Add a float parser near `parsePositiveInt`:

```typescript
function parseFloatOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
```

In the returned object (inside `loadEnv`), add:

```typescript
    BUILDER_ADAPTER: source.BUILDER_ADAPTER === 'mastra' ? 'mastra' : 'fake',
    BUILDER_MODEL: source.BUILDER_MODEL ?? 'anthropic/claude-sonnet-4-6',
    evaluatorThresholds: {
      minTrades: parsePositiveInt(source.EVAL_MIN_TRADES, DEFAULT_EVALUATOR_THRESHOLDS.minTrades),
      minPnlDeltaUsd: parseFloatOr(source.EVAL_MIN_PNL_DELTA_USD, DEFAULT_EVALUATOR_THRESHOLDS.minPnlDeltaUsd),
      maxDrawdownTolerancePct: parseFloatOr(source.EVAL_MAX_DRAWDOWN_TOLERANCE_PCT, DEFAULT_EVALUATOR_THRESHOLDS.maxDrawdownTolerancePct),
      fragilityTopTradePct: parseFloatOr(source.EVAL_FRAGILITY_TOP_TRADE_PCT, DEFAULT_EVALUATOR_THRESHOLDS.fragilityTopTradePct),
      strongPnlDeltaUsd: parseFloatOr(source.EVAL_STRONG_PNL_DELTA_USD, DEFAULT_EVALUATOR_THRESHOLDS.strongPnlDeltaUsd),
      minProfitFactor: parseFloatOr(source.EVAL_MIN_PROFIT_FACTOR, DEFAULT_EVALUATOR_THRESHOLDS.minProfitFactor),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/config/env.test.ts && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat(sp4): env BUILDER_ADAPTER/MODEL + evaluator thresholds"
```

---

## Task 13: AppServices extension + composition wiring + make-services

This task extends `AppServices` and updates **both** constructors (`composition.ts` + `test/support/make-services.ts`) in the same commit so `pnpm typecheck` never reds. Handler registration is deferred to Task 15 (the handler does not exist yet).

**Files:**
- Modify: `src/orchestrator/app-services.ts`, `src/composition.ts`, `test/support/make-services.ts`

- [ ] **Step 1: Extend `AppServices`**

In `src/orchestrator/app-services.ts`, add imports and fields:

```typescript
import type { BuilderPort } from '../ports/builder.port.ts';
import type { HypothesisBuildRepository } from '../ports/hypothesis-build.repository.ts';
import type { BacktestRunRepository } from '../ports/backtest-run.repository.ts';
import type { EvaluationRepository } from '../ports/evaluation.repository.ts';
import type { EvaluatorThresholds } from '../validation/evaluator.ts';
```

Add to the `AppServices` interface:

```typescript
  builder: BuilderPort;
  builds: HypothesisBuildRepository;
  backtests: BacktestRunRepository;
  evaluations: EvaluationRepository;
  evaluatorThresholds: EvaluatorThresholds;
```

- [ ] **Step 2: Wire `composition.ts`**

Add imports:

```typescript
import { FakeBuilder } from './adapters/builder/fake-builder.ts';
import { MastraBuilder } from './adapters/builder/mastra-builder.ts';
import { DrizzleHypothesisBuildRepository } from './adapters/repository/drizzle-hypothesis-build.repository.ts';
import { DrizzleBacktestRunRepository } from './adapters/repository/drizzle-backtest-run.repository.ts';
import { DrizzleEvaluationRepository } from './adapters/repository/drizzle-evaluation.repository.ts';
import type { BuilderPort } from './ports/builder.port.ts';
```

Add a `buildBuilder` factory next to `buildResearcher`:

```typescript
function buildBuilder(env: ReturnType<typeof loadEnv>): BuilderPort {
  if (env.BUILDER_ADAPTER === 'mastra') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required when BUILDER_ADAPTER=mastra');
    return new MastraBuilder(env.BUILDER_MODEL);
  }
  console.warn('[composition] BUILDER_ADAPTER is not "mastra"; using FakeBuilder (template bundles)');
  return new FakeBuilder();
}
```

Add the five fields to the `services` object literal in `composeRuntime`:

```typescript
    builder: buildBuilder(env),
    builds: new DrizzleHypothesisBuildRepository(db),
    backtests: new DrizzleBacktestRunRepository(db),
    evaluations: new DrizzleEvaluationRepository(db),
    evaluatorThresholds: env.evaluatorThresholds,
```

- [ ] **Step 3: Wire `test/support/make-services.ts`**

Add imports:

```typescript
import { FakeBuilder } from '../../src/adapters/builder/fake-builder.ts';
import { InMemoryHypothesisBuildRepository } from '../../src/adapters/repository/in-memory-hypothesis-build.repository.ts';
import { InMemoryBacktestRunRepository } from '../../src/adapters/repository/in-memory-backtest-run.repository.ts';
import { InMemoryEvaluationRepository } from '../../src/adapters/repository/in-memory-evaluation.repository.ts';
import { DEFAULT_EVALUATOR_THRESHOLDS } from '../../src/validation/evaluator.ts';
```

Add the five fields to the returned object (before `...overrides`):

```typescript
    builder: new FakeBuilder(),
    builds: new InMemoryHypothesisBuildRepository(),
    backtests: new InMemoryBacktestRunRepository(),
    evaluations: new InMemoryEvaluationRepository(),
    evaluatorThresholds: DEFAULT_EVALUATOR_THRESHOLDS,
```

- [ ] **Step 4: Verify typecheck + full suite green**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; all existing tests still pass (no handler yet).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/app-services.ts src/composition.ts test/support/make-services.ts
git commit -m "feat(sp4): extend AppServices + composition + make-services wiring (builder, builds, backtests, evaluations, thresholds)"
```

---

## Task 14: hypothesis.build handler + unit tests

**Files:**
- Create: `src/orchestrator/handlers/hypothesis-build.handler.ts`
- Test: `src/orchestrator/handlers/hypothesis-build.handler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/orchestrator/handlers/hypothesis-build.handler.test.ts
import { describe, it, expect } from 'vitest';
import { hypothesisBuildHandler } from './hypothesis-build.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BuilderInput, BuilderOutput, BuilderPort } from '../../ports/builder.port.ts';
import type { PlatformGatewayPort } from '../../ports/platform-gateway.port.ts';
import { MockPlatformGatewayAdapter } from '../../adapters/platform/mock-platform-gateway.adapter.ts';

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'p1', version: 1, sourceKind: 'manual', sourceFingerprint: 'sha256:s', direction: 'long',
    coreIdea: 'oi-based entry filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [],
    profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now,
  };
}
function hypothesis(): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return {
    id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when oi trend persists', targetBehavior: 'filter entries',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] },
    requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d',
    expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'],
    confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never,
    issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now,
  };
}
function task(payload: Record<string, unknown>): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload, createdAt: now, updatedAt: now };
}
async function seeded(over: Partial<AppServices> = {}): Promise<AppServices> {
  const s = makeServices(over);
  await s.strategyProfiles.create(profile());
  await s.hypotheses.create(hypothesis());
  return s;
}

describe('hypothesisBuildHandler', () => {
  it('happy path persists build(candidate→submitted), backtest_run(evaluated), evaluation + full event trail', async () => {
    const s = await seeded();
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('submitted');
    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('evaluated');
    expect(runs[0]?.metrics?.netPnlUsd).toBe(250);
    const evals = await s.evaluations.listByBacktestRun(runs[0]!.id);
    expect(evals[0]?.decision).toBe('PAPER_CANDIDATE');

    const events = await s.events.listByTask('t1');
    const evTypes = events.map((e) => e.type);
    for (const t of ['build.started', 'builder.completed', 'build.validated', 'artifact.stored', 'backtest.submitted', 'backtest.completed', 'evaluation.completed']) {
      expect(evTypes).toContain(t);
    }
  });

  it('same hypothesis + params + bundle does not re-submit (idempotent reuse)', async () => {
    let submitCount = 0;
    const base = new MockPlatformGatewayAdapter();
    const platform: PlatformGatewayPort = {
      getMarketContext: (sym, t) => base.getMarketContext(sym, t),
      getMarketRegime: (sym, t) => base.getMarketRegime(sym, t),
      submitBacktest: (req) => { submitCount += 1; return base.submitBacktest(req); },
      getBacktestResult: (ref) => base.getBacktestResult(ref),
    };
    const s = await seeded({ platform });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s); // identical inputs → reuse, no second submit
    expect(submitCount).toBe(1);
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(1);
    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('backtest.reused');
  });

  it('throws when hypothesis is not validated', async () => {
    const s = makeServices();
    await s.strategyProfiles.create(profile());
    await s.hypotheses.create({ ...hypothesis(), status: 'rejected' });
    await expect(hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s)).rejects.toThrow(/not validated/);
  });

  it('Builder throws → build_failed (issue builder_failed), no artifact, no backtest_run, no submit', async () => {
    const throwingBuilder: BuilderPort = {
      adapter: 'fake', model: 'fake',
      build: async (_in: BuilderInput): Promise<BuilderOutput> => { throw new Error('builder boom'); },
    };
    const s = await seeded({ builder: throwingBuilder });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('builder_failed');
    expect(builds[0]?.bundleArtifactRef).toBeNull();
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);

    const evTypes = (await s.events.listByTask('t1')).map((e) => e.type);
    expect(evTypes).toContain('build_failed');
    expect(evTypes).not.toContain('backtest.submitted');
  });

  it('Build Validator fails (denylist token in bundle) → build_failed with validator issues, no submit', async () => {
    const badBuilder: BuilderPort = {
      adapter: 'fake', model: 'fake',
      build: async (): Promise<BuilderOutput> => ({
        manifest: { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: 'builder-sdk-v0' },
        files: { 'index.ts': 'export const overlay = {}; const s = process.env.SECRET;' },
      }),
    };
    const s = await seeded({ builder: badBuilder });
    await hypothesisBuildHandler(task({ hypothesisId: 'h1' }), s);

    const builds = await s.builds.listByHypothesis('h1');
    expect(builds[0]?.status).toBe('build_failed');
    expect(builds[0]?.issues.map((i) => i.code)).toContain('restricted_import');
    expect(await s.backtests.listByHypothesis('h1')).toHaveLength(0);
  });
});
```

> Note: `AgentEventRepository.listByTask(taskId)` is the confirmed query method (`src/ports/agent-event.repository.ts`); the in-memory adapter records appended events. Use it as written.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/orchestrator/handlers/hypothesis-build.handler.test.ts`
Expected: FAIL — `Cannot find module './hypothesis-build.handler.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/orchestrator/handlers/hypothesis-build.handler.ts
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION } from '../../domain/module-bundle.ts';
import { validateBundle } from '../../validation/build-validator.ts';
import { evaluateBacktest } from '../../validation/evaluator.ts';
import { normalizeFeature, LAB_FEATURE_CATALOG } from '../../domain/hypothesis-rules.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { BacktestRun, BacktestCompletion } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';

export const HypothesisBuildPayloadSchema = z.object({
  hypothesisId: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function event(taskId: string, type: string, payload: Record<string, unknown>) {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}
function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export const hypothesisBuildHandler: WorkflowHandler = async (task, services) => {
  const parsed = validateWithSchema(HypothesisBuildPayloadSchema, task.payload);
  if (parsed.status === 'invalid') {
    throw new Error(`invalid hypothesis.build payload: ${JSON.stringify(parsed.issues)}`);
  }
  const payload = parsed.data;
  const params = payload.params ?? {};

  const hypothesis = await services.hypotheses.findById(payload.hypothesisId);
  if (!hypothesis) throw new Error(`hypothesis not found: ${payload.hypothesisId}`);
  if (hypothesis.status !== 'validated') throw new Error(`hypothesis is not validated: ${hypothesis.id} (${hypothesis.status})`);

  const profile = await services.strategyProfiles.findById(hypothesis.strategyProfileId);
  if (!profile) throw new Error(`strategy profile not found: ${hypothesis.strategyProfileId}`);

  const now = () => new Date().toISOString();
  const buildId = randomUUID();
  await services.events.append(event(task.id, 'build.started', { hypothesisId: hypothesis.id, builder: services.builder.adapter, model: services.builder.model }));

  const build: HypothesisBuild = {
    id: buildId, hypothesisId: hypothesis.id, strategyProfileId: profile.id, status: 'generating',
    builderAdapter: services.builder.adapter, builderModel: services.builder.model,
    bundleHash: null, bundleArtifactRef: null, manifest: null,
    sdkContractVersion: SDK_CONTRACT_VERSION, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION,
    issues: [], attempt: 1, createdAt: now(), updatedAt: now(),
  };
  await services.builds.createGenerating(build);

  // Builder (advisory failure → build_failed, terminal for this attempt; no side-effects after)
  await services.events.append(event(task.id, 'builder.started', { buildId }));
  let out;
  try {
    out = await services.builder.build({ hypothesis, profile, sdkDoc: '' });
  } catch (err) {
    const issues: ValidationIssue[] = [{ code: 'builder_failed', severity: 'error', path: 'builder', message: errMsg(err) }];
    await services.builds.markBuildFailed(buildId, issues);
    await services.events.append(event(task.id, 'builder.failed', { buildId, error: errMsg(err) }));
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: ['builder_failed'] }));
    return;
  }
  await services.events.append(event(task.id, 'builder.completed', { buildId }));

  const bundle = assembleBundle(out.manifest, out.files);
  const allowedCapabilities = new Set<string>([...profile.requiredMarketFeatures.map(normalizeFeature), ...LAB_FEATURE_CATALOG]);
  const validation = validateBundle(bundle, { allowedImports: new Set<string>(), allowedCapabilities });
  if (validation.status === 'build_failed') {
    await services.builds.markBuildFailed(buildId, validation.issues);
    await services.events.append(event(task.id, 'build_failed', { buildId, codes: validation.issues.map((i) => i.code) }));
    return;
  }
  await services.events.append(event(task.id, 'build.validated', { buildId, bundleHash: bundle.bundleHash }));

  const ref = await services.artifacts.put(JSON.stringify(bundle), { kind: 'module_bundle', mime_type: 'application/json', producer: 'builder', metadata: { hypothesisId: hypothesis.id, buildId } });
  await services.builds.markCandidate(buildId, { bundleHash: bundle.bundleHash, bundleArtifactRef: ref, manifest: bundle.manifest });
  await services.events.append(event(task.id, 'artifact.stored', { buildId, artifactId: ref.artifact_id }));

  // Idempotency: same hypothesis + same params + same bundle must NOT re-submit (checked
  // BEFORE the platform side-effect, so reuse never triggers a duplicate backtest).
  const paramsHash = sha256(stableStringify(params));
  const existingRun = await services.backtests.findByIdentity(hypothesis.id, paramsHash, bundle.bundleHash);
  if (existingRun) {
    await services.events.append(event(task.id, 'backtest.reused', { runId: existingRun.id, platformRunId: existingRun.platformRunId, status: existingRun.status }));
    return;
  }

  // Submit (Orchestrator-owned side-effect)
  const baselineModuleId = `strategy:${profile.id}`;
  const variantModuleId = bundle.manifest.moduleId;
  const runRef = await services.platform.submitBacktest({ correlationId: task.correlationId, baselineModuleId, variantModuleId, params });

  const runId = randomUUID();
  const run: BacktestRun = {
    id: runId, hypothesisBuildId: buildId, hypothesisId: hypothesis.id, strategyProfileId: profile.id,
    platformRunId: runRef.platformRunId, correlationId: task.correlationId, params, paramsHash, bundleHash: bundle.bundleHash,
    status: 'submitted', baselineModuleId, variantModuleId,
    metrics: null, baselineMetrics: null, deltaNetPnlUsd: null, deltaMaxDrawdownPct: null, isFragile: null,
    artifactRefs: [], platformContractVersion: 'pending', sdkContractVersion: SDK_CONTRACT_VERSION,
    submittedAt: now(), finishedAt: null, createdAt: now(), updatedAt: now(),
  };
  await services.backtests.createSubmitted(run);
  await services.builds.markSubmitted(buildId);
  await services.events.append(event(task.id, 'backtest.submitted', { runId, platformRunId: runRef.platformRunId }));

  // Resolve result (mock returns synchronously)
  const envelope = await services.platform.getBacktestResult(runRef);
  if (envelope.runStatus !== 'completed' || !envelope.comparison) {
    await services.backtests.markRejected(runId);
    await services.events.append(event(task.id, 'backtest.failed', { runId, runStatus: envelope.runStatus, hasComparison: !!envelope.comparison }));
    return;
  }
  const c = envelope.comparison;
  const completion: BacktestCompletion = {
    metrics: c.variant, baselineMetrics: c.baseline,
    deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
    deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
    isFragile: c.variant.topTradeContributionPct >= services.evaluatorThresholds.fragilityTopTradePct,
    artifactRefs: envelope.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: now(),
  };
  await services.backtests.markCompleted(runId, completion);
  await services.events.append(event(task.id, 'backtest.completed', { runId, deltaNetPnlUsd: completion.deltaNetPnlUsd }));

  // Evaluate (deterministic)
  const outcome = evaluateBacktest(c, services.evaluatorThresholds);
  const evaluation: Evaluation = {
    id: randomUUID(), backtestRunId: runId, hypothesisId: hypothesis.id,
    decision: outcome.decision, reasons: outcome.reasons, metricsSnapshot: c,
    thresholds: services.evaluatorThresholds, createdAt: now(),
  };
  await services.evaluations.create(evaluation);
  await services.backtests.markEvaluated(runId);
  await services.events.append(event(task.id, 'evaluation.completed', { runId, decision: outcome.decision, reasons: outcome.reasons }));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/orchestrator/handlers/hypothesis-build.handler.test.ts && pnpm typecheck`
Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/handlers/hypothesis-build.handler.ts src/orchestrator/handlers/hypothesis-build.handler.test.ts
git commit -m "feat(sp4): hypothesis.build handler (build, validate, submit, evaluate, persist)"
```

---

## Task 15: Register handler + e2e

**Files:**
- Modify: `src/composition.ts`
- Test: `test/e2e/hypothesis-build.test.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/e2e/hypothesis-build.test.ts
import { describe, it, expect } from 'vitest';
import { WorkflowRouter } from '../../src/orchestrator/workflow-router.ts';
import { hypothesisBuildHandler } from '../../src/orchestrator/handlers/hypothesis-build.handler.ts';
import { makeServices } from '../support/make-services.ts';
import type { ResearchTask } from '../../src/domain/types.ts';
import type { HypothesisProposal } from '../../src/domain/hypothesis.ts';
import type { StrategyProfile } from '../../src/domain/strategy-profile.ts';

function profile(): StrategyProfile {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'p1', version: 1, sourceKind: 'manual', sourceFingerprint: 'sha256:s', direction: 'long', coreIdea: 'oi filter', requiredMarketFeatures: ['oi', 'funding'], confidence: 0.6, unknowns: [], profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1', createdAt: now, updatedAt: now };
}
function hypothesis(over: Partial<HypothesisProposal> = {}): HypothesisProposal {
  const now = '2026-01-01T00:00:00Z';
  return { id: 'h1', strategyProfileId: 'p1', thesis: 'Skip entries when oi trend persists', targetBehavior: 'filter entries', ruleAction: { appliesTo: 'long', rules: [{ when: 'oi trend persists for 2 bars', action: 'skip_entry', params: { bars: 2 } }] }, requiredFeatures: ['oi', 'funding'], validationPlan: 'backtest 90d', expectedEffect: { metric: 'win_rate', direction: 'increase' }, invalidationCriteria: ['no improvement'], confidence: 0.5, status: 'validated', fingerprint: 'sha256:abc', proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1', createdAt: now, updatedAt: now, ...over };
}
function task(): ResearchTask {
  const now = '2026-01-01T00:00:00Z';
  return { id: 't1', taskType: 'hypothesis.build', source: 'operator', correlationId: 'c1', status: 'running', payload: { hypothesisId: 'h1' }, createdAt: now, updatedAt: now };
}

describe('e2e hypothesis.build', () => {
  it('routes through the router and evaluates to a decision', async () => {
    const s = makeServices();
    await s.strategyProfiles.create(profile());
    await s.hypotheses.create(hypothesis());
    const router = new WorkflowRouter();
    router.register('hypothesis.build', hypothesisBuildHandler);

    await router.dispatch(task(), s);

    const runs = await s.backtests.listByHypothesis('h1');
    expect(runs[0]?.status).toBe('evaluated');
    expect((await s.evaluations.listByBacktestRun(runs[0]!.id))[0]?.decision).toBe('PAPER_CANDIDATE');
  });
});
```

> Note: `WorkflowRouter.dispatch(task, deps)` is the confirmed method (`src/orchestrator/workflow-router.ts`); the SP-3 e2e test uses the same router. Use it as written.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/e2e/hypothesis-build.test.ts`
Expected: PASS for the standalone router wiring — but it must also be registered in composition. If the router call name differs, fix per the note. Then verify composition registration is missing (Step 3 adds it).

- [ ] **Step 3: Register the handler in `composition.ts`**

Add the import:

```typescript
import { hypothesisBuildHandler } from './orchestrator/handlers/hypothesis-build.handler.ts';
```

Add the registration next to the others:

```typescript
  router.register('hypothesis.build', hypothesisBuildHandler);
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; full suite green (live-LLM + integration tests skip without infra; with Postgres + Redis up, all pass).

- [ ] **Step 5: Commit**

```bash
git add src/composition.ts test/e2e/hypothesis-build.test.ts
git commit -m "feat(sp4): register hypothesis.build handler + e2e"
```

---

## Self-Review (completed during planning)

**Spec coverage:** §3 workflow → Task 14/15. §4 Builder → Task 5/6. §5 contracts → Task 1/2. §6 Build Validator → Task 3. §7 Evaluator → Task 4. §8 persistence → Task 7/8/9/10/11. §9 config/wiring → Task 12/13/15. §10 test scope → all tasks (hash determinism T1; validator codes T3; evaluator branches+boundaries T4; FakeBuilder passes T5; idempotency T8/T11; lifecycle build_failed T14; e2e T15). All 7 spec refinements: typed blocks (T2/T4), persisted failed attempts (T7/T14), lab-computed hash + ignore supplied (T1/T5), import denylist (T3), evaluator math (T4), bundle_hash in unique key (T8/T10/T11), comparison shape note (T2). Plus the 2 plan refinements: real pre-submit idempotency via `findByIdentity` + `backtest.reused`, no duplicate submit (T8 port/in-memory, T11 Drizzle, T14 handler + reuse test); specifier-scoped builtin import scan with a false-positive guard test (T3). ✔

**Type consistency:** `BacktestMetricBlock`/`ComparisonSummary` (platform-gateway.port.ts) consumed identically in T4/T8/T9/T11/T14. `assembleBundle(manifest, files)` signature stable across T1/T3/T5/T14. Repo lifecycle method names (`createGenerating`/`markBuildFailed`/`markCandidate`/`markSubmitted`; `createSubmitted`/`markCompleted`/`markRejected`/`markFailed`/`markEvaluated`/`findByIdentity`) identical in port (T7/T8), in-memory (T7/T8), Drizzle (T11), handler (T14). `EvaluatorThresholds`/`DEFAULT_EVALUATOR_THRESHOLDS` consistent T4/T9/T11/T12/T13.

**Green-typecheck ordering:** Tasks 1–12 add files / optional fields only. Task 13 extends `AppServices` and updates BOTH constructors in one commit. Tasks 14–15 consume already-present fields. No red window.

**Resolved against source (no open questions):** (a) `AgentEventRepository.listByTask(taskId)` and (b) `WorkflowRouter.dispatch(task, deps)` are both confirmed in the SP-3 source and used verbatim. The SP-3 `research-run-cycle` handler + e2e remain the reference pattern.
