import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';

export function registerHealthRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    const ok = await deps.checkReadiness();
    return c.json({ status: ok ? 'ok' : 'degraded', checks: { db: ok } }, ok ? 200 : 503);
  });
}
