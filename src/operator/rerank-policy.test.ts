import { describe, it, expect } from 'vitest';
import { shouldRerank, type RerankConfig } from './rerank-policy.ts';
import type { SimilarStrategyCandidate } from '../domain/strategy-retrieval.ts';

const cfg: RerankConfig = { timeoutMs: 1500, limit: 5, minCandidates: 10, rrfMargin: 0.002 };
const cand = (id: string, rrf: number): SimilarStrategyCandidate => ({ strategyProfileId: id, rrfScore: rrf, metadata: {} as never });
const many = (n: number) => Array.from({ length: n }, (_, i) => cand(`p${i}`, 1 - i * 0.1));

describe('shouldRerank', () => {
  it('false with <2 candidates', () => {
    expect(shouldRerank({ candidates: [cand('a', 1)], goal: 'show_similar', remainingMs: 5000, cfg })).toBe(false);
  });
  it('false when remaining budget < timeout', () => {
    expect(shouldRerank({ candidates: many(12), goal: 'show_similar', remainingMs: 1000, cfg })).toBe(false);
  });
  it('true on explicit show_similar trigger', () => {
    expect(shouldRerank({ candidates: many(3), goal: 'show_similar', remainingMs: 5000, cfg })).toBe(true);
  });
  it('true on RRF ambiguity margin (top-two gap <= margin)', () => {
    const c = [cand('a', 0.5), cand('b', 0.4995), cand('c', 0.1)];
    expect(shouldRerank({ candidates: c, goal: 'analyze', remainingMs: 5000, cfg })).toBe(true);
  });
  it('true on volume trigger (count >= minCandidates)', () => {
    expect(shouldRerank({ candidates: many(10), goal: 'analyze', remainingMs: 5000, cfg })).toBe(true);
  });
  it('false when no trigger fires (few candidates, clear gap, no show_similar)', () => {
    const c = [cand('a', 0.9), cand('b', 0.1), cand('c', 0.05)];
    expect(shouldRerank({ candidates: c, goal: 'analyze', remainingMs: 5000, cfg })).toBe(false);
  });
});
