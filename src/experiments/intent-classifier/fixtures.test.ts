// src/experiments/intent-classifier/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import { loadCases, resolveDataset, fingerprintCases, DATASETS, EvalCaseSchema } from './fixtures.ts';
import { ALLOWED_INTENTS } from '../../chat/intent.ts';

describe('dataset resolution', () => {
  it('resolves the default dataset id', () => {
    expect(resolveDataset('chat-intents-v1')).toBe(DATASETS['chat-intents-v1']);
  });

  it('throws on an unknown dataset id', () => {
    expect(() => resolveDataset('nope')).toThrow(/unknown dataset/);
  });
});

describe('loadCases — chat-intents-v1', () => {
  const cases = loadCases('chat-intents-v1');

  it('loads a non-empty, schema-valid case set', () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
    for (const c of cases) expect(() => EvalCaseSchema.parse(c)).not.toThrow();
  });

  it('every expected intent is one of ALLOWED_INTENTS', () => {
    for (const c of cases) expect(ALLOWED_INTENTS).toContain(c.expect.intent);
  });

  it('covers all 9 allowed intents at least once', () => {
    const covered = new Set(cases.map((c) => c.expect.intent));
    for (const intent of ALLOWED_INTENTS) expect(covered).toContain(intent);
  });

  it('contains both RU and EN replies', () => {
    const langs = new Set(cases.map((c) => c.lang));
    expect(langs).toContain('ru');
    expect(langs).toContain('en');
  });

  it('has unique case ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('fingerprintCases', () => {
  it('is sha256-prefixed and stable for identical input', () => {
    const cases = loadCases('chat-intents-v1');
    const fp = fingerprintCases(cases);
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintCases(cases)).toBe(fp);
  });
});
