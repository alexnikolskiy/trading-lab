// src/experiments/intent-classifier/fixtures.ts
// Loads + validates the labelled chat-intent datasets shipped under __fixtures__/.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ALLOWED_INTENTS } from '../../chat/intent.ts';
import type { EvalCase } from './types.ts';

const DIR = 'src/experiments/intent-classifier/__fixtures__';

export const EvalCaseSchema = z
  .object({
    id: z.string().min(1),
    lang: z.enum(['ru', 'en']),
    message: z.string().min(1),
    expect: z
      .object({
        intent: z.enum(ALLOWED_INTENTS),
        requestedOutcome: z.enum(['onboard', 'research', 'build_backtest', 'status', 'results']).optional(),
        entityRef: z.enum(['last_strategy', 'last_hypothesis', 'last_backtest', 'from_message_text']).optional(),
        hasStrategyText: z.boolean().optional(),
        hasHypothesisText: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const DatasetSchema = z.array(EvalCaseSchema);

export const DATASETS: Record<string, string> = {
  'chat-intents-v1': `${DIR}/chat-intents-v1.json`,
};

export function resolveDataset(id: string): string {
  const path = DATASETS[id];
  if (!path) throw new Error(`unknown dataset "${id}" (known: ${Object.keys(DATASETS).join(', ')})`);
  return path;
}

export function loadCases(id: string): EvalCase[] {
  const path = resolveDataset(id);
  const cases = DatasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`duplicate case id "${c.id}" in dataset ${id}`);
    seen.add(c.id);
  }
  return cases;
}

export function fingerprintCases(cases: EvalCase[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(cases), 'utf8').digest('hex')}`;
}
