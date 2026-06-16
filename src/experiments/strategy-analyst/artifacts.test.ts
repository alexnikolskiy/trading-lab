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
