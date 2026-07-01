import { createHash } from 'node:crypto';
import type { PlatformRunConfig } from '../ports/research-platform.port.ts';
import type { DatasetScope, HoldoutPolicy } from '../domain/research-experiment.ts';
import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function computeStrategyParamsHash(input: {
  bundleHash: string; platformRun: PlatformRunConfig; params: Record<string, unknown>;
}): string {
  const pr = input.platformRun;
  const canonical = {
    v: 1, bundleHash: input.bundleHash,
    platformRun: { datasetId: pr.datasetId, symbols: [...pr.symbols].sort(), timeframe: pr.timeframe, period: pr.period, seed: pr.seed },
    params: input.params,
  };
  return sha(stableStringify(canonical));
}

export function computeStrategyExperimentKey(input: {
  strategyProfileId: string; strategyBundleId: string; bundleHash: string; datasetScope: DatasetScope; holdoutPolicy: HoldoutPolicy;
}): string {
  return sha(stableStringify({
    v: 1, kind: 'strategy_baseline', strategyProfileId: input.strategyProfileId,
    strategyBundleId: input.strategyBundleId, bundleHash: input.bundleHash,
    datasetScope: input.datasetScope, holdoutPolicy: input.holdoutPolicy,
  }));
}
