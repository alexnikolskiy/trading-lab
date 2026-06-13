import { describe, it, expect } from 'vitest';
import { ChatIntentSchema, ALLOWED_INTENTS } from './intent.ts';

describe('ChatIntentSchema', () => {
  it('accepts every allowed intent', () => {
    for (const intent of ALLOWED_INTENTS) {
      const r = ChatIntentSchema.safeParse({ intent, confidence: 0.9 });
      expect(r.success).toBe(true);
    }
  });

  it('rejects an unknown intent', () => {
    const r = ChatIntentSchema.safeParse({ intent: 'transfer.funds', confidence: 0.9 });
    expect(r.success).toBe(false);
  });

  it('rejects unexpected top-level keys (strict)', () => {
    const r = ChatIntentSchema.safeParse({ intent: 'help', confidence: 0.9, tool: 'shell' });
    expect(r.success).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(ChatIntentSchema.safeParse({ intent: 'help', confidence: 1.5 }).success).toBe(false);
    expect(ChatIntentSchema.safeParse({ intent: 'help', confidence: -0.1 }).success).toBe(false);
  });

  it('keeps optional extracted fields when present', () => {
    const r = ChatIntentSchema.safeParse({
      intent: 'strategy.onboard', confidence: 0.8,
      strategyText: 'go long on oi spike', requestedOutcome: 'research', entityRef: 'from_message_text',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.requestedOutcome).toBe('research');
  });
});
