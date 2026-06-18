import { z } from 'zod';
import type { WorkflowHandler } from '../workflow-router.ts';
import { validateWithSchema } from '../../validation/validator.ts';
import { resumePlatformRun } from './resume-platform-backtest.ts';
import { event, errMsg } from './backtest-support.ts';

export const BacktestResumePayloadSchema = z.object({
  platformRunId: z.string().min(1),
  backtestRunId: z.string().min(1).optional(),
});

export const backtestResumeHandler = (): WorkflowHandler => async (task, services) => {
  const validation = validateWithSchema(BacktestResumePayloadSchema, task.payload);
  if (validation.status === 'invalid') {
    await services.events.append(event(task.id, 'backtest.resume.rejected', { issues: validation.issues }));
    return;
  }
  const payload = validation.data;

  const run = payload.backtestRunId
    ? await services.backtests.findById(payload.backtestRunId)
    : await services.backtests.findByPlatformRunId(payload.platformRunId);
  if (!run) {
    await services.events.append(event(task.id, 'backtest.resume.skipped', { reason: 'run_not_found', platformRunId: payload.platformRunId }));
    return;
  }

  try {
    const outcome = await resumePlatformRun(services, run);
    await services.events.append(event(task.id, 'backtest.resume.outcome', { ...outcome }));
  } catch (err) {
    await services.events.append(event(task.id, 'backtest.resume.error', { platformRunId: payload.platformRunId, error: errMsg(err) }));
    throw err;
  }
};
