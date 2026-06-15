import type {
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidationIssueDTO,
  RunResultSummary,
  ComparisonSummaryDTO,
} from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../domain/module-bundle.ts';

export type {
  ResearchCapabilityDescriptor, ListDatasetsFilter, ListDatasetsResult,
  ValidationReport, ValidationIssueDTO,
  RunResultSummary, ComparisonSummaryDTO,
};

export interface ValidateModuleOptions {
  readonly dataNeeds?: object;
}

/**
 * Research-platform lifecycle as seen by trading-lab research orchestration.
 * Separate from PlatformGatewayPort (market-context + the mock backtest path).
 * Grows in SP-7.2+ with submit / status / result / artifacts / cancel.
 */
export interface ResearchPlatformPort {
  discover(): Promise<ResearchCapabilityDescriptor>;
  listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult>;
  validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport>;
}
