// scripts/intent-classifier-eval.ts
// intent:eval — experimental IntentClassifier model evaluation harness.
// Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
// --run is the SOLE trigger for paid calls. No DB, no backtester, no persistence.
// Paid-call volume = models x repeat x caseCount (classify is called per message) — printed up front.
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { loadCases, fingerprintCases } from '../src/experiments/intent-classifier/fixtures.ts';
import { planDryRun } from '../src/experiments/intent-classifier/plan.ts';
import { runEval } from '../src/experiments/intent-classifier/eval-harness.ts';
import { writeRunArtifacts, compactTimestamp } from '../src/experiments/intent-classifier/artifacts.ts';
import { rankAggregates } from '../src/experiments/intent-classifier/aggregate.ts';
import { DEFAULT_THRESHOLD } from '../src/experiments/intent-classifier/scoring.ts';
import { parseRoleModel, type ModelProvider, type ModelProviderEnv } from '../src/adapters/llm/model-provider.ts';
import type { ManifestMeta } from '../src/experiments/intent-classifier/types.ts';

const HARNESS_VERSION = 'intent-eval-v1';
const CONTRACT_VERSION = 'chat-intent-v1'; // ChatIntentSchema shape this harness scores against

function parseCli() {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string', default: 'chat-intents-v1' },
      models: { type: 'string' },
      run: { type: 'boolean', default: false },
      threshold: { type: 'string', default: String(DEFAULT_THRESHOLD) },
      judge: { type: 'boolean', default: false },
      'judge-model': { type: 'string' },
      repeat: { type: 'string', default: '1' },
    },
  });
  const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('--models is required (comma-separated, e.g. openrouter/x-ai/grok-4.1-fast,openrouter/qwen/qwen3.5-flash)');
  const threshold = Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error(`--threshold must be in [0,1], got ${values.threshold}`);
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`--repeat must be an integer in [1,20], got ${values.repeat}`);
  if (values.judge && !values['judge-model']) throw new Error('--judge requires --judge-model <provider/model>');
  return { datasetId: values.dataset!, models, run: values.run!, threshold, judge: values.judge!, judgeModel: values['judge-model'], repeat };
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function modelEnv(): ModelProviderEnv {
  return {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER as ModelProvider,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
}

async function main(): Promise<number> {
  const args = parseCli();
  const cases = loadCases(args.datasetId); // offline JSON read — safe in dry-run

  // ---------- DRY RUN (default): no model construction, no composeMastra ----------
  if (!args.run) {
    const plan = planDryRun({ models: args.models, judge: args.judge, env: process.env, caseCount: cases.length, repeat: args.repeat });
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run', dataset: args.datasetId, caseCount: cases.length, threshold: args.threshold, judge: args.judge, repeat: args.repeat,
      plannedPaidCalls: plan.totalPaidCalls, classifyCalls: plan.classifyCalls, judgeCalls: plan.judgeCalls,
      models: plan.perModel, missingKeys: plan.missingKeys,
      note: 'DRY RUN — no real models constructed, nothing sent. classifyCalls = models x repeat x caseCount. Re-run with --run to make paid calls.',
    }, null, 2)}\n`);
    return 0;
  }

  // ---------- REAL RUN (--run): dynamically import the composeMastra-backed factory ----------
  const env = modelEnv();
  const { buildRealClassifierFor, buildRealJudge } = await import('../src/experiments/intent-classifier/real-classifier-factory.ts');

  let judge: Awaited<ReturnType<typeof buildRealJudge>> | undefined;
  if (args.judge && args.judgeModel) {
    judge = buildRealJudge(env, args.judgeModel);
  }

  const result = await runEval(
    { models: args.models, datasetId: args.datasetId, cases, datasetFingerprint: fingerprintCases(cases), threshold: args.threshold, repeat: args.repeat },
    {
      classifierFor: buildRealClassifierFor(env),
      providerOf: (m) => { const r = parseRoleModel(env, m); return { provider: r.provider, modelId: r.modelId }; },
      clock: () => Date.now(),
      judge,
    },
  );

  const now = new Date();
  const timestamp = compactTimestamp(now);
  const outDir = `.artifacts/experiments/intent-classifier/${args.datasetId}/${timestamp}`;
  const meta: ManifestMeta = { timestamp, gitSha: gitSha(), harnessVersion: HARNESS_VERSION, contractVersion: CONTRACT_VERSION, mode: 'run' };
  const written = writeRunArtifacts(outDir, meta, result);

  // Aggregated ranking summary (intent-accuracy primary; payload + latency tiebreak). Per-run detail is in the artifacts.
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const ranking = rankAggregates(result.aggregates, result.judgeEnabled).map((a) => ({
    model: a.model,
    runs: `${a.runs.ok}/${a.runs.total}`,
    passRate: r3(a.passRate),
    intentAccuracyMean: a.det ? r3(a.det.mean) : null,
    intentAccuracyStd: a.det ? r3(a.det.std) : null,
    payloadMean: a.payload ? r3(a.payload.mean) : null,
    judgeMean: a.judge ? r3(a.judge.mean) : null,
    judgeStd: a.judge ? r3(a.judge.std) : null,
    latencyMeanMs: Math.round(a.latency.mean),
  }));

  process.stdout.write(`${JSON.stringify({
    mode: 'run', outDir, repeat: result.repeat, overallSuccess: result.overallSuccess,
    ranking, artifacts: written,
  }, null, 2)}\n`);

  return result.overallSuccess ? 0 : 3;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`intent:eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
