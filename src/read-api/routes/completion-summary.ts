import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';
import { buildCompletionSummary } from '../completion-summary.ts';

export function registerCompletionSummaryRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/tasks/:taskId/completion-summary', async (c) => {
    const summary = await buildCompletionSummary(deps, c.req.param('taskId'));
    if (!summary) {
      return c.json({ error: { code: 'not_found', message: 'completion summary not available' } }, 404);
    }
    return c.json(summary);
  });
}
