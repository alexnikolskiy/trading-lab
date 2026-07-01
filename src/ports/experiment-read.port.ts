import type { ResearchExperiment, ExperimentRunMember, ExperimentStatus } from '../domain/research-experiment.ts';

export interface ExperimentListQuery {
  strategyProfileId?: string;
  status?: ExperimentStatus;
  limit: number;
  after?: { t: string; id: string };
}

export interface ExperimentReadPort {
  list(q: ExperimentListQuery): Promise<ResearchExperiment[]>;
  getById(id: string): Promise<ResearchExperiment | null>;
  listRuns(experimentId: string): Promise<ExperimentRunMember[]>;
}
