import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, InvalidCursorError } from './pagination.ts';

describe('cursor codec', () => {
  it('round-trips a cursor', () => {
    const c = { t: '2026-01-01T00:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('rejects non-base64 / truncated / tampered / wrong-shape cursors with InvalidCursorError', () => {
    const valid = encodeCursor({ t: '2026-01-01T00:00:00.000Z', id: 'abc' });
    for (const bad of ['', '!!!!', valid.slice(0, valid.length - 3), Buffer.from('{"t":1}', 'utf8').toString('base64url'), Buffer.from('not json', 'utf8').toString('base64url')]) {
      expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
    }
  });

  it('error message leaks no internals', () => {
    try { decodeCursor('garbage'); } catch (e) {
      expect((e as Error).message).toBe('invalid cursor');
    }
  });
});
