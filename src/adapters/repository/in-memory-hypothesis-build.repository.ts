// src/adapters/repository/in-memory-hypothesis-build.repository.ts
import type { HypothesisBuild } from '../../domain/hypothesis-build.ts';
import type { ModuleManifest } from '../../domain/module-bundle.ts';
import type { ArtifactRef } from '../../domain/types.ts';
import type { ValidationIssue } from '../../domain/schemas.ts';
import type { HypothesisBuildRepository } from '../../ports/hypothesis-build.repository.ts';

export class InMemoryHypothesisBuildRepository implements HypothesisBuildRepository {
  private readonly byId = new Map<string, HypothesisBuild>();

  async createGenerating(build: HypothesisBuild): Promise<void> {
    if (this.byId.has(build.id)) throw new Error(`hypothesis_build already exists: ${build.id}`);
    this.byId.set(build.id, { ...build });
  }

  private patch(id: string, patch: Partial<HypothesisBuild>): void {
    const row = this.byId.get(id);
    if (!row) throw new Error(`hypothesis_build not found: ${id}`);
    this.byId.set(id, { ...row, ...patch, updatedAt: new Date().toISOString() });
  }

  async markBuildFailed(id: string, issues: ValidationIssue[]): Promise<void> {
    this.patch(id, { status: 'build_failed', issues });
  }

  async markCandidate(id: string, fields: { bundleHash: string; bundleArtifactRef: ArtifactRef; manifest: ModuleManifest }): Promise<void> {
    this.patch(id, { status: 'candidate', bundleHash: fields.bundleHash, bundleArtifactRef: fields.bundleArtifactRef, manifest: fields.manifest });
  }

  async markSubmitted(id: string): Promise<void> {
    this.patch(id, { status: 'submitted' });
  }

  async findById(id: string): Promise<HypothesisBuild | null> {
    return this.byId.get(id) ?? null;
  }

  async listByHypothesis(hypothesisId: string): Promise<HypothesisBuild[]> {
    return [...this.byId.values()].filter((b) => b.hypothesisId === hypothesisId);
  }
}
