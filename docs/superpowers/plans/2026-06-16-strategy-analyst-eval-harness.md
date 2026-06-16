# StrategyAnalyst Model Evaluation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an experimental harness that runs the existing `StrategyAnalyst` over a fixture across N candidate LLM models, scores each structured output offline against a deterministic rubric, and writes artifacts — with `--run` as the sole trigger for paid calls and no DB/backtester/persistence.

**Architecture:** A pure scoring core (`scoreProfile`) + an injectable orchestration loop (`runEval`) that never touches fs/clock/network directly. The CLI (`scripts/strategy-analyst-eval.ts`) is a thin trigger: dry-run computes a plan via pure `parseRoleModel` and never loads `composeMastra`; `--run` dynamically imports a `composeMastra`-backed real analyst factory and reuses the production `MastraStrategyAnalyst` adapter (no prompt/schema duplication). Each candidate failure is isolated so one bad model never aborts the run.

**Tech Stack:** TypeScript (`node --experimental-strip-types`, NodeNext, ES2022, strict), Vitest (`globals:false`), Zod (existing `AnalystProfileOutputSchema`), `@mastra/core` (existing agents), Node stdlib (`node:util` `parseArgs`, `node:fs`, `node:path`, `node:crypto`, `node:child_process`).

**Spec:** `docs/superpowers/specs/2026-06-16-strategy-analyst-eval-harness-design.md`

**Branch:** `analyst-eval-harness` (already created; spec committed there).

---

## Conventions (read once before starting)

- **Imports use explicit `.ts` extensions** (NodeNext + strip-types), e.g. `import { x } from './scoring.ts'`.
- **No TS parameter properties** — `constructor(private x)` breaks at runtime under `--experimental-strip-types`. Assign in the body.
- **Vitest `globals:false`** — every test imports `{ describe, it, expect, ... }` from `'vitest'`.
- **Test file location** — colocated `src/**/*.test.ts` (matched by `vitest.config.ts`).
- **Run a single test file:** `pnpm vitest run src/experiments/strategy-analyst/<name>.test.ts`
- **Typecheck:** `pnpm typecheck`
- **Full suite:** `pnpm test`
- All new code lives under `src/experiments/strategy-analyst/` + `scripts/strategy-analyst-eval.ts` + the rubric doc.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/experiments/strategy-analyst/types.ts` | Shared types + `JudgeVerdictSchema` (zod). Declarations only. |
| `src/experiments/strategy-analyst/scoring.ts` | **Pure** `scoreProfile(raw, {threshold}) → ScoreResult` + bucket matcher + lexicon. |
| `src/experiments/strategy-analyst/__fixtures__/profiles.ts` | Test-only profile fixtures (not a test file). |
| `src/experiments/strategy-analyst/fixtures.ts` | `resolveFixture(id) → FixtureRef`, `fingerprintSource(content)`. |
| `src/experiments/strategy-analyst/eval-harness.ts` | `runEval(input, deps) → EvalRunResult`. Orchestration; fs/clock/network injected. |
| `src/experiments/strategy-analyst/artifacts.ts` | `writeRunArtifacts(outDir, meta, result)`, `slugModel`, `compactTimestamp`. |
| `src/experiments/strategy-analyst/judge.ts` | `JudgeVerdictSchema` consumer: `runJudge(agent, {...}) → JudgeVerdict`, `buildJudgePrompt`. |
| `src/experiments/strategy-analyst/judge-agent.ts` | `createStrategyAnalystJudgeAgent(model)` (experimental judge agent). |
| `src/experiments/strategy-analyst/plan.ts` | `planDryRun({models, judge, env}) → DryRunPlan` (pure; no model construction). |
| `src/experiments/strategy-analyst/real-analyst-factory.ts` | `buildRealAnalystFor(env)` + `buildRealJudge(...)`. **Only** module that imports `composeMastra`; dynamically imported under `--run`. |
| `src/experiments/strategy-analyst/imports.guard.test.ts` | Guard test: harness modules import no forbidden modules. |
| `scripts/strategy-analyst-eval.ts` | Thin CLI trigger. |
| `docs/fixtures/strategies/long-oi-strategy-rubric.md` | Checked-in judge rubric. |
| `package.json` | Add `analyst:eval` script. |

---

## Task 1: Shared types

**Files:**
- Create: `src/experiments/strategy-analyst/types.ts`

- [ ] **Step 1: Create the types module**

```ts
// src/experiments/strategy-analyst/types.ts
import { z } from 'zod';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';

export type EvalMode = 'dry-run' | 'run';

export interface FixtureRef {
  id: string;
  sourcePath: string;
  notesPath: string;
  rubricPath: string;
}

export interface CheckResult {
  id: string;
  weight: number;
  bucketsHit: number;
  bucketCount: number;
  contribution: number;
  matched: string[];
}

export interface ScoreResult {
  gates: { schemaValid: boolean; directionLong: boolean };
  checks: CheckResult[];
  score: number; // 0..1 — always a number; scoreProfile only runs when a raw object exists
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}

export type CandidateErrorType = 'schema' | 'provider' | 'adapter' | 'timeout' | 'unknown';

export interface CandidateError {
  type: CandidateErrorType;
  message: string;
}

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
  overallScore: z.number().min(0).max(1),
  hallucinations: z.array(z.string()),
  missingFromProfile: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;        // null only when analyze() threw
  rawOutput: AnalystProfileOutput | null; // present only when analyze() returned
  error: CandidateError | null;
  judge: JudgeVerdict | null;       // populated only when --judge ran; written to a SEPARATE file
}

export interface EvalRunResult {
  fixture: { id: string; fingerprint: string };
  threshold: number;
  judgeEnabled: boolean;
  models: string[];
  perModel: CandidateResult[];
  overallSuccess: boolean;          // >=1 PASS
}

export interface ManifestMeta {
  timestamp: string;
  gitSha: string;
  harnessVersion: string;
  contractVersion: string;
  mode: EvalMode;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/experiments/strategy-analyst/types.ts
git commit -m "feat(analyst-eval): shared harness types + JudgeVerdictSchema"
```

---

## Task 2: Test-profile fixtures

These are reused by scoring and harness tests. Not a test file (won't match `*.test.ts`).

**Files:**
- Create: `src/experiments/strategy-analyst/__fixtures__/profiles.ts`

- [ ] **Step 1: Create the fixtures**

```ts
// src/experiments/strategy-analyst/__fixtures__/profiles.ts
import type { AnalystProfileOutput } from '../../../domain/strategy-profile.ts';

/** A strong long_oi profile that should PASS every check. Mirrors research-notes §4–13. */
export const GOOD_LONG_OI_PROFILE: AnalystProfileOutput = {
  direction: 'long',
  coreIdea: 'Long-only mean-reversion: after a sharp dump, enter on a confirmed bounce backed by OI recovery and long liquidations.',
  summary: 'Rule-based FSM on 1m candles. Detects a dump, watches for reversal, enters long when price rises, open interest recovers and long liquidations are present.',
  requiredMarketFeatures: ['ohlcv', 'open interest', 'liquidations'],
  entryConditions: [
    'Dump of >=10% detected over the lookback window',
    'Bounce/reversal from the local low confirmed by green candles',
    'Open interest (OI) recovering',
    'Long liquidations present',
  ],
  exitConditions: [
    'TP1 at +3.5% (partial 50%)',
    'TP2 at +5% (full exit)',
    'Hard stop (SL) at -12%',
    'Time exit after 180 minutes',
  ],
  timeframes: ['1m'],
  indicators: [],
  parameters: [
    { name: 'dump.minDropPct', value: 10, unit: '%', description: 'Minimum drop to trigger', tunable: true },
    { name: 'tpLadder.tp1Pct', value: 3.5, unit: '%', description: 'First take profit', tunable: true },
  ],
  watchLifecycleSummary: 'IDLE -> WATCHING -> IN_POSITION -> COOLDOWN.',
  positionManagementSummary: 'DCA averaging up to two adds on further dips; move stop to breakeven (BE) after TP1.',
  riskManagementSummary: 'Risk sizing, leverage and fills are owned by the runner/platform; the strategy only emits a sizing hint for DCA.',
  runnerOwnedAuthorities: ['position sizing', 'leverage', 'fills', 'execution'],
  confidence: 0.8,
  unknowns: [
    'Exact position sizing and leverage are not specified',
    'Fees/commissions are not specified',
    'Target exchange/venue is not specified',
    'Instrument universe (which symbols) is not specified',
  ],
  evidence: ['"Торгую только в long"', '"первый тейк на +3.5%"'],
};

/** Same as GOOD but direction flipped -> gate 2 fails. */
export const SHORT_DIRECTION_PROFILE: AnalystProfileOutput = { ...GOOD_LONG_OI_PROFILE, direction: 'short' };

/** GOOD but riskManagementSummary fabricates leverage + base size -> check 5 = 0. */
export const FABRICATED_RISK_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  riskManagementSummary: 'Use 10x leverage with a base order size of $100 per entry.',
};

/** GOOD but DCA size hints (1.2x/1.5x) mentioned in risk text -> must NOT trip check 5. */
export const DCA_HINT_RISK_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  riskManagementSummary: 'Sizing is host-owned. DCA adds use sizing hints of 1.2x then 1.5x of the prior size.',
};

/** GOOD but exitConditions omit TP2 -> check 3 partial credit. */
export const MISSING_TP2_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  exitConditions: ['TP1 at +3.5%', 'Hard stop (SL) at -12%', 'Time exit after 180 minutes'],
};

/** GOOD but DCA/BE only in summary, positionManagementSummary empty -> check 4 via fallback. */
export const POSMGMT_IN_SUMMARY_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  summary: GOOD_LONG_OI_PROFILE.summary + ' It uses DCA averaging and moves the stop to breakeven after TP1.',
  positionManagementSummary: null,
};

/** Russian-only phrasing for entry/exit/posmgmt -> synonym buckets must still hit. */
export const RU_PROFILE: AnalystProfileOutput = {
  ...GOOD_LONG_OI_PROFILE,
  requiredMarketFeatures: ['свечи ohlcv', 'открытый интерес (oi)', 'ликвидации'],
  entryConditions: ['пролив более 10%', 'отскок от минимума, две зелёные свечи', 'восстановление oi', 'присутствуют long-ликвидации'],
  exitConditions: ['первый тейк +3.5%', 'второй тейк +5%', 'жёсткий стоп -12%', 'выход по времени 180 минут'],
  positionManagementSummary: 'Усреднение (DCA) до двух доливок; перенос стопа в безубыток после TP1.',
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/experiments/strategy-analyst/__fixtures__/profiles.ts
git commit -m "test(analyst-eval): shared candidate-profile fixtures"
```

---

## Task 3: Scoring core (`scoreProfile`)

The pure deterministic scorer. This is the heart of the harness.

**Files:**
- Create: `src/experiments/strategy-analyst/scoring.ts`
- Test: `src/experiments/strategy-analyst/scoring.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { scoreProfile } from './scoring.ts';
import {
  GOOD_LONG_OI_PROFILE, SHORT_DIRECTION_PROFILE, FABRICATED_RISK_PROFILE,
  DCA_HINT_RISK_PROFILE, MISSING_TP2_PROFILE, POSMGMT_IN_SUMMARY_PROFILE, RU_PROFILE,
} from './__fixtures__/profiles.ts';

function checkById(r: ReturnType<typeof scoreProfile>, id: string) {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not found`);
  return c;
}

describe('scoreProfile — gates', () => {
  it('schema-invalid raw object: schemaValid false, score 0, verdict FAIL', () => {
    const r = scoreProfile({ not: 'a profile' });
    expect(r.gates.schemaValid).toBe(false);
    expect(r.gates.directionLong).toBe(false);
    expect(r.score).toBe(0);
    expect(r.checks).toEqual([]);
    expect(r.verdict).toBe('FAIL');
  });

  it('direction !== long: gate fails, verdict FAIL even if checks score high', () => {
    const r = scoreProfile(SHORT_DIRECTION_PROFILE);
    expect(r.gates.schemaValid).toBe(true);
    expect(r.gates.directionLong).toBe(false);
    expect(r.score).toBeGreaterThan(0.5); // checks still computed for diagnostics
    expect(r.verdict).toBe('FAIL');
  });
});

describe('scoreProfile — positive checks', () => {
  it('good profile passes all checks (score ~1) and verdict PASS', () => {
    const r = scoreProfile(GOOD_LONG_OI_PROFILE);
    expect(r.gates).toEqual({ schemaValid: true, directionLong: true });
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });

  it('missing TP2 -> exitConditions check partial (3 of 4 buckets)', () => {
    const r = scoreProfile(MISSING_TP2_PROFILE);
    const c = checkById(r, 'exit_ladder');
    expect(c.bucketsHit).toBe(3);
    expect(c.bucketCount).toBe(4);
    expect(c.contribution).toBeCloseTo((3 / 4) * 0.2, 5);
  });

  it('DCA/BE only in summary -> positionMgmt check hits via fallback', () => {
    const r = scoreProfile(POSMGMT_IN_SUMMARY_PROFILE);
    const c = checkById(r, 'position_mgmt');
    expect(c.bucketsHit).toBe(2);
  });

  it('Russian-only phrasing still matches synonym buckets', () => {
    const r = scoreProfile(RU_PROFILE);
    expect(r.score).toBeGreaterThanOrEqual(0.99);
    expect(r.verdict).toBe('PASS');
  });
});

describe('scoreProfile — negative risk check (5)', () => {
  it('clean risk summary -> full credit', () => {
    const c = checkById(scoreProfile(GOOD_LONG_OI_PROFILE), 'risk_no_fabrication');
    expect(c.contribution).toBeCloseTo(0.15, 5);
    expect(c.matched).toEqual([]);
  });

  it('fabricated leverage + base size -> zero credit', () => {
    const c = checkById(scoreProfile(FABRICATED_RISK_PROFILE), 'risk_no_fabrication');
    expect(c.contribution).toBe(0);
    expect(c.matched.length).toBeGreaterThan(0);
  });

  it('DCA size hints (1.2x/1.5x) do NOT count as fabrication', () => {
    const c = checkById(scoreProfile(DCA_HINT_RISK_PROFILE), 'risk_no_fabrication');
    expect(c.contribution).toBeCloseTo(0.15, 5);
  });
});

describe('scoreProfile — threshold', () => {
  it('score below threshold -> FAIL even with gates passing', () => {
    const r = scoreProfile(MISSING_TP2_PROFILE, { threshold: 0.999 });
    expect(r.gates).toEqual({ schemaValid: true, directionLong: true });
    expect(r.verdict).toBe('FAIL');
  });
  it('default threshold is 0.8', () => {
    expect(scoreProfile(GOOD_LONG_OI_PROFILE).threshold).toBe(0.8);
  });
});

describe('bucket matching robustness', () => {
  it('the oi token does not match inside unrelated words', () => {
    // "avoid"/"point" contain the substring "oi" but must not satisfy the OI bucket
    const profile = { ...GOOD_LONG_OI_PROFILE, requiredMarketFeatures: ['ohlcv', 'avoid the point', 'liquidations'] };
    const c = checkById(scoreProfile(profile), 'market_features');
    expect(c.bucketsHit).toBe(2); // ohlcv + liquidations, NOT oi
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/experiments/strategy-analyst/scoring.test.ts`
Expected: FAIL — `scoreProfile` is not defined / module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/experiments/strategy-analyst/scoring.ts
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { CheckResult, ScoreResult } from './types.ts';

export const DEFAULT_THRESHOLD = 0.8;

/** A bucket is satisfied when ANY of its regex sources matches the haystack (case-insensitive). */
interface Bucket {
  label: string;
  any: string[]; // regex sources
}

interface PositiveCheckDef {
  id: string;
  weight: number;
  primary: (p: AnalystProfileOutput) => string;
  fallback?: (p: AnalystProfileOutput) => string;
  buckets: Bucket[];
}

function joinFields(...parts: Array<string | string[] | null | undefined>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part == null) continue;
    if (Array.isArray(part)) out.push(part.join(' • '));
    else out.push(part);
  }
  return out.join(' • ').toLowerCase();
}

function matchBuckets(haystack: string, buckets: Bucket[]): { hits: number; matched: string[] } {
  const matched: string[] = [];
  for (const bucket of buckets) {
    const hit = bucket.any.some((src) => new RegExp(src, 'i').test(haystack));
    if (hit) matched.push(bucket.label);
  }
  return { hits: matched.length, matched };
}

// --- lexicon (EN + RU synonyms; short ASCII tokens use \b boundaries to avoid false positives) ---
const OI: Bucket = { label: 'oi', any: ['\\boi\\b', 'open[ _]?interest', 'интерес'] };
const LIQ: Bucket = { label: 'liquidations', any: ['liquidation', '\\bliq\\b', 'ликвидац'] };

const POSITIVE_CHECKS: PositiveCheckDef[] = [
  {
    id: 'market_features',
    weight: 0.2,
    primary: (p) => joinFields(p.requiredMarketFeatures),
    fallback: (p) => joinFields(p.summary, p.coreIdea),
    buckets: [
      { label: 'ohlcv', any: ['ohlcv', 'candle', 'свеч', 'klines', '\\bprice\\b'] },
      OI,
      LIQ,
    ],
  },
  {
    id: 'entry_trigger',
    weight: 0.2,
    primary: (p) => joinFields(p.entryConditions),
    fallback: (p) => joinFields(p.summary, p.coreIdea),
    buckets: [
      { label: 'dump', any: ['dump', 'drop', 'sell[ -]?off', 'crash', 'пролив', 'падени', 'обвал'] },
      { label: 'bounce', any: ['bounce', 'rebound', 'revers', 'отскок', 'разворот', 'восстановлен'] },
      OI,
      LIQ,
    ],
  },
  {
    id: 'exit_ladder',
    weight: 0.2,
    primary: (p) => joinFields(p.exitConditions),
    fallback: (p) => joinFields(p.summary),
    buckets: [
      { label: 'tp1', any: ['tp[ _]?1', 'take[ _]?profit[ _]?1', '3\\.5\\s*%', '\\+3\\.5', 'первый\\s+тейк'] },
      { label: 'tp2', any: ['tp[ _]?2', 'take[ _]?profit[ _]?2', '\\b5\\s*%', 'второй\\s+тейк'] },
      { label: 'sl', any: ['\\bsl\\b', 'stop[ -]?loss', 'hard[ _]?stop', 'стоп', '12\\s*%'] },
      { label: 'time', any: ['time[ _]?exit', 'time[ -]?based', '\\b180\\b', 'timeout', 'по\\s+времени', 'времен'] },
    ],
  },
  {
    id: 'position_mgmt',
    weight: 0.15,
    primary: (p) => joinFields(p.positionManagementSummary),
    fallback: (p) => joinFields(p.summary),
    buckets: [
      { label: 'dca', any: ['\\bdca\\b', 'averag', 'add[ _]?to[ _]?position', 'scal\\w*\\s*in', 'усреднен', 'доливк', 'докуп'] },
      { label: 'breakeven', any: ['break[ _-]?even', '\\bbe\\b', 'безубыт'] },
    ],
  },
  {
    id: 'unknowns_flagged',
    weight: 0.1,
    primary: (p) => joinFields(p.unknowns),
    buckets: [
      { label: 'sizing', any: ['\\bsiz', 'leverage', 'плеч', 'equity', 'марж'] },
      { label: 'fees', any: ['\\bfee', 'commission', 'комисс'] },
      { label: 'exchange', any: ['exchange', 'venue', 'бирж', 'okx', 'bybit', 'binance', 'bitget'] },
      { label: 'universe', any: ['universe', '\\bsymbol', 'instrument', '\\bpairs?\\b', 'which\\s+coins', 'инструмент', 'тикер'] },
    ],
  },
];

const RISK_WEIGHT = 0.15;

// Fabrication patterns for the negative check. Leverage requires >=2x OR the explicit word,
// so DCA size hints (1.2x/1.5x) are NOT flagged.
const FAB_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'leverage_x', re: /\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]\b/i },
  { label: 'leverage_word', re: /leverage\s*[:=]?\s*\d/i },
  { label: 'leverage_ru', re: /плеч\w*\s*[:=]?\s*\d/i },
  { label: 'base_size_usd', re: /\$\s*\d|\b\d+\s*(?:usd|usdt|dollars?)\b|base[ _]?order\s*[:=]?\s*\d/i },
  { label: 'equity_fraction', re: /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:equity|account|balance|capital|portfolio|deposit|депозит)/i },
];

const FAB_PARAM_NAME = /leverage|плеч|margin|марж|base.?order|position.?siz|order.?siz|notional/i;

function scoreRiskNoFabrication(p: AnalystProfileOutput): CheckResult {
  const matched: string[] = [];
  const riskText = (p.riskManagementSummary ?? '').toString();
  for (const { label, re } of FAB_PATTERNS) if (re.test(riskText)) matched.push(label);
  const paramFab = p.parameters.some((param) => param.value != null && FAB_PARAM_NAME.test(param.name));
  if (paramFab) matched.push('param_sizing');
  const clean = matched.length === 0;
  return {
    id: 'risk_no_fabrication',
    weight: RISK_WEIGHT,
    bucketsHit: clean ? 1 : 0,
    bucketCount: 1,
    contribution: clean ? RISK_WEIGHT : 0,
    matched,
  };
}

export function scoreProfile(raw: unknown, opts?: { threshold?: number }): ScoreResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const parsed = AnalystProfileOutputSchema.safeParse(raw);

  if (!parsed.success) {
    return { gates: { schemaValid: false, directionLong: false }, checks: [], score: 0, threshold, verdict: 'FAIL' };
  }

  const profile = parsed.data;
  const gates = { schemaValid: true, directionLong: profile.direction === 'long' };

  const checks: CheckResult[] = [];
  for (const def of POSITIVE_CHECKS) {
    let haystack = def.primary(profile);
    if (haystack.trim() === '' && def.fallback) haystack = def.fallback(profile);
    const { hits, matched } = matchBuckets(haystack, def.buckets);
    const bucketCount = def.buckets.length;
    checks.push({ id: def.id, weight: def.weight, bucketsHit: hits, bucketCount, contribution: (hits / bucketCount) * def.weight, matched });
  }
  checks.push(scoreRiskNoFabrication(profile));

  const score = checks.reduce((sum, c) => sum + c.contribution, 0);
  const verdict = gates.schemaValid && gates.directionLong && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/scoring.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/experiments/strategy-analyst/scoring.ts src/experiments/strategy-analyst/scoring.test.ts
git commit -m "feat(analyst-eval): pure deterministic scoreProfile (gates + weighted checks)"
```

---

## Task 4: Fixture resolution + fingerprint

**Files:**
- Create: `src/experiments/strategy-analyst/fixtures.ts`
- Test: `src/experiments/strategy-analyst/fixtures.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { resolveFixture, fingerprintSource, FIXTURES } from './fixtures.ts';

describe('resolveFixture', () => {
  it('resolves the long-oi fixture to its source/notes/rubric paths', () => {
    const ref = resolveFixture('long-oi');
    expect(ref.id).toBe('long-oi');
    expect(ref.sourcePath).toBe('docs/fixtures/strategies/long-oi-strategy-source.md');
    expect(ref.notesPath).toBe('docs/fixtures/strategies/long-oi-strategy-research-notes.md');
    expect(ref.rubricPath).toBe('docs/fixtures/strategies/long-oi-strategy-rubric.md');
  });

  it('throws a clear error for an unknown fixture id', () => {
    expect(() => resolveFixture('nope')).toThrow(/unknown fixture/i);
  });

  it('FIXTURES is the registry of known ids', () => {
    expect(Object.keys(FIXTURES)).toContain('long-oi');
  });
});

describe('fingerprintSource', () => {
  it('is a sha256: prefixed stable hash', () => {
    const fp = fingerprintSource('hello');
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintSource('hello')).toBe(fp); // deterministic
    expect(fingerprintSource('hello2')).not.toBe(fp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/experiments/strategy-analyst/fixtures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/experiments/strategy-analyst/fixtures.ts
import { createHash } from 'node:crypto';
import type { FixtureRef } from './types.ts';

const DIR = 'docs/fixtures/strategies';

export const FIXTURES: Record<string, FixtureRef> = {
  'long-oi': {
    id: 'long-oi',
    sourcePath: `${DIR}/long-oi-strategy-source.md`,
    notesPath: `${DIR}/long-oi-strategy-research-notes.md`,
    rubricPath: `${DIR}/long-oi-strategy-rubric.md`,
  },
};

export function resolveFixture(id: string): FixtureRef {
  const ref = FIXTURES[id];
  if (!ref) throw new Error(`unknown fixture "${id}" (known: ${Object.keys(FIXTURES).join(', ')})`);
  return ref;
}

export function fingerprintSource(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/fixtures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/experiments/strategy-analyst/fixtures.ts src/experiments/strategy-analyst/fixtures.test.ts
git commit -m "feat(analyst-eval): fixture registry + source fingerprint"
```

---

## Task 5: Eval harness (`runEval`) — success + error isolation

**Files:**
- Create: `src/experiments/strategy-analyst/eval-harness.ts`
- Test: `src/experiments/strategy-analyst/eval-harness.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/eval-harness.test.ts
import { describe, it, expect } from 'vitest';
import { runEval } from './eval-harness.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { StrategyAnalystInput } from '../../domain/strategy-source.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { JudgeVerdict } from './types.ts';
import { GOOD_LONG_OI_PROFILE } from './__fixtures__/profiles.ts';

function fakeAnalyst(out: AnalystProfileOutput): StrategyAnalystPort {
  return {
    adapter: 'fake',
    model: 'fake',
    async analyze(_input: StrategyAnalystInput): Promise<AnalystProfileOutput> {
      return out;
    },
  };
}

function throwingAnalyst(message: string): StrategyAnalystPort {
  return {
    adapter: 'fake',
    model: 'fake',
    async analyze(): Promise<AnalystProfileOutput> {
      throw new Error(message);
    },
  };
}

const baseInput = {
  models: ['anthropic/claude-x', 'openai/gpt-x'],
  fixtureId: 'long-oi',
  fixtureText: 'long only strategy text',
  fixtureFingerprint: 'sha256:abc',
  threshold: 0.8,
};

function deps(map: Record<string, StrategyAnalystPort>, judge?: (p: AnalystProfileOutput) => Promise<JudgeVerdict>) {
  let tick = 0;
  return {
    analystFor: (m: string) => map[m]!,
    providerOf: (m: string) => ({ provider: m.split('/')[0]!, modelId: m.split('/').slice(1).join('/') }),
    clock: () => (tick += 100), // deterministic latency
    judge,
  };
}

describe('runEval', () => {
  it('passes the fixture as manual_description content and scores each model', async () => {
    let seen: StrategyAnalystInput | undefined;
    const capturing: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      async analyze(input) { seen = input; return GOOD_LONG_OI_PROFILE; },
    };
    const result = await runEval(baseInput, deps({ 'anthropic/claude-x': capturing, 'openai/gpt-x': capturing }));
    expect(seen).toEqual({ kind: 'manual_description', content: 'long only strategy text', title: 'long-oi' });
    expect(result.perModel).toHaveLength(2);
    expect(result.perModel.every((r) => r.verdict === 'PASS')).toBe(true);
    expect(result.overallSuccess).toBe(true);
    expect(result.fixture).toEqual({ id: 'long-oi', fingerprint: 'sha256:abc' });
  });

  it('isolates a throwing model: FAIL + error recorded, run continues, other model PASSes', async () => {
    const result = await runEval(baseInput, deps({
      'anthropic/claude-x': throwingAnalyst('schema validation failed'),
      'openai/gpt-x': fakeAnalyst(GOOD_LONG_OI_PROFILE),
    }));
    expect(result.perModel).toHaveLength(2);
    const bad = result.perModel.find((r) => r.model === 'anthropic/claude-x')!;
    expect(bad.verdict).toBe('FAIL');
    expect(bad.score).toBeNull();
    expect(bad.rawOutput).toBeNull();
    expect(bad.error).toEqual({ type: 'schema', message: 'schema validation failed' });
    const good = result.perModel.find((r) => r.model === 'openai/gpt-x')!;
    expect(good.verdict).toBe('PASS');
    expect(result.overallSuccess).toBe(true);
  });

  it('classifies a timeout error', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] }, deps({ 'x/y': throwingAnalyst('request timed out after 30s') }));
    expect(result.perModel[0]!.error!.type).toBe('timeout');
  });

  it('runs an injected judge and attaches its verdict (separate from deterministic verdict)', async () => {
    const judgeVerdict: JudgeVerdict = { dimensions: [], overallScore: 0.9, hallucinations: [], missingFromProfile: [], notes: 'ok' };
    const result = await runEval({ ...baseInput, models: ['x/y'] },
      deps({ 'x/y': fakeAnalyst(GOOD_LONG_OI_PROFILE) }, async () => judgeVerdict));
    expect(result.judgeEnabled).toBe(true);
    expect(result.perModel[0]!.judge).toEqual(judgeVerdict);
    expect(result.perModel[0]!.verdict).toBe('PASS'); // judge did not change it
  });

  it('judge failure does not fail the candidate (judge stays null)', async () => {
    const result = await runEval({ ...baseInput, models: ['x/y'] },
      deps({ 'x/y': fakeAnalyst(GOOD_LONG_OI_PROFILE) }, async () => { throw new Error('judge boom'); }));
    expect(result.perModel[0]!.verdict).toBe('PASS');
    expect(result.perModel[0]!.judge).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/experiments/strategy-analyst/eval-harness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/experiments/strategy-analyst/eval-harness.ts
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { scoreProfile } from './scoring.ts';
import type { CandidateError, CandidateResult, EvalRunResult, JudgeVerdict } from './types.ts';

export interface RunEvalInput {
  models: string[];
  fixtureId: string;
  fixtureText: string;
  fixtureFingerprint: string;
  threshold: number;
}

export interface RunEvalDeps {
  analystFor: (modelId: string) => StrategyAnalystPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (profile: AnalystProfileOutput) => Promise<JudgeVerdict>;
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const perModel: CandidateResult[] = [];

  for (const model of input.models) {
    const { provider, modelId } = deps.providerOf(model);
    const start = deps.clock();
    try {
      const analyst = deps.analystFor(model);
      const raw = await analyst.analyze({ kind: 'manual_description', content: input.fixtureText, title: input.fixtureId });
      const latencyMs = deps.clock() - start;
      const score = scoreProfile(raw, { threshold: input.threshold });

      let judge: JudgeVerdict | null = null;
      if (deps.judge) {
        try {
          judge = await deps.judge(raw);
        } catch (judgeErr) {
          // Judge is best-effort and NEVER affects the deterministic verdict.
          process.stderr.write(`judge failed for ${model}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
          judge = null;
        }
      }

      perModel.push({ model, provider, modelId, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge });
    } catch (err) {
      const latencyMs = deps.clock() - start;
      perModel.push({ model, provider, modelId, latencyMs, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null });
    }
  }

  return {
    fixture: { id: input.fixtureId, fingerprint: input.fixtureFingerprint },
    threshold: input.threshold,
    judgeEnabled: deps.judge != null,
    models: input.models,
    perModel,
    overallSuccess: perModel.some((r) => r.verdict === 'PASS'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/eval-harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/experiments/strategy-analyst/eval-harness.ts src/experiments/strategy-analyst/eval-harness.test.ts
git commit -m "feat(analyst-eval): runEval orchestration with per-model error isolation + optional judge"
```

---

## Task 6: Artifacts writer

**Files:**
- Create: `src/experiments/strategy-analyst/artifacts.ts`
- Test: `src/experiments/strategy-analyst/artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/artifacts.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeRunArtifacts, slugModel, compactTimestamp } from './artifacts.ts';
import type { EvalRunResult, ManifestMeta } from './types.ts';

const ROOT = '.artifacts-test/analyst-eval';

afterEach(() => rmSync('.artifacts-test', { recursive: true, force: true }));

describe('slugModel', () => {
  it('replaces / and : with _', () => {
    expect(slugModel('openrouter/x-ai/grok:beta')).toBe('openrouter_x-ai_grok_beta');
  });
});

describe('compactTimestamp', () => {
  it('formats a Date as compact UTC', () => {
    expect(compactTimestamp(new Date('2026-06-16T15:30:00.000Z'))).toBe('20260616T153000Z');
  });
});

function sampleResult(): EvalRunResult {
  return {
    fixture: { id: 'long-oi', fingerprint: 'sha256:abc' },
    threshold: 0.8,
    judgeEnabled: true,
    models: ['openai/gpt-x'],
    overallSuccess: true,
    perModel: [{
      model: 'openai/gpt-x', provider: 'openai', modelId: 'gpt-x', latencyMs: 123,
      verdict: 'PASS',
      score: { gates: { schemaValid: true, directionLong: true }, checks: [], score: 0.9, threshold: 0.8, verdict: 'PASS' },
      rawOutput: null,
      error: null,
      judge: { dimensions: [], overallScore: 0.8, hallucinations: [], missingFromProfile: [], notes: 'n' },
    }],
  };
}

const meta: ManifestMeta = {
  timestamp: '20260616T153000Z', gitSha: 'abc1234', harnessVersion: 'analyst-eval-v1',
  contractVersion: 'strategy-profile-v1', mode: 'run',
};

describe('writeRunArtifacts', () => {
  it('writes manifest.json, per-model json, and a SEPARATE judge file (judge excluded from model json)', () => {
    const outDir = join(ROOT, 'long-oi', meta.timestamp);
    const written = writeRunArtifacts(outDir, meta, sampleResult());

    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'openai_gpt-x.json'))).toBe(true);
    expect(existsSync(join(outDir, 'openai_gpt-x.judge.json'))).toBe(true);
    expect(written.length).toBe(3);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.mode).toBe('run');
    expect(manifest.contractVersion).toBe('strategy-profile-v1');
    expect(manifest.overallSuccess).toBe(true);
    expect(manifest.perModel).toEqual([{ model: 'openai/gpt-x', verdict: 'PASS', score: 0.9 }]);

    const modelJson = JSON.parse(readFileSync(join(outDir, 'openai_gpt-x.json'), 'utf8'));
    expect(modelJson.judge).toBeUndefined(); // judge lives only in the separate file
    expect(modelJson.verdict).toBe('PASS');

    const judgeJson = JSON.parse(readFileSync(join(outDir, 'openai_gpt-x.judge.json'), 'utf8'));
    expect(judgeJson.overallScore).toBe(0.8);
  });

  it('omits the judge file when judge is null', () => {
    const result = sampleResult();
    result.perModel[0]!.judge = null;
    const outDir = join(ROOT, 'long-oi', 'nojudge');
    const written = writeRunArtifacts(outDir, meta, result);
    expect(existsSync(join(outDir, 'openai_gpt-x.judge.json'))).toBe(false);
    expect(written.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/experiments/strategy-analyst/artifacts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/experiments/strategy-analyst/artifacts.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CandidateResult, EvalRunResult, ManifestMeta } from './types.ts';

export function slugModel(model: string): string {
  return model.replace(/[/:]/g, '_');
}

export function compactTimestamp(date: Date): string {
  // 2026-06-16T15:30:00.000Z -> 20260616T153000Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Returns the list of written file paths. Judge (if present) is written to a SEPARATE file. */
export function writeRunArtifacts(outDir: string, meta: ManifestMeta, result: EvalRunResult): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  for (const candidate of result.perModel) {
    const slug = slugModel(candidate.model);
    const { judge, ...withoutJudge } = candidate; // judge excluded from the per-model file
    const modelPath = join(outDir, `${slug}.json`);
    writeJson(modelPath, withoutJudge);
    written.push(modelPath);

    if (judge != null) {
      const judgePath = join(outDir, `${slug}.judge.json`);
      writeJson(judgePath, judge);
      written.push(judgePath);
    }
  }

  const manifestPath = join(outDir, 'manifest.json');
  writeJson(manifestPath, {
    timestamp: meta.timestamp,
    gitSha: meta.gitSha,
    harnessVersion: meta.harnessVersion,
    contractVersion: meta.contractVersion,
    mode: meta.mode,
    fixture: result.fixture,
    threshold: result.threshold,
    judgeEnabled: result.judgeEnabled,
    models: result.models,
    perModel: result.perModel.map((c: CandidateResult) => ({ model: c.model, verdict: c.verdict, score: c.score?.score ?? null })),
    overallSuccess: result.overallSuccess,
  });
  written.push(manifestPath);

  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/artifacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/experiments/strategy-analyst/artifacts.ts src/experiments/strategy-analyst/artifacts.test.ts
git commit -m "feat(analyst-eval): artifact writer (manifest + per-model + separate judge file)"
```

---

## Task 7: Judge agent + judge runner

**Files:**
- Create: `src/experiments/strategy-analyst/judge-agent.ts`
- Create: `src/experiments/strategy-analyst/judge.ts`
- Test: `src/experiments/strategy-analyst/judge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/judge.test.ts
import { describe, it, expect } from 'vitest';
import { runJudge, buildJudgePrompt } from './judge.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';
import { GOOD_LONG_OI_PROFILE } from './__fixtures__/profiles.ts';

// Minimal fake of the @mastra/core Agent surface used by runJudge.
function fakeAgent(verdict: JudgeVerdict) {
  return {
    async generate(_prompt: string, _opts: unknown) {
      return { object: verdict };
    },
  };
}

const verdict: JudgeVerdict = {
  dimensions: [{ name: 'direction', score: 1, rationale: 'long' }],
  overallScore: 0.85, hallucinations: [], missingFromProfile: [], notes: 'good',
};

describe('buildJudgePrompt', () => {
  it('includes the rubric, the research notes, and the candidate profile JSON', () => {
    const prompt = buildJudgePrompt({ profile: GOOD_LONG_OI_PROFILE, rubricText: 'RUBRIC-MARK', notesText: 'NOTES-MARK' });
    expect(prompt).toContain('RUBRIC-MARK');
    expect(prompt).toContain('NOTES-MARK');
    expect(prompt).toContain('"direction": "long"');
  });
});

describe('runJudge', () => {
  it('returns a schema-valid JudgeVerdict from the agent', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJudge(fakeAgent(verdict) as any, { profile: GOOD_LONG_OI_PROFILE, rubricText: 'r', notesText: 'n' });
    expect(JudgeVerdictSchema.safeParse(out).success).toBe(true);
    expect(out.overallScore).toBe(0.85);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/experiments/strategy-analyst/judge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the judge agent**

```ts
// src/experiments/strategy-analyst/judge-agent.ts
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const STRATEGY_ANALYST_JUDGE_AGENT_ID = 'strategy-analyst-judge';

const INSTRUCTIONS = [
  'You are evaluating a candidate StrategyProfile produced by another model against a rubric and reference research notes.',
  'Score each rubric dimension from 0 to 1 with a short rationale.',
  'List any claims in the profile that are NOT supported by the source/notes (hallucinations).',
  'List rubric items the profile omitted (missingFromProfile).',
  'Be strict and concise. Do not propose changes; only assess.',
].join(' ');

export function createStrategyAnalystJudgeAgent(model: ProviderModel): Agent {
  return new Agent({ id: STRATEGY_ANALYST_JUDGE_AGENT_ID, name: 'Strategy Analyst Judge', instructions: INSTRUCTIONS, model });
}
```

- [ ] **Step 4: Write the judge runner**

```ts
// src/experiments/strategy-analyst/judge.ts
import type { Agent } from '@mastra/core/agent';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import { JudgeVerdictSchema, type JudgeVerdict } from './types.ts';

export interface JudgeInput {
  profile: AnalystProfileOutput;
  rubricText: string;
  notesText: string;
}

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    '--- RUBRIC START ---',
    input.rubricText,
    '--- RUBRIC END ---',
    '',
    '--- RESEARCH NOTES (reference) START ---',
    input.notesText,
    '--- RESEARCH NOTES END ---',
    '',
    '--- CANDIDATE PROFILE (JSON) START ---',
    JSON.stringify(input.profile, null, 2),
    '--- CANDIDATE PROFILE END ---',
    '',
    'Return the structured judge verdict.',
  ].join('\n');
}

export async function runJudge(agent: Agent, input: JudgeInput): Promise<JudgeVerdict> {
  const result = await agent.generate(buildJudgePrompt(input), { structuredOutput: { schema: JudgeVerdictSchema } });
  return JudgeVerdictSchema.parse(result.object);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/judge.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/experiments/strategy-analyst/judge.ts src/experiments/strategy-analyst/judge-agent.ts src/experiments/strategy-analyst/judge.test.ts
git commit -m "feat(analyst-eval): opt-in LLM-as-a-judge agent + runner (rubric + notes)"
```

---

## Task 8: Dry-run planner

**Files:**
- Create: `src/experiments/strategy-analyst/plan.ts`
- Test: `src/experiments/strategy-analyst/plan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/plan.test.ts
import { describe, it, expect } from 'vitest';
import { planDryRun, KEY_BY_PROVIDER } from './plan.ts';

describe('planDryRun', () => {
  it('resolves providers via prefix and reports key presence per model', () => {
    const plan = planDryRun({
      models: ['anthropic/claude-x', 'openai/gpt-x'],
      judge: false,
      env: { ANTHROPIC_API_KEY: 'a' }, // OPENAI_API_KEY missing
    });
    expect(plan.perModel).toEqual([
      { model: 'anthropic/claude-x', provider: 'anthropic', modelId: 'claude-x', requiredKey: 'ANTHROPIC_API_KEY', keyPresent: true },
      { model: 'openai/gpt-x', provider: 'openai', modelId: 'gpt-x', requiredKey: 'OPENAI_API_KEY', keyPresent: false },
    ]);
    expect(plan.analystCalls).toBe(2);
    expect(plan.judgeCalls).toBe(0);
    expect(plan.totalPaidCalls).toBe(2);
    expect(plan.missingKeys).toEqual(['OPENAI_API_KEY']);
  });

  it('counts judge calls when judge is enabled', () => {
    const plan = planDryRun({ models: ['x/y', 'a/b'], judge: true, env: {} });
    expect(plan.judgeCalls).toBe(2);
    expect(plan.totalPaidCalls).toBe(4);
  });

  it('falls back to MODEL_PROVIDER for an unprefixed id', () => {
    const plan = planDryRun({ models: ['claude-x'], judge: false, env: { MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' } });
    expect(plan.perModel[0]!.provider).toBe('anthropic');
    expect(plan.perModel[0]!.keyPresent).toBe(true);
  });

  it('marks an unresolvable provider (no prefix, no MODEL_PROVIDER) as unknown', () => {
    const plan = planDryRun({ models: ['mystery-model'], judge: false, env: {} });
    expect(plan.perModel[0]!.provider).toBe('unknown');
    expect(plan.perModel[0]!.keyPresent).toBe(false);
  });

  it('KEY_BY_PROVIDER maps each provider to its env var', () => {
    expect(KEY_BY_PROVIDER).toEqual({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/experiments/strategy-analyst/plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/experiments/strategy-analyst/plan.ts
import { parseRoleModel, MODEL_PROVIDERS, type ModelProvider, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';

export const KEY_BY_PROVIDER: Record<ModelProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface DryRunModelPlan {
  model: string;
  provider: ModelProvider | 'unknown';
  modelId: string;
  requiredKey: string | null;
  keyPresent: boolean;
}

export interface DryRunPlan {
  perModel: DryRunModelPlan[];
  analystCalls: number;
  judgeCalls: number;
  totalPaidCalls: number;
  missingKeys: string[];
}

function isProvider(value: string | undefined): value is ModelProvider {
  return value != null && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export interface PlanInput {
  models: string[];
  judge: boolean;
  env: Record<string, string | undefined>;
}

export function planDryRun(input: PlanInput): DryRunPlan {
  const modelEnv: ModelProviderEnv = { MODEL_PROVIDER: input.env.MODEL_PROVIDER as ModelProvider };

  const perModel: DryRunModelPlan[] = input.models.map((model) => {
    const { provider, modelId } = parseRoleModel(modelEnv, model);
    if (!isProvider(provider)) {
      return { model, provider: 'unknown', modelId, requiredKey: null, keyPresent: false };
    }
    const requiredKey = KEY_BY_PROVIDER[provider];
    return { model, provider, modelId, requiredKey, keyPresent: Boolean(input.env[requiredKey]) };
  });

  const missingKeys = [...new Set(perModel.filter((m) => m.requiredKey != null && !m.keyPresent).map((m) => m.requiredKey as string))];
  const analystCalls = input.models.length;
  const judgeCalls = input.judge ? input.models.length : 0;

  return { perModel, analystCalls, judgeCalls, totalPaidCalls: analystCalls + judgeCalls, missingKeys };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/experiments/strategy-analyst/plan.ts src/experiments/strategy-analyst/plan.test.ts
git commit -m "feat(analyst-eval): pure dry-run planner (provider/key report, no model construction)"
```

---

## Task 9: Real analyst + judge factory (composeMastra-backed)

This is the **only** module that imports `composeMastra`. It is dynamically imported by the CLI **only under `--run`**, so dry-run never loads it. No unit test (it constructs real provider SDK clients); verified by `tsc` + the guard test (Task 10) + the manual run (Task 12).

**Files:**
- Create: `src/experiments/strategy-analyst/real-analyst-factory.ts`

- [ ] **Step 1: Write the implementation**

```ts
// src/experiments/strategy-analyst/real-analyst-factory.ts
// IMPORTANT: this is the ONLY harness module that imports composeMastra / constructs real
// provider models. The CLI dynamically imports it ONLY under --run, so dry-run never loads it.
import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraStrategyAnalyst } from '../../adapters/analyst/mastra-strategy-analyst.ts';
import { resolveLanguageModel, type ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import { createStrategyAnalystJudgeAgent } from './judge-agent.ts';
import { runJudge } from './judge.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { JudgeVerdict } from './types.ts';

/** Build a composeMastra-backed analyst for one candidate model (analyst='mastra', all else 'fake'). */
export function buildRealAnalystFor(baseEnv: ModelProviderEnv): (modelId: string) => StrategyAnalystPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      STRATEGY_ANALYST_ADAPTER: 'mastra',
      STRATEGY_ANALYST_MODEL: modelId,
      RESEARCHER_ADAPTER: 'fake',
      RESEARCHER_MODEL: 'fake',
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      INTENT_CLASSIFIER_ADAPTER: 'fake',
      INTENT_CLASSIFIER_MODEL: 'fake',
      BUILDER_ADAPTER: 'fake',
      BUILDER_MODEL: 'fake',
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.analyst;
    if (!entry) throw new Error('analyst agent was not composed (check STRATEGY_ANALYST_ADAPTER)');
    return new MastraStrategyAnalyst(entry.agent, entry.label);
  };
}

/** Build a judge closure bound to a judge model + the rubric/notes text. */
export function buildRealJudge(
  baseEnv: ModelProviderEnv,
  judgeModelId: string,
  rubricText: string,
  notesText: string,
): (profile: AnalystProfileOutput) => Promise<JudgeVerdict> {
  const resolved = resolveLanguageModel(baseEnv, judgeModelId);
  const agent = createStrategyAnalystJudgeAgent(resolved.model);
  return (profile: AnalystProfileOutput) => runJudge(agent, { profile, rubricText, notesText });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/experiments/strategy-analyst/real-analyst-factory.ts
git commit -m "feat(analyst-eval): composeMastra-backed real analyst + judge factory (run-only)"
```

---

## Task 10: Import guard test

Asserts the always-loaded harness modules (everything except `real-analyst-factory.ts`) never import forbidden subsystems.

**Files:**
- Test: `src/experiments/strategy-analyst/imports.guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/experiments/strategy-analyst/imports.guard.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/experiments/strategy-analyst';

// real-analyst-factory.ts legitimately imports composeMastra; it is loaded ONLY under --run.
const ALLOWED_TO_IMPORT_COMPOSE = new Set(['real-analyst-factory.ts']);

// Forbidden subsystems for the experimental harness (no DB/queue/builder/backtest/hypothesis/repository/platform).
const FORBIDDEN = [
  /\/adapters\/repository\//,
  /\/adapters\/queue\//,
  /\/adapters\/platform\//,
  /\/adapters\/builder\//,
  /\/orchestrator\//,
  /\/db\b/,
  /drizzle/,
  /hypothesis/,
  /backtest/,
  /mock-platform/,
];

function harnessSourceFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

describe('harness import boundaries', () => {
  it('no always-loaded module imports composeMastra (only the run-only factory may)', () => {
    for (const file of harnessSourceFiles()) {
      if (ALLOWED_TO_IMPORT_COMPOSE.has(file)) continue;
      const src = readFileSync(join(DIR, file), 'utf8');
      expect(src, `${file} must not import composeMastra`).not.toMatch(/compose-mastra/);
    }
  });

  it('no harness module imports a forbidden subsystem', () => {
    for (const file of harnessSourceFiles()) {
      const src = readFileSync(join(DIR, file), 'utf8');
      const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l));
      for (const line of importLines) {
        for (const pattern of FORBIDDEN) {
          expect(pattern.test(line), `${file}: forbidden import matched ${pattern} -> ${line.trim()}`).toBe(false);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run src/experiments/strategy-analyst/imports.guard.test.ts`
Expected: PASS (the harness as built so far imports nothing forbidden).

> If this FAILS, a harness module is importing a forbidden subsystem — fix the offending import, do not relax the guard.

- [ ] **Step 3: Commit**

```bash
git add src/experiments/strategy-analyst/imports.guard.test.ts
git commit -m "test(analyst-eval): guard harness import boundaries"
```

---

## Task 11: CLI script + npm script

Thin trigger. Dry-run by default (never loads `real-analyst-factory.ts`); `--run` dynamically imports it.

**Files:**
- Create: `scripts/strategy-analyst-eval.ts`
- Modify: `package.json` (add `analyst:eval` to `scripts`)

- [ ] **Step 1: Write the CLI script**

```ts
// scripts/strategy-analyst-eval.ts
// analyst:eval — experimental StrategyAnalyst model evaluation harness.
// Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
// --run is the SOLE trigger for paid calls. No DB, no backtester, no persistence.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolveFixture, fingerprintSource } from '../src/experiments/strategy-analyst/fixtures.ts';
import { planDryRun } from '../src/experiments/strategy-analyst/plan.ts';
import { runEval } from '../src/experiments/strategy-analyst/eval-harness.ts';
import { writeRunArtifacts, compactTimestamp } from '../src/experiments/strategy-analyst/artifacts.ts';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import { STRATEGY_PROFILE_CONTRACT_VERSION } from '../src/domain/strategy-profile.ts';
import type { ManifestMeta } from '../src/experiments/strategy-analyst/types.ts';

const HARNESS_VERSION = 'analyst-eval-v1';

function parseCli() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string', default: 'long-oi' },
      models: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '0.8' },
      judge: { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
    },
  });
  const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('--models is required (comma-separated, e.g. anthropic/claude-x,openai/gpt-x)');
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  if (values.judge && !values['judge-model']) throw new Error('--judge requires --judge-model <provider/model>');
  return { fixtureId: values.fixture!, models, run: values.run!, threshold, judge: values.judge!, judgeModel: values['judge-model'] };
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function modelEnv(): ModelProviderEnv {
  return {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
}

async function main(): Promise<number> {
  const args = parseCli();
  const fixture = resolveFixture(args.fixtureId);
  const fixtureText = readFileSync(fixture.sourcePath, 'utf8');

  // ---------- DRY RUN (default): no model construction, no composeMastra ----------
  if (!args.run) {
    const plan = planDryRun({ models: args.models, judge: args.judge, env: process.env });
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', fixture: args.fixtureId, threshold: args.threshold, judge: args.judge,
      plannedPaidCalls: plan.totalPaidCalls, analystCalls: plan.analystCalls, judgeCalls: plan.judgeCalls,
      models: plan.perModel, missingKeys: plan.missingKeys,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  // ---------- REAL RUN (--run): dynamically import the composeMastra-backed factory ----------
  const env = modelEnv();
  const { buildRealAnalystFor, buildRealJudge } = await import('../src/experiments/strategy-analyst/real-analyst-factory.ts');

  let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
  if (args.judge && args.judgeModel) {
    const rubricText = readFileSync(fixture.rubricPath, 'utf8');
    const notesText = readFileSync(fixture.notesPath, 'utf8');
    judge = buildRealJudge(env, args.judgeModel, rubricText, notesText);
  }

  const result = await runEval(
    { models: args.models, fixtureId: fixture.id, fixtureText, fixtureFingerprint: fingerprintSource(fixtureText), threshold: args.threshold },
    {
      analystFor: buildRealAnalystFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
      judge,
    },
  );

  const now = new Date();
  const timestamp = compactTimestamp(now);
  const outDir = `.artifacts/experiments/strategy-analyst/${fixture.id}/${timestamp}`;
  const meta: ManifestMeta = { timestamp, gitSha: gitSha(), harnessVersion: HARNESS_VERSION, contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION, mode: 'run' };
  const written = writeRunArtifacts(outDir, meta, result);

  process.stdout.write(`${JSON.stringify({
    mode: 'run', outDir, overallSuccess: result.overallSuccess,
    perModel: result.perModel.map((c) => ({ model: c.model, verdict: c.verdict, score: c.score?.score ?? null, error: c.error?.type ?? null })),
    artifacts: written,
  }, null, 2)}\n`);

  return result.overallSuccess ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`analyst:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`, add (after `"platform:resume"`):

```json
    "analyst:eval": "node --experimental-strip-types scripts/strategy-analyst-eval.ts",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Verify dry-run works and constructs no models (no keys needed)**

Run:
```bash
pnpm analyst:eval --fixture long-oi --models anthropic/claude-opus-4-8,openai/gpt-5
```
Expected: prints a JSON object with `"mode": "dry-run"`, `"plannedPaidCalls": 2`, a `models` array reporting `keyPresent` per model, and the DRY RUN note. Exit code 0. **No network calls, no errors about missing keys.**

- [ ] **Step 5: Verify the judge arg validation**

Run:
```bash
pnpm analyst:eval --models anthropic/claude-x --judge
```
Expected: stderr `analyst:eval failed: --judge requires --judge-model <provider/model>`, exit code 1.

- [ ] **Step 6: Commit**

```bash
git add scripts/strategy-analyst-eval.ts package.json
git commit -m "feat(analyst-eval): analyst:eval CLI (dry-run default, --run-only paid calls)"
```

---

## Task 12: Judge rubric document

**Files:**
- Create: `docs/fixtures/strategies/long-oi-strategy-rubric.md`

- [ ] **Step 1: Write the rubric**

```markdown
# Rubric: long_oi StrategyProfile evaluation

Score the candidate StrategyProfile against these dimensions (each 0–1). Use the source
description and the research notes as ground truth. Penalize invented specifics.

## Dimensions

1. **Direction** — Net bias is long-only. No short branch invented.
2. **Core idea** — Mean-reversion after a sharp dump; enter long on a confirmed bounce backed by OI recovery + long liquidations. Not trend-following.
3. **Market features** — Names the real data needs: OHLCV (1m candles), open interest (OI), liquidations. No technical indicators claimed (the strategy is rule-based).
4. **Entry trigger** — Dump detection (~10% drop) → watch → confirmed reversal (price rising / green candles), OI recovering, long liquidations present.
5. **Exit ladder** — TP1 (+3.5%, partial), TP2 (+5%, full), hard stop (−12%), time exit (180m). Move stop to breakeven after TP1.
6. **Position management** — DCA averaging (max two adds on further dips); breakeven after TP1.
7. **Boundary discipline** — Treats position sizing, leverage, fills, fees, exchange, and instrument universe as runner/platform-owned. Does NOT invent exact leverage or base order size. DCA size multipliers are hints only.
8. **Unknowns honesty** — Flags missing sizing/leverage, fees, exchange, and instrument universe (or equivalents) rather than fabricating them.

## Hallucination flags (list any present)

- Invented leverage (e.g. "10x") or base order size (e.g. "$100").
- Invented fees, commissions, exchange, or specific instrument list.
- Claimed 8-minute liquidation window or technical indicators (the module uses neither).
- Trailing stop (the module has none).

## Missing-from-profile (list rubric items the profile omitted)

Note any of dimensions 1–8 the profile fails to cover.
```

- [ ] **Step 2: Commit**

```bash
git add docs/fixtures/strategies/long-oi-strategy-rubric.md
git commit -m "docs(analyst-eval): judge rubric for long_oi StrategyProfile evaluation"
```

---

## Task 13: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole project**

Run: `pnpm typecheck`
Expected: PASS (no errors).

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all prior suites green PLUS the new `src/experiments/strategy-analyst/*.test.ts` suites. Zero paid calls were made (all harness tests use fakes).

- [ ] **Step 3: Confirm the SP-4 / production paths are untouched**

Run: `git diff --name-only main...HEAD`
Expected: only files under `src/experiments/strategy-analyst/`, `scripts/strategy-analyst-eval.ts`, `package.json`, `docs/fixtures/strategies/long-oi-strategy-rubric.md`, and `docs/superpowers/{specs,plans}/...`. No changes to `src/domain/`, `src/orchestrator/`, `src/adapters/` (other than imports of existing code), `src/mastra/`, or DB/migrations.

- [ ] **Step 4: Confirm dry-run safety one more time**

Run: `pnpm analyst:eval --models anthropic/claude-x,openai/gpt-x,openrouter/x-ai/grok-x`
Expected: `"mode": "dry-run"`, `plannedPaidCalls: 3`, exit 0, no network activity.

- [ ] **Step 5 (OPTIONAL — only if the user explicitly authorizes spend): a real single-model run**

> Requires the relevant provider key in the environment. This makes a real paid call. Do NOT run without explicit user authorization.

Run (example):
```bash
ANTHROPIC_API_KEY=… pnpm analyst:eval --fixture long-oi --models anthropic/claude-opus-4-8 --run
```
Expected: writes `.artifacts/experiments/strategy-analyst/long-oi/<timestamp>/{manifest.json,anthropic_claude-opus-4-8.json}`; prints `overallSuccess`; exit 0 if PASS, 3 if it ran but did not pass. No DB writes; no `StrategyProfile` persisted.

---

## Self-Review (completed during planning)

**1. Spec coverage:**
- §1 reuse path → Task 9 (`real-analyst-factory` reuses `composeMastra` + `MastraStrategyAnalyst`); injectable factory → Task 5 deps.
- §2 module layout → Tasks 1–11 (one file per responsibility).
- §3 scoring (gates + weighted + field-scoping/fallback + negative check) → Task 3.
- §3.4 real-path error handling (throw → FAIL/score null/rawOutput null, run continues) → Task 5.
- §4 artifacts (manifest + per-model + separate judge file; slug; timestamp) → Task 6.
- §5 CLI + strict paid-call gate (--run sole trigger; dry-run no composeMastra) → Tasks 8, 11; dry-run safety verified in Task 11 Step 4 + Task 13 Step 4.
- §6 opt-in judge (explicit model, gated by --run, separate file, no effect on verdict) → Tasks 7, 9, 11.
- §7 success + boundaries → guard test Task 10; verification Task 13 Step 3.
- §8 testing (all listed cases) → Tasks 3, 5, 6, 7, 8, 10.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output.

**3. Type consistency:** `ScoreResult`, `CandidateResult`, `EvalRunResult`, `ManifestMeta`, `JudgeVerdict`, `FixtureRef` defined once in Task 1 and used verbatim downstream. `scoreProfile(raw, {threshold})`, `runEval(input, deps)`, `writeRunArtifacts(outDir, meta, result)`, `planDryRun({models,judge,env})`, `buildRealAnalystFor(env)`, `buildRealJudge(env, judgeModelId, rubricText, notesText)`, `runJudge(agent, input)` signatures are consistent across tasks. `KEY_BY_PROVIDER` keyed by `ModelProvider`. Check ids (`market_features`, `entry_trigger`, `exit_ladder`, `position_mgmt`, `unknowns_flagged`, `risk_no_fabrication`) referenced consistently between `scoring.ts` and `scoring.test.ts`.
