import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { SingleStageStrategyCritic } from './single-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';

const refinement = {
  vulnerabilities: ['no invalidation'],
  selfDeception: [],
  risks: { market: 'm', timing: 't', news: 'n', liquidity: 'l', btcRegime: 'b', exhaustion: 'e' },
  earlyBreakSigns: [],
  preEntryChecks: [],
  verdict: { mainVulnerability: 'v', severity: 'medium', badIdeaOrBadTiming: 'bad_timing', whatWouldStrengthen: 'add filter' },
  improvedStrategyText: 'IMPROVED',
  changeLog: ['added filter'],
};

function stubAgent(): Agent {
  return {
    generate: async () => ({ object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }),
  } as unknown as Agent;
}

describe('SingleStageStrategyCritic', () => {
  it('reports adapter/mode/model', () => {
    const a = new SingleStageStrategyCritic(stubAgent(), 'anthropic/claude-sonnet-4-6');
    expect(a.adapter).toBe('mastra');
    expect(a.mode).toBe('single');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('calls the agent once, accrues onUsage once, and returns the parsed refinement', async () => {
    const seen: AgentCallUsage[] = [];
    let calls = 0;
    const agent = {
      generate: async () => { calls += 1; return { object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }; },
    } as unknown as Agent;
    const a = new SingleStageStrategyCritic(agent, 'anthropic/claude-sonnet-4-6');
    const out = await a.refine({ kind: 'manual_description', content: 'short after a pump' }, { onUsage: (u) => { seen.push(u); } });
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ modelId: 'anthropic/claude-sonnet-4-6', inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    expect(out.improvedStrategyText).toBe('IMPROVED');
    expect(out.verdict.severity).toBe('medium');
  });
});
