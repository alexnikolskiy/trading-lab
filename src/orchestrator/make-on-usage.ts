import { randomUUID } from 'node:crypto';
import type { AgentCallOpts } from '../ports/agent-call-opts.ts';
import type { AppServices } from './app-services.ts';
import type { ResearchTask } from '../domain/types.ts';

/**
 * Shared per-call cost/token accrual hook. Extracted verbatim-equivalent from the inline
 * onUsage blocks in research-run-cycle / hypothesis-build: add tokens, look up the model
 * price, accrue $ cost when priced, else emit a research.cost_unpriced audit event.
 */
export function makeOnUsage(task: ResearchTask, services: AppServices): AgentCallOpts {
  return {
    onUsage: async (u) => {
      await services.tokenUsage.add(task.correlationId, u.totalTokens);
      const price = await services.modelPricing.priceFor(u.modelId);
      if (price) {
        await services.tokenUsage.addCost(
          task.correlationId,
          u.inputTokens * price.inputUsdPerToken + u.outputTokens * price.outputUsdPerToken,
        );
      } else {
        await services.events.append({
          id: randomUUID(), taskId: task.id, type: 'research.cost_unpriced',
          payload: { modelId: u.modelId }, createdAt: new Date().toISOString(),
        });
      }
    },
  };
}
