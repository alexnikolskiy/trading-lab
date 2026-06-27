import { describe, it, expect } from 'vitest';
import { runEval, runOnce } from './eval-harness.ts';
import type { RunEvalDeps, RunEvalInput } from './eval-harness.ts';
import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
import type { StrategyCriticInput, StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { Candidate, CriticEvalCase, JudgeVerdict } from './types.ts';
import { resolveCase } from './fixtures.ts';
import { GOOD_PUMP_SHORT_REFINEMENT } from './__fixtures__/refinements.ts';

const CAND: Candidate = { mode: 'two_stage', label: 'two_stage:critic=c,refiner=r', criticModel: 'c', refinerModel: 'r' };
const CASE: CriticEvalCase = resolveCase('pump-short');

function fakeCritic(out: StrategyRefinement): StrategyCriticPort {
  return { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(_i: StrategyCriticInput): Promise<StrategyRefinement> { return out; } };
}
function throwingCritic(message: string): StrategyCriticPort {
  return { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(): Promise<StrategyRefinement> { throw new Error(message); } };
}
function flakyCritic(failTimes: number, out: StrategyRefinement): StrategyCriticPort {
  let n = 0;
  return { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(): Promise<StrategyRefinement> { n += 1; if (n <= failTimes) throw new Error('schema validation failed'); return out; } };
}

const baseInput: RunEvalInput = { candidates: [CAND], cases: [CASE], threshold: 0.6 };

function deps(critic: StrategyCriticPort, judge?: (r: StrategyRefinement, c: CriticEvalCase) => Promise<JudgeVerdict>): RunEvalDeps {
  let tick = 0;
  return {
    criticFor: () => critic,
    providerOf: (m: string) => ({ provider: 'fake', modelId: m }),
    clock: () => (tick += 100),
    judge,
  };
}

describe('runOnce / runEval', () => {
  it('passes the case text as manual_description and scores PASS for a good refinement', async () => {
    let seen: StrategyCriticInput | undefined;
    const capturing: StrategyCriticPort = { adapter: 'fake', mode: 'two_stage', model: 'c', async refine(i) { seen = i; return GOOD_PUMP_SHORT_REFINEMENT; } };
    const r = await runOnce(CAND, CASE, baseInput, deps(capturing));
    expect(seen).toEqual({ kind: 'manual_description', content: CASE.text, title: CASE.id });
    expect(r.verdict).toBe('PASS');
    expect(r.label).toBe(CAND.label);
    expect(r.criticModel).toBe('c');
    expect(r.refinerModel).toBe('r');
    expect(r.caseId).toBe('pump-short');
  });

  it('isolates a throwing critic: FAIL + classified error, score null', async () => {
    const result = await runEval(baseInput, deps(throwingCritic('schema validation failed')));
    const only = result.perCandidate[0]!;
    expect(only.verdict).toBe('FAIL');
    expect(only.score).toBeNull();
    expect(only.rawOutput).toBeNull();
    expect(only.error).toEqual({ type: 'schema', message: 'schema validation failed' });
    expect(result.overallSuccess).toBe(false);
  });

  it('classifies a timeout error', async () => {
    const result = await runEval(baseInput, deps(throwingCritic('request timed out after 30s')));
    expect(result.perCandidate[0]!.error!.type).toBe('timeout');
  });

  it('runs an injected judge but never lets it change the verdict', async () => {
    const verdict: JudgeVerdict = { dimensions: [], overallScore: 0.9, hallucinations: [], missing: [], notes: 'ok' };
    const result = await runEval(baseInput, deps(fakeCritic(GOOD_PUMP_SHORT_REFINEMENT), async () => verdict));
    expect(result.judgeEnabled).toBe(true);
    expect(result.perCandidate[0]!.judge).toEqual(verdict);
    expect(result.perCandidate[0]!.verdict).toBe('PASS');
  });

  it('a throwing judge leaves the candidate PASS with judge null (best-effort)', async () => {
    const result = await runEval(baseInput, deps(fakeCritic(GOOD_PUMP_SHORT_REFINEMENT), async () => { throw new Error('judge boom'); }));
    expect(result.perCandidate[0]!.verdict).toBe('PASS');
    expect(result.perCandidate[0]!.judge).toBeNull();
  });

  it('iterates candidates × cases × repeat sequentially', async () => {
    const result = await runEval(
      { candidates: [CAND], cases: [resolveCase('pump-short'), resolveCase('dump-long')], threshold: 0.6, repeat: 2 },
      deps(flakyCritic(1, GOOD_PUMP_SHORT_REFINEMENT)),
    );
    expect(result.repeat).toBe(2);
    expect(result.perCandidate).toHaveLength(4); // 1 candidate × 2 cases × 2 repeats
    expect(result.cases).toEqual(['pump-short', 'dump-long']);
    expect(result.aggregates).toHaveLength(1);
  });
});
