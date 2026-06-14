import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONTRACT_VERSION } from '@trading-platform/sdk';
import type { GatewayTransport } from '@trading-platform/sdk/agent';

export interface ResearchPlatformConfig {
  command: string;
  args: string[];
  gatewayConfigPath?: string;
  discoveryTimeoutMs: number;
  expectedContractVersion: string;
}

export interface GatewaySession {
  transport: GatewayTransport;
  close(): Promise<void>;
}

export function loadResearchPlatformConfig(source: NodeJS.ProcessEnv): ResearchPlatformConfig {
  const command = source.TRADING_PLATFORM_GATEWAY_COMMAND;
  if (!command) throw new Error('TRADING_PLATFORM_GATEWAY_COMMAND is required for mcp integration');
  const rawArgs = source.TRADING_PLATFORM_GATEWAY_ARGS ?? '';
  const args = rawArgs.split(/\s+/).filter((a) => a.length > 0);
  const timeout = Number(source.TRADING_PLATFORM_DISCOVERY_TIMEOUT_MS);
  return {
    command,
    args,
    gatewayConfigPath: source.TRADING_PLATFORM_GATEWAY_CONFIG || undefined,
    discoveryTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
    expectedContractVersion: source.TRADING_PLATFORM_EXPECTED_CONTRACT || CONTRACT_VERSION,
  };
}

/** Inherit the parent env (defined string entries only) + inject MCP_GATEWAY_CONFIG for the child. */
export function buildChildEnv(config: ResearchPlatformConfig, base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string') env[k] = v;
  }
  if (config.gatewayConfigPath) env.MCP_GATEWAY_CONFIG = config.gatewayConfigPath;
  return env;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Prefer structuredContent; else parse the concatenated text content blocks as JSON; else return raw content. */
export function extractToolResult(result: { structuredContent?: unknown; content?: unknown }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('');
    if (text.length > 0) return JSON.parse(text);
  }
  return content;
}

/** Spawn the gateway over stdio and wrap it as a GatewayTransport. Caller owns close(). */
export async function createGatewayTransport(config: ResearchPlatformConfig): Promise<GatewaySession> {
  const stdio = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: buildChildEnv(config, process.env),
  });
  const client = new Client({ name: 'trading-lab', version: '0.0.1' });
  await client.connect(stdio);
  const transport: GatewayTransport = {
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> });
      // callTool returns a union that includes a legacy `{ toolResult }` shape;
      // narrow to the `{ content?, structuredContent? }` view extractToolResult reads.
      return extractToolResult(result as { structuredContent?: unknown; content?: unknown });
    },
  };
  return {
    transport,
    close: async () => { await client.close(); },
  };
}
