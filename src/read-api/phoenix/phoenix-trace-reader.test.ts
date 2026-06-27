import { describe, it, expect, vi } from 'vitest';
import { PhoenixTraceReader } from './phoenix-trace-reader.ts';

// NOTE (confirmed in Task A1): the Phoenix spans envelope key is `data`, not `spans`.
const spansResponse = (spans: unknown[]) =>
  new Response(JSON.stringify({ data: spans, next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });

const agentSpan = (trace: string, name: string) => ({
  name, span_kind: 'AGENT', parent_id: null,
  start_time: '2026-06-27T10:00:00.000Z', end_time: '2026-06-27T10:00:02.000Z',
  status_code: 'OK', attributes: {}, context: { trace_id: trace, span_id: trace + '-root' },
});

const base = { baseUrl: 'http://px:6006', projectName: 'trading-lab' };

describe('PhoenixTraceReader', () => {
  it('returns tracing-disabled (no fetch) when disabled', async () => {
    const fetchImpl = vi.fn();
    const r = new PhoenixTraceReader({ ...base, enabled: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await r.getAgentTraces('analyst')).toEqual({ agentId: 'analyst', reasonCode: 'tracing-disabled', traces: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('queries the project spans endpoint with the api key and maps matching traces', async () => {
    const fetchImpl = vi.fn(async () => spansResponse([agentSpan('t1', 'strategy-analyst')]));
    const r = new PhoenixTraceReader({ ...base, enabled: true, apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await r.getAgentTraces('analyst');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/v1/projects/trading-lab/spans');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(out.reasonCode).toBeNull();
    expect(out.traces.map((t) => t.traceId)).toEqual(['t1']);
  });

  it('matches by metadata.agentId when the span name differs', async () => {
    const s = { ...agentSpan('t9', 'agent.run'), attributes: { 'metadata.agentId': 'researcher' } };
    const r = new PhoenixTraceReader({ ...base, enabled: true, fetchImpl: (async () => spansResponse([s])) as unknown as typeof fetch });
    expect((await r.getAgentTraces('researcher')).traces).toHaveLength(1);
  });

  it('returns no-traces when nothing matches the agent', async () => {
    const r = new PhoenixTraceReader({ ...base, enabled: true, fetchImpl: (async () => spansResponse([agentSpan('t1', 'builder')])) as unknown as typeof fetch });
    expect(await r.getAgentTraces('analyst')).toEqual({ agentId: 'analyst', reasonCode: 'no-traces', traces: [] });
  });

  it('returns phoenix-unreachable (no throw, no leak) when the fetch fails', async () => {
    const r = new PhoenixTraceReader({ ...base, enabled: true, fetchImpl: (async () => { throw new Error('ECONNREFUSED secret://px'); }) as unknown as typeof fetch });
    const out = await r.getAgentTraces('analyst');
    expect(out).toEqual({ agentId: 'analyst', reasonCode: 'phoenix-unreachable', traces: [] });
  });

  it('returns phoenix-unreachable on a non-2xx Phoenix response', async () => {
    const r = new PhoenixTraceReader({ ...base, enabled: true, fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch });
    expect((await r.getAgentTraces('analyst')).reasonCode).toBe('phoenix-unreachable');
  });
});
