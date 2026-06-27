import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { STRATEGY_CRITIC_COMBINED_INSTRUCTIONS } from './strategy-critic-combined.agent.ts';

const STRUCTURE_MARKERS = ['Entry conditions', 'Exit & invalidation', 'Required data signals', 'Caveats'];

describe('strategy-critic-combined instructions', () => {
  it('organise improvedStrategyText into the four labelled sections', () => {
    for (const marker of STRUCTURE_MARKERS) {
      expect(STRATEGY_CRITIC_COMBINED_INSTRUCTIONS).toContain(marker);
    }
  });

  it('still grounds in platform data and keeps the runner-owned boundary', () => {
    expect(STRATEGY_CRITIC_COMBINED_INSTRUCTIONS).toContain('AVAILABLE PLATFORM DATA');
    expect(STRATEGY_CRITIC_COMBINED_INSTRUCTIONS).toContain('runner-owned');
  });

  it('does NOT add the structure markers to the critique-only or refiner agents', () => {
    const criticSrc = readFileSync(new URL('./strategy-critic.agent.ts', import.meta.url), 'utf8');
    const refinerSrc = readFileSync(new URL('./strategy-refiner.agent.ts', import.meta.url), 'utf8');
    for (const marker of STRUCTURE_MARKERS) {
      expect(criticSrc).not.toContain(marker);
      expect(refinerSrc).not.toContain(marker);
    }
  });
});
