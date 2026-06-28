import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.ts';
import { runBuilderProofLoop } from './builder-proof-loop.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import type { StrategyBuilderInput } from '../ports/strategy-builder.port.ts';

const INPUT = {
  spec: { goal: 'long oi rebound' },
  authoringDoc: 'doc',
  profile: undefined,
} as unknown as StrategyBuilderInput;

class ScriptedProver implements BundleProverPort {
  private i = 0;
  constructor(private readonly verdicts: ProofVerdict[]) {}
  async prove(): Promise<ProofVerdict> { return this.verdicts[this.i++]; }
}

describe('runBuilderProofLoop', () => {
  it('proven на первой попытке → attempts=1', async () => {
    const outcome = await runBuilderProofLoop({
      builder: new FakeStrategyBuilder(),
      prover: new ScriptedProver([{ proven: true }]),
      input: INPUT,
    });
    expect(outcome.proven).toBe(true);
    expect(outcome.attempts).toBe(1);
  });
});
