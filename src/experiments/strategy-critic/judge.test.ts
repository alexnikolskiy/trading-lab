import { describe, it, expect } from 'vitest';
import { buildJudgePrompt } from './judge.ts';
import { GOOD_PUMP_SHORT_REFINEMENT } from './__fixtures__/refinements.ts';

describe('buildJudgePrompt', () => {
  it('embeds the original text and the candidate refinement JSON', () => {
    const prompt = buildJudgePrompt({ originalText: 'шорт после пампа от 10% за 20 минут', refinement: GOOD_PUMP_SHORT_REFINEMENT });
    expect(prompt).toContain('шорт после пампа от 10% за 20 минут');
    expect(prompt).toContain(GOOD_PUMP_SHORT_REFINEMENT.improvedStrategyText);
    expect(prompt).toContain('Return the structured judge verdict.');
  });
});
