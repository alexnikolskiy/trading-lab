import { describe, it, expect } from 'vitest';
import { strategyOnboardHandler } from './strategy-onboard.handler.ts';
import { makeServices } from '../../../test/support/make-services.ts';
import { sourceFingerprint } from '../../domain/fingerprint.ts';
import { FakeStrategyAnalyst } from '../../adapters/analyst/fake-strategy-analyst.ts';
import type { StrategyAnalystPort } from '../../ports/strategy-analyst.port.ts';
import type { StrategyCriticPort } from '../../ports/strategy-critic.port.ts';
import type { StrategyRefinement } from '../../domain/strategy-critic.ts';
import type { StrategyRetrievalIndexerPort } from '../app-services.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { ResearchTask } from '../../domain/types.ts';

const task = (payload: Record<string, unknown>): ResearchTask => ({
  id: 'task-1', taskType: 'strategy.onboard', source: 'web', correlationId: 'c1',
  status: 'running', payload, createdAt: '2026-06-11T00:00:00Z', updatedAt: '2026-06-11T00:00:00Z',
});
const validPayload = { kind: 'article', content: 'buy dips on capitulation', title: 'Dip buyer' };

describe('strategyOnboardHandler', () => {
  it('analyzes, persists a profile, and records started+completed audit events', async () => {
    const services = makeServices();
    await strategyOnboardHandler(task(validPayload), services);
    const fp = sourceFingerprint('article', validPayload.content);
    const profile = await services.strategyProfiles.findByFingerprint(fp);
    expect(profile).not.toBeNull();
    expect(profile?.contractVersion).toBe('strategy-profile-v1');
    expect(profile?.sourceArtifactRef.content_hash).toMatch(/^sha256:/);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toEqual(['strategy_analyst.started', 'strategy_analyst.completed']);
  });

  it('is idempotent: a duplicate source is deduped without calling the LLM', async () => {
    let calls = 0;
    const spy: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      analyze: async (input) => { calls += 1; return new FakeStrategyAnalyst().analyze(input); },
    };
    const services = makeServices({ analyst: spy });
    await strategyOnboardHandler(task(validPayload), services);
    expect(calls).toBe(1);
    await strategyOnboardHandler(task(validPayload), services);
    expect(calls).toBe(1);
    const evts = await services.events.listByTask('task-1');
    const types = evts.map((e) => e.type);
    expect(types).toContain('strategy.onboard.deduped');
    const deduped = evts.find((e) => e.type === 'strategy.onboard.deduped');
    expect((deduped?.payload as Record<string, unknown>)?.profileId).toBeDefined();
    expect((deduped?.payload as Record<string, unknown>)?.strategyId).toBeUndefined();
  });

  it('throws on an invalid payload', async () => {
    const services = makeServices();
    await expect(strategyOnboardHandler(task({ kind: 'tweet' }), services)).rejects.toThrow(/invalid strategy.onboard payload/);
  });

  it('invokes the retrieval indexer with the persisted profile after onboarding', async () => {
    const indexed: StrategyProfile[] = [];
    const indexer: StrategyRetrievalIndexerPort = { index: async (p) => { indexed.push(p); } };
    const services = makeServices({ strategyRetrievalIndexer: indexer });
    await strategyOnboardHandler(task(validPayload), services);
    const fp = sourceFingerprint('article', validPayload.content);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.sourceFingerprint).toBe(fp);
  });

  it('completes onboarding even if the indexer is fail-soft (never throws)', async () => {
    // The real indexer never throws; this asserts the handler does not depend on its outcome.
    const indexer: StrategyRetrievalIndexerPort = { index: async () => { /* swallow, fail-soft */ } };
    const services = makeServices({ strategyRetrievalIndexer: indexer });
    await expect(strategyOnboardHandler(task(validPayload), services)).resolves.toBeUndefined();
    const fp = sourceFingerprint('article', validPayload.content);
    expect(await services.strategyProfiles.findByFingerprint(fp)).not.toBeNull();
  });

  it('records a failed audit event and rethrows when the analyst throws', async () => {
    const analyst: StrategyAnalystPort = {
      adapter: 'fake', model: 'fake',
      analyze: async () => { throw new Error('llm exploded'); },
    };
    const services = makeServices({ analyst });
    await expect(strategyOnboardHandler(task(validPayload), services)).rejects.toThrow('llm exploded');
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toEqual(['strategy_analyst.started', 'strategy_analyst.failed']);
  });
});

const cannedRefinement = (improved: string): StrategyRefinement => ({
  vulnerabilities: ['no invalidation'],
  selfDeception: [],
  risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
  earlyBreakSigns: [],
  preEntryChecks: [],
  verdict: { mainVulnerability: 'no stop', severity: 'high', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add a filter' },
  improvedStrategyText: improved,
  changeLog: ['added a regime filter'],
});

function spyAnalyst(): { analyst: StrategyAnalystPort; seen: string[] } {
  const seen: string[] = [];
  const analyst: StrategyAnalystPort = {
    adapter: 'fake', model: 'fake',
    analyze: async (input) => { seen.push(input.content); return new FakeStrategyAnalyst().analyze(input); },
  };
  return { analyst, seen };
}

describe('strategyOnboardHandler — pre-flight critic', () => {
  it('flag off (strategyCritic null): no critic events, analyst sees the original text', async () => {
    const { analyst, seen } = spyAnalyst();
    const services = makeServices({ analyst }); // strategyCritic defaults to null
    await strategyOnboardHandler(task(validPayload), services);
    expect(seen).toEqual([validPayload.content]);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).not.toContain('strategy_critic.started');
    expect(types).not.toContain('strategy_critic.completed');
  });

  it('flag on: emits started+completed, stores the critique artifact, analyst sees improvedStrategyText', async () => {
    const { analyst, seen } = spyAnalyst();
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => cannedRefinement(`IMPROVED: ${input.content}`),
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services);
    expect(seen).toEqual([`IMPROVED: ${validPayload.content}`]);
    const evts = await services.events.listByTask('task-1');
    const types = evts.map((e) => e.type);
    expect(types).toContain('strategy_critic.started');
    expect(types).toContain('strategy_critic.completed');
    const completed = evts.find((e) => e.type === 'strategy_critic.completed');
    const pl = completed?.payload as Record<string, unknown>;
    expect(pl.mode).toBe('two_stage');
    expect(pl.severity).toBe('high');
    expect(pl.badIdeaOrBadTiming).toBe('bad_timing');
    expect(pl.mainVulnerability).toBe('no stop');
    expect(typeof pl.critiqueRef).toBe('string');
  });

  it('critic throws: emits strategy_critic.failed and the analyst sees the ORIGINAL text (fail-soft)', async () => {
    const { analyst, seen } = spyAnalyst();
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async () => { throw new Error('critic exploded'); },
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services);
    expect(seen).toEqual([validPayload.content]); // original, not improved
    const evts = await services.events.listByTask('task-1');
    const types = evts.map((e) => e.type);
    expect(types).toContain('strategy_critic.failed');
    expect(types).not.toContain('strategy_critic.completed');
    const failed = evts.find((e) => e.type === 'strategy_critic.failed');
    expect((failed?.payload as Record<string, unknown>).error).toBe('critic exploded');
  });

  it('dedup short-circuit still skips the critic (fingerprint on the original content)', async () => {
    let refineCalls = 0;
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => { refineCalls += 1; return cannedRefinement(input.content); },
    };
    const services = makeServices({ strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services); // first onboard
    expect(refineCalls).toBe(1);
    await strategyOnboardHandler(task(validPayload), services); // duplicate → deduped before critic
    expect(refineCalls).toBe(1);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('strategy.onboard.deduped');
  });

  it('skipPreflightCritique:true → critic NOT called; analyst sees the payload content as-is', async () => {
    const { analyst, seen } = spyAnalyst();
    let refineCalls = 0;
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => { refineCalls += 1; return cannedRefinement(`IMPROVED: ${input.content}`); },
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task({ ...validPayload, skipPreflightCritique: true }), services);
    expect(refineCalls).toBe(0);
    expect(seen).toEqual([validPayload.content]); // original, never improved
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).not.toContain('strategy_critic.started');
    expect(types).not.toContain('strategy_critic.completed');
  });

  it('absent flag + critic present → the auto-critic runs (analyst sees improvedStrategyText)', async () => {
    const { analyst, seen } = spyAnalyst();
    const critic: StrategyCriticPort = {
      adapter: 'fake', mode: 'two_stage', model: 'fake',
      refine: async (input) => cannedRefinement(`IMPROVED: ${input.content}`),
    };
    const services = makeServices({ analyst, strategyCritic: critic });
    await strategyOnboardHandler(task(validPayload), services); // no skip flag
    expect(seen).toEqual([`IMPROVED: ${validPayload.content}`]);
    const types = (await services.events.listByTask('task-1')).map((e) => e.type);
    expect(types).toContain('strategy_critic.completed');
  });
});
