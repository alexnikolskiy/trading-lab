// src/experiments/wfo-gate1/case-source.ts
//
// Extracts Gate1Input cases for the WFO Gate1 eval dataset from RECORDED
// strategy_baseline_validation experiments — reconstructing the same Gate1Input the live WFO
// builds in ExperimentService.runWalkForwardOptimization (§ GATE1), so the eval dataset reflects
// real production inputs rather than synthetic ones (see fixtures.ts for those).
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { classifyEntryAffectingParams } from '../../domain/wfo.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchExperimentRepository } from '../../ports/research-experiment.repository.ts';
import type { StrategyBacktestRunRepository } from '../../ports/strategy-backtest-run.repository.ts';
import type { StrategyProfileRepository } from '../../ports/strategy-profile.repository.ts';
import type { BacktestMetricBlock } from '../../ports/platform-gateway.port.ts';
import type { Gate1Input } from '../../ports/wfo-agents.port.ts';
import { RawCaseSchema, type RawCase } from './types.ts';

export interface CaseSource {
  load(): Promise<RawCase[]>;
}

export interface DbCaseSourceDeps {
  experiments: ResearchExperimentRepository;
  strategyBacktests: StrategyBacktestRunRepository;
  strategyProfiles: StrategyProfileRepository;
}

/**
 * Mirrors ExperimentService.runWalkForwardOptimization's GATE1 input construction:
 * entryAffecting derives from the profile's tunable params; hasEntrySignalEvidence defaults to
 * `totalTrades > 0` (the live WFO also honors an explicit input.entrySignalEvidence override —
 * that recorded-evidence enrichment does not exist yet for this offline reconstruction, so a
 * 0-trade case here always lands at hasEntrySignalEvidence === false).
 */
export function reconstructGate1Input(args: {
  profile: StrategyProfile;
  baselineMetrics: BacktestMetricBlock;
}): Gate1Input {
  const { entryAffecting } = classifyEntryAffectingParams(args.profile.profile.parameters);
  const hasEntrySignalEvidence = args.baselineMetrics.totalTrades > 0;
  return {
    profile: args.profile,
    baselineMetrics: args.baselineMetrics,
    entryAffecting,
    hasEntrySignalEvidence,
  };
}

export class DbCaseSource implements CaseSource {
  private readonly deps: DbCaseSourceDeps;

  constructor(deps: DbCaseSourceDeps) {
    this.deps = deps;
  }

  async load(): Promise<RawCase[]> {
    const cases: RawCase[] = [];
    const experiments = await this.deps.experiments.listByType('strategy_baseline_validation');

    for (const exp of experiments) {
      // A non-completed baseline has no reliable members/metrics yet — expected, not noise, so
      // this skip stays quiet (no console.warn).
      if (exp.status !== 'completed') continue;

      const members = await this.deps.experiments.listMembers(exp.id);
      // Train-window metrics when a split exists, sanity when mode:'none' (mirrors the
      // Slice-B #123 fix in runWalkForwardOptimization).
      const member = members.find((m) => m.role === 'train') ?? members.find((m) => m.role === 'sanity');
      if (!member) {
        console.warn(`[wfo-gate1/case-source] skipping experiment ${exp.id}: no train or sanity member`);
        continue;
      }
      if (!member.strategyBacktestRunId) {
        console.warn(
          `[wfo-gate1/case-source] skipping experiment ${exp.id}: chosen member ${member.id} (role=${member.role}) has no strategyBacktestRunId`,
        );
        continue;
      }

      const run = await this.deps.strategyBacktests.findById(member.strategyBacktestRunId);
      if (!run?.metrics) {
        console.warn(
          `[wfo-gate1/case-source] skipping experiment ${exp.id}: strategy backtest run ${member.strategyBacktestRunId} has no metrics`,
        );
        continue;
      }

      const profile = await this.deps.strategyProfiles.findById(exp.strategyProfileId);
      if (!profile) {
        console.warn(
          `[wfo-gate1/case-source] skipping experiment ${exp.id}: strategy profile ${exp.strategyProfileId} not found`,
        );
        continue;
      }

      const input = reconstructGate1Input({ profile, baselineMetrics: run.metrics });
      cases.push({ id: `case-${exp.id}`, input, meta: { experimentId: exp.id, sourceRef: 'db' } });
    }

    return cases;
  }
}

export class SnapshotCaseSource implements CaseSource {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<RawCase[]> {
    const raw = readFileSync(this.filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Genuinely validates the parsed JSON is an array of RawCase with a real Gate1Input payload
    // (RawCaseSchema.input now runs Gate1InputMinimalSchema, not a bare z.any() cast).
    return z.array(RawCaseSchema).parse(parsed);
  }
}
