import type { Agent } from '@mastra/core/agent';
import type { IntentClassifierPort } from '../../ports/intent-classifier.port.ts';
import { ChatIntentSchema } from '../../chat/intent.ts';

function buildPrompt(message: string): string {
  return `Classify the following user message.\n\n--- USER MESSAGE START ---\n${message}\n--- USER MESSAGE END ---\n\nReturn the structured intent.`;
}

/** Best-effort recovery of the raw model JSON from the unstructured text channel. */
function parseRawText(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  return text; // last resort: hand the raw string back; the ChatIntentSchema gate marks it invalid
}

export interface MastraIntentClassifierOptions {
  /**
   * How the structured output is validated.
   * - `'strict'` (default) — PRODUCTION behaviour, unchanged: Mastra validates against
   *   ChatIntentSchema inside generate() and throws STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED on
   *   any deviation.
   * - `'raw'` — EVAL only: `errorStrategy: 'warn'` makes generate() log + continue instead of
   *   throwing, and classify() returns the raw model output (recovered from `result.text` when a
   *   deviation leaves `result.object` empty). The harness/guard's ChatIntentSchema gate stays the
   *   single trust boundary, so a deviation is scored as a per-case schema-invalid miss with the
   *   model's intent still visible — never a bald throw that kills the run.
   */
  schemaValidation?: 'strict' | 'raw';
}

export class MastraIntentClassifier implements IntentClassifierPort {
  readonly adapter = 'mastra' as const;
  readonly model: string;
  private readonly agent: Agent;
  private readonly schemaValidation: 'strict' | 'raw';

  constructor(agent: Agent, label: string, options: MastraIntentClassifierOptions = {}) {
    this.agent = agent;
    this.model = label;
    this.schemaValidation = options.schemaValidation ?? 'strict';
  }

  async classify(message: string): Promise<unknown> {
    if (this.schemaValidation === 'strict') {
      // PRODUCTION path — Mastra validates inside generate(); the guard re-validates downstream.
      const result = await this.agent.generate(buildPrompt(message), {
        structuredOutput: { schema: ChatIntentSchema },
      });
      // Return raw object; the guard's schema gate is the trust boundary.
      return result.object;
    }

    // EVAL path — never let Mastra's internal zod gate throw; the harness re-validates.
    const result: { object?: unknown; text?: unknown } = await this.agent.generate(buildPrompt(message), {
      structuredOutput: { schema: ChatIntentSchema, errorStrategy: 'warn' },
    });
    return result.object != null ? result.object : parseRawText(result.text);
  }
}
