// src/adapters/platform/submitted-bundle.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createOverlayManifest, type OverlayManifestInput } from '@trading-platform/sdk/builder';
import { toSubmittedBundle, MissingOverlayMetaError } from './submitted-bundle.ts';
import { assembleBundle, SDK_CONTRACT_VERSION, type ModuleManifest } from '../../domain/module-bundle.ts';
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';

function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function serializeCanon(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanon).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${serializeCanon(o[k])}`).join(',')}}`;
}
// MUST match the platform: sorted-key + trailing "\n" (the newline is load-bearing for bundleHash parity).
function canon(value: unknown): string { return `${serializeCanon(value)}\n`; }

const manifest: ModuleManifest = {
  moduleId: 'overlay-m1', moduleKind: 'hypothesis_overlay', appliesTo: 'long',
  entry: 'index.ts', exports: ['overlay'], capabilities: ['oi'], sdkContractVersion: SDK_CONTRACT_VERSION,
};
const files = { 'index.ts': 'export const overlay = { rules: [] };', 'helpers/util.ts': 'export const u = 1;' };
const meta: OverlayManifestMeta = {
  id: 'overlay-m1', version: '0.1.0', name: 'filter entries', summary: 'skip on oi trend',
  rationale: 'oi-based entry filter', author: 'agent', targetStrategyRef: 'strategy:p1',
  interceptionPoint: 'post_entry_management', paramsSchema: { type: 'object', additionalProperties: false },
};
// Same 1:1 mapping toSubmittedBundle uses internally → the projected manifest must equal this.
const expectedInput: OverlayManifestInput = {
  id: meta.id, version: meta.version, name: meta.name, summary: meta.summary, rationale: meta.rationale,
  author: meta.author, paramsSchema: meta.paramsSchema, targetStrategyRef: meta.targetStrategyRef,
  interceptionPoint: meta.interceptionPoint,
};
const expectedManifest = createOverlayManifest(expectedInput);
const expectedManifestJson = JSON.stringify(expectedManifest);

describe('toSubmittedBundle', () => {
  const sub = toSubmittedBundle(assembleBundle(manifest, files, meta));

  it('emits manifest.json as the 017 overlay manifest from createOverlayManifest (not the lab manifest)', () => {
    const man = sub.files.find((f) => f.path === 'manifest.json')!;
    const decoded = JSON.parse(Buffer.from(man.contentBase64, 'base64').toString('utf8'));
    expect(decoded).toEqual(expectedManifest);
    expect(decoded.kind).toBe('overlay');
    expect(decoded.hooks).toEqual(['apply']);
    expect(decoded.status).toBe('research_only');
    expect(decoded.targetStrategyRef).toBe('strategy:p1');
    expect(decoded.interceptionPoint).toBe('post_entry_management');
    expect(decoded.moduleId).toBeUndefined(); // lab-native field must NOT leak into the 017 manifest
  });

  it('sets submitted.manifest to the same 017 overlay manifest', () => {
    expect(sub.manifest).toEqual(expectedManifest);
  });

  it('re-roots code files under module/ and adds manifest.json at root, all base64', () => {
    const paths = sub.files.map((f) => f.path).sort();
    expect(paths).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    const idx = sub.files.find((f) => f.path === 'module/index.ts')!;
    expect(Buffer.from(idx.contentBase64, 'base64').toString('utf8')).toBe(files['index.ts']);
  });

  it('descriptor.files lists manifest.json + module/** entries, sorted, with per-file sha256', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; entryPoint: string; kind: string; contractVersion: string; bundleHash: string };
    expect(d.files.map((f) => f.path)).toEqual(['manifest.json', 'module/helpers/util.ts', 'module/index.ts']);
    expect(d.files.find((f) => f.path === 'module/index.ts')!.sha256).toBe(sha256Hex(files['index.ts']));
    expect(d.files.find((f) => f.path === 'manifest.json')!.sha256).toBe(sha256Hex(expectedManifestJson));
    expect(d.kind).toBe('overlay');
    expect(d.entryPoint).toBe('module/index.ts');
    expect(typeof d.contractVersion).toBe('string');
  });

  it('bundleHash replicates the platform formula over the 017 manifest.json (self-consistent)', () => {
    const d = sub.descriptor as { files: { path: string; sha256: string }[]; bundleHash: string };
    const manifestSha256 = sha256Hex(expectedManifestJson);
    const expected = `sha256:${sha256Hex(canon({ manifestSha256, files: d.files }))}`;
    expect(d.bundleHash).toBe(expected);
  });

  it('every file path is a safe relative path (no traversal, no leading slash)', () => {
    for (const f of sub.files) {
      expect(f.path.startsWith('/')).toBe(false);
      expect(f.path.includes('..')).toBe(false);
    }
  });
});

describe('toSubmittedBundle fail-closed without overlayMeta', () => {
  it('throws MissingOverlayMetaError with code overlay_meta_missing', () => {
    const bundle = assembleBundle(manifest, files); // no overlayMeta → pre-SP-7.1b bundle
    expect(() => toSubmittedBundle(bundle)).toThrow(MissingOverlayMetaError);
    try {
      toSubmittedBundle(bundle);
      throw new Error('expected MissingOverlayMetaError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingOverlayMetaError);
      expect((e as MissingOverlayMetaError).code).toBe('overlay_meta_missing');
    }
  });
});

describe('toSubmittedBundle path safety', () => {
  const code = 'export const overlay = {};';
  function withFileKey(key: string) {
    return assembleBundle(manifest, { [key]: code }, meta);
  }

  it.each([
    ['empty', ''],
    ['traversal', '../x.ts'],
    ['absolute', '/x.ts'],
    ['drive-letter', 'C:/x.ts'],
    ['backslash', 'dir\\x.ts'],
    ['NUL', 'dir/\0x.ts'],
  ])('rejects an unsafe file path: %s', (_label, key) => {
    expect(() => toSubmittedBundle(withFileKey(key))).toThrow();
  });

  it('rejects an unsafe manifest.entry', () => {
    const b = assembleBundle({ ...manifest, entry: '../index.ts' }, { 'index.ts': code }, meta);
    expect(() => toSubmittedBundle(b)).toThrow();
  });

  it('still accepts a safe nested path', () => {
    expect(() => toSubmittedBundle(assembleBundle(manifest, { 'index.ts': code, 'helpers/util.ts': 'export const u = 1;' }, meta))).not.toThrow();
  });
});
