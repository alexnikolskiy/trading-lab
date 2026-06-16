// src/experiments/strategy-analyst/types.ts
import { z } from 'zod';
import type { AnalystProfileOutput } from '../../domain/strategy-profile.ts';

export type EvalMode = 'dry-run' | 'run';

export interface FixtureRef {
  id: string;
  sourcePath: string;
  notesPath: string;
  rubricPath: string;
}

export interface CheckResult {
  id: string;
  weight: number;
  bucketsHit: number;
  bucketCount: number;
  contribution: number;
  matched: string[];
}

export interface ScoreResult {
  gates: { schemaValid: boolean; directionLong: boolean };
  checks: CheckResult[];
  score: number; // 0..1 — always a number; scoreProfile only runs when a raw object exists
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}

export type CandidateErrorType = 'schema' | 'provider' | 'adapter' | 'timeout' | 'unknown';

export interface CandidateError {
  type: CandidateErrorType;
  message: string;
}

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
  overallScore: z.number().min(0).max(1),
  hallucinations: z.array(z.string()),
  missingFromProfile: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;        // null only when analyze() threw
  rawOutput: AnalystProfileOutput | null; // present only when analyze() returned
  error: CandidateError | null;
  judge: JudgeVerdict | null;       // populated only when --judge ran; written to a SEPARATE file
}

export interface EvalRunResult {
  fixture: { id: string; fingerprint: string };
  threshold: number;
  judgeEnabled: boolean;
  models: string[];
  perModel: CandidateResult[];
  overallSuccess: boolean;          // >=1 PASS
}

export interface ManifestMeta {
  timestamp: string;
  gitSha: string;
  harnessVersion: string;
  contractVersion: string;
  mode: EvalMode;
}
