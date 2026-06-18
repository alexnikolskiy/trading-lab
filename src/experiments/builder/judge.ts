import type { Agent } from '@mastra/core/agent';
import type { BuilderOutput } from '../../ports/builder.port.ts';
import type { HypothesisProposal } from '../../domain/hypothesis.ts';
import { BuilderJudgeVerdictSchema } from './types.ts';
import type { BuilderJudgeVerdict } from './types.ts';

export const BUILDER_JUDGE_RUBRIC = `
Dimension: hypothesis_fidelity (0–1)
  Does the generated code directly implement what the hypothesis proposes?
  Does it reference the correct overlay action (skip_entry, tighten_stop, exit_now, etc.)?
  0 = code ignores the hypothesis intent. 1 = code directly encodes the hypothesis rule(s).

Dimension: logic_soundness (0–1)
  Is the overlay logic internally consistent and free from obvious bugs?
  Are conditionals, thresholds and params sensible given the hypothesis context?
  0 = broken logic, contradictory conditions, or trivially wrong thresholds.
  1 = logic is coherent and defensible.

Dimension: sdk_compliance (0–1)
  Does the code follow the overlay SDK contract?
  - exports const overlay (data-driven {rules:[]} OR functional (ctx)=>OverlayDecision)
  - returns valid OverlayDecision: {kind:'pass'|'skip_entry'|'tighten_stop'|'exit_now', ...}
  - no forbidden patterns (process.env, eval, fetch, import, require)
  0 = violates SDK contract. 1 = fully compliant.

Dimension: param_specificity (0–1)
  Are thresholds and params specific (numbers, not placeholders)?
  Does the code avoid vague "TBD" / magic numbers with no rationale?
  0 = all placeholders or no meaningful params. 1 = concrete, hypothesis-justified values.
`.trim();

export interface BuilderJudgeInput {
  hypothesis: HypothesisProposal;
  output: BuilderOutput;
}

export function buildBuilderJudgePrompt(input: BuilderJudgeInput): string {
  const entrySource = input.output.files[input.output.manifest.entry] ?? '(entry file missing)';
  return [
    '--- RUBRIC START ---',
    BUILDER_JUDGE_RUBRIC,
    '--- RUBRIC END ---',
    '',
    '--- HYPOTHESIS START ---',
    `Thesis: ${input.hypothesis.thesis}`,
    `Target behavior: ${input.hypothesis.targetBehavior}`,
    `Applies to: ${input.hypothesis.ruleAction.appliesTo}`,
    `Expected effect: ${input.hypothesis.expectedEffect.metric} should ${input.hypothesis.expectedEffect.direction}`,
    `Rules: ${JSON.stringify(input.hypothesis.ruleAction.rules, null, 2)}`,
    '--- HYPOTHESIS END ---',
    '',
    '--- MANIFEST START ---',
    JSON.stringify(input.output.manifest, null, 2),
    '--- MANIFEST END ---',
    '',
    '--- GENERATED CODE (index.ts) START ---',
    entrySource,
    '--- GENERATED CODE END ---',
    '',
    'Return a structured judge verdict scoring the generated code against the rubric.',
  ].join('\n');
}

export async function runBuilderJudge(agent: Agent, input: BuilderJudgeInput): Promise<BuilderJudgeVerdict> {
  const result = await agent.generate(buildBuilderJudgePrompt(input), {
    structuredOutput: { schema: BuilderJudgeVerdictSchema },
  });
  return BuilderJudgeVerdictSchema.parse(result.object);
}
