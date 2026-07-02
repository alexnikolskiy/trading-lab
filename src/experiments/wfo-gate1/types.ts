import { z } from 'zod';
import type { Gate1Input } from '../../ports/wfo-agents.port.ts';

export type Gate1Decision = 'improve' | 'allow_exploratory_sweep' | 'stop_not_worth' | 'stop_insufficient_evidence';

export type LabelSource = 'oracle' | 'teacher';

export interface RawCase {
  id: string;
  input: Gate1Input;
  meta: { experimentId: string; sourceRef: string };
}

export type OracleLabel = { label: Gate1Decision; confidence: 'obvious' } | { needsTeacher: true };

export interface FrozenCase {
  id: string;
  input: Gate1Input;
  label: Gate1Decision;
  labelSource: LabelSource;
  teacherModel?: string;
  rationale?: string;
  createdAt: string;
}

export interface FrozenDataset {
  snapshotId: string;
  createdAt: string;
  gitSha: string;
  sourceRef: string;
  cases: FrozenCase[];
}

// Minimal REAL validation of a Gate1Input payload (not a full StrategyProfile/BacktestMetricBlock
// schema — those live as plain interfaces, not zod schemas). This asserts the shape callers
// (DbCaseSource / SnapshotCaseSource / the oracle labeler) actually dereference: profile must be
// a non-null object, baselineMetrics must carry a numeric totalTrades, entryAffecting must be a
// string array, hasEntrySignalEvidence must be a boolean. Cast to Gate1Input at the boundary —
// intentionally narrower than the full interface (same as the previous z.any() cast), but unlike
// z.any() it actually rejects malformed snapshot/db payloads at parse time.
const Gate1InputMinimalSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
  baselineMetrics: z.object({ totalTrades: z.number() }).passthrough(),
  entryAffecting: z.array(z.string()),
  hasEntrySignalEvidence: z.boolean(),
});

export const RawCaseSchema = z.object({
  id: z.string(),
  input: Gate1InputMinimalSchema as unknown as z.ZodType<Gate1Input>,
  meta: z.object({
    experimentId: z.string(),
    sourceRef: z.string(),
  }),
});
