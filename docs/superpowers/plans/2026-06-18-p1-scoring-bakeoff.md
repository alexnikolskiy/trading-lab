# P1: Strengthen Researcher Eval Scoring + Model Bake-off

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent score saturation on generic output by requiring forensic-symbol and lifecycle-sequence grounding, then run a 3+ model bake-off with raw-output saving and a Markdown ranking report.

**Architecture:** Extend `src/experiments/researcher/scoring.ts` with two new checks (`forensic_symbol_grounding`, `lifecycle_sequence_grounding`), one new gate (`noStrategyRewrite`, `forensicGrounded`), and rebalanced weights. Add `--save-outputs` / `--report` flags to `scripts/researcher-eval.ts`. Report saved to `docs/eval-results/`.

**Tech Stack:** TypeScript ESM, Vitest, no new dependencies.

---

### Task 1: Add `forensic_symbol_grounding` check + `noStrategyRewrite` gate to scoring

**Files:**
- Modify: `src/experiments/researcher/scoring.ts`
- Modify: `src/experiments/researcher/types.ts`
- Modify: `src/experiments/researcher/scoring.test.ts`

Scoring invariants after this task:
- Score max without evidence ≈ 0.70 (passes at 0.7 threshold only when other checks are perfect)
- Score of a generic "use better filters" output that doesn't mention ESPORTSUSDT/EDGEUSDT/COAIUSDT: < 0.7
- Gate `noStrategyRewrite` = false when output says "replace the strategy" / "new approach"

- [ ] **Step 1: Write failing tests for new gate and check**

Add to `src/experiments/researcher/scoring.test.ts` inside `describe('scoreResearcherOutput', ...)`:

```typescript
it('fails output that does not mention forensic symbols when tradeEvidence is present', () => {
  const noSymbol = {
    researchSummary: 'Bot results show hard_stop losses with dca sequences. Entry occurred, then dca was triggered, then sl fired. OI dropped during the liquidation cascade.',
    hypotheses: [{
      ...good.hypotheses[0],
      thesis: 'Hard stop losses cluster after dca sequences with declining OI; tighten stop after second dca when OI falls 10%.',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'after dca when oi falls 10%', action: 'tighten_stop', params: {}, rationale: 'hard_stop after dca observed in bot results' }] },
      validationPlan: 'Replay against June window; reject if total pnl decreases.',
    }],
  };
  const result = scoreResearcherOutput(noSymbol, evalContext);
  // Does not mention ESPORTSUSDT → forensic_symbol_grounding = 0, forensicGrounded gate fails
  expect(result.verdict).toBe('FAIL');
  expect(result.gates.forensicGrounded).toBe(false);
  expect(result.checks.find((c) => c.id === 'forensic_symbol_grounding')?.contribution).toBe(0);
});

it('fails output that attempts to rewrite the strategy', () => {
  const rewrite = {
    researchSummary: 'The current strategy should be replaced with a trend-following approach on ESPORTSUSDT.',
    hypotheses: [{
      ...good.hypotheses[0],
      thesis: 'Replace the current long-OI strategy with a trend filter on ESPORTSUSDT after hard_stop dca losses.',
    }],
  };
  const result = scoreResearcherOutput(rewrite, evalContext);
  expect(result.verdict).toBe('FAIL');
  expect(result.gates.noStrategyRewrite).toBe(false);
});

it('passes output that mentions at least one forensic symbol AND lifecycle terms', () => {
  const forensicGrounded = {
    researchSummary: 'ESPORTSUSDT hard_stop losses show entry→dca→dca→sl lifecycle. OI declines after entry. Reject if pnl does not improve.',
    hypotheses: [{
      ...good.hypotheses[0],
      thesis: 'ESPORTSUSDT hard_stop losses after dca sequences indicate tighten_stop is needed when OI falls after dca.',
      ruleAction: { appliesTo: 'long', rules: [{ when: 'after dca when oi falls 10%', action: 'tighten_stop', params: {}, rationale: 'Observed hard_stop on ESPORTSUSDT after dca in forensic bundles.' }] },
      validationPlan: 'Replay on June window; reject if hard_stop rate does not fall or pnl decreases.',
      invalidationCriteria: ['Reject if total pnl decreases or hard_stop count does not fall on ESPORTSUSDT.'],
    }],
  };
  const result = scoreResearcherOutput(forensicGrounded, evalContext);
  expect(result.verdict).toBe('PASS');
  expect(result.gates.forensicGrounded).toBe(true);
  expect(result.checks.find((c) => c.id === 'forensic_symbol_grounding')?.contribution).toBeGreaterThan(0);
  expect(result.checks.find((c) => c.id === 'lifecycle_sequence_grounding')?.contribution).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to confirm they fail (3 new tests)**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm vitest run src/experiments/researcher/scoring.test.ts
```

Expected: 3 new tests FAIL (gates/checks not yet implemented), 2 existing tests PASS.

- [ ] **Step 3: Add `noStrategyRewrite` to gates type in `types.ts`**

In `src/experiments/researcher/types.ts`, update `ScoreResult.gates`:

```typescript
export interface ScoreResult {
  gates: {
    schemaValid: boolean;
    hasHypothesis: boolean;
    researchOnly: boolean;
    contextGrounded: boolean;
    noStrategyRewrite: boolean;
    forensicGrounded: boolean;
  };
  checks: CheckResult[];
  score: number;
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}
```

- [ ] **Step 4: Implement `forensicSymbolPatterns`, `lifecycleSequencePatterns`, strategy-rewrite detection in `scoring.ts`**

Replace `scoring.ts` with the following (full file):

```typescript
import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import type { CheckResult, ScoreResult } from './types.ts';

const DEFAULT_THRESHOLD = 0.7;

function textOf(raw: unknown): string {
  return JSON.stringify(raw).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function check(id: string, weight: number, haystack: string, patterns: RegExp[], minMatches = 1): CheckResult {
  const matched = patterns.filter((p) => p.test(haystack)).map((p) => p.source);
  const contribution = matched.length === 0 ? 0 : weight * Math.min(matched.length / Math.max(minMatches, 1), 1);
  return { id, weight, contribution, matched };
}

function profileSpecificPatterns(profile: StrategyProfile | undefined): RegExp[] {
  if (!profile) return [];
  const details = (profile.profile ?? {}) as Partial<StrategyProfile['profile']>;
  const text = [
    profile.coreIdea,
    details.summary ?? '',
    ...(details.entryConditions ?? []),
    ...(details.exitConditions ?? []),
    details.positionManagementSummary ?? '',
  ].join(' ').toLowerCase();
  const patterns: RegExp[] = [];
  if (text.includes('10%')) patterns.push(/10\s*%/);
  if (text.includes('3.5%')) patterns.push(/3(?:[.,])?5\s*%/);
  if (text.includes('5%')) patterns.push(/(?:^|[^0-9.])5\s*%/);
  if (text.includes('12%')) patterns.push(/12\s*%/);
  if (text.includes('180 minutes')) patterns.push(/180\s*(minutes?|mins?|m)\b/);
  if (text.includes('dca')) patterns.push(/\bdca\b|усредн/);
  if (text.includes('breakeven') || text.includes('(be)')) patterns.push(/\bbreakeven\b|\bbe\b|безубыт/);
  if (text.includes('open interest') || text.includes('oi')) patterns.push(/\boi\b|open interest/);
  if (text.includes('liquidations')) patterns.push(/liquidation/);
  if (text.includes('dump')) patterns.push(/dump|sharp dump|пролив/);
  if (text.includes('bounce')) patterns.push(/bounce|reversal|отскок/);
  return patterns;
}

function evidenceSpecificPatterns(
  botResults: readonly BotRunResultDetail[] | undefined,
  tradeEvidence: readonly TradeEvidenceBundle[] | undefined,
): RegExp[] {
  const symbols = unique((botResults ?? [])
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .map((trade) => trade.symbol.toLowerCase())
    .slice(0, 5));
  const closeReasons = unique([
    ...(botResults ?? []).flatMap((detail) => detail.trades)
      .filter((trade) => Number(trade.realizedPnl) < 0)
      .map((trade) => trade.closeReason?.toLowerCase())
      .filter((reason): reason is string => Boolean(reason)),
    ...(tradeEvidence ?? [])
      .map((bundle) => bundle.closeReason?.toLowerCase())
      .filter((reason): reason is string => Boolean(reason)),
  ]);
  const eventTypes = unique((tradeEvidence ?? [])
    .flatMap((bundle) => bundle.lifecycleEvents)
    .map((event) => event.type.toLowerCase())
    .filter((type) => type !== 'entry'));

  return [
    ...symbols.map((symbol) => new RegExp(escapeRegExp(symbol), 'i')),
    ...closeReasons.map((reason) => new RegExp(escapeRegExp(reason), 'i')),
    ...eventTypes.map((type) => new RegExp(`\\b${escapeRegExp(type)}\\b`, 'i')),
  ];
}

/**
 * Patterns derived from the actual symbols present in forensic trade bundles.
 * Requires the output to mention at least one concrete losing symbol from the evidence,
 * not just generic "the strategy has losses".
 */
function forensicSymbolPatterns(tradeEvidence: readonly TradeEvidenceBundle[] | undefined): RegExp[] {
  if (!tradeEvidence || tradeEvidence.length === 0) return [];
  const symbols = unique(tradeEvidence.map((b) => b.symbol.toLowerCase()));
  return symbols.map((s) => new RegExp(escapeRegExp(s), 'i'));
}

/**
 * Patterns derived from the actual lifecycle event sequence in forensic bundles.
 * The forensic data shows entry→dca→dca→sl sequences; output should reference
 * those specific stages, not just generic "stop loss occurred".
 */
function lifecycleSequencePatterns(tradeEvidence: readonly TradeEvidenceBundle[] | undefined): RegExp[] {
  if (!tradeEvidence || tradeEvidence.length === 0) return [];
  const eventTypes = unique(
    tradeEvidence.flatMap((b) => b.lifecycleEvents).map((e) => e.type.toLowerCase()),
  );
  const closeReasons = unique(
    tradeEvidence.map((b) => b.closeReason?.toLowerCase()).filter((r): r is string => Boolean(r)),
  );
  return [
    ...eventTypes.filter((t) => t !== 'entry').map((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i')),
    ...closeReasons.map((r) => new RegExp(escapeRegExp(r), 'i')),
  ];
}

const FORBIDDEN = /\b(place|submit|execute|cancel)\s+(live\s+)?orders?\b|\bleverage\s*[:=]?\s*\d|\bdeploy\b|\bapi[_ -]?key\b|секрет|ордер/i;

const STRATEGY_REWRITE = /\breplace\s+(the\s+)?(current\s+)?strategy\b|\bnew\s+(strategy|approach|algorithm)\b|\bswitch\s+to\b|\bredesign\b|\binstead\s+of\s+the\s+(current\s+)?strategy\b|\bdrop\s+the\s+strategy\b/i;

export function scoreResearcherOutput(
  raw: unknown,
  opts: {
    threshold?: number;
    profile?: StrategyProfile;
    botResults?: readonly BotRunResultDetail[];
    tradeEvidence?: readonly TradeEvidenceBundle[];
  } = {},
): ScoreResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const parsed = ResearcherOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      gates: { schemaValid: false, hasHypothesis: false, researchOnly: false, contextGrounded: false, noStrategyRewrite: true, forensicGrounded: true },
      checks: [],
      score: 0,
      threshold,
      verdict: 'FAIL',
    };
  }

  const output = parsed.data;
  const haystack = textOf(output);

  const profileGrounding = check('profile_specificity', 0.10, haystack, profileSpecificPatterns(opts.profile), 2);
  const evidenceGrounding = check('evidence_specificity', 0.10, haystack, evidenceSpecificPatterns(opts.botResults, opts.tradeEvidence), 2);

  const forensicSymPats = forensicSymbolPatterns(opts.tradeEvidence);
  const forensicSymGrounding = check('forensic_symbol_grounding', 0.15, haystack, forensicSymPats, 1);

  const lifecyclePats = lifecycleSequencePatterns(opts.tradeEvidence);
  const lifecycleGrounding = check('lifecycle_sequence_grounding', 0.15, haystack, lifecyclePats, 2);

  const hasForensic = (opts.tradeEvidence?.length ?? 0) > 0;
  const needsProfileGrounding = profileSpecificPatterns(opts.profile).length > 0;
  const needsEvidenceGrounding = evidenceSpecificPatterns(opts.botResults, opts.tradeEvidence).length > 0;

  const noStrategyRewrite = !STRATEGY_REWRITE.test(haystack);
  // When forensic bundles are provided, output MUST mention ≥1 forensic symbol AND ≥2 lifecycle terms.
  const forensicGrounded = !hasForensic
    || (forensicSymGrounding.contribution > 0 && lifecycleGrounding.contribution > 0);

  const gates = {
    schemaValid: true,
    hasHypothesis: output.hypotheses.length > 0,
    researchOnly: !FORBIDDEN.test(haystack),
    contextGrounded: (!needsProfileGrounding || profileGrounding.contribution > 0)
      && (!needsEvidenceGrounding || evidenceGrounding.contribution > 0),
    noStrategyRewrite,
    forensicGrounded,
  };

  const checks: CheckResult[] = [
    // 0.15 — factual use of bot data (less generic than before: requires ≥3 out of 6 patterns)
    check('uses_bot_results', 0.15, haystack, [/bot results?/, /\btrade/, /\bpnl\b/, /winrate/, /stop[_ -]?loss|be_stop|hard_stop|time_exit/, /holding/], 3),
    // 0.20 — falsifiable: metric + direction + rejection criteria
    check('falsifiable_validation', 0.20, haystack, [/reject if/, /invalidation/, /compare/, /replay/, /does not improve/, /falls|decreases|does not fall/, /\b(pnl|winrate|holding|trade count)\b/], 3),
    // 0.10 — specifically targets a failure pattern from the data
    check('targets_failure_pattern', 0.10, haystack, [/loss/, /negative/, /stop[_ -]?loss|be_stop|hard_stop|time_exit/, /slow/, /late/, /holding/], 2),
    // 0.10 — references a valid builder overlay action
    check('builder_ready_overlay', 0.10, haystack, [/skip_entry|allow_entry|scale_in|scale_out|tighten_stop|widen_stop|exit_now|adjust_size|no_op/]),
    // 0.05 — uses metric names
    check('metric_specific', 0.05, haystack, [/pnl/, /winrate/, /holding/, /trade/], 2),
    profileGrounding,
    evidenceGrounding,
    forensicSymGrounding,
    lifecycleGrounding,
  ];

  // Weights sum: 0.15+0.20+0.10+0.10+0.05+0.10+0.10+0.15+0.15 = 1.10 (headroom intentional: no single check alone passes threshold)

  const score = checks.reduce((sum, c) => sum + c.contribution, 0);
  const allGatesPassed = gates.schemaValid && gates.hasHypothesis && gates.researchOnly
    && gates.contextGrounded && gates.noStrategyRewrite && gates.forensicGrounded;
  const verdict = allGatesPassed && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
```

- [ ] **Step 5: Run all scoring tests**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm vitest run src/experiments/researcher/scoring.test.ts
```

Expected: 5/5 PASS.

- [ ] **Step 6: Run typecheck**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/experiments/researcher/scoring.ts src/experiments/researcher/scoring.test.ts src/experiments/researcher/types.ts
git commit -m "feat: strengthen researcher scoring with forensic-symbol and lifecycle-sequence gates"
```

---

### Task 2: Fix good-fixture test to satisfy new forensic gates

**Files:**
- Modify: `src/experiments/researcher/scoring.test.ts`

The existing `good` fixture in scoring.test.ts was written before forensic gates existed. It needs to mention at least one forensic symbol (ESPORTSUSDT is in `evalContext.tradeEvidence`) and lifecycle terms (dca, sl).

- [ ] **Step 1: Update the `good` fixture to mention ESPORTSUSDT + lifecycle terms**

In `scoring.test.ts`, update the `good` object's thesis and ruleAction rationale:

```typescript
const good = {
  researchSummary: 'Uses bot results: low winrate, negative pnl and be_stop clusters on ESPORTSUSDT show late exits after the long-only dump-and-bounce setup stays open too long. Forensic bundles confirm entry→dca→dca→sl sequence with declining OI.',
  hypotheses: [{
    thesis: 'ESPORTSUSDT hard_stop losses after dca sequences indicate tighten_stop is needed: losses cluster around be_stop exits after long holding time, so tighten the stop earlier when the 10% dump bounce loses OI recovery.',
    targetBehavior: 'Reduce slow losing trades without changing execution.',
    ruleAction: { appliesTo: 'long', rules: [{ when: 'oi fails to recover after the dump bounce and the trade remains open near 180 minutes with dca triggered', action: 'tighten_stop', params: {}, rationale: 'Observed hard_stop after dca on ESPORTSUSDT in forensic bundles: entry→dca→dca→sl with declining OI.' }] },
    requiredFeatures: ['oi', 'ohlcv'],
    validationPlan: 'Replay against the June bot-result window and compare winrate, pnl and hard_stop rate for ESPORTSUSDT be_stop-heavy losers. Reject if total pnl decreases.',
    expectedEffect: { metric: 'avg losing trade pnl', direction: 'increase', magnitude: 'less negative' },
    invalidationCriteria: ['Reject if total pnl decreases or hard_stop count does not fall on ESPORTSUSDT.'],
    confidence: 0.7,
  }],
};
```

- [ ] **Step 2: Run all scoring tests**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm vitest run src/experiments/researcher/scoring.test.ts
```

Expected: 5/5 PASS.

- [ ] **Step 3: Run full researcher test suite**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm vitest run src/experiments/researcher/
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add src/experiments/researcher/scoring.test.ts
git commit -m "test: update good fixture to satisfy forensic-symbol and lifecycle gates"
```

---

### Task 3: Add `--save-outputs` and Markdown report to eval script

**Files:**
- Modify: `scripts/researcher-eval.ts`

The bake-off needs raw outputs per-model per-run saved for manual review, and a Markdown ranking table for quick reading.

- [ ] **Step 1: Add `--save-outputs` CLI flag and report rendering**

Replace `scripts/researcher-eval.ts` with:

```typescript
// researcher:eval — experimental Researcher model evaluation harness.
// Default = DRY RUN. Use --run as the sole trigger for paid LLM calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import { rankAggregates } from '../src/experiments/researcher/aggregate.ts';
import { fingerprintFixture, loadBotResultsFixture, loadTradeEvidenceFixture, longOiStrategyProfile, resolveResearcherFixture } from '../src/experiments/researcher/fixtures.ts';
import { runEval } from '../src/experiments/researcher/eval-harness.ts';
import type { EvalRunResult } from '../src/experiments/researcher/types.ts';

function parseCli() {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string', default: 'long-oi-vps-2026-06-01' },
      models: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: '0.7' },
      repeat: { type: 'string', default: '1' },
      'save-outputs': { type: 'boolean', default: false },
    },
  });
  const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('--models is required');
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
  return { fixtureId: values.fixture!, models, run: values.run!, threshold, repeat, saveOutputs: values['save-outputs']! };
}

function modelEnv(): ModelProviderEnv {
  return {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function renderMarkdownReport(result: EvalRunResult, fixtureId: string, date: string): string {
  const ranking = rankAggregates(result.aggregates);
  const rows = ranking.map((a, i) => {
    const passRatePct = Math.round(a.passRate * 100);
    const score = a.scoreMean === null ? 'n/a' : r3(a.scoreMean).toFixed(3);
    const latency = Math.round(a.latencyMeanMs / 1000);
    return `| ${i + 1} | \`${a.model}\` | ${passRatePct}% | ${score} | ${latency}s | ${a.runs.ok}/${a.runs.total} |`;
  });

  const perModelDetail = ranking.map((agg) => {
    const runs = result.perModel.filter((r) => r.model === agg.model);
    const checkRows = runs
      .filter((r) => r.score !== null)
      .flatMap((r, ri) =>
        (r.score!.checks.map((c) => `  - run${ri + 1} \`${c.id}\`: ${r3(c.contribution).toFixed(3)} / ${c.weight} (matched: ${c.matched.slice(0, 3).join(', ') || 'none'})`))
      );
    const gateRows = runs
      .filter((r) => r.score !== null)
      .map((r, ri) => {
        const g = r.score!.gates;
        const failed = Object.entries(g).filter(([, v]) => !v).map(([k]) => k);
        return `  - run${ri + 1} gates failed: ${failed.length === 0 ? 'none' : failed.join(', ')}`;
      });
    return [
      `### ${agg.model}`,
      '',
      '**Checks per run:**',
      ...checkRows,
      '',
      '**Gates per run:**',
      ...gateRows,
    ].join('\n');
  });

  return [
    `# Researcher Eval Bake-off — ${date}`,
    '',
    `**Fixture:** \`${fixtureId}\`  `,
    `**Threshold:** ${result.threshold}  `,
    `**Repeat:** ${result.repeat}  `,
    `**Overall success:** ${result.overallSuccess}`,
    '',
    '## Ranking',
    '',
    '| # | Model | Pass Rate | Score Mean | Latency (avg) | Runs OK |',
    '|---|-------|-----------|------------|---------------|---------|',
    ...rows,
    '',
    '## Per-Model Check Detail',
    '',
    ...perModelDetail,
  ].join('\n');
}

async function main(): Promise<number> {
  const args = parseCli();
  const fixture = resolveResearcherFixture(args.fixtureId);
  const profile = longOiStrategyProfile();
  const botResults = await loadBotResultsFixture(fixture.botResultsDir);
  const tradeEvidence = await loadTradeEvidenceFixture(fixture.botResultsDir, botResults);
  const fixtureFingerprint = fingerprintFixture(profile, botResults, tradeEvidence);

  if (!args.run) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      fixture: fixture.id,
      threshold: args.threshold,
      repeat: args.repeat,
      models: args.models,
      botRuns: botResults.length,
      closedTrades: botResults.reduce((sum, d) => sum + d.trades.length, 0),
      tradeEvidenceBundles: tradeEvidence.length,
      plannedPaidCalls: args.models.length * args.repeat,
      note: 'DRY RUN — no real models constructed, nothing sent. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  const env = modelEnv();
  const { buildRealResearcherFor } = await import('../src/experiments/researcher/real-researcher-factory.ts');
  const result = await runEval(
    { models: args.models, fixtureId: fixture.id, fixtureFingerprint, profile, botResults, tradeEvidence, threshold: args.threshold, repeat: args.repeat },
    {
      researcherFor: buildRealResearcherFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
    },
  );

  const ranking = rankAggregates(result.aggregates).map((a) => ({
    model: a.model,
    runs: `${a.runs.ok}/${a.runs.total}`,
    passRate: r3(a.passRate),
    scoreMean: a.scoreMean === null ? null : r3(a.scoreMean),
    latencyMeanMs: Math.round(a.latencyMeanMs),
  }));

  if (args.saveOutputs) {
    const date = new Date().toISOString().slice(0, 10);
    const outDir = `docs/eval-results`;
    mkdirSync(outDir, { recursive: true });
    const slug = `${date}-${fixture.id}`;
    writeFileSync(`${outDir}/${slug}.json`, JSON.stringify(result, null, 2));
    const md = renderMarkdownReport(result, fixture.id, date);
    writeFileSync(`${outDir}/${slug}.md`, md);
    process.stderr.write(`[eval] saved raw outputs to ${outDir}/${slug}.json\n`);
    process.stderr.write(`[eval] saved markdown report to ${outDir}/${slug}.md\n`);
  }

  process.stdout.write(`${JSON.stringify({ mode: 'run', fixture: fixture.id, repeat: result.repeat, overallSuccess: result.overallSuccess, ranking, perModel: result.perModel }, null, 2)}\n`);
  return result.overallSuccess ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`researcher:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
```

- [ ] **Step 2: Run typecheck**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Dry-run sanity check**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm researcher:eval --models openrouter/x-ai/grok-4.3
```

Expected: JSON with `tradeEvidenceBundles: 3`, no crash.

- [ ] **Step 4: Commit**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add scripts/researcher-eval.ts
git commit -m "feat: add --save-outputs and markdown report to researcher:eval"
```

---

### Task 4: Run bake-off on 3 models with repeat=3, save outputs

**Files:**
- Create: `docs/eval-results/2026-06-18-long-oi-vps-2026-06-01.json` (generated)
- Create: `docs/eval-results/2026-06-18-long-oi-vps-2026-06-01.md` (generated)

This task is an **execution task** (run a command, inspect results). Do not modify code.

- [ ] **Step 1: Run bake-off on 3 models**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
pnpm researcher:eval \
  --run \
  --models "openrouter/x-ai/grok-4.3,openrouter/openai/gpt-5.5,openrouter/google/gemini-2.5-pro" \
  --repeat 3 \
  --threshold 0.7 \
  --save-outputs \
  2>&1 | tee /tmp/bakeoff-output.txt
```

Expected: Saves `.json` and `.md` to `docs/eval-results/`.

- [ ] **Step 2: Inspect Markdown report**

```bash
cat docs/eval-results/2026-06-18-long-oi-vps-2026-06-01.md
```

Check:
- Each model's pass rate clearly visible
- Score per check visible
- Gate failures clearly listed

- [ ] **Step 3: Commit the generated reports**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab
git add docs/eval-results/
git commit -m "data: add 3-model bake-off results with forensic scoring (2026-06-18)"
```

---

## Self-Review

**Spec coverage:**
- Усилить scoring (Этап 4): Task 1 adds `forensic_symbol_grounding`, `lifecycle_sequence_grounding`, `noStrategyRewrite`, `forensicGrounded` gates → ✓
- penalty за generic hypotheses → `forensicGrounded` gate prevents them from passing → ✓
- check на ссылку на конкретные symbols → `forensic_symbol_grounding` with weight 0.15 → ✓
- check на lifecycle events → `lifecycle_sequence_grounding` → ✓
- Bake-off 3-5 моделей (Этап 5): Task 4 → ✓
- Save raw outputs: Task 3 `--save-outputs` → ✓
- Human-readable report: Task 3 Markdown report → ✓

**Placeholder scan:** No TBD/TODO in code steps. All code is complete.

**Type consistency:** `ScoreResult.gates` extended in `types.ts` Task 1 Step 3; used in `scoring.ts` Task 1 Step 4; `EvalRunResult` imported in `scripts/researcher-eval.ts` Task 3.
