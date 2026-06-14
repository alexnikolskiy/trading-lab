import { describe, it, expect } from 'vitest';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';

const manifest: ModuleManifest = {
  moduleId: 'm1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};

describe('MockResearchPlatformAdapter.validateModule', () => {
  it('returns an accepted, non-executed report', async () => {
    const adapter = new MockResearchPlatformAdapter();
    const report = await adapter.validateModule(assembleBundle(manifest, { 'index.ts': 'export const overlay = {};' }));
    expect(report.status).toBe('accepted');
    expect(report.executed).toBe(false);
    expect(report.issues).toEqual([]);
  });
});
