import type { MiddlewareHandler } from 'hono';
import { parseBearer, safeEqual } from './bearer.ts';
import type { BearerAuthOptions } from './bearer-auth.ts';

/** Callback ingress auth: Bearer header OR ?token= query (backtester webhook has no custom headers). */
export function callbackBearerAuth(token: string | undefined, opts: BearerAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!token) {
      return c.json({ error: { code: 'service_unavailable', message: opts.notConfiguredMessage } }, 503);
    }
    const headerToken = parseBearer(c.req.header('authorization'));
    const queryToken = c.req.query('token');
    const presented = headerToken ?? (queryToken && queryToken.length > 0 ? queryToken : null);
    if (presented === null || !safeEqual(presented, token)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}
