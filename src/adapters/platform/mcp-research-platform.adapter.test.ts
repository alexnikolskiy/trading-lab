import { describe, it, expect } from 'vitest';
import type { GatewayToolName, GatewayTransport } from '@trading-platform/sdk/agent';
import { McpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { ContractIncompatibleError } from './research-contract.ts';

function fakeTransport(responses: Partial<Record<GatewayToolName, unknown>>): {
  transport: GatewayTransport; calls: Array<{ tool: string; args: unknown }>;
} {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const transport: GatewayTransport = {
    async call(tool, args) { calls.push({ tool, args }); return responses[tool]; },
  };
  return { transport, calls };
}

const descriptor = (cv: string, supported: string[]) => ({
  contractVersion: cv, supportedContractVersions: supported,
  marketDataKinds: [], runModes: [], metricCatalog: [], robustnessCatalog: [],
});

describe('McpResearchPlatformAdapter', () => {
  it('discover() calls discover_research_contract and returns the descriptor', async () => {
    const { transport, calls } = fakeTransport({ discover_research_contract: descriptor('031.2', ['031.2']) });
    const a = new McpResearchPlatformAdapter(transport, '031.2');
    const d = await a.discover();
    expect(calls).toEqual([{ tool: 'discover_research_contract', args: {} }]);
    expect(d.contractVersion).toBe('031.2');
  });

  it('discover() throws ContractIncompatibleError on an incompatible version', async () => {
    const { transport } = fakeTransport({ discover_research_contract: descriptor('031.9', ['031.9']) });
    const a = new McpResearchPlatformAdapter(transport, '031.2');
    await expect(a.discover()).rejects.toBeInstanceOf(ContractIncompatibleError);
  });

  it('listDatasets() calls list_datasets with the filter', async () => {
    const { transport, calls } = fakeTransport({ list_datasets: { datasets: [] } });
    const a = new McpResearchPlatformAdapter(transport, '031.2');
    const r = await a.listDatasets({ symbol: 'BTCUSDT' });
    expect(calls).toEqual([{ tool: 'list_datasets', args: { symbol: 'BTCUSDT' } }]);
    expect(r.datasets).toEqual([]);
  });
});
