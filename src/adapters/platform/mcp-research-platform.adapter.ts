import { discover, listDatasets } from '@trading-platform/sdk/agent';
import type { GatewayTransport } from '@trading-platform/sdk/agent';
import type {
  ResearchPlatformPort,
  ResearchCapabilityDescriptor,
  ListDatasetsFilter,
  ListDatasetsResult,
} from '../../ports/research-platform.port.ts';
import { assertContractCompatible } from './research-contract.ts';

/** Stateless over a live transport; the caller owns the session lifecycle (one session per probe). */
export class McpResearchPlatformAdapter implements ResearchPlatformPort {
  constructor(
    private readonly transport: GatewayTransport,
    private readonly acceptedContractVersion: string,
  ) {}

  async discover(): Promise<ResearchCapabilityDescriptor> {
    const descriptor = await discover(this.transport);
    assertContractCompatible(descriptor, this.acceptedContractVersion);
    return descriptor;
  }

  async listDatasets(filter?: ListDatasetsFilter): Promise<ListDatasetsResult> {
    return listDatasets(this.transport, filter);
  }
}
