import { describe, it, expect } from 'vitest';
import { createChatApp } from '../../src/chat/chat-app.ts';
import { makeServices } from '../support/make-services.ts';
import { FakeIntentClassifier } from '../../src/adapters/intent/fake-intent-classifier.ts';
import { InMemoryQueueAdapter } from '../../src/adapters/queue/in-memory-queue.adapter.ts';

describe('e2e: chat -> proposes an onboard+research chain (awaiting confirmation)', () => {
  it('persists a proposal and asks the operator to confirm instead of enqueuing on the first turn', async () => {
    const queue = new InMemoryQueueAdapter();
    const services = makeServices();

    const app = createChatApp({
      classifier: new FakeIntentClassifier(),
      sessions: services.chatSessions, plans: services.chatPlans,
      researchTasks: services.researchTasks, strategyProfiles: services.strategyProfiles,
      hypotheses: services.hypotheses, events: services.events, queue,
      proposals: services.actionProposals, proposalTtlMs: 600_000,
      minConfidence: 0.6, maxMessageChars: 4000,
      authToken: 'e2e-chat-token',
    });

    const res = await app.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-chat-token' },
      body: JSON.stringify({ message: 'исследуй эту стратегию: лонг при росте OI и падении цены', sessionId: 's1' }),
    });
    const body = await res.json() as { kind: string; pendingInteractionId?: string; actions?: { id: string }[] };
    expect(res.status).toBe(200);
    expect(body.kind).toBe('assistant_message');
    expect(body.pendingInteractionId).toBeTruthy();
    expect(body.actions?.map((a) => a.id)).toEqual(['confirm', 'cancel']);

    // First turn is a no-op on the work side: nothing enqueued, no plan, no task.
    expect(queue.queued).toHaveLength(0);

    const session = await services.chatSessions.get('s1');
    expect(session?.pendingInteraction?.kind).toBe('action_confirmation');
    expect(session?.pendingPlanId).toBeUndefined();
    expect(session?.lastResearchTaskId).toBeUndefined();

    // The proposal snapshot carries the onboard task + the research chain, awaiting confirmation.
    const proposal = await services.actionProposals.findById(session!.pendingInteraction!.proposalId);
    expect(proposal?.status).toBe('pending');
    expect(proposal?.task.taskType).toBe('strategy.onboard');
    expect(proposal?.task.chain?.nextTaskType).toBe('research.run_cycle');
    expect(await services.researchTasks.findByDedupeKey(`chat-proposal:${proposal!.id}`)).toBeNull();
  });
});
