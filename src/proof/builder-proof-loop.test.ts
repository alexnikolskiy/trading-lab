import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.ts';
import { runBuilderProofLoop } from './builder-proof-loop.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import type { StrategyBuilder, StrategyBuilderInput, StrategyBuilderOutput, BuildFeedback } from '../ports/strategy-builder.port.ts';

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

class RecordingBuilder implements StrategyBuilder {
  readonly adapter = 'rec';
  readonly model = 'rec';
  readonly feedbacks: (BuildFeedback | undefined)[] = [];
  private readonly inner = new FakeStrategyBuilder();
  async build(i: StrategyBuilderInput): Promise<StrategyBuilderOutput> {
    this.feedbacks.push(i.feedback);
    return this.inner.build(i);
  }
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

  it('divergence → parity-feedback → proven на 2-й попытке', async () => {
    const builder = new RecordingBuilder();
    const outcome = await runBuilderProofLoop({
      builder,
      prover: new ScriptedProver([
        { proven: false, divergence: { bar: 14, field: 'qty', expected: 1, actual: 1.5 } },
        { proven: true },
      ]),
      input: INPUT,
    });
    expect(outcome.proven).toBe(true);
    expect(outcome.attempts).toBe(2);
    // 1-я попытка — без feedback; 2-я — parity-feedback от divergence
    expect(builder.feedbacks[0]).toBeUndefined();
    expect(builder.feedbacks[1]).toEqual({ kind: 'parity', diff: { bar: 14, field: 'qty', expected: 1, actual: 1.5 } });
  });
});
