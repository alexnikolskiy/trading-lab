// src/experiments/intent-classifier/eval-harness.ts
// DI orchestrator. Imports NO model/composeMastra code — the real classifier is injected.
// Model-major, sequential (no parallelism, to avoid provider rate limits). Per-model isolation:
// a model that cannot be built FAILs alone; a single message that throws is a schema-invalid miss.
import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import { scoreCase, scoreRun } from './scoring.ts';
import { aggregateRuns } from './aggregate.ts';
import type { CandidateError, CandidateResult, CaseResult, EvalCase, EvalRunResult, JudgeVerdict, ModelAggregate } from './types.ts';

export interface RunEvalInput {
  models: string[];
  datasetId: string;
  cases: EvalCase[];
  datasetFingerprint: string;
  threshold: number;
  repeat?: number; // independent runs per model; default 1, assumed >= 1
}

export interface JudgeRunInput {
  cases: EvalCase[];
  results: CaseResult[];
}

export interface RunEvalDeps {
  classifierFor: (modelId: string) => IntentClassifierPort;
  providerOf: (modelId: string) => { provider: string; modelId: string };
  clock: () => number;
  judge?: (input: JudgeRunInput) => Promise<JudgeVerdict>;
}

export function classifyError(err: unknown): CandidateError {
  const message = err instanceof Error ? err.message : String(err);
  let type: CandidateError['type'] = 'unknown';
  if (/timeout|timed out/i.test(message)) type = 'timeout';
  else if (/schema|zod|parse|validation|invalid/i.test(message)) type = 'schema';
  else if (/api key|provider|rate limit|status|fetch|network|econn|unauthorized/i.test(message)) type = 'provider';
  return { type, message };
}

/** One independent run for a model: classify every case -> scoreRun -> (optional) batch judge. Never throws. */
async function runOnce(model: string, input: RunEvalInput, deps: RunEvalDeps): Promise<CandidateResult> {
  const { provider, modelId } = deps.providerOf(model);
  const runStart = deps.clock();

  let classifier: IntentClassifierPort;
  try {
    classifier = deps.classifierFor(model);
  } catch (err) {
    // Catastrophic: the classifier could not be built — the whole run fails (isolated to this model).
    return { model, provider, modelId, latencyMs: deps.clock() - runStart, verdict: 'FAIL', score: null, error: classifyError(err), judge: null };
  }

  const caseResults: CaseResult[] = [];
  for (const c of input.cases) {
    const start = deps.clock();
    try {
      const raw = await classifier.classify(c.message);
      caseResults.push(scoreCase(raw, c, deps.clock() - start));
    } catch (err) {
      // A single message failing is a schema-invalid miss, not a run abort.
      caseResults.push({
        id: c.id, lang: c.lang, expectedIntent: c.expect.intent,
        actualIntent: null, intentMatch: false, schemaValid: false,
        payloadChecks: [], payloadScore: null, latencyMs: deps.clock() - start, error: classifyError(err),
      });
    }
  }

  const score = scoreRun(caseResults, { threshold: input.threshold });
  const latencyMs = deps.clock() - runStart;

  let judge: JudgeVerdict | null = null;
  if (deps.judge) {
    try {
      judge = await deps.judge({ cases: input.cases, results: caseResults });
    } catch (judgeErr) {
      // Judge is best-effort and NEVER affects the deterministic verdict.
      process.stderr.write(`judge failed for ${model}: ${judgeErr instanceof Error ? judgeErr.message : String(judgeErr)}\n`);
      judge = null;
    }
  }

  return { model, provider, modelId, latencyMs, verdict: score.verdict, score, error: null, judge };
}

export async function runEval(input: RunEvalInput, deps: RunEvalDeps): Promise<EvalRunResult> {
  const repeat = input.repeat ?? 1;
  const perModel: CandidateResult[] = [];
  const aggregates: ModelAggregate[] = [];

  for (const model of input.models) {
    const runs: CandidateResult[] = [];
    for (let k = 0; k < repeat; k++) {
      const r = await runOnce(model, input, deps);
      runs.push(r);
      perModel.push(r);
    }
    aggregates.push(aggregateRuns(runs));
  }

  return {
    dataset: { id: input.datasetId, fingerprint: input.datasetFingerprint, caseCount: input.cases.length },
    threshold: input.threshold,
    repeat,
    judgeEnabled: deps.judge != null,
    models: input.models,
    perModel,
    aggregates,
    overallSuccess: perModel.some((r) => r.verdict === 'PASS'),
  };
}
