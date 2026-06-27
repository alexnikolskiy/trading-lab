// src/experiments/strategy-critic/eval-harness.ts
import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import { scoreRefinement } from './scoring.ts';
import type { Candidate, CandidateError, CandidateResult, CriticEvalCase, EvalRunResult, JudgeVerdict, ModelAggregate, Stats } from './types.ts';

export interface RunEvalInput {
  candidates: Candidate[];
  cases: CriticEvalCase[];
  threshold: number;
  repeat?: number; // independent runs per (candidate, case); default 1, assumed >= 1
}

export interface RunEvalDeps {
  criticFor: (candidate: Candidate) => StrategyCriticPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (refinement: StrategyRefinement, evalCase: CriticEvalCase) => Promise<JudgeVerdict>;
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

function criticModelOf(c: Candidate): string {
  return c.mode === 'single' ? c.combinedModel : c.criticModel;
}
function refinerModelOf(c: Candidate): string | null {
  return c.mode === 'two_stage' ? c.refinerModel : null;
}

/** One independent run: refine() -> scoreRefinement() -> (optional) judge(). Never throws. */
export async function runOnce(candidate: Candidate, evalCase: CriticEvalCase, input: RunEvalInput, deps: RunEvalDeps): Promise<CandidateResult> {
  const criticModel = criticModelOf(candidate);
  const refinerModel = refinerModelOf(candidate);
  const start = deps.clock();
  try {
    const critic = deps.criticFor(candidate);
    const raw = await critic.refine({ kind: 'manual_description', content: evalCase.text, title: evalCase.id });
    const latencyMs = deps.clock() - start;
    const score = scoreRefinement(raw, evalCase, { threshold: input.threshold });

    let judge: JudgeVerdict | null = null;
    if (deps.judge) {
      try {
        judge = await deps.judge(raw, evalCase);
      } catch (judgeErr) {
        // Judge is best-effort and NEVER affects the deterministic verdict.
        process.stderr.write(`judge failed for ${candidate.label}/${evalCase.id}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
        judge = null;
      }
    }

    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: score.verdict, score, rawOutput: raw, error: null, judge };
  } catch (err) {
    const latencyMs = deps.clock() - start;
    return { label: candidate.label, mode: candidate.mode, criticModel, refinerModel, caseId: evalCase.id, latencyMs, verdict: 'FAIL', score: null, rawOutput: null, error: classifyError(err), judge: null };
  }
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const perCandidate: CandidateResult[] = [];
  const aggregates: ModelAggregate[] = [];

  // Sequential, candidate-major then case then run index — no parallelism (provider rate limits).
  for (const candidate of input.candidates) {
    const runs: CandidateResult[] = [];
    for (const evalCase of input.cases) {
      for (let k = 0; k < repeat; k++) {
        const r = await runOnce(candidate, evalCase, input, deps);
        runs.push(r);
        perCandidate.push(r);
      }
    }
    aggregates.push(aggregateRuns(runs));
  }

  return {
    threshold: input.threshold,
    repeat,
    judgeEnabled: deps.judge != null,
    candidates: input.candidates,
    cases: input.cases.map((c) => c.id),
    perCandidate,
    aggregates,
    overallSuccess: perCandidate.some((r) => r.verdict === 'PASS'),
  };
}

// TEMPORARY stub — replaced by an import from ./aggregate.ts in Task 7.
function aggregateRuns(runs: CandidateResult[]): ModelAggregate {
  const first = runs[0]!;
  const failed = runs.filter((r) => r.error !== null);
  const passCount = runs.filter((r) => r.verdict === 'PASS').length;
  const zero: Stats = { mean: 0, median: 0, std: 0, min: 0, max: 0 };
  const latencies = runs.map((r) => r.latencyMs);
  return {
    label: first.label,
    mode: first.mode,
    criticModel: first.criticModel,
    refinerModel: first.refinerModel,
    runs: { total: runs.length, ok: runs.length - failed.length, failed: failed.length, failedByType: {} },
    passRate: passCount / runs.length,
    det: null,
    judge: null,
    latency: { mean: latencies.reduce((a, b) => a + b, 0) / latencies.length, median: 0 },
  };
}
