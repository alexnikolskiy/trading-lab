import type { DatasetScope, HoldoutPolicy } from '../domain/research-experiment.ts';
import { sha256, stableStringify } from '../orchestrator/handlers/backtest-support.ts';

/**
 * Deterministic idempotency key for a Research Experiment.
 *
 * Computes sha256(canonical({ v:1, strategyProfileId, buildId, bundleHash,
 *   datasetScopeHash, holdoutPolicyHash }))
 * where the nested hashes are sha256(stableStringify(scope/policy)).
 *
 * Uses the project's key-sorted `stableStringify` (from backtest-support.ts)
 * so the key is independent of JS property insertion order.
 */
export function computeExperimentKey(input: {
  strategyProfileId: string;
  buildId?: string;
  bundleHash?: string;
  datasetScope: DatasetScope;
  holdoutPolicy: HoldoutPolicy;
}): string {
  return sha256(
    stableStringify({
      v: 1,
      strategyProfileId: input.strategyProfileId,
      buildId: input.buildId ?? null,
      bundleHash: input.bundleHash ?? null,
      datasetScopeHash: sha256(stableStringify(input.datasetScope)),
      holdoutPolicyHash: sha256(stableStringify(input.holdoutPolicy)),
    }),
  );
}
