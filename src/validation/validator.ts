import type { ZodType, ZodTypeDef } from 'zod';
import type { ValidationIssue } from '../domain/schemas.ts';

/** Locale-independent total order, so the gate is deterministic across environments. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type SchemaValidation<T> =
  | { status: 'valid'; issues: []; data: T }
  | { status: 'invalid'; issues: ValidationIssue[] };

/** Schema gate (gate #1 in design §12): validate unknown input against a Zod schema.
 *  On success it returns the parsed, typed value so callers never re-parse. */
export function validateWithSchema<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): SchemaValidation<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { status: 'valid', issues: [], data: parsed.data };

  const issues: ValidationIssue[] = parsed.error.issues
    .map((i) => ({
      code: 'schema_violation',
      severity: 'error' as const,
      path: i.path.join('.'),
      message: i.message,
    }))
    .sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.message, b.message));

  return { status: 'invalid', issues };
}
