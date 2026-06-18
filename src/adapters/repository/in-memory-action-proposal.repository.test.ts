import { describe, expect, it } from 'vitest';
import { InMemoryActionProposalRepository } from './in-memory-action-proposal.repository.ts';
import type { ActionProposal } from '../../domain/action-proposal.ts';

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
  id: 'p1',
  sessionId: 's1',
  subjectHash: 'sha256:subject',
  action: 'strategy.analyze',
  source: 'web',
  task: {
    taskType: 'strategy.onboard',
    payload: { kind: 'manual_description', content: 'лонг после пролива' },
    dedupeKey: 'chat-proposal:p1',
    userGoal: 'strategy.onboard',
  },
  status: 'pending',
  expiresAt: '2026-06-18T12:10:00.000Z',
  createdAt: '2026-06-18T12:00:00.000Z',
  updatedAt: '2026-06-18T12:00:00.000Z',
  ...over,
});

describe('InMemoryActionProposalRepository', () => {
  it('creates and returns defensive copies', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    const found = await repo.findById('p1');
    expect(found).toEqual(proposal());
    found!.task.payload.content = 'mutated';
    expect((await repo.findById('p1'))?.task.payload.content).toBe('лонг после пролива');
  });

  it('confirms a live pending proposal once', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:05:00.000Z')).kind).toBe('confirmed_now');
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:05:01.000Z')).kind).toBe('already_confirmed');
  });

  it('does not confirm another session or an expired proposal', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    expect((await repo.confirmPending('p1', 'other', '2026-06-18T12:05:00.000Z')).kind).toBe('not_found');
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:11:00.000Z')).kind).toBe('expired');
  });

  it('cancels only a live pending proposal', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:05:00.000Z')).toBe(true);
    expect(await repo.cancelPending('p1', 's1', '2026-06-18T12:05:01.000Z')).toBe(false);
  });

  it('confirmPending after cancel returns not_found', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    await repo.cancelPending('p1', 's1', '2026-06-18T12:05:00.000Z');
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:06:00.000Z')).kind).toBe('not_found');
  });

  it('confirmPending after expiry returns not_found on second call', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    // First call past expiresAt transitions status to 'expired'
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:11:00.000Z')).kind).toBe('expired');
    // Second call on an already-expired proposal returns not_found
    expect((await repo.confirmPending('p1', 's1', '2026-06-18T12:12:00.000Z')).kind).toBe('not_found');
  });

  it('attachTask sets confirmedTaskId on a confirmed proposal', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    await repo.confirmPending('p1', 's1', '2026-06-18T12:05:00.000Z');
    await repo.attachTask('p1', 'task-1', '2026-06-18T12:05:01.000Z');
    expect((await repo.findById('p1'))?.confirmedTaskId).toBe('task-1');
  });

  it('attachTask throws when proposal not found', async () => {
    const repo = new InMemoryActionProposalRepository();
    await expect(repo.attachTask('missing', 'task-1', '2026-06-18T12:05:00.000Z')).rejects.toThrow();
  });

  it('attachTask throws when proposal is not confirmed (still pending)', async () => {
    const repo = new InMemoryActionProposalRepository();
    await repo.create(proposal());
    await expect(repo.attachTask('p1', 'task-1', '2026-06-18T12:05:00.000Z')).rejects.toThrow();
  });
});
