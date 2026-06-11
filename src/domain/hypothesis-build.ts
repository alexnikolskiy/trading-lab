// src/domain/hypothesis-build.ts
import type { ModuleManifest } from './module-bundle.ts';
import type { ArtifactRef } from './types.ts';
import type { ValidationIssue } from './schemas.ts';

export type HypothesisBuildStatus = 'generating' | 'build_failed' | 'candidate' | 'submitted';

export interface HypothesisBuild {
  id: string;
  hypothesisId: string;
  strategyProfileId: string;
  status: HypothesisBuildStatus;
  builderAdapter: string;
  builderModel: string;
  bundleHash: string | null;
  bundleArtifactRef: ArtifactRef | null;
  manifest: ModuleManifest | null;
  sdkContractVersion: string;
  bundleContractVersion: string;
  issues: ValidationIssue[];
  attempt: number;
  createdAt: string;
  updatedAt: string;
}
