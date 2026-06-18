import { composeMastra, type MastraCompositionEnv } from '../../mastra/compose-mastra.ts';
import { MastraResearcher } from '../../adapters/researcher/mastra-researcher.ts';
import type { ModelProviderEnv } from '../../adapters/llm/model-provider.ts';
import type { ResearcherPort } from '../../ports/researcher.port.ts';

export function buildRealResearcherFor(baseEnv: ModelProviderEnv): (modelId: string) => ResearcherPort {
  return (modelId: string) => {
    const env: MastraCompositionEnv = {
      ...baseEnv,
      STRATEGY_ANALYST_ADAPTER: 'fake',
      STRATEGY_ANALYST_MODEL: 'fake',
      RESEARCHER_ADAPTER: 'mastra',
      RESEARCHER_MODEL: modelId,
      CRITIC_ADAPTER: 'fake',
      CRITIC_MODEL: 'fake',
      ENABLE_CRITIC_AGENT: false,
      INTENT_CLASSIFIER_ADAPTER: 'fake',
      INTENT_CLASSIFIER_MODEL: 'fake',
      BUILDER_ADAPTER: 'fake',
      BUILDER_MODEL: 'fake',
    };
    const runtime = composeMastra(env);
    const entry = runtime.agents.researcher;
    if (!entry) throw new Error('researcher agent was not composed (check RESEARCHER_ADAPTER)');
    return new MastraResearcher(entry.agent, entry.label);
  };
}
