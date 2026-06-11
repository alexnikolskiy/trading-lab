// src/adapters/repository/in-memory-hypothesis-build.repository.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryHypothesisBuildRepository } from './in-memory-hypothesis-build.repository.ts';
import { SDK_CONTRACT_VERSION, MODULE_BUNDLE_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ArtifactRef } from '../../domain/types.ts';

function build(id: string): HypothesisBuild {
  const now = '2026-01-01T00:00:00Z';
  return {
    id, hypothesisId: 'h1', strategyProfileId: 'p1', status: 'generating',
    builderAdapter: 'fake', builderModel: 'fake', bundleHash: null, bundleArtifactRef: null,
    manifest: null, sdkContractVersion: SDK_CONTRACT_VERSION, bundleContractVersion: MODULE_BUNDLE_CONTRACT_VERSION,
    issues: [], attempt: 1, createdAt: now, updatedAt: now,
  };
}
const manifest: ModuleManifest = { moduleId: 'm', moduleKind: 'hypothesis_overlay', appliesTo: 'long', entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION };
const ref: ArtifactRef = { artifact_id: 'a1', uri: 'file://a', content_hash: 'sha256:x', kind: 'module_bundle', size_bytes: 1, mime_type: 'application/json', created_at: '2026-01-01T00:00:00Z', producer: 'builder', metadata: {} };

describe('InMemoryHypothesisBuildRepository', () => {
  it('createGenerating then findById returns the row', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    expect((await repo.findById('b1'))?.status).toBe('generating');
  });

  it('throws on duplicate id', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await expect(repo.createGenerating(build('b1'))).rejects.toThrow(/already exists/);
  });

  it('markBuildFailed sets status + issues', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await repo.markBuildFailed('b1', [{ code: 'builder_failed', severity: 'error', path: 'builder', message: 'boom' }]);
    const row = await repo.findById('b1');
    expect(row?.status).toBe('build_failed');
    expect(row?.issues[0]?.code).toBe('builder_failed');
  });

  it('markCandidate sets candidate + bundle fields', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await repo.markCandidate('b1', { bundleHash: 'sha256:zz', bundleArtifactRef: ref, manifest });
    const row = await repo.findById('b1');
    expect(row?.status).toBe('candidate');
    expect(row?.bundleHash).toBe('sha256:zz');
    expect(row?.manifest?.moduleId).toBe('m');
  });

  it('markSubmitted sets submitted', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    await repo.markSubmitted('b1');
    expect((await repo.findById('b1'))?.status).toBe('submitted');
  });

  it('listByHypothesis filters by hypothesisId', async () => {
    const repo = new InMemoryHypothesisBuildRepository();
    await repo.createGenerating(build('b1'));
    expect(await repo.listByHypothesis('h1')).toHaveLength(1);
    expect(await repo.listByHypothesis('other')).toHaveLength(0);
  });
});
