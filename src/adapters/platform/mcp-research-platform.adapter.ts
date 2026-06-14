import { discover, listDatasets, validateModule } from '@trading-platform/sdk/agent';
import type { GatewayTransport, ValidateModuleRequest } from '@trading-platform/sdk/agent';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
  ValidationReport,
  ValidateModuleOptions,
} from '../../ports/research-platform.port.ts';
import { assertContractCompatible } from './research-contract.ts';
import type { GatewaySession } from './mcp-research-transport.ts';
import { toSubmittedBundle } from './submitted-bundle.ts';
import { GatewayValidationError } from './gateway-errors.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';

/** Stateless over a live transport; the caller owns the session lifecycle (one session per probe). */
export class McpResearchPlatformAdapter implements ResearchPlatformPort {
  private readonly transport: GatewayTransport;
  private readonly acceptedContractVersion: string;

  constructor(transport: GatewayTransport, acceptedContractVersion: string) {
    this.transport = transport;
    this.acceptedContractVersion = acceptedContractVersion;
  }

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const descriptor = await discover(this.transport);
    assertContractCompatible(descriptor, this.acceptedContractVersion);
    return descriptor;
  }

  async listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    return listDatasets(this.transport, filter);
  }

  async validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport> {
    const request: ValidateModuleRequest = {
      module: { kind: 'submitted', bundle: toSubmittedBundle(bundle) },
      ...(options?.dataNeeds !== undefined ? { dataNeeds: options.dataNeeds } : {}),
    };
    const result = await validateModule(this.transport, request);
    if (!result.ok) throw new GatewayValidationError(result.error);
    return result.report;
  }
}

/** Runtime-safe variant: opens a session per call and closes it. Boot constructs nothing live. */
export class LazyMcpResearchPlatformAdapter implements ResearchPlatformPort {
  private readonly connect: () => Promise<GatewaySession>;
  private readonly acceptedContractVersion: string;

  constructor(connect: () => Promise<GatewaySession>, acceptedContractVersion: string) {
    this.connect = connect;
    this.acceptedContractVersion = acceptedContractVersion;
  }

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).discover();
    } finally {
      await session.close();
    }
  }

  async listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).listDatasets(filter);
    } finally {
      await session.close();
    }
  }

  async validateModule(bundle: ModuleBundle, options?: ValidateModuleOptions): Promise<ValidationReport> {
    const session = await this.connect();
    try {
      return await new McpResearchPlatformAdapter(session.transport, this.acceptedContractVersion).validateModule(bundle, options);
    } finally {
      await session.close();
    }
  }
}
