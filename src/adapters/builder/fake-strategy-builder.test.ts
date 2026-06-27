import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from './fake-strategy-builder.js';
import { SHORT_AFTER_PUMP_SOURCE } from './fixtures/short-after-pump.strategy-source.js';

describe('FakeStrategyBuilder', () => {
  const builder = new FakeStrategyBuilder();
  const input = { spec: {}, authoringDoc: '' };

  it('build() returns SHORT_AFTER_PUMP_SOURCE', async () => {
    const result = await builder.build(input);
    expect(result.source).toBe(SHORT_AFTER_PUMP_SOURCE);
  });

  it('manifestMeta.id is short_after_pump', async () => {
    const result = await builder.build(input);
    expect(result.manifestMeta.id).toBe('short_after_pump');
  });

  it('manifestMeta.hooks includes onBarClose', async () => {
    const result = await builder.build(input);
    expect(result.manifestMeta.hooks).toContain('onBarClose');
  });
});
