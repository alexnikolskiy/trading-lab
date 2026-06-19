import type { RerankerPort } from '../../src/ports/strategy-similarity.port.ts';
import type { SimilarStrategyCandidate } from '../../src/domain/strategy-retrieval.ts';

/** Deterministic reranker for tests/CI: reorders by a provided key fn (default: reverse rrf to prove
 *  the reorder happened), takes the top `limit`. No network. Optionally throws / delays for fault tests. */
export class FakeReranker implements RerankerPort {
  readonly #key: (c: SimilarStrategyCandidate) => number;
  readonly #behavior: 'ok' | 'throw';

  constructor(opts?: { key?: (c: SimilarStrategyCandidate) => number; behavior?: 'ok' | 'throw' }) {
    this.#key = opts?.key ?? ((c) => -c.rrfScore);
    this.#behavior = opts?.behavior ?? 'ok';
  }

  async rerank(
    _query: string,
    candidates: readonly SimilarStrategyCandidate[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly SimilarStrategyCandidate[]> {
    if (this.#behavior === 'throw') throw new Error('fake reranker failure');
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return [...candidates].sort((a, b) => this.#key(a) - this.#key(b)).slice(0, limit);
  }
}
