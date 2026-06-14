import type { GatewayError } from '@trading-platform/sdk/agent';

/** Thrown when the gateway returns an `ok:false` envelope (transport-level / contract / bundle-load failure). */
export class GatewayValidationError extends Error {
  readonly category: GatewayError['category'];
  readonly code: string;

  constructor(error: GatewayError) {
    super(`gateway ${error.category}/${error.code}: ${error.message}`);
    this.name = 'GatewayValidationError';
    this.category = error.category;
    this.code = error.code;
  }
}
