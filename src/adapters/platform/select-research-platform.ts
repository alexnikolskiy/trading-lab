import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { ResearchPlatformPort } from '../../ports/research-platform.port.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { loadResearchPlatformConfig, createGatewayTransport } from './mcp-research-transport.ts';

/**
 * Boot-safe: the mcp branch defers all config loading + transport creation into the per-call
 * connect thunk, so composeRuntime never spawns the gateway and never depends on trading-platform.
 */
export function selectResearchPlatform(integration: 'mock' | 'mcp'): ResearchPlatformPort {
  if (integration === 'mcp') {
    return new LazyMcpResearchPlatformAdapter(
      () => createGatewayTransport(loadResearchPlatformConfig(process.env)),
      process.env.TRADING_PLATFORM_EXPECTED_CONTRACT || CONTRACT_VERSION,
    );
  }
  return new MockResearchPlatformAdapter();
}
