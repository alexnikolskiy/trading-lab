import type { MiddlewareHandler } from 'hono';
import { bearerAuth } from '../auth/bearer-auth.ts';

// Service-to-service gate for the chat ingress. Delegates to the shared bearerAuth
// factory; chat remains the OWNER of the /chat/messages boundary (its 503 message and
// its wiring in createChatApp). Behavior is identical to SP-6.1:
//   token unset/empty         -> 503 { error: { code: 'service_unavailable', message: 'chat ingress not configured' } }
//   token set, bad/no Bearer  -> 401 { error: { code: 'unauthorized', message: 'missing or invalid token' } }
//   token set, Bearer matches -> next()
export function chatAuthMiddleware(token?: string): MiddlewareHandler {
  return bearerAuth(token, { notConfiguredMessage: 'chat ingress not configured' });
}
