import { describe, it, expect } from 'vitest';
import { assertContractCompatible, ContractIncompatibleError } from './research-contract.ts';
import type { ResearchCapabilityDescriptor } from '../../ports/research-platform.port.ts';

function descriptor(contractVersion: string, supported: string[]): ResearchCapabilityDescriptor {
  return {
    contractVersion,
    supportedContractVersions: supported,
    marketDataKinds: [],
    runModes: [],
    metricCatalog: [],
    robustnessCatalog: [],
  };
}

describe('assertContractCompatible', () => {
  it('passes when expected equals contractVersion', () => {
    expect(() => assertContractCompatible(descriptor('031.2', []), '031.2')).not.toThrow();
  });

  it('passes when expected is in supportedContractVersions', () => {
    expect(() => assertContractCompatible(descriptor('031.3', ['031.2', '031.3']), '031.2')).not.toThrow();
  });

  it('throws ContractIncompatibleError otherwise, carrying expected/actual/supported', () => {
    try {
      assertContractCompatible(descriptor('031.3', ['031.3']), '031.1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractIncompatibleError);
      const e = err as ContractIncompatibleError;
      expect(e.expected).toBe('031.1');
      expect(e.actual).toBe('031.3');
      expect(e.supported).toEqual(['031.3']);
    }
  });
});
