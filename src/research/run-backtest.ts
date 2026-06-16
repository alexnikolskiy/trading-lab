import { isTerminal } from '../ports/research-platform.port.ts';
import type { ResearchPlatformPort, SubmitOverlayRunOptions, RunResultSummary } from '../ports/research-platform.port.ts';
import type { ModuleBundle } from '../domain/module-bundle.ts';

export interface PollOptions {
  readonly maxPolls: number;
  readonly pollDelayMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type PlatformRunOutcome =
  | { readonly status: 'completed'; readonly runId: string; readonly summary: RunResultSummary; readonly artifactIds: readonly string[] }
  | { readonly status: 'pending'; readonly runId: string }
  | { readonly status: 'rejected'; readonly runId: string; readonly terminalCode?: string };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pollOverlayRun(
  platform: ResearchPlatformPort,
  runId: string,
  poll: PollOptions,
): Promise<PlatformRunOutcome> {
  const sleep = poll.sleep ?? realSleep;
  let terminal = false;
  for (let i = 0; i < poll.maxPolls; i += 1) {
    const view = await platform.getRunStatus(runId);
    if (isTerminal(view.status)) { terminal = true; break; }
    if (i < poll.maxPolls - 1) await sleep(poll.pollDelayMs);
  }
  if (!terminal) return { status: 'pending', runId };

  const res = await platform.getRunResult(runId);
  if (res.kind === 'summary' && res.summary.status === 'completed' && res.summary.comparison !== undefined) {
    return { status: 'completed', runId, summary: res.summary, artifactIds: res.summary.artifactRefs.map((r) => r.artifactId) };
  }
  const terminalCode = res.kind === 'status' ? res.view.terminalCode : undefined;
  return { status: 'rejected', runId, ...(terminalCode !== undefined ? { terminalCode } : {}) };
}

export async function runOverlayBacktest(
  platform: ResearchPlatformPort,
  bundle: ModuleBundle,
  opts: SubmitOverlayRunOptions,
  poll: PollOptions,
): Promise<PlatformRunOutcome> {
  const handle = await platform.submitOverlayRun(bundle, opts);
  return pollOverlayRun(platform, handle.runId, poll);
}
