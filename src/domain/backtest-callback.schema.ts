import { z } from 'zod';

const terminalStatuses = ['completed', 'failed', 'canceled', 'expired', 'timed_out'] as const;

/** Payload POSTed by trading-backtester / trading-platform on terminal job transition. */
export const BacktestCompletionCallbackSchema = z.object({
  eventType: z.enum(['job_completed', 'job_failed', 'job_canceled', 'job_expired', 'job_timed_out']),
  jobId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(terminalStatuses),
  correlationId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  summary: z.record(z.unknown()),
  emittedAtMs: z.number(),
});

export type BacktestCompletionCallback = z.infer<typeof BacktestCompletionCallbackSchema>;
