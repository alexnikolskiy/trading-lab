import { describe, it, expect } from 'vitest';
import { loadResearchPlatformConfig, createGatewayTransport } from './mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';

// Opt-in: needs a real gateway. Set RUN_PLATFORM_INTEGRATION=true + TRADING_PLATFORM_GATEWAY_COMMAND/ARGS.
const enabled = process.env.RUN_PLATFORM_INTEGRATION === 'true' && !!process.env.TRADING_PLATFORM_GATEWAY_COMMAND;

describe.skipIf(!enabled)('platform discovery integration (real gateway over stdio)', () => {
  it('discovers a compatible contract and lists datasets', async () => {
    const config = loadResearchPlatformConfig(process.env);
    const session = await createGatewayTransport(config);
    try {
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      const descriptor = await platform.discover();
      expect(typeof descriptor.contractVersion).toBe('string');
      expect(descriptor.contractVersion.length).toBeGreaterThan(0);
      const datasets = await platform.listDatasets();
      expect(Array.isArray(datasets.datasets)).toBe(true);
    } finally {
      await session.close();
    }
  }, 30000);
});
