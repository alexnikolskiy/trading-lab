// src/experiments/intent-classifier/eval-harness.test.ts
import { describe, it, expect } from 'vitest';
import { runEval, classifyError, type RunEvalInput, type RunEvalDeps, type JudgeRunInput } from './eval-harness.ts';
import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import type { EvalCase, JudgeVerdict } from './types.ts';
import { FakeIntentClassifier } from '../../adapters/intent/fake-intent-classifier.ts';
import { loadCases, fingerprintCases } from './fixtures.ts';

function classifier(fn: (message: string) => unknown): IntentClassifierPort {
  return { adapter: 'fake', model: 'stub', async classify(message: string) { return fn(message); } };
}
const constantIntent = (intent: string) => classifier(() => ({ intent, confidence: 0.9 }));

const twoCases: EvalCase[] = [
  { id: 'help', lang: 'en', message: 'help', expect: { intent: 'help' } },
  { id: 'oos', lang: 'ru', message: 'погода', expect: { intent: 'out_of_scope' } },
];

function input(over: Partial<RunEvalInput> & { models: string[]; cases: EvalCase[] }): RunEvalInput {
  return { datasetId: 'test', datasetFingerprint: 'sha256:abc', threshold: 0.7, ...over };
}

function deps(map: Record<string, IntentClassifierPort>, judge?: (i: JudgeRunInput) => Promise<JudgeVerdict>): RunEvalDeps {
  let tick = 0;
  return {
    classifierFor: (m) => { const c = map[m]; if (!c) throw new Error(`no classifier for ${m}`); return c; },
    providerOf: (m) => ({ provider: m.split('/')[0]!, modelId: m.split('/').slice(1).join('/') }),
    clock: () => (tick += 10),
    judge,
  };
}

describe('classifyError', () => {
  it('classifies timeout / schema / provider / unknown', () => {
    expect(classifyError(new Error('request timed out')).type).toBe('timeout');
    expect(classifyError(new Error('zod validation failed')).type).toBe('schema');
    expect(classifyError(new Error('rate limit exceeded')).type).toBe('provider');
    expect(classifyError(new Error('weird')).type).toBe('unknown');
  });
});

describe('runEval — dataset mechanics', () => {
  it('classifies every case for every model and scores intent accuracy', async () => {
    const result = await runEval(
      input({ models: ['p/help-bot'], cases: twoCases }),
      deps({ 'p/help-bot': constantIntent('help') }), // only the help case matches
    );
    expect(result.perModel).toHaveLength(1);
    const s = result.perModel[0]!.score!;
    expect(s.caseCount).toBe(2);
    expect(s.intentAccuracy).toBe(0.5); // 1 of 2
    expect(s.cases.map((c) => c.intentMatch)).toEqual([true, false]);
  });

  it('isolates a model whose classifier cannot be built: FAIL + error, other model still runs', async () => {
    const result = await runEval(
      input({ models: ['p/broken', 'p/ok'], cases: twoCases, threshold: 0.4 }),
      deps({ 'p/ok': constantIntent('help') }), // 'p/broken' missing -> classifierFor throws
    );
    const broken = result.perModel.find((r) => r.model === 'p/broken')!;
    expect(broken.verdict).toBe('FAIL');
    expect(broken.score).toBeNull();
    expect(broken.error).not.toBeNull();
    const ok = result.perModel.find((r) => r.model === 'p/ok')!;
    expect(ok.score).not.toBeNull();
  });

  it('treats a per-case classify throw as a schema-invalid miss without aborting the run', async () => {
    let n = 0;
    const flaky = classifier(() => { n += 1; if (n === 1) throw new Error('boom'); return { intent: 'out_of_scope', confidence: 0.9 }; });
    const result = await runEval(input({ models: ['p/flaky'], cases: twoCases, threshold: 0.1 }), deps({ 'p/flaky': flaky }));
    const s = result.perModel[0]!.score!;
    expect(s.cases[0]!.error).not.toBeNull();
    expect(s.cases[0]!.schemaValid).toBe(false);
    expect(s.cases[1]!.intentMatch).toBe(true);
    expect(s.schemaValidCount).toBe(1);
  });

  it('credits intent but flags schema-invalidity separately, without aborting the run', async () => {
    // valid intent but entityRef "from_message" is an invalid enum -> raw reaches the harness
    const c = classifier(() => ({ intent: 'help', confidence: 0.9, entityRef: 'from_message' }));
    const result = await runEval(input({ models: ['p/x'], cases: [twoCases[0]!], threshold: 0.5 }), deps({ 'p/x': c }));
    expect(result.perModel[0]!.error).toBeNull(); // run did NOT throw
    const score = result.perModel[0]!.score!;
    const cr = score.cases[0]!;
    expect(cr.actualIntent).toBe('help');
    expect(cr.intentMatch).toBe(true); // intent recognized -> counts toward intentAccuracy
    expect(cr.schemaValid).toBe(false); // ...but would not pass the strict gate
    expect(cr.error?.type).toBe('schema');
    expect(score.intentAccuracy).toBe(1); // primary metric credits the correct intent
    expect(score.schemaValidRate).toBe(0); // secondary metric: 0% passed strict validation
    expect(result.perModel[0]!.verdict).toBe('PASS');
  });

  it('attaches an injected judge verdict without changing the deterministic verdict', async () => {
    const verdict: JudgeVerdict = { dimensions: [], overallScore: 0.9, disputedCases: [], notes: 'ok' };
    const result = await runEval(input({ models: ['p/ok'], cases: twoCases, threshold: 0.4 }),
      deps({ 'p/ok': constantIntent('help') }, async () => verdict));
    expect(result.judgeEnabled).toBe(true);
    expect(result.perModel[0]!.judge).toEqual(verdict);
    expect(result.perModel[0]!.verdict).toBe('PASS');
  });

  it('judge failure leaves judge null and does not fail the run', async () => {
    const result = await runEval(input({ models: ['p/ok'], cases: twoCases, threshold: 0.4 }),
      deps({ 'p/ok': constantIntent('help') }, async () => { throw new Error('judge boom'); }));
    expect(result.perModel[0]!.judge).toBeNull();
    expect(result.perModel[0]!.verdict).toBe('PASS');
  });

  it('repeat=3 runs each model 3x; identical deterministic outputs -> std 0, one aggregate', async () => {
    const result = await runEval(input({ models: ['p/ok'], cases: twoCases, repeat: 3, threshold: 0.4 }),
      deps({ 'p/ok': constantIntent('help') }));
    expect(result.repeat).toBe(3);
    expect(result.perModel).toHaveLength(3);
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]!.det!.std).toBe(0);
  });

  it('judge disabled -> aggregate.judge null', async () => {
    const result = await runEval(input({ models: ['p/ok'], cases: twoCases, threshold: 0.4 }), deps({ 'p/ok': constantIntent('help') }));
    expect(result.judgeEnabled).toBe(false);
    expect(result.aggregates[0]!.judge).toBeNull();
  });
});

describe('runEval — real FakeIntentClassifier over the shipped dataset (offline)', () => {
  it('the rule-based fake classifies the v1 dataset at 100% intent + payload accuracy', async () => {
    const cases = loadCases('chat-intents-v1');
    const result = await runEval(
      { models: ['fake/rules'], datasetId: 'chat-intents-v1', cases, datasetFingerprint: fingerprintCases(cases), threshold: 0.7 },
      {
        classifierFor: () => new FakeIntentClassifier(),
        providerOf: (m) => ({ provider: m.split('/')[0]!, modelId: m.split('/').slice(1).join('/') }),
        clock: () => 0,
      },
    );
    const s = result.perModel[0]!.score!;
    expect(s.intentAccuracy).toBe(1);
    expect(s.payloadAccuracy).toBe(1);
    expect(result.overallSuccess).toBe(true);
  });
});
