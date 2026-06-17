// src/experiments/intent-classifier/types.ts
// Shared contracts for the IntentClassifier eval harness. Symmetrical to
// src/experiments/strategy-analyst/types.ts but role-specific: the unit of work is a
// labelled chat-message dataset, and the headline metric is intent-match accuracy.
import { z } from 'zod';
import type { AllowedIntent } from '../../chat/intent.ts';

export type EvalMode = 'dry-run' | 'run';

export type EntityRef = 'last_strategy' | 'last_hypothesis' | 'last_backtest' | 'from_message_text';
export type RequestedOutcome = 'onboard' | 'research' | 'build_backtest' | 'status' | 'results';

/** What we expect the classifier to produce for one chat message. Intent is the primary signal;
 *  the optional payload fields are the secondary signal (only checked when present). */
export interface EvalCaseExpect {
  intent: AllowedIntent;
  requestedOutcome?: RequestedOutcome;
  entityRef?: EntityRef;
  hasStrategyText?: boolean;
  hasHypothesisText?: boolean;
}

export interface EvalCase {
  id: string;
  lang: 'ru' | 'en';
  message: string;
  expect: EvalCaseExpect;
}

export interface PayloadCheck {
  field: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}

export type CandidateErrorType = 'schema' | 'provider' | 'adapter' | 'timeout' | 'unknown';

export interface CandidateError {
  type: CandidateErrorType;
  message: string;
}

/** Per-message scoring detail. `actualIntent` is null when the classifier output failed the
 *  ChatIntentSchema gate (schemaValid=false) or the classify() call threw. */
export interface CaseResult {
  id: string;
  lang: 'ru' | 'en';
  expectedIntent: AllowedIntent;
  actualIntent: string | null;
  intentMatch: boolean;
  schemaValid: boolean;
  payloadChecks: PayloadCheck[];
  payloadScore: number | null; // null when the case carried no payload expectations
  latencyMs: number;
  error: CandidateError | null; // per-case error (classify threw, or schema-invalid)
}

/** One model run over the whole dataset. `score` (== intentAccuracy) is the gated headline;
 *  payloadAccuracy is the secondary signal / ranking tiebreaker. */
export interface ScoreResult {
  intentAccuracy: number; // correct intents / total cases (PRIMARY)
  payloadAccuracy: number | null; // mean payloadScore over cases with payload expectations
  score: number; // == intentAccuracy
  threshold: number;
  verdict: 'PASS' | 'FAIL';
  cases: CaseResult[];
  caseCount: number;
  schemaValidCount: number;
  schemaValidRate: number; // schemaValidCount / caseCount — share passing the strict gate (prod-acceptable). Independent of intentAccuracy.
}

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
  overallScore: z.number().min(0).max(1),
  disputedCases: z.array(z.object({ id: z.string(), note: z.string() })), // cases where the EXPECTED label is arguable
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  latencyMs: number; // total run latency across all cases
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null; // null only when the classifier could not be built (catastrophic run failure)
  error: CandidateError | null; // run-level catastrophic error (per-case errors live inside score.cases)
  judge: JudgeVerdict | null; // populated only when --judge ran; written to a SEPARATE file
}

export interface Stats {
  mean: number;
  median: number;
  std: number; // population std (divide by n); n === 1 -> 0
  min: number;
  max: number;
}

export interface ModelAggregate {
  model: string;
  provider: string;
  modelId: string;
  runs: { total: number; ok: number; failed: number; failedByType: Record<string, number> };
  passRate: number; // PASS count / total runs (failed runs count as non-PASS)
  det: Stats | null; // over runs with a score — these are intentAccuracy stats
  schemaValid: Stats | null; // over runs with a score — schemaValidRate stats (informational; not a ranking key)
  payload: Stats | null; // over runs with a payloadAccuracy; null if no run carried payload expectations
  judge: Stats | null; // over runs with a judge verdict; null if judge never ran
  latency: { mean: number; median: number }; // over all runs
}

export interface EvalRunResult {
  dataset: { id: string; fingerprint: string; caseCount: number };
  threshold: number;
  repeat: number;
  judgeEnabled: boolean;
  models: string[];
  perModel: CandidateResult[]; // flat: every run, ordered model-major then run index
  aggregates: ModelAggregate[]; // one per model
  overallSuccess: boolean; // >=1 run (any model) with verdict PASS
}

export interface ManifestMeta {
  timestamp: string;
  gitSha: string;
  harnessVersion: string;
  contractVersion: string;
  mode: EvalMode;
}
