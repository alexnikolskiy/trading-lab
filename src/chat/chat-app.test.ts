import { describe, it, expect } from 'vitest';
import { createChatApp, type ChatAppDeps } from './chat-app.ts';
import { FakeIntentClassifier } from '../adapters/intent/fake-intent-classifier.ts';
import { InMemoryResearchTaskRepository } from '../adapters/repository/in-memory-research-task.repository.ts';
import { InMemoryStrategyProfileRepository } from '../adapters/repository/in-memory-strategy-profile.repository.ts';
import { InMemoryHypothesisProposalRepository } from '../adapters/repository/in-memory-hypothesis-proposal.repository.ts';
import { InMemoryAgentEventRepository } from '../adapters/repository/in-memory-agent-event.repository.ts';
import { InMemoryChatSessionRepository } from '../adapters/repository/in-memory-chat-session.repository.ts';
import { InMemoryChatPlanRepository } from '../adapters/repository/in-memory-chat-plan.repository.ts';
import { InMemoryQueueAdapter } from '../adapters/queue/in-memory-queue.adapter.ts';

function appDeps(over: Partial<ChatAppDeps> = {}): ChatAppDeps {
  return {
    classifier: new FakeIntentClassifier(),
    sessions: new InMemoryChatSessionRepository(),
    plans: new InMemoryChatPlanRepository(),
    researchTasks: new InMemoryResearchTaskRepository(),
    strategyProfiles: new InMemoryStrategyProfileRepository(),
    hypotheses: new InMemoryHypothesisProposalRepository(),
    events: new InMemoryAgentEventRepository(),
    queue: new InMemoryQueueAdapter(),
    minConfidence: 0.6,
    maxMessageChars: 4000,
    ...over,
  };
}

function post(app: ReturnType<typeof createChatApp>, body: unknown) {
  return app.request('/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /chat/messages', () => {
  it('rejects an empty message with 400', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only message with 400 and never calls the classifier', async () => {
    let calls = 0;
    const spy = {
      adapter: 'fake' as const,
      model: 'fake',
      classify: async () => { calls += 1; return { intent: 'help', confidence: 1 }; },
    };
    const app = createChatApp(appDeps({ classifier: spy }));
    const res = await post(app, { message: '   ' });
    expect(res.status).toBe(400);
    expect(calls).toBe(0); // schema gate rejects before handler/classifier runs
  });

  it('rejects an oversize message with 400', async () => {
    const app = createChatApp(appDeps({ maxMessageChars: 5 }));
    const res = await post(app, { message: 'this is way too long' });
    expect(res.status).toBe(400);
    const body = await res.json() as { reason?: string };
    expect(body.reason).toBe('message_too_long');
  });

  it('returns 200 + out_of_scope for a weather question and generates a sessionId', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: 'какая сегодня погода?' });
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; sessionId: string };
    expect(body.kind).toBe('out_of_scope');
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it('returns 200 + task_created and echoes the provided sessionId', async () => {
    const app = createChatApp(appDeps());
    const res = await post(app, { message: 'исследуй эту стратегию: лонг при росте OI', sessionId: 'sess-42' });
    expect(res.status).toBe(200);
    const body = await res.json() as { kind: string; sessionId: string; plannedNextStep?: { taskType: string } };
    expect(body.kind).toBe('task_created');
    expect(body.sessionId).toBe('sess-42');
    expect(body.plannedNextStep?.taskType).toBe('research.run_cycle');
  });
});
