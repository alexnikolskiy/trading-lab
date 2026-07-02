import { stableStringify } from '../orchestrator/handlers/backtest-support.ts';

export type GridPoint = Record<string, unknown>;

export class GridTooLargeError extends Error {
  readonly size: number;
  readonly max: number;

  constructor(size: number, max: number) {
    super(`grid_too_large: ${size} > ${max}`);
    this.name = 'GridTooLargeError';
    this.size = size;
    this.max = max;
  }
}

export function expandGrid(grid: Record<string, unknown[]>, maxPoints: number): GridPoint[] {
  const keys = Object.keys(grid).sort();
  let points: GridPoint[] = [{}];

  for (const k of keys) {
    const vals = grid[k] ?? [];
    points = points.flatMap((p) => vals.map((v) => ({ ...p, [k]: v })));
  }

  const seen = new Set<string>();
  const out: GridPoint[] = [];

  for (const p of points) {
    const s = stableStringify(p);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(p);
    }
  }

  if (out.length > maxPoints) {
    throw new GridTooLargeError(out.length, maxPoints);
  }

  return out;
}
