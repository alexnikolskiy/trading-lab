import { z } from 'zod';

export const ALLOWED_INTENTS = [
  'strategy.onboard', 'research.run_cycle', 'hypothesis.build',
  'results.backtest', 'results.trading', 'task.status', 'help',
  'out_of_scope', 'needs_clarification',
] as const;

export type AllowedIntent = (typeof ALLOWED_INTENTS)[number];

/**
 * Advisory LLM output. ALWAYS untrusted: re-validated by the guard's schema gate.
 * The classifier never emits trusted ids; `taskIdHint` is verified via findById
 * before use, and ids the user could not know are resolved from session memory.
 */
export const ChatIntentSchema = z.object({
  intent: z.enum(ALLOWED_INTENTS),
  confidence: z.number().min(0).max(1),
  strategyText: z.string().optional(),
  hypothesisText: z.string().optional(),
  entityRef: z.enum(['last_strategy', 'last_hypothesis', 'last_backtest', 'from_message_text']).optional(),
  taskIdHint: z.string().optional(),
  requestedOutcome: z.enum(['onboard', 'research', 'build_backtest', 'status', 'results']).optional(),
  rationale: z.string().optional(),
}).strict();

export type ChatIntent = z.infer<typeof ChatIntentSchema>;
