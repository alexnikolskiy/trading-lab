import { describe, it, expect } from 'vitest';
import { scoreRefinement, DEFAULT_THRESHOLD } from './scoring.ts';
import { resolveCase } from './fixtures.ts';
import {
  GOOD_PUMP_SHORT_REFINEMENT,
  WRONG_DIRECTION_REFINEMENT,
  LOW_COVERAGE_REFINEMENT,
  RUNNER_OVERREACH_REFINEMENT,
} from './__fixtures__/refinements.ts';

const CASE = resolveCase('pump-short');

describe('scoreRefinement', () => {
  it('defaults the threshold to 0.6', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.6);
    expect(scoreRefinement(GOOD_PUMP_SHORT_REFINEMENT, CASE).threshold).toBe(0.6);
  });
  it('PASSes a good refinement (all gates + full coverage)', () => {
    const r = scoreRefinement(GOOD_PUMP_SHORT_REFINEMENT, CASE);
    expect(r.gates).toEqual({ schemaValid: true, directionPreserved: true, noRunnerOverreach: true, nonTrivialChange: true });
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(r.verdict).toBe('PASS');
  });
  it('GOOD refinement covers all 6 aspects (full coverage regression guard)', () => {
    const r = scoreRefinement(GOOD_PUMP_SHORT_REFINEMENT, CASE);
    const failedAspects = r.checks.filter((c) => !c.hit).map((c) => c.id);
    expect(failedAspects).toEqual([]);
    expect(r.score).toBe(1);
  });
  it('FAILs when direction is not preserved', () => {
    const r = scoreRefinement(WRONG_DIRECTION_REFINEMENT, CASE);
    expect(r.gates.directionPreserved).toBe(false);
    expect(r.verdict).toBe('FAIL');
  });
  it('FAILs on runner overreach (leverage / base size)', () => {
    const r = scoreRefinement(RUNNER_OVERREACH_REFINEMENT, CASE);
    expect(r.gates.noRunnerOverreach).toBe(false);
    expect(r.verdict).toBe('FAIL');
  });
  it('FAILs on low aspect coverage even when all gates pass', () => {
    const r = scoreRefinement(LOW_COVERAGE_REFINEMENT, CASE);
    expect(r.gates.directionPreserved).toBe(true);
    expect(r.gates.noRunnerOverreach).toBe(true);
    expect(r.gates.nonTrivialChange).toBe(true);
    expect(r.score).toBeLessThan(0.6);
    expect(r.verdict).toBe('FAIL');
  });
});
