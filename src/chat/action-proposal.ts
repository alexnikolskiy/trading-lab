import type { TaskSource } from '../domain/types.ts';
import type { ActionProposal } from '../domain/action-proposal.ts';
import { sourceFingerprint } from '../domain/fingerprint.ts';
import type { PlanDecision } from './guard.ts';

export function buildActionProposal(input: {
  id: string;
  sessionId: string;
  source: TaskSource;
  message: string;
  decision: Extract<PlanDecision, { kind: 'propose_task' }>;
  now: string;
  expiresAt: string;
}): ActionProposal {
  const { id, sessionId, source, message, decision, now, expiresAt } = input;

  return {
    id,
    sessionId,
    subjectHash: sourceFingerprint('manual_description', message.trim()),
    action: decision.action,
    source,
    task: {
      taskType: decision.taskType,
      payload: decision.payload,
      dedupeKey: `chat-proposal:${id}`,
      chain: decision.chain,
      userGoal: decision.userGoal,
    },
    status: 'pending',
    // Evidence is attached by the Operator retrieval path (plan Task 8); default empty here.
    evidenceRefs: [],
    evidenceWarnings: [],
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
}
