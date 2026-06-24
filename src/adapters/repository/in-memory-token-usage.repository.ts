import type { TokenUsageRepository } from '../../ports/token-usage.repository.ts';

export class InMemoryTokenUsageRepository implements TokenUsageRepository {
  readonly #totals = new Map<string, number>();

  async add(correlationId: string, tokens: number): Promise<void> {
    this.#totals.set(correlationId, (this.#totals.get(correlationId) ?? 0) + tokens);
  }

  async get(correlationId: string): Promise<number> {
    return this.#totals.get(correlationId) ?? 0;
  }
}
