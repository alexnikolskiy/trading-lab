import { describe, it, expect } from 'vitest';
import { buildCandidates } from './candidates.ts';

describe('buildCandidates', () => {
  it('single: one candidate per model with stable labels', () => {
    const out = buildCandidates({ mode: 'single', models: ['a', 'b'] });
    expect(out).toEqual([
      { mode: 'single', label: 'single:a', combinedModel: 'a' },
      { mode: 'single', label: 'single:b', combinedModel: 'b' },
    ]);
  });
  it('two_stage: cross-product of critic × refiner with stable labels', () => {
    const out = buildCandidates({ mode: 'two_stage', criticModels: ['a', 'b'], refinerModels: ['x', 'y'] });
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.label)).toEqual([
      'two_stage:critic=a,refiner=x',
      'two_stage:critic=a,refiner=y',
      'two_stage:critic=b,refiner=x',
      'two_stage:critic=b,refiner=y',
    ]);
    expect(out[0]).toEqual({ mode: 'two_stage', label: 'two_stage:critic=a,refiner=x', criticModel: 'a', refinerModel: 'x' });
  });
  it('throws when single is missing --models', () => {
    expect(() => buildCandidates({ mode: 'single', models: [] })).toThrow(/--models/);
  });
  it('throws when two_stage is missing --critic-models or --refiner-models', () => {
    expect(() => buildCandidates({ mode: 'two_stage', criticModels: [], refinerModels: ['x'] })).toThrow(/--critic-models/);
    expect(() => buildCandidates({ mode: 'two_stage', criticModels: ['a'], refinerModels: [] })).toThrow(/--refiner-models/);
  });
});
