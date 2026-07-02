import { describe, it, expect } from 'vitest';
import { buildFrozenCases, type TeacherLabeler } from './teacher.ts';
import { SYNTHETIC_CASES } from './fixtures.ts';

describe('buildFrozenCases', () => {
  it('labels obvious cases via oracle (no teacher call) and needsTeacher cases via teacher', async () => {
    let calls = 0;
    const teacher: TeacherLabeler = async () => {
      calls++;
      return { label: 'improve', rationale: 'r' };
    };
    const now = () => '2026-07-02T00:00:00.000Z';
    const teacherModel = 'gpt-frontier';

    const frozen = await buildFrozenCases(SYNTHETIC_CASES, { teacher, teacherModel, now });

    expect(frozen).toHaveLength(SYNTHETIC_CASES.length);

    const byId = new Map(frozen.map((f) => [f.id, f]));

    expect(byId.get('synthetic-0trade-exit-only')).toEqual({
      id: 'synthetic-0trade-exit-only',
      input: SYNTHETIC_CASES[0]!.input,
      label: 'stop_insufficient_evidence',
      labelSource: 'oracle',
      createdAt: now(),
    });

    expect(byId.get('synthetic-0trade-entry-evidence')).toEqual({
      id: 'synthetic-0trade-entry-evidence',
      input: SYNTHETIC_CASES[1]!.input,
      label: 'allow_exploratory_sweep',
      labelSource: 'oracle',
      createdAt: now(),
    });

    expect(byId.get('synthetic-0trade-entry-no-evidence')).toEqual({
      id: 'synthetic-0trade-entry-no-evidence',
      input: SYNTHETIC_CASES[2]!.input,
      label: 'stop_insufficient_evidence',
      labelSource: 'oracle',
      createdAt: now(),
    });

    expect(byId.get('synthetic-has-trades')).toEqual({
      id: 'synthetic-has-trades',
      input: SYNTHETIC_CASES[3]!.input,
      label: 'improve',
      labelSource: 'teacher',
      teacherModel: 'gpt-frontier',
      rationale: 'r',
      createdAt: now(),
    });

    // Only the one needsTeacher (has-trades) case invokes the teacher.
    expect(calls).toBe(1);
  });
});
