import { describe, it, expect } from 'vitest';
import type { Agent } from '@mastra/core/agent';
import { SingleStageStrategyCritic } from './single-stage-strategy-critic.ts';
import type { AgentCallUsage } from '../../ports/agent-call-opts.ts';
import { MAX_OUTPUT_TOKENS } from '../llm/generate-defaults.ts';

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

describe('SingleStageStrategyCritic', () => {
  it('reports adapter/mode/model', () => {
    const agent = {
      generate: async () => ({ object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } }),
    } as unknown as Agent;
    const a = new SingleStageStrategyCritic(agent, 'anthropic/claude-sonnet-4-6');
    expect(a.adapter).toBe('mastra');
    expect(a.mode).toBe('single');
    expect(a.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('calls the agent once, accrues onUsage once, returns the parsed refinement, and passes modelSettings.maxOutputTokens', async () => {
    const seen: AgentCallUsage[] = [];
    let calls = 0;
    let capturedOpts: unknown;
    const agent = {
      generate: async (_prompt: string, opts: unknown) => {
        calls += 1;
        capturedOpts = opts;
        return { object: refinement, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
      },
    } as unknown as Agent;
    const a = new SingleStageStrategyCritic(agent, 'anthropic/claude-sonnet-4-6');
    const out = await a.refine(
      { kind: 'manual_description', content: 'short after a pump' },
      { onUsage: (u) => { seen.push(u); } },
    );
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ modelId: 'anthropic/claude-sonnet-4-6', inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    expect(out.improvedStrategyText).toBe('IMPROVED');
    expect(out.verdict.severity).toBe('medium');
    // maxOutputTokens cap must be forwarded
    const opts = capturedOpts as { modelSettings?: { maxOutputTokens?: number } };
    expect(opts.modelSettings?.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });
});
