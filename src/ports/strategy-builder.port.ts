import type { CreateModuleManifestInput } from '@trading-backtester/sdk/builder';

/** Strategy authoring request — describes what to build; unused by FakeStrategyBuilder. */
export interface StrategyAuthoringSpec {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}

/** Required inputs for createModuleManifest minus `kind` (supplied by Task 4 as 'strategy'). */
export type StrategyManifestMeta = Omit<CreateModuleManifestInput, 'kind'>;

export interface StrategyBuilderInput {
  readonly spec: StrategyAuthoringSpec;
  readonly authoringDoc: string;
}

export interface StrategyBuilderOutput {
  readonly source: string;
  readonly manifestMeta: StrategyManifestMeta;
}

export interface StrategyBuilder {
  build(i: StrategyBuilderInput): Promise<StrategyBuilderOutput>;
}
