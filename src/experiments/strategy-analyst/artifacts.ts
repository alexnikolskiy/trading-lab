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

/**
 * Per model, writes one `<slug>.run<k>.json` per run (k = 1..N, judge excluded), a
 * `<slug>.run<k>.judge.json` for runs that produced a judge verdict, and a
 * `<slug>.aggregate.json`. Plus a top-level `manifest.json`. Returns the written paths.
 */
export function writeRunArtifacts(outDir: string, meta: ManifestMeta, result: EvalRunResult): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  // Group the flat per-run results by model, preserving execution order.
  const byModel = new Map<string, CandidateResult[]>();
  for (const c of result.perModel) {
    const arr = byModel.get(c.model) ?? [];
    arr.push(c);
    byModel.set(c.model, arr);
  }

  for (const [model, runs] of byModel) {
    const slug = slugModel(model);
    runs.forEach((candidate, i) => {
      const k = i + 1;
      const { judge, ...withoutJudge } = candidate; // judge excluded from the per-run file
      const runPath = join(outDir, `${slug}.run${k}.json`);
      writeJson(runPath, withoutJudge);
      written.push(runPath);
      if (judge != null) {
        const judgePath = join(outDir, `${slug}.run${k}.judge.json`);
        writeJson(judgePath, judge);
        written.push(judgePath);
      }
    });
    const aggregate = result.aggregates.find((a) => a.model === model);
    if (aggregate) {
      const aggPath = join(outDir, `${slug}.aggregate.json`);
      writeJson(aggPath, aggregate);
      written.push(aggPath);
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
    repeat: result.repeat,
    judgeEnabled: result.judgeEnabled,
    models: result.models,
    perModel: result.aggregates.map((a) => ({
      model: a.model,
      aggregate: { passRate: a.passRate, detMean: a.det?.mean ?? null, judgeMean: a.judge?.mean ?? null },
    })),
    overallSuccess: result.overallSuccess,
  });
  written.push(manifestPath);

  return written;
}
