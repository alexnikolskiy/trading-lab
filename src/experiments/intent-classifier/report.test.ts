// src/experiments/intent-classifier/report.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReport, writeReport } from './report.ts';
import type {
  CandidateResult, CaseResult, EvalCase, EvalRunResult, JudgeVerdict, ManifestMeta, ModelAggregate, ScoreResult,
} from './types.ts';

const meta: ManifestMeta = {
  timestamp: '20260617T153000Z', gitSha: 'abc1234', harnessVersion: 'intent-eval-v1',
  contractVersion: 'chat-intent-v1', mode: 'run',
};

const LONG_MSG = 'проверь стратегию: лонг при росте open interest и пробое VWAP с дополнительным фильтром по объёму и волатильности';

const cases: EvalCase[] = [
  { id: 'c-help', lang: 'en', message: 'help', expect: { intent: 'help' } },
  { id: 'c-strat', lang: 'ru', message: LONG_MSG, expect: { intent: 'strategy.onboard', requestedOutcome: 'onboard', hasStrategyText: true } },
  { id: 'c-oos', lang: 'ru', message: 'какая погода', expect: { intent: 'out_of_scope' } },
  { id: 'c-extra', lang: 'en', message: 'show me the trading results', expect: { intent: 'results.trading' } },
];

function caseResult(over: Partial<CaseResult> & { id: string; expectedIntent: CaseResult['expectedIntent'] }): CaseResult {
  return {
    lang: 'ru', actualIntent: over.expectedIntent, intentMatch: true, schemaValid: true,
    payloadChecks: [], payloadScore: null, latencyMs: 5, error: null, ...over,
  };
}

function scoreOf(cs: CaseResult[], threshold = 0.7): ScoreResult {
  const total = cs.length;
  const acc = cs.filter((c) => c.intentMatch).length / total;
  const pl = cs.filter((c) => c.payloadScore != null).map((c) => c.payloadScore as number);
  return {
    intentAccuracy: acc, payloadAccuracy: pl.length ? pl.reduce((a, b) => a + b, 0) / pl.length : null,
    score: acc, threshold, verdict: acc >= threshold ? 'PASS' : 'FAIL',
    cases: cs, caseCount: total, schemaValidCount: cs.filter((c) => c.schemaValid).length,
    schemaValidRate: total ? cs.filter((c) => c.schemaValid).length / total : 0,
  };
}

const goodCases: CaseResult[] = [
  caseResult({ id: 'c-help', lang: 'en', expectedIntent: 'help', latencyMs: 5 }),
  caseResult({ id: 'c-strat', lang: 'ru', expectedIntent: 'strategy.onboard', payloadScore: 1, latencyMs: 12 }),
  caseResult({ id: 'c-oos', lang: 'ru', expectedIntent: 'out_of_scope', latencyMs: 7 }),
];
const badCases: CaseResult[] = [
  caseResult({ id: 'c-help', lang: 'en', expectedIntent: 'help', actualIntent: 'out_of_scope', intentMatch: false, latencyMs: 5 }),
  caseResult({ id: 'c-strat', lang: 'ru', expectedIntent: 'strategy.onboard', actualIntent: 'research.run_cycle', intentMatch: false, payloadScore: 0, latencyMs: 10 }),
  caseResult({ id: 'c-oos', lang: 'ru', expectedIntent: 'out_of_scope', actualIntent: null, intentMatch: false, schemaValid: false, latencyMs: 4, error: { type: 'schema', message: 'bad' } }),
  // intent correct, but the object failed the strict gate (bad secondary enum) -> NOT a mislabel
  caseResult({ id: 'c-extra', lang: 'en', expectedIntent: 'results.trading', actualIntent: 'results.trading', intentMatch: true, schemaValid: false, latencyMs: 6, error: { type: 'schema', message: 'bad entityRef' } }),
];

const goodAgg: ModelAggregate = {
  model: 'good-model', provider: 'openrouter', modelId: 'good', runs: { total: 1, ok: 1, failed: 0, failedByType: {} },
  passRate: 1, det: { mean: 1, median: 1, std: 0, min: 1, max: 1 },
  schemaValid: { mean: 1, median: 1, std: 0, min: 1, max: 1 }, payload: { mean: 1, median: 1, std: 0, min: 1, max: 1 },
  judge: null, latency: { mean: 24, median: 24 },
};
const badAgg: ModelAggregate = {
  model: 'bad-model', provider: 'openrouter', modelId: 'bad', runs: { total: 1, ok: 1, failed: 0, failedByType: {} },
  passRate: 0, det: { mean: 0, median: 0, std: 0, min: 0, max: 0 },
  schemaValid: { mean: 0.5, median: 0.5, std: 0, min: 0.5, max: 0.5 }, payload: { mean: 0, median: 0, std: 0, min: 0, max: 0 },
  judge: null, latency: { mean: 19, median: 19 },
};

function run(model: string, score: ScoreResult | null, judge: JudgeVerdict | null = null, error: CandidateResult['error'] = null): CandidateResult {
  return { model, provider: 'openrouter', modelId: model, latencyMs: 24, verdict: score?.verdict ?? 'FAIL', score, error, judge };
}

const baseResult: EvalRunResult = {
  dataset: { id: 'chat-intents-v1', fingerprint: 'sha256:deadbeef', caseCount: 3 },
  threshold: 0.7, repeat: 1, judgeEnabled: false, models: ['good-model', 'bad-model'],
  perModel: [run('good-model', scoreOf(goodCases)), run('bad-model', scoreOf(badCases))],
  aggregates: [goodAgg, badAgg], overallSuccess: true,
};

describe('renderReport — header + summary', () => {
  const md = renderReport(meta, baseResult, cases);

  it('renders the round header', () => {
    expect(md).toContain('20260617T153000Z');
    expect(md).toContain('abc1234');
    expect(md).toContain('chat-intents-v1');
    expect(md).toContain('sha256:deadbeef');
    expect(md).toContain('good-model');
    expect(md).toContain('bad-model');
  });

  it('orders the summary by rankAggregates and marks the winner', () => {
    expect(md).toContain('★ good-model'); // rank #1
    expect(md).not.toContain('★ bad-model');
    expect(md.indexOf('good-model')).toBeLessThan(md.indexOf('bad-model'));
  });

  it('is deterministic (pure render)', () => {
    expect(renderReport(meta, baseResult, cases)).toBe(md);
  });
});

describe('renderReport — per-case tables', () => {
  const md = renderReport(meta, baseResult, cases);

  it('shows expected → actual, match/schema ticks, and payload "—" when no expectation', () => {
    expect(md).toContain('| help → help | ✓ | ✓ | — |');
  });

  it('shows ✗ on a mislabel and the error type on a schema-invalid case', () => {
    expect(md).toContain('out_of_scope → — | ✗ | ✗ |');
    expect(md).toContain('schema'); // error type surfaced in the table
  });
});

describe('renderReport — Mislabels block', () => {
  const md = renderReport(meta, baseResult, cases);

  it('lists only failures, with truncated message text (~80 chars)', () => {
    expect(md).toContain('Mislabels (0)'); // good-model: nothing wrong
    expect(md).toContain('Mislabels (3)'); // bad-model: all three failed
    expect(md).toContain('help → out_of_scope');
    expect(md).toContain('out_of_scope → —');
    expect(md).toContain('out_of_scope → — _(schema-invalid)_'); // schema-invalid miss is flagged in mislabels
    const trunc = `${LONG_MSG.slice(0, 80)}…`;
    expect(md).toContain(trunc);
    expect(md).not.toContain(LONG_MSG); // the full (untruncated) message must not appear
  });
});

describe('renderReport — intent vs schema-validity split', () => {
  const md = renderReport(meta, baseResult, cases);

  it('adds a Schema valid column to the summary, next to intent accuracy', () => {
    expect(md).toContain('Schema valid');
    expect(md).toContain('Intent acc (mean±std)');
  });

  it('surfaces schema-invalid-but-intent-correct cases in their own block (not in Mislabels)', () => {
    expect(md).toContain('Schema-invalid but intent correct (1)');
    expect(md).toContain('results.trading _(schema-invalid)_ — "show me the trading results"');
    expect(md).toContain('Mislabels (3)'); // c-extra (intent correct) is NOT counted as a mislabel
  });
});

describe('renderReport — judge block', () => {
  it('renders dimensions / overallScore / disputedCases / notes and a Judge summary column', () => {
    const verdict: JudgeVerdict = {
      dimensions: [{ name: 'correctness', score: 0.9, rationale: 'mostly right' }],
      overallScore: 0.85, disputedCases: [{ id: 'c-help', note: 'arguable label' }], notes: 'looks fine',
    };
    const judgedAgg: ModelAggregate = { ...goodAgg, judge: { mean: 0.85, median: 0.85, std: 0, min: 0.85, max: 0.85 } };
    const result: EvalRunResult = {
      ...baseResult, judgeEnabled: true, models: ['good-model'],
      perModel: [run('good-model', scoreOf(goodCases), verdict)], aggregates: [judgedAgg],
    };
    const md = renderReport(meta, result, cases);
    expect(md).toContain('Judge'); // summary column header
    expect(md).toContain('0.850'); // overall score
    expect(md).toContain('correctness');
    expect(md).toContain('mostly right');
    expect(md).toContain('arguable label');
    expect(md).toContain('looks fine');
  });
});

describe('renderReport — catastrophic run', () => {
  it('renders a failure note instead of a table when the run produced no score', () => {
    const result: EvalRunResult = {
      ...baseResult, models: ['broken'],
      perModel: [run('broken', null, null, { type: 'provider', message: 'boom' })],
      aggregates: [{ ...badAgg, model: 'broken', det: null, schemaValid: null, payload: null, passRate: 0, runs: { total: 1, ok: 0, failed: 1, failedByType: { provider: 1 } } }],
      overallSuccess: false,
    };
    const md = renderReport(meta, result, cases);
    expect(md).toContain('Run failed');
    expect(md).toContain('boom');
  });
});

describe('writeReport', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  it('writes report.md to outDir with exactly the rendered markdown and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-report-'));
    dirs.push(dir);
    const path = writeReport(dir, meta, baseResult, cases);
    expect(path).toBe(join(dir, 'report.md'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(renderReport(meta, baseResult, cases));
  });
});
