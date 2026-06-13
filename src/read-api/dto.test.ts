import { describe, it, expect } from 'vitest';
import { HypothesisListQuerySchema, BacktestListQuerySchema, AgentEventListQuerySchema } from './dto.ts';

describe('query schemas', () => {
  it('defaults limit to 20 and clamps invalid', () => {
    expect(HypothesisListQuerySchema.parse({}).limit).toBe(20);
    expect(HypothesisListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(HypothesisListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(HypothesisListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects unknown status', () => {
    expect(BacktestListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(HypothesisListQuerySchema.safeParse({ status: 'validated' }).success).toBe(true);
  });

  it('agent-event since must be ISO datetime', () => {
    expect(AgentEventListQuerySchema.safeParse({ since: 'yesterday' }).success).toBe(false);
    expect(AgentEventListQuerySchema.safeParse({ since: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
  });
});
