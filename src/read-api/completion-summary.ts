// src/read-api/completion-summary.ts
import type { ResearchTask } from '../domain/types.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { BacktestRun } from '../domain/backtest-run.ts';
import type { BacktestMetricBlock } from '../ports/platform-gateway.port.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { HypothesisReadPort } from '../ports/hypothesis-read.port.ts';
import type { BacktestReadPort } from '../ports/backtest-read.port.ts';
import type { AgentEventReadPort } from '../ports/agent-event-read.port.ts';

// Display-hint only — mirrors backtest-completed.handler.ts:22 (MAX_CYCLE_DEPTH = 2). Kept local so the
// read layer does not import an orchestrator handler (avoids upward layer coupling + load-time deps).
const MAX_CYCLE_DEPTH = 2;

export type EvaluationDecisionLabel = 'PASS' | 'FAIL' | 'MODIFY' | 'INCONCLUSIVE' | 'PAPER_CANDIDATE';

export interface ProfileRef { id: string; coreIdea: string; direction: string }
export interface HypothesisRef { id: string; thesis: string; confidence: number | null; status: string | null }
export interface KeyMetrics {
  netPnlUsd: number | null; netPnlPct: number | null; winRate: number | null;
  profitFactor: number | null; maxDrawdownPct: number | null; sharpe: number | null; totalTrades: number | null;
}
export interface SummaryLinks { taskId: string; profileId?: string; hypothesisId?: string; backtestRunId?: string }

export interface BacktestCompletedCompletionSummary {
  kind: 'backtest.completed'; taskId: string; status: string; profile: ProfileRef | null;
  hypothesis: HypothesisRef | null; decision: EvaluationDecisionLabel;
  metrics: KeyMetrics; reasons: string[]; willRetry: boolean; links: SummaryLinks;
}

export interface RunCycleCompletionSummary {
  kind: 'research.run_cycle'; taskId: string; status: string; profile: ProfileRef | null;
  counts: { proposed: number; validated: number; rejected: number; deduped: number; criticReviews: number; backtestsEnqueued: number };
  topHypotheses: HypothesisRef[]; nextStep?: { taskType: string }; links: SummaryLinks;
}

export type CompletionSummary = BacktestCompletedCompletionSummary | RunCycleCompletionSummary;

export interface CompletionSummaryDeps {
  researchTasks: Pick<ResearchTaskRepository, 'findById'>;
  strategyProfiles: Pick<StrategyProfileRepository, 'findById'>;
  hypotheses: Pick<HypothesisReadPort, 'list' | 'getById'>;
  backtests: Pick<BacktestReadPort, 'getById'>;
  agentEvents: Pick<AgentEventReadPort, 'list'>;
}

const THESIS_MAX = 240;
const clip = (s: string, n = THESIS_MAX): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

async function safe<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

function toKeyMetrics(m: BacktestMetricBlock | null): KeyMetrics {
  return {
    netPnlUsd: m?.netPnlUsd ?? null, netPnlPct: m?.netPnlPct ?? null, winRate: m?.winRate ?? null,
    profitFactor: m?.profitFactor ?? null, maxDrawdownPct: m?.maxDrawdownPct ?? null,
    sharpe: m?.sharpe ?? null, totalTrades: m?.totalTrades ?? null,
  };
}
function toProfileRef(p: StrategyProfile): ProfileRef { return { id: p.id, coreIdea: clip(p.coreIdea), direction: p.direction }; }
function toHypothesisRef(h: HypothesisProposal): HypothesisRef {
  return { id: h.id, thesis: clip(h.thesis), confidence: h.confidence ?? null, status: h.status ?? null };
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

async function buildRunCycle(deps: CompletionSummaryDeps, task: ResearchTask): Promise<RunCycleCompletionSummary> {
  const profileId = (task.payload as { strategyProfileId?: string }).strategyProfileId;
  const profile = profileId ? await safe(() => deps.strategyProfiles.findById(profileId)) : null;

  const events = (await safe(() => deps.agentEvents.list({ taskId: task.id, type: 'research.run_cycle.completed', limit: 1 }))) ?? [];
  const ev = events[0]?.payload as { proposed?: unknown; validated?: unknown; rejected?: unknown; deduped?: unknown; criticReviews?: unknown } | undefined;
  const validated = num(ev?.validated);
  const counts = {
    proposed: num(ev?.proposed), validated, rejected: num(ev?.rejected),
    deduped: num(ev?.deduped), criticReviews: num(ev?.criticReviews), backtestsEnqueued: validated,
  };

  let topHypotheses: HypothesisRef[] = [];
  if (profileId) {
    const hs = (await safe(() => deps.hypotheses.list({ profileId, status: 'validated', limit: 50 }))) ?? [];
    topHypotheses = [...hs]
      .sort((a, b) => (b.confidence - a.confidence) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, 3)
      .map(toHypothesisRef);
  }

  return {
    kind: 'research.run_cycle', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null, counts, topHypotheses,
    links: { taskId: task.id, profileId },
  };
}

async function buildBacktestCompleted(deps: CompletionSummaryDeps, task: ResearchTask): Promise<BacktestCompletedCompletionSummary> {
  const p = task.payload as {
    backtestRunId?: string; hypothesisId?: string; strategyProfileId?: string;
    decision?: string; reasons?: unknown; cycleDepth?: number;
  };
  const decision = (p.decision ?? 'INCONCLUSIVE') as EvaluationDecisionLabel;
  const reasons = Array.isArray(p.reasons) ? p.reasons.map(String) : [];
  const cycleDepth = typeof p.cycleDepth === 'number' ? p.cycleDepth : 0;
  const run: BacktestRun | null = p.backtestRunId ? await safe(() => deps.backtests.getById(p.backtestRunId!)) : null;
  const hyp = p.hypothesisId ? await safe(() => deps.hypotheses.getById(p.hypothesisId!)) : null;
  const profile = p.strategyProfileId ? await safe(() => deps.strategyProfiles.findById(p.strategyProfileId!)) : null;
  return {
    kind: 'backtest.completed', taskId: task.id, status: task.status,
    profile: profile ? toProfileRef(profile) : null,
    hypothesis: hyp ? toHypothesisRef(hyp) : null,
    decision, metrics: toKeyMetrics(run?.metrics ?? null), reasons,
    willRetry: (decision === 'FAIL' || decision === 'MODIFY') && cycleDepth < MAX_CYCLE_DEPTH,
    links: { taskId: task.id, profileId: p.strategyProfileId, hypothesisId: p.hypothesisId, backtestRunId: p.backtestRunId },
  };
}

export async function buildCompletionSummary(deps: CompletionSummaryDeps, taskId: string): Promise<CompletionSummary | null> {
  const task = await safe(() => deps.researchTasks.findById(taskId));
  if (!task || task.status !== 'completed') return null;
  switch (task.taskType) {
    case 'backtest.completed': return buildBacktestCompleted(deps, task);
    case 'research.run_cycle': return buildRunCycle(deps, task);
    default: return null;
  }
}
