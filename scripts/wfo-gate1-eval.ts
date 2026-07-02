// scripts/wfo-gate1-eval.ts
// wfo-gate1:eval — thin CLI wiring the WFO Gate1 model-eval harness together.
// Default = DRY RUN (no real model construction, no composeMastra, no paid calls).
// --label builds a frozen dataset (paid teacher labeling of any non-obvious case).
// --run --snapshot <id> runs the paid eval against a frozen dataset.
// Mirrors scripts/turn-interpreter-eval.ts.
import { execSync } from 'node:child_process';
import {
  parseArgs,
  planDryRun,
  writeRunArtifacts,
  writeReport,
  compactTimestamp,
  type CliArgs,
} from '../src/experiments/wfo-gate1/report.ts';
import { runEval } from '../src/experiments/wfo-gate1/eval-harness.ts';
import { rankAggregates, frontierVerdict } from '../src/experiments/wfo-gate1/aggregate.ts';
import { DbCaseSource, SnapshotCaseSource, type CaseSource } from '../src/experiments/wfo-gate1/case-source.ts';
import { buildFrozenCases } from '../src/experiments/wfo-gate1/teacher.ts';
import { freezeDataset, writeSnapshot, loadSnapshot } from '../src/experiments/wfo-gate1/dataset.ts';
import { composeRuntime } from '../src/composition.ts';
import { parseRoleModel, type ModelProviderEnv, type ModelProvider } from '../src/adapters/llm/model-provider.ts';

const HARNESS_VERSION = 'wfo-gate1-eval-v1';
const CONTRACT_VERSION = 'wfo-gate1-v0';

const DATASETS_DIR = '.artifacts/experiments/wfo-gate1/datasets';

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

// ---------- DRY RUN (default): no model construction, no composeMastra, no paid calls ----------
function runDryRun(args: CliArgs): number {
  let caseCount = 0;
  let note: string | undefined;
  if (args.snapshot) {
    const dataset = loadSnapshot(DATASETS_DIR, args.snapshot);
    caseCount = dataset.cases.length;
  } else {
    note = 'no --snapshot given — caseCount=0 (pass --snapshot <id> for an accurate plan)';
  }

  const plan = planDryRun(args, modelEnv(), caseCount);

  process.stdout.write(`${JSON.stringify({
    mode: 'dry-run',
    contractVersion: CONTRACT_VERSION,
    snapshot: args.snapshot ?? null,
    caseCount: plan.caseCount,
    threshold: args.threshold,
    repeat: args.repeat,
    plannedPaidCalls: plan.plannedPaidCalls,
    classifyCalls: plan.classifyCalls,
    models: args.models,
    missingKeys: plan.missingKeys,
    ...(note ? { note } : {}),
  }, null, 2)}\n`);

  return 0;
}

// ---------- LABEL (paid teacher): builds and freezes a dataset ----------
// Order matters: build/load the case source (free/local) FIRST, fail fast on an empty
// source, and only THEN dynamically import the composeMastra-backed teacher factory — a
// broken/empty source is a setup error and must never surface as a key/model error.
async function labelFromSource(source: CaseSource, teacherModel: string, sourceRef: string): Promise<number> {
  const rawCases = await source.load();
  if (rawCases.length === 0) {
    throw new Error(`Case source loaded 0 cases (source=${sourceRef}) — fix the source before spending on a teacher.`);
  }

  const { buildRealTeacher } = await import('../src/experiments/wfo-gate1/real-gate1-factory.ts');
  const teacher = buildRealTeacher(modelEnv(), teacherModel);

  const frozen = await buildFrozenCases(rawCases, {
    teacher,
    teacherModel,
    now: () => new Date().toISOString(),
  });

  const dataset = freezeDataset(frozen, { gitSha: gitSha(), sourceRef, now: new Date().toISOString() });
  const filePath = writeSnapshot(DATASETS_DIR, dataset);

  process.stdout.write(`${JSON.stringify({
    mode: 'label',
    snapshotId: dataset.snapshotId,
    caseCount: dataset.cases.length,
    sourceRef: dataset.sourceRef,
    filePath,
  }, null, 2)}\n`);

  return 0;
}

async function runLabel(args: CliArgs): Promise<number> {
  const teacherModel = args.teacherModel;
  if (!teacherModel) {
    // parseArgs already enforces this; kept for explicit type-narrowing.
    throw new Error('--label requires --teacher-model <provider/model>');
  }

  if (!args.source || args.source === 'db') {
    const { services, pool, queue } = composeRuntime();
    try {
      const source = new DbCaseSource({
        experiments: services.experiments,
        strategyBacktests: services.strategyBacktests,
        strategyProfiles: services.strategyProfiles,
      });
      return await labelFromSource(source, teacherModel, args.source ?? 'db');
    } finally {
      await queue.close();
      await pool.end();
    }
  }

  const source = new SnapshotCaseSource(args.source);
  return await labelFromSource(source, teacherModel, args.source);
}

// ---------- RUN (paid eval): paid INTENT — a setup problem exits non-zero, never
// silently degrades to dry-run. parseArgs already rejects --run without --snapshot. ----------
async function runEvalCli(args: CliArgs): Promise<number> {
  const snapshot = args.snapshot;
  if (!snapshot) {
    // parseArgs already enforces this; kept for explicit type-narrowing.
    throw new Error('--run requires --snapshot <snapshotId>');
  }

  const dataset = loadSnapshot(DATASETS_DIR, snapshot); // fail-fast on unknown id

  const plan = planDryRun(args, modelEnv(), dataset.cases.length);
  if (plan.missingKeys.length > 0) {
    process.stdout.write(`${JSON.stringify({ error: 'missing_keys', missingKeys: plan.missingKeys }, null, 2)}\n`);
    return 2; // exit BEFORE any paid call
  }

  const env = modelEnv();
  const { buildRealGate1For } = await import('../src/experiments/wfo-gate1/real-gate1-factory.ts');

  const result = await runEval(
    { models: args.models, dataset, threshold: args.threshold, repeat: args.repeat },
    {
      gate1For: buildRealGate1For(env),
      providerOf: (m) => {
        const r = parseRoleModel(env, m);
        return { provider: r.provider, modelId: r.modelId };
      },
      clock: () => Date.now(),
    },
  );

  // Thread the CLI's own harness identity into the manifest.
  result.manifest.harnessVersion = HARNESS_VERSION;
  result.manifest.gitSha = gitSha();

  const ranked = rankAggregates(result.aggregates);
  const verdict = frontierVerdict(ranked, {
    incumbentModelId: process.env.WFO_GATE1_MODEL ?? '',
    threshold: args.threshold,
  });

  const outDir = `.artifacts/experiments/wfo-gate1/${snapshot}/${compactTimestamp(new Date())}`;
  const written = writeRunArtifacts(outDir, result);
  written.push(writeReport(outDir, result, verdict));

  const overallSuccess = result.aggregates.some((a) => a.passRate > 0);

  process.stdout.write(`${JSON.stringify({
    mode: 'run',
    outDir,
    overallSuccess,
    verdict,
    ranking: ranked.map((a) => ({
      modelId: a.modelId,
      provider: a.provider,
      passRate: a.passRate,
      meanScore: a.meanScore,
      accuracy: a.accuracy,
    })),
    artifacts: written,
  }, null, 2)}\n`);

  return overallSuccess ? 0 : 3;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.label) return runLabel(args);
  if (args.run) return runEvalCli(args);
  return runDryRun(args);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
