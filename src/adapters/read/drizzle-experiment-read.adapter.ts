import { and, or, eq, lt, desc, asc, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { researchExperiment, experimentRunMember } from '../../db/schema.ts';
import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { ExperimentListQuery, ExperimentReadPort } from '../../ports/experiment-read.port.ts';
// Single source of truth — mappers are exported from the write adapter (Task 3).
import { expToDomain, memToDomain } from '../repository/drizzle-research-experiment.repository.ts';

export class DrizzleExperimentReadAdapter implements ExperimentReadPort {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async list(q: ExperimentListQuery): Promise<ResearchExperiment[]> {
    const conds: SQL[] = [];
    if (q.strategyProfileId) conds.push(eq(researchExperiment.strategyProfileId, q.strategyProfileId));
    if (q.status) conds.push(eq(researchExperiment.status, q.status));
    if (q.after) {
      const d = new Date(q.after.t);
      conds.push(
        or(
          lt(researchExperiment.createdAt, d),
          and(eq(researchExperiment.createdAt, d), lt(researchExperiment.id, q.after.id)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(researchExperiment)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(researchExperiment.createdAt), desc(researchExperiment.id))
      .limit(q.limit);
    return rows.map(expToDomain);
  }

  async getById(id: string): Promise<ResearchExperiment | null> {
    const rows = await this.db
      .select()
      .from(researchExperiment)
      .where(eq(researchExperiment.id, id))
      .limit(1);
    return rows[0] ? expToDomain(rows[0]) : null;
  }

  async listRuns(experimentId: string): Promise<ExperimentRunMember[]> {
    const rows = await this.db
      .select()
      .from(experimentRunMember)
      .where(eq(experimentRunMember.experimentId, experimentId))
      .orderBy(asc(experimentRunMember.createdAt));
    return rows.map(memToDomain);
  }
}
