import { describe, it, expect } from 'vitest';
import { FakeStrategyBuilder } from '../adapters/builder/fake-strategy-builder.js';
import { assembleStrategyBundle } from './strategy-bundle.js';

const spec = {};

describe('assembleStrategyBundle', () => {
  it('manifest.kind=strategy, bundleHash format, self-contained bytes, determinism', async () => {
    const out = await new FakeStrategyBuilder().build({ spec, authoringDoc: '' });
    const a = await assembleStrategyBundle(out);

    expect(a.manifest.kind).toBe('strategy');
    expect(a.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // decoded bytes (minus export default) must have no import/require/from
    expect(
      /\b(import|require)\s*[(.]|\bfrom\s+['"]/.test(
        new TextDecoder().decode(a.bytes).replace(/export\s+default/g, ''),
      ),
    ).toBe(false);

    const a2 = await assembleStrategyBundle(out);
    expect(a2.bundleHash).toBe(a.bundleHash); // determinism
  });
});
