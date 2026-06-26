import type { Agent } from '@mastra/core/agent';
import type { StrategyCriticPort, AgentCallOpts } from '../../ports/strategy-critic.port.ts';
import {
  StrategyRefinementSchema,
  type StrategyCriticInput,
  type StrategyRefinement,
} from '../../domain/strategy-critic.ts';

function buildPrompt(input: StrategyCriticInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  return `${header}\n\n--- STRATEGY START ---\n${input.content}\n--- STRATEGY END ---\n\nCritique this strategy AND return an improved version.`;
}

export class SingleStageStrategyCritic implements StrategyCriticPort {
  readonly adapter = 'mastra' as const;
  readonly mode = 'single' as const;
  readonly model: string;
  private readonly agent: Agent;

  constructor(agent: Agent, model: string) {
    this.agent = agent;
    this.model = model;
  }

  async refine(input: StrategyCriticInput, opts?: AgentCallOpts): Promise<StrategyRefinement> {
    const result = await this.agent.generate(buildPrompt(input), {
      structuredOutput: { schema: StrategyRefinementSchema },
    });
    await opts?.onUsage?.({
      modelId: this.model,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: result.usage?.totalTokens ?? 0,
    });
    return StrategyRefinementSchema.parse(result.object);
  }
}
