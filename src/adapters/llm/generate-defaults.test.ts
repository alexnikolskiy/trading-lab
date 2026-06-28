import { describe, it, expect } from 'vitest';
import { MAX_OUTPUT_TOKENS } from './generate-defaults.ts';

describe('generate-defaults', () => {
  it('MAX_OUTPUT_TOKENS equals 16384', () => {
    expect(MAX_OUTPUT_TOKENS).toBe(16384);
  });
});
