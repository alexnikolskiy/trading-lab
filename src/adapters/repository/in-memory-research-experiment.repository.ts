import type {
  ResearchExperiment, ExperimentRunMember, ExperimentEvaluation,
} from '../../domain/research-experiment.ts';
import type { ResearchExperimentRepository } from '../../ports/research-experiment.repository.ts';

export class InMemoryResearchExperimentRepository implements ResearchExperimentRepository {
  private readonly experiments = new Map<string, ResearchExperiment>();
  private readonly members = new Map<string, ExperimentRunMember>();
  private readonly evaluations: ExperimentEvaluation[] = [];

  async createExperiment(e: ResearchExperiment): Promise<void> { this.experiments.set(e.id, { ...e }); }
  async findById(id: string): Promise<ResearchExperiment | null> { return this.experiments.get(id) ?? null; }
  async findByKey(key: string): Promise<ResearchExperiment | null> {
    for (const e of this.experiments.values()) if (e.experimentKey === key) return e;
    return null;
  }
  async updateExperiment(id: string, patch: Partial<ResearchExperiment>): Promise<void> {
    const cur = this.experiments.get(id);
    if (cur) this.experiments.set(id, { ...cur, ...patch });
  }
  async addMember(m: ExperimentRunMember): Promise<void> { this.members.set(m.id, { ...m }); }
  async updateMember(id: string, patch: Partial<ExperimentRunMember>): Promise<void> {
    const cur = this.members.get(id);
    if (cur) this.members.set(id, { ...cur, ...patch });
  }
  async listMembers(experimentId: string): Promise<ExperimentRunMember[]> {
    return [...this.members.values()]
      .filter((m) => m.experimentId === experimentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async addEvaluation(ev: ExperimentEvaluation): Promise<void> { this.evaluations.push({ ...ev }); }
}
