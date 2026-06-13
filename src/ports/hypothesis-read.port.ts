import type { HypothesisProposal, HypothesisStatus } from '../domain/hypothesis.ts';
import type { Cursor } from './keyset.ts';

export interface HypothesisListQuery {
  status?: HypothesisStatus;
  profileId?: string;
  limit: number;
  after?: Cursor;
}

export interface HypothesisReadPort {
  list(q: HypothesisListQuery): Promise<HypothesisProposal[]>;
  getById(id: string): Promise<HypothesisProposal | null>;
}
