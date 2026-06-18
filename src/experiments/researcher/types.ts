import { z } from 'zod';
import type { ResearcherOutput } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';

export const JudgeVerdictSchema = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(1), rationale: z.string() })),
  overallScore: z.number().min(0).max(1),
  hallucinations: z.array(z.string()),
  missingFromOutput: z.array(z.string()),
  notes: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export interface CheckResult {
  id: string;
  weight: number;
  contribution: number;
  matched: string[];
}

export interface ScoreResult {
  gates: {
    schemaValid: boolean;
    hasHypothesis: boolean;
    researchOnly: boolean;
    contextGrounded: boolean;
    noStrategyRewrite: boolean;
    forensicGrounded: boolean;
  };
  checks: CheckResult[];
  score: number;
  threshold: number;
  verdict: 'PASS' | 'FAIL';
}

export interface CandidateError {
  type: 'schema' | 'provider' | 'adapter' | 'timeout' | 'unknown';
  message: string;
}

export interface CandidateResult {
  model: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  verdict: 'PASS' | 'FAIL';
  score: ScoreResult | null;
  rawOutput: ResearcherOutput | null;
  error: CandidateError | null;
  judge: JudgeVerdict | null;
}

export interface ModelAggregate {
  model: string;
  provider: string;
  modelId: string;
  runs: { total: number; ok: number; failed: number; failedByType: Record<string, number> };
  passRate: number;
  scoreMean: number | null;
  latencyMeanMs: number;
}

export interface ResearcherEvalInput {
  models: string[];
  fixtureId: string;
  fixtureFingerprint: string;
  profile: StrategyProfile;
  botResults: readonly BotRunResultDetail[];
  tradeEvidence?: readonly TradeEvidenceBundle[];
  threshold: number;
  repeat?: number;
}

export interface EvalRunResult {
  fixture: { id: string; fingerprint: string };
  threshold: number;
  repeat: number;
  models: string[];
  perModel: CandidateResult[];
  aggregates: ModelAggregate[];
  overallSuccess: boolean;
}
