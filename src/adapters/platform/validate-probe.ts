import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventRepository } from '../../ports/agent-event.repository.ts';
import type { ResearchPlatformPort, ValidationReport } from '../../ports/research-platform.port.ts';
import type { ModuleBundle } from '../../domain/module-bundle.ts';
import { ContractIncompatibleError } from './research-contract.ts';

export interface ValidateProbeDeps {
  platform: ResearchPlatformPort;
  events: AgentEventRepository;
  probeId: string;
  integration: string;
  bundle: ModuleBundle;
  dataNeeds?: object;
}

export interface ValidateProbeResult {
  report: ValidationReport;
}

function mkEvent(taskId: string, type: string, payload: Record<string, unknown>): AgentEvent {
  return { id: randomUUID(), taskId, type, payload, createdAt: new Date().toISOString() };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runValidateProbe(deps: ValidateProbeDeps): Promise<ValidateProbeResult> {
  const { platform, events, probeId, integration, bundle, dataNeeds } = deps;
  await events.append(mkEvent(probeId, 'platform.validate.started', {
    integration, bundleHash: bundle.bundleHash, moduleId: bundle.manifest.moduleId,
  }));

  // Fail-closed contract gate (discover() asserts contract compatibility inside the adapter).
  try {
    await platform.discover();
  } catch (err) {
    if (err instanceof ContractIncompatibleError) {
      await events.append(mkEvent(probeId, 'platform.contract.incompatible', {
        expected: err.expected, actual: err.actual, supported: [...err.supported],
      }));
    }
    await events.append(mkEvent(probeId, 'platform.validate.failed', { error: errMsg(err) }));
    throw err;
  }

  let report: ValidationReport;
  try {
    report = await platform.validateModule(bundle, dataNeeds !== undefined ? { dataNeeds } : undefined);
  } catch (err) {
    await events.append(mkEvent(probeId, 'platform.validate.failed', { error: errMsg(err) }));
    throw err;
  }

  const errorCount = report.issues.filter((i) => i.severity === 'error').length;
  const warningCount = report.issues.filter((i) => i.severity === 'warning').length;
  await events.append(mkEvent(probeId, 'platform.validate.completed', { status: report.status, errorCount, warningCount }));
  if (report.status === 'rejected') {
    await events.append(mkEvent(probeId, 'platform.validate.rejected', { errorCount }));
  }
  return { report };
}
