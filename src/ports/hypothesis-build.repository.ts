// src/ports/hypothesis-build.repository.ts
import type { HypothesisBuild } from '../domain/hypothesis-build.ts';
import type { ModuleManifest } from '../domain/module-bundle.ts';
import type { ArtifactRef } from '../domain/types.ts';
import type { ValidationIssue } from '../domain/schemas.ts';

export interface HypothesisBuildRepository {
  createGenerating(build: HypothesisBuild): Promise<void>;
  markBuildFailed(id: string, issues: ValidationIssue[]): Promise<void>;
  markCandidate(id: string, fields: { bundleHash: string; bundleArtifactRef: ArtifactRef; manifest: ModuleManifest }): Promise<void>;
  markSubmitted(id: string): Promise<void>;
  findById(id: string): Promise<HypothesisBuild | null>;
  listByHypothesis(hypothesisId: string): Promise<HypothesisBuild[]>;
}
