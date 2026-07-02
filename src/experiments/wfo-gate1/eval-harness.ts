import { scoreCase, scoreRun } from './scoring.ts';
import type { CaseScore, RunScore } from './scoring.ts';
import type { FrozenDataset } from './types.ts';
import type { Gate1DecisionPort } from '../../ports/wfo-agents.port.ts';

export interface RunEvalInput {
  models: string[];
  dataset: FrozenDataset;
  threshold: number;
  repeat?: number;
}

export interface RunEvalDeps {
  gate1For: (modelId: string) => Gate1DecisionPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
}

export interface CandidateResult {
  modelId: string;
  provider: string;
  ok: boolean;
  error?: string;
  result?: RunScore;
}

export interface ModelAggregate {
  modelId: string;
  provider: string;
  runs: number;
  meanScore: number;
  accuracy: number;
  oracleAccuracy: number;
  teacherAccuracy: number;
  passRate: number;
  meanLatencyMs: number;
}

export interface ManifestMeta {
  snapshotId: string;
  models: string[];
  repeat: number;
  threshold: number;
  caseCount: number;
  teacherModel: string | null;
  teacherCircular: boolean;
  harnessVersion: string;
  gitSha: string;
}

export interface EvalRunResult {
  manifest: ManifestMeta;
  candidates: CandidateResult[];
  aggregates: ModelAggregate[];
}

const HARNESS_VERSION = 'wfo-gate1-eval-v1';

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const candidates: CandidateResult[] = [];

  for (const modelId of input.models) {
    const { provider } = deps.providerOf(modelId);
    let gate1: Gate1DecisionPort;
    try {
      gate1 = deps.gate1For(modelId);
    } catch (err) {
      candidates.push({ modelId, provider, ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const allCaseScores: CaseScore[] = [];
    for (let r = 0; r < repeat; r++) {
      for (const c of input.dataset.cases) {
        const t0 = deps.clock();
        let raw: unknown;
        try {
          raw = await gate1.decide(c.input);
        } catch {
          raw = { __throw: true }; // becomes a schema-invalid miss in scoreCase
        }
        const latencyMs = deps.clock() - t0;
        allCaseScores.push(scoreCase(raw, c, latencyMs));
      }
    }
    const result = scoreRun(allCaseScores, { threshold: input.threshold });
    candidates.push({ modelId, provider, ok: true, result });
  }

  const aggregates: ModelAggregate[] = candidates.map((c) => {
    const cases = c.result?.cases ?? [];
    const meanLatencyMs = cases.length ? cases.reduce((a, x) => a + x.latencyMs, 0) / cases.length : 0;
    return {
      modelId: c.modelId,
      provider: c.provider,
      runs: repeat,
      meanScore: c.result?.meanScore ?? 0,
      accuracy: c.result?.accuracy ?? 0,
      oracleAccuracy: c.result?.oracleAccuracy ?? 0,
      teacherAccuracy: c.result?.teacherAccuracy ?? 0,
      passRate: c.result ? (c.result.verdict === 'PASS' ? 1 : 0) : 0,
      meanLatencyMs,
    };
  });

  const teacherModel = input.dataset.cases.find((c) => c.teacherModel !== undefined)?.teacherModel ?? null;
  const teacherCircular = teacherModel !== null && input.models.includes(teacherModel);

  const manifest: ManifestMeta = {
    snapshotId: input.dataset.snapshotId,
    models: input.models,
    repeat,
    threshold: input.threshold,
    caseCount: input.dataset.cases.length,
    teacherModel,
    teacherCircular,
    harnessVersion: HARNESS_VERSION,
    gitSha: 'unknown',
  };

  return { manifest, candidates, aggregates };
}
