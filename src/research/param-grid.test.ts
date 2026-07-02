import { describe, it, expect } from 'vitest';
import { expandGrid, GridTooLargeError } from './param-grid.ts';

describe('param-grid', () => {
  it('expands a grid to the cartesian product, deduped and stable', () => {
    expect(expandGrid({ a: [1, 2], b: ['x'] }, 8)).toEqual([{ a: 1, b: 'x' }, { a: 2, b: 'x' }]);
    expect(expandGrid({ a: [1, 1] }, 8)).toEqual([{ a: 1 }]); // dedupe identical points
  });

  it('throws GridTooLargeError past the cap', () => {
    expect(() => expandGrid({ a: [1, 2, 3], b: [1, 2, 3] }, 8)).toThrow(GridTooLargeError); // 9 > 8
  });
});
