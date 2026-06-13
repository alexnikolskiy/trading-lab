import type { AgentTaskType, TaskStatus } from '../domain/types.ts';
import type { ValidationIssue } from '../domain/schemas.ts';
import { ALLOWED_INTENTS } from './intent.ts';

export interface PlannedNextStep {
  taskType: AgentTaskType;
  after: AgentTaskType;
}

export type ChatResponse =
  | { kind: 'task_created'; sessionId: string; taskId: string; taskType: AgentTaskType; status: TaskStatus; plannedNextStep?: PlannedNextStep }
  | { kind: 'task_status'; sessionId: string; taskId: string; status: TaskStatus }
  | { kind: 'needs_clarification'; sessionId: string; question: string; missing: string[] }
  | { kind: 'out_of_scope'; sessionId: string; message: string }
  | { kind: 'capability_not_available'; sessionId: string; capability: string; message: string }
  | { kind: 'help'; sessionId: string; message: string; supportedIntents: string[] }
  | { kind: 'rejected'; sessionId: string; reason: string; issues?: ValidationIssue[] }
  | { kind: 'error'; sessionId: string; message: string };

export function outOfScope(sessionId: string): ChatResponse {
  return {
    kind: 'out_of_scope', sessionId,
    message: 'Я помогаю только с задачами Trading Lab: онбординг стратегий, исследование, гипотезы и статусы задач.',
  };
}

export function help(sessionId: string): ChatResponse {
  return {
    kind: 'help', sessionId,
    message: 'Я понимаю запросы Trading Lab: пришлите стратегию для онбординга/исследования, спросите статус задачи или последнюю гипотезу.',
    supportedIntents: [...ALLOWED_INTENTS],
  };
}

export function capabilityNotAvailable(sessionId: string, capability: string, message: string): ChatResponse {
  return { kind: 'capability_not_available', sessionId, capability, message };
}

export function needsClarification(sessionId: string, question: string, missing: string[]): ChatResponse {
  return { kind: 'needs_clarification', sessionId, question, missing };
}

export function taskCreated(
  sessionId: string, taskId: string, taskType: AgentTaskType, status: TaskStatus, plannedNextStep?: PlannedNextStep,
): ChatResponse {
  return { kind: 'task_created', sessionId, taskId, taskType, status, plannedNextStep };
}

export function taskStatus(sessionId: string, taskId: string, status: TaskStatus): ChatResponse {
  return { kind: 'task_status', sessionId, taskId, status };
}

export function rejected(sessionId: string, reason: string, issues?: ValidationIssue[]): ChatResponse {
  return { kind: 'rejected', sessionId, reason, issues };
}

export function errorResponse(sessionId: string, message: string): ChatResponse {
  return { kind: 'error', sessionId, message };
}
