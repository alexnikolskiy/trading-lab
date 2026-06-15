import { createHash, randomUUID } from 'node:crypto';
import type { AppServices } from '../app-services.ts';
import type { ResearchTask } from '../../domain/types.ts';
import type { AgentEvent } from '../../ports/agent-event.repository.ts';
import type { ComparisonSummary } from '../../ports/platform-gateway.port.ts';
import type { BacktestCompletion } from '../../domain/backtest-run.ts';
import type { Evaluation } from '../../domain/evaluation.ts';
import type { PlatformRunConfig, Ref } from '../../ports/research-platform.port.ts';
import { evaluateBacktest } from '../../validation/evaluator.ts';

export function event(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sha256(input: string): string {
  // Byte-identical to the legacy SP-4 handler hash: `sha256:` prefix + utf8 input.
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Backend-aware identity hash. sp4_mock stays byte-identical to the legacy hash. */
export function computeParamsHash(
  backend: 'sp4_mock' | 'research_platform',
  params: Record<string, unknown>,
  ctx?: { platformRun: PlatformRunConfig; baselineRef: Ref },
): string {
  if (backend === 'sp4_mock') return sha256(stableStringify(params));
  const { platformRun, baselineRef } = ctx!;
  return sha256(stableStringify({
    backend: 'research_platform',
    params,
    baseline: { id: baselineRef.id, version: baselineRef.version },
    platformRun: {
      datasetId: platformRun.datasetId,
      symbols: [...platformRun.symbols].sort(),
      timeframe: platformRun.timeframe,
      period: { from: platformRun.period.from, to: platformRun.period.to },
      seed: platformRun.seed,
    },
  }));
}

/** Shared completion + evaluation tail (extracted verbatim from the SP-4 path). */
export async function finalizeBacktestCompletion(
  services: AppServices,
  task: ResearchTask,
  args: { runId: string; hypothesisId: string; comparison: ComparisonSummary; artifactRefs: string[] },
): Promise<void> {
  const now = () => new Date().toISOString();
  const c = args.comparison;
  const completion: BacktestCompletion = {
    metrics: c.variant, baselineMetrics: c.baseline,
    deltaNetPnlUsd: c.variant.netPnlUsd - c.baseline.netPnlUsd,
    deltaMaxDrawdownPct: c.variant.maxDrawdownPct - c.baseline.maxDrawdownPct,
    isFragile: c.variant.topTradeContributionPct >= services.evaluatorThresholds.fragilityTopTradePct,
    artifactRefs: args.artifactRefs, platformContractVersion: c.platformContractVersion, finishedAt: now(),
  };
  await services.backtests.markCompleted(args.runId, completion);
  await services.events.append(event(task.id, 'backtest.completed', { runId: args.runId, deltaNetPnlUsd: completion.deltaNetPnlUsd }));

  const outcome = evaluateBacktest(c, services.evaluatorThresholds);
  const evaluation: Evaluation = {
    id: randomUUID(), backtestRunId: args.runId, hypothesisId: args.hypothesisId,
    decision: outcome.decision, reasons: outcome.reasons, metricsSnapshot: c,
    thresholds: services.evaluatorThresholds, createdAt: now(),
  };
  await services.evaluations.create(evaluation);
  await services.backtests.markEvaluated(args.runId);
  await services.events.append(event(task.id, 'evaluation.completed', { runId: args.runId, decision: outcome.decision, reasons: outcome.reasons }));
}
