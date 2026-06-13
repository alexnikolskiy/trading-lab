import { describe, it, expect } from 'vitest';
import { ChatMessageRequestSchema } from './request.ts';

describe('ChatMessageRequestSchema', () => {
  it('accepts a minimal message and defaults channel to web', () => {
    const r = ChatMessageRequestSchema.safeParse({ message: 'покажи статус' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.channel).toBe('web');
  });

  it('accepts an explicit sessionId and telegram channel', () => {
    const r = ChatMessageRequestSchema.safeParse({ message: 'hi', sessionId: 's1', channel: 'telegram' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.sessionId).toBe('s1');
  });

  it('rejects an empty message', () => {
    expect(ChatMessageRequestSchema.safeParse({ message: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only message (trimmed to empty)', () => {
    expect(ChatMessageRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(ChatMessageRequestSchema.safeParse({ message: '\n\t  ' }).success).toBe(false);
  });

  it('trims surrounding whitespace on a valid message', () => {
    const r = ChatMessageRequestSchema.safeParse({ message: '  покажи статус  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.message).toBe('покажи статус');
  });

  it('rejects an unknown channel', () => {
    expect(ChatMessageRequestSchema.safeParse({ message: 'x', channel: 'sms' }).success).toBe(false);
  });
});
