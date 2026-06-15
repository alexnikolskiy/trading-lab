import type { Hono } from 'hono';
import type { ReadApiDeps } from '../deps.ts';

export function registerHealthRoutes(app: Hono, deps: ReadApiDeps): void {
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    const ok = await deps.checkReadiness();
    return c.json({ status: ok ? 'ok' : 'degraded', checks: { db: ok } }, ok ? 200 : 503);
  });
}

// Credential probe. MUST be mounted on the auth-gated /v1 sub-app so it runs through
// readAuthMiddleware: a valid TRADING_LAB_READ_TOKEN → 200 { status: 'ok' }; missing/invalid
// → the same 401 envelope as every other /v1 route. Unlike the open /readyz (process/db
// readiness only), this lets a consumer verify the read credentials it will use for /v1/* reads.
export function registerAuthzRoute(app: Hono): void {
  app.get('/authz', (c) => c.json({ status: 'ok' }));
}
