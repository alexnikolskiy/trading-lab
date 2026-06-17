// src/experiments/intent-classifier/imports.guard.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'src/experiments/intent-classifier';

// real-classifier-factory.ts legitimately imports composeMastra; it is loaded ONLY under --run.
const ALLOWED_TO_IMPORT_COMPOSE = new Set(['real-classifier-factory.ts']);

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
