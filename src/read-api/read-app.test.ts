import { describe, it, expect } from 'vitest';
import { createReadApp } from './read-app.ts';
import type { ReadApiDeps } from './deps.ts';
import { InMemoryHypothesisReadAdapter } from '../adapters/read/in-memory-hypothesis-read.adapter.ts';
import { InMemoryBacktestReadAdapter } from '../adapters/read/in-memory-backtest-read.adapter.ts';
import { InMemoryAgentEventReadAdapter } from '../adapters/read/in-memory-agent-event-read.adapter.ts';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function deps(over: Partial<ReadApiDeps> = {}): ReadApiDeps {
  return {
    hypotheses: new InMemoryHypothesisReadAdapter([]),
    backtests: new InMemoryBacktestReadAdapter([]),
    agentEvents: new InMemoryAgentEventReadAdapter([]),
    checkReadiness: async () => true,
    token: TOKEN,
    ...over,
  };
}

describe('createReadApp skeleton', () => {
  it('GET /healthz is open and 200', async () => {
    const res = await createReadApp(deps()).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reflects checkReadiness', async () => {
    expect((await createReadApp(deps()).request('/readyz')).status).toBe(200);
    const down = await createReadApp(deps({ checkReadiness: async () => false })).request('/readyz');
    expect(down.status).toBe(503);
  });

  it('GET /v1/* requires a token (401 without it)', async () => {
    expect((await createReadApp(deps()).request('/v1/hypotheses')).status).toBe(401);
    // The 200-with-token case needs real routes — it lands in Task 15 (stub routes register no GET here).
  });

  it('non-GET on a /v1 path returns 405 (not 404)', async () => {
    const app = createReadApp(deps());
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request('/v1/hypotheses', { method, headers: AUTH });
      expect(res.status, method).toBe(405);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('method_not_allowed');
    }
  });
});
