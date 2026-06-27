import type { Candidate } from './types.ts';

export interface BuildCandidatesArgs {
  mode: 'single' | 'two_stage';
  models?: string[];        // single
  criticModels?: string[];  // two_stage
  refinerModels?: string[]; // two_stage
}

export function buildCandidates(args: BuildCandidatesArgs): Candidate[] {
  if (args.mode === 'single') {
    const models = args.models ?? [];
    if (models.length === 0) throw new Error('--mode single requires --models (comma-separated, e.g. anthropic/claude-x,openai/gpt-x)');
    return models.map((m) => ({ mode: 'single', label: `single:${m}`, combinedModel: m }));
  }
  const critics = args.criticModels ?? [];
  const refiners = args.refinerModels ?? [];
  if (critics.length === 0) throw new Error('--mode two_stage requires --critic-models (comma-separated)');
  if (refiners.length === 0) throw new Error('--mode two_stage requires --refiner-models (comma-separated)');
  const out: Candidate[] = [];
  for (const c of critics) {
    for (const r of refiners) {
      out.push({ mode: 'two_stage', label: `two_stage:critic=${c},refiner=${r}`, criticModel: c, refinerModel: r });
    }
  }
  return out;
}
