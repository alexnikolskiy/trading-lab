import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SHORT_AFTER_PUMP_SOURCE } from './short-after-pump.strategy-source.js';

const EXPECTED_SHA256 = '162e71cc877285dcb828e7a13f22d5160d9fba3f45ef2d5e2f1f02755f72e75c';

describe('stand-in source', () => {
  it('is self-contained ESM createStrategyModule', () => {
    expect(SHORT_AFTER_PUMP_SOURCE).toContain('export default');
    expect(SHORT_AFTER_PUMP_SOURCE).toContain('createStrategyModule');
    const stripped = SHORT_AFTER_PUMP_SOURCE.replace(/export\s+default/g, '');
    expect(/\b(import|require)\s*[(.]|\bfrom\s+['"]/.test(stripped)).toBe(false);
  });

  it('fidelity: byte-exact length and sha256 match committed constants', () => {
    expect(SHORT_AFTER_PUMP_SOURCE).toHaveLength(2561);
    const actual = createHash('sha256').update(SHORT_AFTER_PUMP_SOURCE).digest('hex');
    expect(actual).toBe(EXPECTED_SHA256);
  });
});
