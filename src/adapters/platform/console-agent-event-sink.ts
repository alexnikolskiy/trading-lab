import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';

/** DB-free AgentEvent sink for the platform:discover CLI: prints each event and keeps an in-memory log. */
export class ConsoleAgentEventSink implements AgentEventRepository {
  private readonly events: AgentEvent[] = [];

  async append(event: AgentEvent): Promise<void> {
    this.events.push(event);
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  async listByTask(taskId: string): Promise<AgentEvent[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }
}
