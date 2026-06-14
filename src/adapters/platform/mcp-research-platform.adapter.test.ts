import { describe, it, expect } from 'vitest';
import { McpResearchPlatformAdapter, LazyMcpResearchPlatformAdapter } from './mcp-research-platform.adapter.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { GatewayTransport, ValidateModuleResult } from '@trading-platform/sdk/agent';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const bundle = assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' });

function transportReturning(result: ValidateModuleResult): { transport: GatewayTransport; calls: { tool: string; payload: unknown }[] } {
  const calls: { tool: string; payload: unknown }[] = [];
  const transport: GatewayTransport = { call: async (tool: string, payload: unknown) => { calls.push({ tool, payload }); return result; } };
  return { transport, calls };
}

describe('McpResearchPlatformAdapter.validateModule', () => {
  it('sends a submitted bundle to validate_module and returns the report on ok', async () => {
    const okReport = { status: 'accepted', issues: [], executed: false } as const;
    const { transport, calls } = transportReturning({ ok: true, report: okReport });
    const report = await new McpResearchPlatformAdapter(transport, CONTRACT_VERSION).validateModule(bundle);
    expect(report).toEqual(okReport);
    expect(calls[0]!.tool).toBe('validate_module');
    expect((calls[0]!.payload as { module: { kind: string } }).module.kind).toBe('submitted');
  });

  it('throws GatewayValidationError on an ok:false envelope', async () => {
    const { transport } = transportReturning({ ok: false, error: { category: 'validation_error', code: 'invalid_module', message: 'bad' } });
    await expect(new McpResearchPlatformAdapter(transport, CONTRACT_VERSION).validateModule(bundle))
      .rejects.toBeInstanceOf(GatewayValidationError);
  });

  it('Lazy variant opens and closes a session around the call', async () => {
    const okReport = { status: 'accepted', issues: [], executed: false } as const;
    const { transport } = transportReturning({ ok: true, report: okReport });
    let closed = false;
    const lazy = new LazyMcpResearchPlatformAdapter(
      async () => ({ transport, close: async () => { closed = true; } }),
      CONTRACT_VERSION,
    );
    const report = await lazy.validateModule(bundle);
    expect(report).toEqual(okReport);
    expect(closed).toBe(true);
  });
});
