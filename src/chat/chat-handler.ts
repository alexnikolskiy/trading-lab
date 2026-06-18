import { randomUUID } from 'node:crypto';
import type { TaskSource } from '../domain/types.ts';
import type { IntentClassifierPort } from '../ports/intent-classifier.port.ts';
import type { ChatSessionContext, ChatSessionRepository } from '../ports/chat-session.repository.ts';
import type { ChatPlanRepository } from '../ports/chat-plan.repository.ts';
import type { ResearchTaskRepository } from '../ports/research-task.repository.ts';
import type { StrategyProfileRepository } from '../ports/strategy-profile.repository.ts';
import type { HypothesisProposalRepository } from '../ports/hypothesis-proposal.repository.ts';
import type { AgentEventRepository } from '../ports/agent-event.repository.ts';
import type { TaskQueuePort } from '../ports/task-queue.port.ts';
import type { ActionProposalRepository } from '../ports/action-proposal.repository.ts';
import { parseIntent, planChatAction, type PlanDecision } from './guard.ts';
import { buildActionProposal } from './action-proposal.ts';
import {
  assistantMessage, rejected, errorResponse,
  type ChatResponse, type EvidencePresentation, type ProposedActionView,
} from './response.ts';

export interface ChatHandlerDeps {
  classifier: IntentClassifierPort;
  sessions: ChatSessionRepository;
  plans: ChatPlanRepository;
  researchTasks: ResearchTaskRepository;
  strategyProfiles: StrategyProfileRepository;
  hypotheses: HypothesisProposalRepository;
  events: AgentEventRepository;
  queue: TaskQueuePort;
  proposals: ActionProposalRepository;
  /** Confirmation window for a proposed action — policy, not deployment tuning. */
  proposalTtlMs: number;
  minConfidence: number;
}

export interface HandleChatInput {
  message: string;
  session: ChatSessionContext;
  source: TaskSource;
}

export async function handleChatMessage(input: HandleChatInput, deps: ChatHandlerDeps): Promise<ChatResponse> {
  const sid = input.session.sessionId;
  const chatRequestId = randomUUID();
  const now = (): string => new Date().toISOString();
  const ev = (type: string, payload: Record<string, unknown>): Promise<void> =>
    deps.events.append({ id: randomUUID(), taskId: chatRequestId, type, payload, createdAt: now() });

  await ev('chat.intent_classifier.started', {
    chatRequestId, sessionId: sid, adapter: deps.classifier.adapter, model: deps.classifier.model,
    messageChars: input.message.length, // length only — never the raw content
  });

  let raw: unknown;
  try {
    raw = await deps.classifier.classify(input.message);
  } catch (err) {
    await ev('chat.intent_classifier.failed', { chatRequestId, error: err instanceof Error ? err.message : String(err) });
    return errorResponse(sid, 'Не удалось обработать сообщение.');
  }

  const parsed = parseIntent(raw);
  if (!parsed.ok) {
    await ev('chat.intent_guard.rejected', { chatRequestId, reason: 'schema_invalid' });
    return rejected(sid, 'schema_invalid', parsed.issues);
  }
  await ev('chat.intent_classifier.completed', { chatRequestId, intent: parsed.intent.intent, confidence: parsed.intent.confidence });

  const decision = await planChatAction(parsed.intent, {
    message: input.message,
    session: input.session,
    minConfidence: deps.minConfidence,
    deps: { researchTasks: deps.researchTasks, strategyProfiles: deps.strategyProfiles, hypotheses: deps.hypotheses },
  });

  if (decision.kind === 'respond') {
    if (decision.auditReason) {
      await ev('chat.intent_guard.rejected', {
        chatRequestId, reason: decision.auditReason, intent: parsed.intent.intent, confidence: parsed.intent.confidence,
      });
    }
    return decision.response;
  }

  // Propose-and-confirm: the first turn writes an ActionProposal and asks the operator
  // to confirm. No task is created or enqueued here — that happens on confirmation (a
  // separate turn). The session pendingInteraction points at the proposal.
  const proposalId = randomUUID();
  const expiresAt = new Date(Date.now() + deps.proposalTtlMs).toISOString();
  const proposal = buildActionProposal({
    id: proposalId, sessionId: sid, source: input.source, message: input.message, decision, now: now(), expiresAt,
  });
  await deps.proposals.create(proposal);

  await deps.sessions.upsert({
    ...input.session,
    lastUserGoal: decision.userGoal,
    pendingInteraction: { kind: 'action_confirmation', proposalId, expiresAt },
    updatedAt: now(),
  });

  // Privacy: IDs / types / expiry only — never the raw message or strategy text.
  await ev('chat.proposal.created', {
    chatRequestId, proposalId, sessionId: sid, action: decision.action, taskType: decision.taskType, expiresAt,
  });

  const interpretation = interpretProposal(decision);
  const evidence: EvidencePresentation[] = [{ kind: 'interpretation', text: interpretation }];
  const actions: ProposedActionView[] = [
    { id: 'confirm', label: 'Подтвердить', style: 'primary' },
    { id: 'cancel', label: 'Отмена', style: 'secondary' },
  ];
  return assistantMessage(sid, interpretation, { evidence, actions, pendingInteractionId: proposalId });
}

/** Deterministic operator-facing interpretation, keyed by the proposed action / chain. */
function interpretProposal(decision: Extract<PlanDecision, { kind: 'propose_task' }>): string {
  switch (decision.action) {
    case 'strategy.analyze':
      return 'Вижу, что вы прислали стратегию и хотите провести анализ. Подтвердите запуск анализа.';
    case 'research.run_cycle':
      return decision.chain
        ? 'Вижу стратегию и запрос на исследование. Сначала будет создан и проанализирован профиль, затем запущен исследовательский цикл. Подтвердите этот план.'
        : 'Вижу запрос на исследование выбранной стратегии. Подтвердите запуск исследовательского цикла.';
    case 'hypothesis.build':
      return 'Вижу запрос на проверку гипотезы. Подтвердите запуск сборки и бэктеста гипотезы.';
    default:
      return 'Подтвердите запуск предложенного действия.';
  }
}
