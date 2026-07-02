import { z } from 'zod';

import type { StrategyParameter } from './strategy-profile.ts';

/** Alias for the `StrategyProfile.profile.parameters[]` element type. */
export type ProfileParam = StrategyParameter;

const ENTRY_AFFECTING_NAME_PREFIXES = [
  'dump.',
  'entry.',
  'oiFilter.',
  'liqFilter.',
  'watch.cooldown',
  'warmup.maxSignalAge',
];

const ENTRY_AFFECTING_DESCRIPTION_KEYWORDS = ['entry', 'signal', 'filter', 'cooldown'];

function isEntryAffecting(param: ProfileParam): boolean {
  if (ENTRY_AFFECTING_NAME_PREFIXES.some((prefix) => param.name.startsWith(prefix))) {
    return true;
  }
  const description = param.description?.toLowerCase() ?? '';
  return ENTRY_AFFECTING_DESCRIPTION_KEYWORDS.some((keyword) => description.includes(keyword));
}

/**
 * Splits a strategy profile's tunable params into entry-affecting vs exit/risk buckets.
 * Used by GATE1's anti-waste guard and to restrict the sweep grid at a 0-trade baseline.
 */
export function classifyEntryAffectingParams(
  profileParams: ProfileParam[],
): { entryAffecting: string[]; exitRisk: string[] } {
  const entryAffecting: string[] = [];
  const exitRisk: string[] = [];
  for (const param of profileParams) {
    if (!param.tunable) continue;
    if (isEntryAffecting(param)) {
      entryAffecting.push(param.name);
    } else {
      exitRisk.push(param.name);
    }
  }
  return { entryAffecting, exitRisk };
}

export const Gate1OutputSchema = z.object({
  decision: z.enum(['improve', 'allow_exploratory_sweep', 'stop_not_worth', 'stop_insufficient_evidence']),
  reason: z.string(),
});
export type Gate1Output = z.infer<typeof Gate1OutputSchema>;

export const SweepDesignOutputSchema = z.object({
  grid: z.record(z.array(z.unknown())),
  rationale: z.string(),
});
export type SweepDesignOutput = z.infer<typeof SweepDesignOutputSchema>;

export const ResultInterpretOutputSchema = z.object({
  decision: z.enum(['select', 'extend', 'stop']),
  // must match one of the top-N paramsHashes when decision === 'select'
  chosenParamsHash: z.string().optional(),
  extendHint: z.string().optional(),
});
export type ResultInterpretOutput = z.infer<typeof ResultInterpretOutputSchema>;
