import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeParamsHash } from './backtest-support.ts';

// Reproduce the legacy SP-4 hash exactly to prove byte-compatibility.
function legacyStableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyStableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${legacyStableStringify(obj[k])}`).join(',')}}`;
}
// The legacy SP-4 sha256 carries a `sha256:` prefix and hashes utf8 — preserve both for byte-compat.
const legacy = (p: Record<string, unknown>) => `sha256:${createHash('sha256').update(legacyStableStringify(p), 'utf8').digest('hex')}`;

describe('computeParamsHash', () => {
  const params = { bars: 2, threshold: 0.5 };
  const platformRun = { datasetId: 'ds', symbols: ['ETH', 'BTC'], timeframe: '1h', period: { from: 'a', to: 'b' }, seed: 9 };
  const baselineRef = { id: 'strategy:p1', version: 'v1' };

  it('sp4_mock hash is byte-identical to the legacy sha256(stableStringify(params))', () => {
    expect(computeParamsHash('sp4_mock', params)).toBe(legacy(params));
  });

  it('research_platform hash differs from the sp4_mock hash for the same params', () => {
    expect(computeParamsHash('research_platform', params, { platformRun, baselineRef })).not.toBe(computeParamsHash('sp4_mock', params));
  });

  it('research_platform hash is symbol-order-insensitive', () => {
    const a = computeParamsHash('research_platform', params, { platformRun, baselineRef });
    const b = computeParamsHash('research_platform', params, { platformRun: { ...platformRun, symbols: ['BTC', 'ETH'] }, baselineRef });
    expect(a).toBe(b);
  });

  it('research_platform hash changes when the dataset/seed/baseline changes', () => {
    const base = computeParamsHash('research_platform', params, { platformRun, baselineRef });
    expect(computeParamsHash('research_platform', params, { platformRun: { ...platformRun, seed: 10 }, baselineRef })).not.toBe(base);
    expect(computeParamsHash('research_platform', params, { platformRun, baselineRef: { id: 'strategy:p2', version: 'v1' } })).not.toBe(base);
  });
});
