import { describe, it, expect } from 'vitest';
import { parseIntent, planChatAction, type PlanArgs } from './guard.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryHypothesisProposalRepository } from '../adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import type { ChatSessionContext } from '../ports/chat-session.repository.ts';
import type { StrategyProfile } from '../domain/strategy-profile.ts';
import type { HypothesisProposal } from '../domain/hypothesis.ts';
import type { ResearchTask } from '../domain/types.ts';

const session = (over: Partial<ChatSessionContext> = {}): ChatSessionContext => ({
  sessionId: 's1', updatedAt: '2026-06-13T00:00:00Z', ...over,
});

function mkDeps() {
  return {
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
  };
}

function args(intentOver: Partial<PlanArgs> = {}, deps = mkDeps()): { plan: PlanArgs; deps: ReturnType<typeof mkDeps> } {
  return {
    plan: { message: 'm', session: session(), minConfidence: 0.6, deps, ...intentOver },
    deps,
  };
}

const profile = (id: string): StrategyProfile => ({
  id, version: 1, sourceKind: 'manual_description', sourceFingerprint: `sha256:${id}`,
  direction: 'long', coreIdea: 'idea', requiredMarketFeatures: [], confidence: 0.5, unknowns: [],
  profile: {} as never, sourceArtifactRef: {} as never, contractVersion: 'strategy-profile-v1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const validatedHyp = (id: string, profileId: string): HypothesisProposal => ({
  id, strategyProfileId: profileId, thesis: 't', targetBehavior: 'b',
  ruleAction: { appliesTo: 'long', rules: [{ when: 'w', action: 'no_op', params: {} }] },
  requiredFeatures: ['oi'], validationPlan: 'p', expectedEffect: { metric: 'win_rate', direction: 'increase' },
  invalidationCriteria: ['x'], confidence: 0.5, status: 'validated', fingerprint: `sha256:${id}`,
  proposal: {} as never, issues: [], contractVersion: 'hypothesis-proposal-v1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
const task = (id: string): ResearchTask => ({
  id, taskType: 'strategy.onboard', source: 'web', correlationId: 'c1', status: 'running',
  payload: {}, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

describe('parseIntent (schema gate)', () => {
  it('accepts a valid intent', () => {
    const r = parseIntent({ intent: 'help', confidence: 0.9 });
    expect(r.ok).toBe(true);
  });
  it('rejects malformed classifier output', () => {
    const r = parseIntent({ intent: 'transfer.funds', confidence: 2 });
    expect(r.ok).toBe(false);
  });
});

describe('planChatAction', () => {
  it('out_of_scope bypasses confidence and responds statically', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'out_of_scope', confidence: 0.1 }, plan);
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') expect(d.response.kind).toBe('out_of_scope');
  });

  it('low confidence -> needs_clarification, no task', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'strategy.onboard', confidence: 0.2, strategyText: 'x' }, plan);
    expect(d.kind).toBe('respond');
    if (d.kind === 'respond') {
      expect(d.response.kind).toBe('needs_clarification');
      expect(d.auditReason).toBe('low_confidence');
    }
  });

  it('results.trading -> capability_not_available', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'results.trading', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('capability_not_available');
  });

  it('results.backtest -> capability_not_available', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'results.backtest', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('capability_not_available');
  });

  it('task.status with a resolvable session pointer -> task_status', async () => {
    const { plan, deps } = args({ session: session({ lastResearchTaskId: 't1' }) });
    await deps.researchTasks.create(task('t1'));
    const d = await planChatAction({ intent: 'task.status', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('task_status');
  });

  it('task.status with nothing resolvable -> needs_clarification', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'task.status', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('needs_clarification');
  });

  it('strategy.onboard with text -> create_task, no chain', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'strategy.onboard', confidence: 0.9, strategyText: 'go long on oi' }, plan);
    expect(d.kind).toBe('create_task');
    if (d.kind === 'create_task') {
      expect(d.taskType).toBe('strategy.onboard');
      expect(d.payload).toEqual({ kind: 'manual_description', content: 'go long on oi' });
      expect(d.chain).toBeUndefined();
    }
  });

  it('strategy.onboard + research outcome -> create_task with chain fingerprint', async () => {
    const { plan } = args();
    const text = 'go long on oi spike';
    const d = await planChatAction(
      { intent: 'strategy.onboard', confidence: 0.9, strategyText: text, requestedOutcome: 'research' }, plan,
    );
    expect(d.kind).toBe('create_task');
    if (d.kind === 'create_task') {
      expect(d.chain?.nextTaskType).toBe('research.run_cycle');
      expect(d.chain?.resolveProfileByFingerprint).toBe(sourceFingerprint('manual_description', text));
    }
  });

  it('strategy.onboard without text -> needs_clarification', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'strategy.onboard', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('needs_clarification');
  });

  it('research.run_cycle with strategy text -> onboard create_task with chain', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'research.run_cycle', confidence: 0.9, strategyText: 'new strat' }, plan);
    expect(d.kind).toBe('create_task');
    if (d.kind === 'create_task') {
      expect(d.taskType).toBe('strategy.onboard');
      expect(d.chain?.nextTaskType).toBe('research.run_cycle');
    }
  });

  it('research.run_cycle via last_strategy -> create_task research.run_cycle', async () => {
    const { plan, deps } = args({ session: session({ lastStrategyProfileId: 'p1' }) });
    await deps.strategyProfiles.create(profile('p1'));
    const d = await planChatAction({ intent: 'research.run_cycle', confidence: 0.9 }, plan);
    expect(d.kind).toBe('create_task');
    if (d.kind === 'create_task') {
      expect(d.taskType).toBe('research.run_cycle');
      expect(d.payload).toEqual({ strategyProfileId: 'p1' });
    }
  });

  it('research.run_cycle with no resolvable strategy -> needs_clarification', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'research.run_cycle', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('needs_clarification');
  });

  it('hypothesis.build via latest validated by profile -> create_task', async () => {
    const { plan, deps } = args({ session: session({ lastStrategyProfileId: 'p1' }) });
    await deps.hypotheses.create(validatedHyp('h1', 'p1'));
    const d = await planChatAction({ intent: 'hypothesis.build', confidence: 0.9 }, plan);
    expect(d.kind).toBe('create_task');
    if (d.kind === 'create_task') {
      expect(d.taskType).toBe('hypothesis.build');
      expect(d.payload).toEqual({ hypothesisId: 'h1' });
    }
  });

  it('hypothesis.build with no resolvable hypothesis -> needs_clarification', async () => {
    const { plan } = args();
    const d = await planChatAction({ intent: 'hypothesis.build', confidence: 0.9 }, plan);
    expect(d.kind === 'respond' && d.response.kind).toBe('needs_clarification');
  });
});
