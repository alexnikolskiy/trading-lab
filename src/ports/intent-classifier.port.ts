/**
 * Advisory intent classifier. `classify` returns `unknown` on purpose: the chat
 * guard's schema gate (ChatIntentSchema) is the single trust boundary. The
 * classifier has no tools, performs no side effects, and reads no secrets.
 */
export interface IntentClassifierPort {
  readonly adapter: 'fake' | 'mastra';
  readonly model: string;
  classify(message: string): Promise<unknown>;
}
