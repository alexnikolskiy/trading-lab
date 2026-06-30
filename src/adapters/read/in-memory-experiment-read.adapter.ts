import type { ResearchExperiment, ExperimentRunMember } from '../../domain/research-experiment.ts';
import type { ExperimentListQuery, ExperimentReadPort } from '../../ports/experiment-read.port.ts';

export class InMemoryExperimentReadAdapter implements ExperimentReadPort {
  private readonly experiments: ResearchExperiment[];
  private readonly members: ExperimentRunMember[];

  constructor(seed: { experiments?: ResearchExperiment[]; members?: ExperimentRunMember[] } = {}) {
    this.experiments = seed.experiments ?? [];
    this.members = seed.members ?? [];
  }

  async list(q: ExperimentListQuery): Promise<ResearchExperiment[]> {
    let rows = [...this.experiments]
      .filter((e) => (q.strategyProfileId ? e.strategyProfileId === q.strategyProfileId : true))
      .filter((e) => (q.status ? e.status === q.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (q.after) {
      rows = rows.filter(
        (e) =>
          e.createdAt < q.after!.t ||
          (e.createdAt === q.after!.t && e.id < q.after!.id),
      );
    }
    return rows.slice(0, q.limit);
  }

  async getById(id: string): Promise<ResearchExperiment | null> {
    return this.experiments.find((e) => e.id === id) ?? null;
  }

  async listRuns(experimentId: string): Promise<ExperimentRunMember[]> {
    return this.members
      .filter((m) => m.experimentId === experimentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
