import { describe, it, expect } from 'vitest';
import { InMemoryTokenUsageRepository } from './in-memory-token-usage.repository.ts';

describe('InMemoryTokenUsageRepository', () => {
  it('returns 0 for an unknown correlationId', async () => {
    const repo = new InMemoryTokenUsageRepository();
    expect(await repo.get('c1')).toBe(0);
  });
  it('accumulates added tokens per correlationId', async () => {
    const repo = new InMemoryTokenUsageRepository();
    await repo.add('c1', 100);
    await repo.add('c1', 50);
    await repo.add('c2', 7);
    expect(await repo.get('c1')).toBe(150);
    expect(await repo.get('c2')).toBe(7);
  });
});
