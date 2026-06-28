// F2b — порт платформенного proof-seam (trading-platform 050 prove_bundle.mjs).
// Verdict.divergence форма идентична BuildFeedback['parity']['diff'] — выравнивание с F2a-портом.
export type ProofVerdict =
  | { readonly proven: true }
  | { readonly proven: false; readonly divergence: { bar: number; field: string; expected: unknown; actual: unknown } }
  | { readonly proven: false; readonly failClosed: { reason: string } };

export interface BundleProverPort {
  prove(bundleSource: string): Promise<ProofVerdict>;
}
