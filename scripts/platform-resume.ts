// scripts/platform-resume.ts
// platform:resume — drive pending research_platform backtest runs to terminal (no re-submit).
// Boots the DB-backed runtime (like `pnpm worker`); all resume logic lives in the core.
import { pathToFileURL } from 'node:url';
import { composeRuntime } from '../src/composition.ts';
import { resumePendingPlatformRuns } from '../src/orchestrator/handlers/resume-platform-backtest.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { services, queue, pool } = composeRuntime();
  let code = 0;
  try {
    const result = await resumePendingPlatformRuns(services);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err: unknown) {
    process.stderr.write(`platform:resume failed: ${err instanceof Error ? err.message : String(err)}\n`);
    code = 1;
  } finally {
    await queue.close();
    await pool.end();
    process.exit(code);
  }
}
