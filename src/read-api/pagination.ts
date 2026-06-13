import { z } from 'zod';
import type { Cursor } from '../ports/keyset.ts';

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

const CursorSchema = z.object({ t: z.string().datetime(), id: z.string().min(1) });

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError();
  }
  const result = CursorSchema.safeParse(parsed);
  if (!result.success) throw new InvalidCursorError();
  return result.data;
}
