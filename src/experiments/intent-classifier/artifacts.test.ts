// src/experiments/intent-classifier/artifacts.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugModel, compactTimestamp, writeRunArtifacts } from './artifacts.ts';
import type { CandidateResult, EvalRunResult, ManifestMeta, ModelAggregate, ScoreResult } from './types.ts';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'intent-eval-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const score = (acc: number): ScoreResult => ({
  intentAccuracy: acc, payloadAccuracy: 1, score: acc, threshold: 0.7,
  verdict: acc >= 0.7 ? 'PASS' : 'FAIL', cases: [], caseCount: 20, schemaValidCount: 20,
});

const run = (model: string, judge: CandidateResult['judge']): CandidateResult => ({
  model, provider: 'openrouter', modelId: model.split('/').slice(1).join('/'), latencyMs: 100,
  verdict: 'PASS', score: score(1), error: null, judge,
});

const aggregate = (model: string): ModelAggregate => ({
  model, provider: 'openrouter', modelId: 'm', runs: { total: 1, ok: 1, failed: 0, failedByType: {} },
  passRate: 1, det: { mean: 1, median: 1, std: 0, min: 1, max: 1 },
  payload: { mean: 1, median: 1, std: 0, min: 1, max: 1 }, judge: null, latency: { mean: 100, median: 100 },
});

describe('slugModel / compactTimestamp', () => {
  it('makes a model id filesystem-safe', () => {
    expect(slugModel('openrouter/x-ai/grok-4.1-fast')).toBe('openrouter_x-ai_grok-4.1-fast');
  });
  it('compacts an ISO timestamp', () => {
    expect(compactTimestamp(new Date('2026-06-17T15:30:00.000Z'))).toBe('20260617T153000Z');
  });
});

describe('writeRunArtifacts', () => {
  const meta: ManifestMeta = {
    timestamp: '20260617T153000Z', gitSha: 'abc1234', harnessVersion: 'intent-eval-v1',
    contractVersion: 'chat-intent-v1', mode: 'run',
  };

  function result(perModel: CandidateResult[]): EvalRunResult {
    return {
      dataset: { id: 'chat-intents-v1', fingerprint: 'sha256:deadbeef', caseCount: 20 },
      threshold: 0.7, repeat: 1, judgeEnabled: perModel.some((r) => r.judge != null),
      models: [...new Set(perModel.map((r) => r.model))],
      perModel, aggregates: [...new Set(perModel.map((r) => r.model))].map(aggregate),
      overallSuccess: true,
    };
  }

  it('writes per-run, aggregate and manifest files; strips judge from the run file', () => {
    const dir = freshDir();
    const m = 'openrouter/qwen/q';
    const written = writeRunArtifacts(dir, meta, result([run(m, null)]));
    const slug = slugModel(m);
    expect(existsSync(join(dir, `${slug}.run1.json`))).toBe(true);
    expect(existsSync(join(dir, `${slug}.aggregate.json`))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    const runFile = JSON.parse(readFileSync(join(dir, `${slug}.run1.json`), 'utf8'));
    expect('judge' in runFile).toBe(false);
    expect(written).toContain(join(dir, 'manifest.json'));
  });

  it('writes a separate judge file only for runs that produced a verdict', () => {
    const dir = freshDir();
    const m = 'openrouter/qwen/q';
    const judge = { dimensions: [], overallScore: 0.9, disputedCases: [], notes: 'ok' };
    writeRunArtifacts(dir, meta, result([run(m, judge)]));
    const slug = slugModel(m);
    expect(existsSync(join(dir, `${slug}.run1.judge.json`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, `${slug}.run1.judge.json`), 'utf8')).overallScore).toBe(0.9);
  });

  it('records the dataset (not fixture) in the manifest', () => {
    const dir = freshDir();
    writeRunArtifacts(dir, meta, result([run('openrouter/qwen/q', null)]));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.dataset).toEqual({ id: 'chat-intents-v1', fingerprint: 'sha256:deadbeef', caseCount: 20 });
    expect(manifest.harnessVersion).toBe('intent-eval-v1');
  });
});
