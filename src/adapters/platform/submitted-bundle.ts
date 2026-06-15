// src/adapters/platform/submitted-bundle.ts
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import { createOverlayManifest } from '@trading-platform/sdk/builder';
import type { OverlayManifestInput } from '@trading-platform/sdk/builder';
import type { SubmittedBundle } from '@trading-platform/sdk/agent';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import type { OverlayManifestMeta } from '../../domain/overlay-manifest-meta.ts';

const MODULE_DIR = 'module';

/** Thrown when a bundle reaches the platform wire boundary without SP-7.1b overlayMeta (not validation-ready). */
export class MissingOverlayMetaError extends Error {
  readonly code = 'overlay_meta_missing';
  constructor() {
    super('toSubmittedBundle: bundle is missing overlayMeta (pre-SP-7.1b bundle is not validation-ready) [overlay_meta_missing]');
    this.name = 'MissingOverlayMetaError';
  }
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Recursive sorted-key serializer (strings via JSON.stringify) — matches the platform's `serialize`. */
function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${serializeCanonical(obj[k])}`).join(',')}}`;
}

/**
 * Canonical JSON — MUST byte-match trading-platform `src/research/backtest/canonical-json.ts`:
 * sorted-key + a TRAILING "\n". The newline is load-bearing for bundleHash parity; omitting it
 * makes the gateway recompute a different hash → bundle_integrity_violation.
 */
function canonicalJson(value: unknown): string {
  return `${serializeCanonical(value)}\n`;
}

/**
 * Reject unsafe relative bundle paths locally so SP-7.1 guarantees structural correctness
 * before the gateway materializes the bundle (mirrors the platform's isSafeBundlePath guard).
 */
function assertSafeBundlePath(path: string, kind: string): void {
  if (path.length === 0) throw new Error(`toSubmittedBundle: empty ${kind} path`);
  if (path.includes('\0')) throw new Error(`toSubmittedBundle: NUL in ${kind} path: ${JSON.stringify(path)}`);
  if (path.includes('\\')) throw new Error(`toSubmittedBundle: backslash in ${kind} path: ${path}`);
  if (path.startsWith('/')) throw new Error(`toSubmittedBundle: absolute ${kind} path: ${path}`);
  if (/^[A-Za-z]:/.test(path)) throw new Error(`toSubmittedBundle: drive-letter ${kind} path: ${path}`);
  if (path.split('/').some((seg) => seg === '..')) throw new Error(`toSubmittedBundle: path traversal in ${kind} path: ${path}`);
}

/** Map the lab-native OverlayManifestMeta onto the SDK's OverlayManifestInput (1:1; SDK fills the rest). */
function mapMetaToOverlayInput(meta: OverlayManifestMeta): OverlayManifestInput {
  return {
    id: meta.id,
    version: meta.version,
    name: meta.name,
    summary: meta.summary,
    rationale: meta.rationale,
    author: meta.author,
    paramsSchema: meta.paramsSchema,
    targetStrategyRef: meta.targetStrategyRef,
    interceptionPoint: meta.interceptionPoint,
  };
}

/**
 * Map a lab ModuleBundle to the platform's submitted-bundle wire shape (SP-7.1b §3).
 *  - `manifest.json` = a real 017 overlay manifest built from `bundle.overlayMeta` via the SDK's
 *    `createOverlayManifest` (NOT the lab-native manifest) — this is what the gateway validates.
 *  - lab `files` keys are re-rooted under `module/`; `descriptor.entryPoint` still comes from the
 *    lab manifest's `entry`.
 *  - `descriptor.files` = `manifest.json` + all `module/**` payload entries (sorted, per-file sha256).
 *  - `bundleHash` replicates `trading-platform/.../bundle-hash.ts::computeBundleHash`.
 */
export function toSubmittedBundle(bundle: ModuleBundle): SubmittedBundle {
  if (bundle.overlayMeta === undefined) throw new MissingOverlayMetaError();
  for (const key of Object.keys(bundle.files)) assertSafeBundlePath(key, 'file');
  assertSafeBundlePath(bundle.manifest.entry, 'entry');

  const manifest017 = createOverlayManifest(mapMetaToOverlayInput(bundle.overlayMeta));
  const manifestJson = JSON.stringify(manifest017);
  const manifestSha256 = sha256Hex(manifestJson);

  // One sorted payload list (manifest.json + module/**) drives both descriptor.files and files[].
  const payload = [
    { path: 'manifest.json', source: manifestJson },
    ...Object.entries(bundle.files).map(([rel, source]) => ({ path: `${MODULE_DIR}/${rel}`, source })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const descriptorFiles = payload.map((f) => ({ path: f.path, sha256: sha256Hex(f.source) }));
  const bundleHash = `sha256:${sha256Hex(canonicalJson({ manifestSha256, files: descriptorFiles }))}`;

  const descriptor = {
    contractVersion: CONTRACT_VERSION,
    kind: 'overlay' as const, // lab moduleKind 'hypothesis_overlay' → platform 'overlay'
    entryPoint: `${MODULE_DIR}/${bundle.manifest.entry}`,
    files: descriptorFiles,
    bundleHash,
  };

  const files = payload.map((f) => ({ path: f.path, contentBase64: Buffer.from(f.source, 'utf8').toString('base64') }));

  return { manifest: manifest017, files, descriptor };
}
