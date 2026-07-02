import { describe, it, expect } from 'vitest';
import { runEval } from './eval-harness.ts';
import { SYNTHETIC_CASES } from './fixtures.ts';
import type { FrozenCase, FrozenDataset } from './types.ts';
import type { Gate1DecisionPort } from '../../ports/wfo-agents.port.ts';

const NOW = '2026-01-01T00:00:00.000Z';

const frozenCases: FrozenCase[] = [
  { id: SYNTHETIC_CASES[0]!.id, input: SYNTHETIC_CASES[0]!.input, label: 'improve', labelSource: 'teacher', teacherModel: 'm1', createdAt: NOW },
  { id: SYNTHETIC_CASES[1]!.id, input: SYNTHETIC_CASES[1]!.input, label: 'improve', labelSource: 'oracle', createdAt: NOW },
  { id: SYNTHETIC_CASES[2]!.id, input: SYNTHETIC_CASES[2]!.input, label: 'improve', labelSource: 'oracle', createdAt: NOW },
];

const dataset: FrozenDataset = {
  snapshotId: 'test-snapshot',
  createdAt: NOW,
  gitSha: 'abc123',
  sourceRef: 'test',
  cases: frozenCases,
};

function fakeGate1(modelId: string): Gate1DecisionPort {
  return {
    adapter: 'fake',
    model: modelId,
    decide: async () => ({ decision: 'improve', reason: 'r' }),
  };
}

describe('runEval', () => {
  it('runs model-major and aggregates accuracy per model', async () => {
    const res = await runEval(
      { models: ['m1', 'm2'], dataset, threshold: 0.9, repeat: 1 },
      { gate1For: (m) => fakeGate1(m), providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    expect(res.aggregates.map((a) => a.modelId)).toEqual(['m1', 'm2']);
    expect(res.aggregates[0]!.accuracy).toBe(1);
    expect(res.aggregates[1]!.accuracy).toBe(1);
    expect(res.manifest.caseCount).toBe(3);
  });

  it('isolates a model whose gate1For throws', async () => {
    const res = await runEval(
      { models: ['ok', 'broken'], dataset, threshold: 0.9, repeat: 1 },
      {
        gate1For: (m) => { if (m === 'broken') throw new Error('no key'); return fakeGate1(m); },
        providerOf: (m) => ({ provider: 'fake', modelId: m }),
        clock: () => 0,
      },
    );
    const broken = res.candidates.find((c) => c.modelId === 'broken')!;
    expect(broken.ok).toBe(false);
    expect(broken.error).toBeDefined();
    const ok = res.candidates.find((c) => c.modelId === 'ok')!;
    expect(ok.ok).toBe(true);
    expect(ok.result?.accuracy).toBe(1);
  });

  it('a schema-invalid decision is a scored miss, not a crash', async () => {
    const res = await runEval(
      { models: ['bad'], dataset, threshold: 0.9, repeat: 1 },
      {
        gate1For: () => ({ adapter: 'fake', model: 'bad', decide: async () => ({}) as never }),
        providerOf: (m) => ({ provider: 'fake', modelId: m }),
        clock: () => 0,
      },
    );
    const cand = res.candidates[0]!;
    expect(cand.ok).toBe(true);
    expect(cand.result?.schemaValidRate).toBe(0);
  });

  it('flags teacher circularity when the teacher model is also a candidate', async () => {
    const res = await runEval(
      { models: ['m1', 'm2'], dataset, threshold: 0.9, repeat: 1 },
      { gate1For: (m) => fakeGate1(m), providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    expect(res.manifest.teacherModel).toBe('m1');
    expect(res.manifest.teacherCircular).toBe(true);
  });

  it('does not flag circularity when the teacher model is not a candidate', async () => {
    const res = await runEval(
      { models: ['m2', 'm3'], dataset, threshold: 0.9, repeat: 1 },
      { gate1For: (m) => fakeGate1(m), providerOf: (m) => ({ provider: 'fake', modelId: m }), clock: () => 0 },
    );
    expect(res.manifest.teacherModel).toBe('m1');
    expect(res.manifest.teacherCircular).toBe(false);
  });
});
