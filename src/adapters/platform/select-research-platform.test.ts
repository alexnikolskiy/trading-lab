import { describe, it, expect, vi } from 'vitest';
import { selectResearchPlatform } from './select-research-platform.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import * as transport from './mcp-research-transport.ts';

describe('selectResearchPlatform', () => {
  it('defaults to the mock adapter', () => {
    expect(selectResearchPlatform('mock')).toBeInstanceOf(MockResearchPlatformAdapter);
  });

  it('returns a lazy mcp adapter for mcp without opening a transport', () => {
    const spy = vi.spyOn(transport, 'createGatewayTransport');
    const a = selectResearchPlatform('mcp');
    expect(a).toBeInstanceOf(LazyMcpResearchPlatformAdapter);
    expect(spy).not.toHaveBeenCalled(); // construction is inert; no gateway spawn at boot
    spy.mockRestore();
  });
});
