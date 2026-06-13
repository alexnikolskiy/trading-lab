import type { ChatSessionContext, ChatSessionRepository } from '../../ports/chat-session.repository.ts';

export class InMemoryChatSessionRepository implements ChatSessionRepository {
  private readonly byId = new Map<string, ChatSessionContext>();

  async get(sessionId: string): Promise<ChatSessionContext | null> {
    const found = this.byId.get(sessionId);
    return found ? { ...found } : null;
  }

  async upsert(ctx: ChatSessionContext): Promise<void> {
    this.byId.set(ctx.sessionId, { ...ctx });
  }
}
