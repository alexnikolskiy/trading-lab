import { labelObvious } from './oracle.ts';
import type { RawCase, FrozenCase, Gate1Decision } from './types.ts';
import type { Gate1Input } from '../../ports/wfo-agents.port.ts';

export type TeacherLabeler = (input: Gate1Input) => Promise<{ label: Gate1Decision; rationale: string }>;

export async function buildFrozenCases(
  rawCases: RawCase[],
  deps: { teacher: TeacherLabeler; teacherModel: string; now: () => string }
): Promise<FrozenCase[]> {
  const frozen: FrozenCase[] = [];

  for (const c of rawCases) {
    const o = labelObvious(c.input);

    if ('confidence' in o) {
      frozen.push({
        id: c.id,
        input: c.input,
        label: o.label,
        labelSource: 'oracle',
        createdAt: deps.now(),
      });
      continue;
    }

    const { label, rationale } = await deps.teacher(c.input);
    frozen.push({
      id: c.id,
      input: c.input,
      label,
      labelSource: 'teacher',
      teacherModel: deps.teacherModel,
      rationale,
      createdAt: deps.now(),
    });
  }

  return frozen;
}
