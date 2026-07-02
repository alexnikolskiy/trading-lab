import { Gate1OutputSchema } from '../../domain/wfo.ts';
import type { FrozenCase, LabelSource } from './types.ts';

export const DEFAULT_THRESHOLD = 0.9;
export const REASON_PENALTY = 0.1;

export interface CaseScore {
  id: string;
  schemaValid: boolean;
  decisionMatch: boolean;
  reasonOk: boolean;
  labelSource: LabelSource;
  score: number;
  latencyMs: number;
}

export interface RunScore {
  schemaValidRate: number;
  accuracy: number;
  oracleAccuracy: number;
  teacherAccuracy: number;
  reasonOkRate: number;
  meanScore: number;
  passRate: number;
  threshold: number;
  verdict: 'PASS' | 'FAIL';
  cases: CaseScore[];
}

function reasonNonContradictory(out: unknown): boolean {
  // Type guard to ensure we have the right structure
  if (typeof out !== 'object' || out === null) return false;

  const data = out as Record<string, unknown>;
  const reason = data.reason;
  const decision = data.decision;

  // Reason must be non-empty
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return false;
  }

  // If it's a stop_* decision, check for sweep/improve keywords
  if (typeof decision === 'string' && decision.startsWith('stop_')) {
    const reasonLower = reason.toLowerCase();
    const sweepKeywords = [
      'should sweep',
      'worth improving',
      'run a sweep',
    ];

    for (const keyword of sweepKeywords) {
      if (reasonLower.includes(keyword)) {
        return false;
      }
    }
  }

  return true;
}

export function scoreCase(raw: unknown, c: FrozenCase, latencyMs: number): CaseScore {
  const parsed = Gate1OutputSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      id: c.id,
      schemaValid: false,
      decisionMatch: false,
      reasonOk: false,
      labelSource: c.labelSource,
      score: 0,
      latencyMs,
    };
  }

  const decisionMatch = parsed.data.decision === c.label;
  const reasonOk = reasonNonContradictory(parsed.data);
  const score = decisionMatch ? (reasonOk ? 1 : 1 - REASON_PENALTY) : 0;

  return {
    id: c.id,
    schemaValid: true,
    decisionMatch,
    reasonOk,
    labelSource: c.labelSource,
    score,
    latencyMs,
  };
}

export function scoreRun(cases: CaseScore[], opts?: { threshold?: number }): RunScore {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;

  if (cases.length === 0) {
    return {
      schemaValidRate: 0,
      accuracy: 0,
      oracleAccuracy: 0,
      teacherAccuracy: 0,
      reasonOkRate: 0,
      meanScore: 0,
      passRate: 0,
      threshold,
      verdict: 'FAIL',
      cases: [],
    };
  }

  const schemaValidRate = cases.filter(c => c.schemaValid).length / cases.length;
  const accuracy = cases.filter(c => c.decisionMatch).length / cases.length;
  const reasonOkRate = cases.filter(c => c.reasonOk).length / cases.length;
  const meanScore = cases.reduce((sum, c) => sum + c.score, 0) / cases.length;

  // Calculate oracle accuracy
  const oracleCases = cases.filter(c => c.labelSource === 'oracle');
  const oracleAccuracy = oracleCases.length > 0
    ? oracleCases.filter(c => c.decisionMatch).length / oracleCases.length
    : 0;

  // Calculate teacher accuracy
  const teacherCases = cases.filter(c => c.labelSource === 'teacher');
  const teacherAccuracy = teacherCases.length > 0
    ? teacherCases.filter(c => c.decisionMatch).length / teacherCases.length
    : 0;

  const passRate = meanScore >= threshold ? 1 : 0;
  const verdict = meanScore >= threshold ? 'PASS' : 'FAIL';

  return {
    schemaValidRate,
    accuracy,
    oracleAccuracy,
    teacherAccuracy,
    reasonOkRate,
    meanScore,
    passRate,
    threshold,
    verdict,
    cases,
  };
}
