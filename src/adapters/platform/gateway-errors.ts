import type { GatewayError } from '../../ports/research-run-lifecycle.ts';

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

/** Thrown when a run-lifecycle gateway call returns an `ok:false` envelope. */
export class GatewayRunError extends Error {
  readonly category: GatewayError['category'];
  readonly code: string;
  constructor(error: GatewayError) {
    super(`gateway ${error.category}/${error.code}: ${error.message}`);
    this.name = 'GatewayRunError';
    this.category = error.category;
    this.code = error.code;
  }
}
