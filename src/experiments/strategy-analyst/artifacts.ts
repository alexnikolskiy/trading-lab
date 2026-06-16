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
