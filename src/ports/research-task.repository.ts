import type { ResearchTask, TaskStatus } from '../domain/types.ts';

export interface ResearchTaskRepository {
  create(task: ResearchTask): Promise<void>;
  findById(id: string): Promise<ResearchTask | null>;
  findByDedupeKey(dedupeKey: string): Promise<ResearchTask | null>;
  updateStatus(id: string, status: TaskStatus): Promise<void>;
}
