// src/mastra/agents/intent-classifier-judge.agent.ts
// Judge agent for the IntentClassifier eval harness. Lives in src/mastra (single home for Agent
// construction). Separate from the production intent-classifier agent — it assesses, never classifies.
import { Agent } from '@mastra/core/agent';
import type { ProviderModel } from '../../adapters/llm/model-provider.ts';

export const INTENT_CLASSIFIER_JUDGE_AGENT_ID = 'intent-classifier-judge';

const INSTRUCTIONS = [
  'You are auditing an intent classifier over a labelled chat dataset.',
  'Each row has a user message, the EXPECTED intent label, and the classifier ACTUAL intent.',
  'Score overall classification quality (and any per-dimension breakdown you find useful) from 0 to 1 with short rationales.',
  'Flag any case where the EXPECTED label itself is arguable in disputedCases.',
  'Be strict and concise. Do not propose changes; only assess.',
].join(' ');

export function createIntentClassifierJudgeAgent(model: ProviderModel): Agent {
  return new Agent({ id: INTENT_CLASSIFIER_JUDGE_AGENT_ID, name: 'Intent Classifier Judge', instructions: INSTRUCTIONS, model });
}
