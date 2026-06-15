// scripts/platform-run.ts
// platform:run — submitted_overlay run lifecycle probe. No runtime boot, no DB.
// Usage: platform:run <bundle.json|-> <runconfig.json>  (run config: {datasetId,symbols,timeframe,period,seed,baselineModuleRef})
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  loadResearchPlatformConfig, createGatewayTransport, withTimeout,
  type GatewaySession,
} from '../src/adapters/platform/mcp-research-transport.ts';
import { McpResearchPlatformAdapter } from '../src/adapters/platform/mcp-research-platform.adapter.ts';
import { ConsoleAgentEventSink } from '../src/adapters/platform/console-agent-event-sink.ts';
import { runBacktestProbe } from '../src/adapters/platform/run-probe.ts';
import type { ModuleBundle } from '../src/domain/module-bundle.ts';
import type { SubmitOverlayRunOptions } from '../src/ports/research-platform.port.ts';

function readJson<T>(arg: string | undefined): T {
  const raw = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  return JSON.parse(raw) as T;
}

async function main(): Promise<void> {
  const bundle = readJson<ModuleBundle>(process.argv[2]);
  const opts = readJson<SubmitOverlayRunOptions>(process.argv[3]);
  const config = loadResearchPlatformConfig(process.env);
  const events = new ConsoleAgentEventSink();
  const probeId = `probe:${randomUUID()}`;
  let session: GatewaySession | undefined;
  try {
    const result = await withTimeout((async () => {
      session = await createGatewayTransport(config);
      const platform = new McpResearchPlatformAdapter(session.transport, config.expectedContractVersion);
      return runBacktestProbe({ platform, events, probeId, integration: 'mcp', bundle, opts, poll: { maxPolls: 30, pollDelayMs: 2000 } });
    })(), config.discoveryTimeoutMs, 'platform:run');
    process.stdout.write(`${JSON.stringify({ outcome: result.outcome.status, comparison: result.comparison }, null, 2)}\n`);
  } finally {
    if (session) await session.close();
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  process.stderr.write(`platform:run failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
