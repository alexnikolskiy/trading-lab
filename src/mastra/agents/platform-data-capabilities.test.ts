import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORM_DATA_CAPABILITIES } from './platform-data-capabilities.ts';
import { STRATEGY_REFINER_INSTRUCTIONS } from './strategy-refiner.agent.ts';
import { STRATEGY_CRITIC_COMBINED_INSTRUCTIONS } from './strategy-critic-combined.agent.ts';

const MARKERS = ['open interest', 'funding', 'taker', 'liquidation'];

describe('platform-data grounding', () => {
  it('the capabilities constant names every available signal', () => {
    const text = PLATFORM_DATA_CAPABILITIES.toLowerCase();
    for (const m of MARKERS) expect(text).toContain(m);
  });

  it('refiner + combined INSTRUCTIONS embed the capabilities markers', () => {
    for (const instr of [STRATEGY_REFINER_INSTRUCTIONS, STRATEGY_CRITIC_COMBINED_INSTRUCTIONS]) {
      const text = instr.toLowerCase();
      for (const m of MARKERS) expect(text).toContain(m);
    }
  });

  it('the pure-critique agent is NOT grounded (no capabilities markers, no import)', () => {
    const path = fileURLToPath(new URL('./strategy-critic.agent.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');
    expect(src).not.toContain('platform-data-capabilities');
    const lower = src.toLowerCase();
    for (const m of ['open interest', 'funding rate', 'taker buy']) expect(lower).not.toContain(m);
  });
});
