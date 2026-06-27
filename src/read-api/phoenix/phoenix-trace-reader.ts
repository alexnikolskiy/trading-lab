import { buildTracesFromSpans, type AgentTracesDto, type RawPhoenixSpan } from './trace-dto.ts';

export interface PhoenixTraceReaderDeps {
  enabled: boolean;
  baseUrl: string;
  projectName: string;
  apiKey?: string;
  limit?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Lab read-api agent id -> candidate mastra agent span names. Identity is the
 * AGENT (agent_run) span name OR attributes['metadata.agentId']. Confirm/refine
 * the exact strings against the Task A1 fixture. 'system' (office "boss") is the
 * orchestrator and has no mastra agent_run span -> no candidates -> no-traces.
 */
export const LAB_AGENT_SPAN_CANDIDATES: Record<string, string[]> = {
  analyst: ['strategy-analyst'],
  researcher: ['researcher'],
  critic: ['critic', 'strategy-critic-combined'],
  builder: ['builder'],
  system: [],
};

export class PhoenixTraceReader {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly deps: PhoenixTraceReaderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async getAgentTraces(labAgentId: string): Promise<AgentTracesDto> {
    if (!this.deps.enabled) return { agentId: labAgentId, reasonCode: 'tracing-disabled', traces: [] };

    const candidates = LAB_AGENT_SPAN_CANDIDATES[labAgentId] ?? [labAgentId];
    let raw: RawPhoenixSpan[];
    try {
      raw = await this.fetchSpans();
    } catch {
      // Never surface the raw error/url/key — typed state only.
      return { agentId: labAgentId, reasonCode: 'phoenix-unreachable', traces: [] };
    }

    const matchAgent = (root: RawPhoenixSpan): boolean => {
      const metaId = root.attributes['metadata.agentId'];
      return candidates.some((c) => root.name === c || root.name === `agent.${c}` || metaId === c);
    };
    const traces = candidates.length === 0 ? [] : buildTracesFromSpans(raw, matchAgent);
    if (traces.length === 0) return { agentId: labAgentId, reasonCode: 'no-traces', traces: [] };
    return { agentId: labAgentId, reasonCode: null, traces };
  }

  private async fetchSpans(): Promise<RawPhoenixSpan[]> {
    const limit = this.deps.limit ?? 200;
    const url = `${this.deps.baseUrl}/v1/projects/${encodeURIComponent(this.deps.projectName)}/spans?limit=${limit}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.deps.apiKey) headers.Authorization = `Bearer ${this.deps.apiKey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.deps.requestTimeoutMs ?? 4000);
    try {
      const res = await this.fetchImpl(url, { headers, signal: ctrl.signal });
      if (!res.ok) throw new Error(`phoenix ${res.status}`);
      // Phoenix returns { data: [...], next_cursor } — confirmed live in Task A1 (NOT { spans }).
      const body = (await res.json()) as { data?: RawPhoenixSpan[] };
      return body.data ?? [];
    } finally {
      clearTimeout(timer);
    }
  }
}
