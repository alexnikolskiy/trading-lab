import { describe, it, expect, vi } from 'vitest';
import { ConsoleAgentEventSink } from './console-agent-event-sink.ts';

describe('ConsoleAgentEventSink', () => {
  it('buffers appended events and lists them by task', async () => {
    const sink = new ConsoleAgentEventSink();
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await sink.append({ id: '1', taskId: 'probe:a', type: 'x', payload: {}, createdAt: 'now' });
    await sink.append({ id: '2', taskId: 'probe:b', type: 'y', payload: {}, createdAt: 'now' });
    expect(await sink.listByTask('probe:a')).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(2);
    write.mockRestore();
  });
});
