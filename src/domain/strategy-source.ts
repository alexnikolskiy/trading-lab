import { z } from 'zod';

export const SOURCE_KINDS = [
  'bot_code', 'readme', 'article', 'notebooklm_summary', 'manual_description', 'crawler',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const StrategyAnalystInputSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  content: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  /**
   * Chat HITL already resolved the pre-flight critic for this onboard — the worker MUST NOT re-run it.
   * Absent (crawler / direct /tasks) → the worker auto-critic runs (gated by STRATEGY_PREFLIGHT_CRITIQUE).
   * Not part of the source fingerprint (dedupe keys on kind+content only).
   */
  skipPreflightCritique: z.boolean().optional(),
});
export type StrategyAnalystInput = z.infer<typeof StrategyAnalystInputSchema>;
