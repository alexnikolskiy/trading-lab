import type { StrategyBuilder, StrategyBuilderInput, BuildFeedback } from '../ports/strategy-builder.port.ts';
import type { BundleProverPort, ProofVerdict } from './bundle-prover.port.ts';
import { assembleStrategyBundle } from '../domain/strategy-bundle.ts';
import { validateStrategyBundle } from '../validation/strategy-bundle-validator.ts';

export interface ProofOutcome {
  readonly proven: boolean;
  readonly attempts: number;
  readonly lastVerdict?: ProofVerdict;
  readonly lastViolations?: string[];
}

export interface BuilderProofLoopDeps {
  readonly builder: StrategyBuilder;
  readonly prover: BundleProverPort;
  readonly input: StrategyBuilderInput;
  readonly maxIterations?: number;
}

function verdictToFeedback(v: Extract<ProofVerdict, { proven: false }>): BuildFeedback {
  if ('divergence' in v) return { kind: 'parity', diff: v.divergence };
  return { kind: 'validation', violations: [v.failClosed.reason] };
}

export async function runBuilderProofLoop(deps: BuilderProofLoopDeps): Promise<ProofOutcome> {
  const maxIterations = deps.maxIterations ?? 5;
  let feedback: BuildFeedback | undefined;
  let lastVerdict: ProofVerdict | undefined;
  let lastViolations: string[] | undefined;

  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    const out = await deps.builder.build({ ...deps.input, feedback });
    const bundle = await assembleStrategyBundle(out);

    const verdict = validateStrategyBundle(bundle);
    if (verdict.status === 'rejected') {
      lastViolations = verdict.violations;
      feedback = { kind: 'validation', violations: verdict.violations };
      continue;
    }

    const proof = await deps.prover.prove(bundle.source);
    if (proof.proven) return { proven: true, attempts: attempt };
    lastVerdict = proof;
    feedback = verdictToFeedback(proof);
  }

  return { proven: false, attempts: maxIterations, lastVerdict, lastViolations };
}
