import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShellBundleProver } from './shell-bundle-prover.ts';

function writeStubCli(dir: string, verdict: object): string {
  const cli = join(dir, 'stub-cli.mjs');
  writeFileSync(cli,
    `import { writeFileSync } from 'node:fs';\n` +
    `const out = process.argv[process.argv.indexOf('--out') + 1];\n` +
    `writeFileSync(out, ${JSON.stringify(JSON.stringify(verdict))});\n`);
  return cli;
}

describe('createShellBundleProver', () => {
  it('шеллит CLI, парсит записанный вердикт', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbp-'));
    try {
      const cli = writeStubCli(dir, { proven: false, divergence: { bar: 7, field: 'qty', expected: 1, actual: 2 } });
      const prover = createShellBundleProver({ cli });
      const v = await prover.prove('export default function createStrategyModule(){ return {}; }');
      expect(v).toEqual({ proven: false, divergence: { bar: 7, field: 'qty', expected: 1, actual: 2 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
