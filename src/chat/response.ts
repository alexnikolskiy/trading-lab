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

export function outOfScope(sessionId: string): Extract<ChatResponse, { kind: 'out_of_scope' }> {
  return {
    kind: 'out_of_scope', sessionId,
    message: 'Я помогаю только с задачами Trading Lab: онбординг стратегий, исследование, гипотезы и статусы задач.',
  };
}

export function help(sessionId: string): Extract<ChatResponse, { kind: 'help' }> {
  return {
    kind: 'help', sessionId,
    message: 'Я понимаю запросы Trading Lab: пришлите стратегию для онбординга/исследования, спросите статус задачи или последнюю гипотезу.',
    supportedIntents: [...ALLOWED_INTENTS],
  };
}

export function capabilityNotAvailable(sessionId: string, capability: string, message: string): Extract<ChatResponse, { kind: 'capability_not_available' }> {
  return { kind: 'capability_not_available', sessionId, capability, message };
}

export function needsClarification(sessionId: string, question: string, missing: string[]): Extract<ChatResponse, { kind: 'needs_clarification' }> {
  return { kind: 'needs_clarification', sessionId, question, missing };
}

export function taskCreated(
  sessionId: string, taskId: string, taskType: AgentTaskType, status: TaskStatus, plannedNextStep?: PlannedNextStep,
): Extract<ChatResponse, { kind: 'task_created' }> {
  return { kind: 'task_created', sessionId, taskId, taskType, status, plannedNextStep };
}

export function taskStatus(sessionId: string, taskId: string, status: TaskStatus): Extract<ChatResponse, { kind: 'task_status' }> {
  return { kind: 'task_status', sessionId, taskId, status };
}

export function rejected(sessionId: string, reason: string, issues?: ValidationIssue[]): Extract<ChatResponse, { kind: 'rejected' }> {
  return { kind: 'rejected', sessionId, reason, issues };
}

export function errorResponse(sessionId: string, message: string): Extract<ChatResponse, { kind: 'error' }> {
  return { kind: 'error', sessionId, message };
}
