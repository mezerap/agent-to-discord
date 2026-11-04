import { createHash, randomUUID } from 'node:crypto';
import { runFailure } from './run-failure.js';

export const AUTOMATION_RUN_LIMIT = 30;

export function createRun(job, { kind = 'scheduled', now = Date.now(), execution = null, notificationMode, requestKey } = {}) {
  const run = { id: randomUUID(), kind, status: 'starting', startedAt: now, execution: execution?.model ? { ...execution } : null,
    notificationMode: notificationMode || job.notificationMode || 'always', deliveryStatus: 'pending' };
  if (requestKey) run.requestKey = requestKey;
  job.runs ??= [];
  job.runs.unshift(run);
  trimRuns(job);
  return run;
}

export function trimRuns(job) {
  job.runs ??= [];
  if (job.runs.length > AUTOMATION_RUN_LIMIT) job.runs.length = AUTOMATION_RUN_LIMIT;
}

export function finishRun(job, runId, turn, now = Date.now()) {
  const run = findRun(job, runId);
  if (!run || run.status !== 'starting' && run.status !== 'running') return run || null;
  run.completedAt = now;
  run.turnId = turn?.id || run.turnId;
  run.status = turn?.status === 'completed' ? 'completed' : 'failed';
  if (run.status === 'failed') run.failure = runFailure(turn?.error, 'turn', now, run.turnId);
  return run;
}

export function failRun(job, runId, error, phase, now = Date.now()) {
  const run = findRun(job, runId);
  if (!run || ['completed', 'failed', 'interrupted'].includes(run.status)) return run || null;
  run.completedAt = now;
  run.status = 'failed';
  run.failure = runFailure(error, phase, now, run.turnId);
  return run;
}

export function setRunDelivery(job, runId, status, error, now = Date.now()) {
  if (!['pending', 'sent', 'failed', 'unknown', 'suppressed'].includes(status)) throw new Error('Invalid run delivery status.');
  const run = findRun(job, runId);
  if (!run) return null;
  const deliveryWasUncertain = run.deliveryStatus === 'unknown';
  run.deliveryStatus = deliveryWasUncertain && status === 'sent' ? 'unknown' : status;
  if (run.deliveryStatus === 'sent') run.deliveredAt = now;
  else delete run.deliveredAt;
  if (run.deliveryStatus === 'sent' && status === 'sent' && run.result?.signature) job.lastNotifiedSignature = run.result.signature;
  if (error) run.deliveryError = String(error).slice(0, 300);
  else if (run.deliveryStatus !== 'unknown') delete run.deliveryError;
  return run;
}

export function recoverRuns(job, now = Date.now()) {
  let changed = false;
  for (const run of job.runs || []) {
    if (run.status === 'completed' && run.deliveryStatus === 'pending') {
      run.deliveryStatus = 'unknown';
      delete run.deliveredAt;
      changed = true;
      continue;
    }
    if (run.status !== 'starting' && run.status !== 'running') continue;
    run.status = 'interrupted';
    run.completedAt = now;
    if (run.deliveryStatus === 'pending') {
      run.deliveryStatus = 'unknown';
      delete run.deliveredAt;
    }
    run.failure = runFailure(null, 'restart', now, run.turnId);
    changed = true;
  }
  return changed;
}

export function shouldNotify(job, run) {
  if (!run || run.status === 'starting' || run.status === 'running') return false;
  if (run.status !== 'completed') return true;
  if ((run.notificationMode || job.notificationMode) === 'always') return true;
  return run.resultChanged !== false;
}

export function runHistory(job) {
  return (job.runs || []).map(({ id, kind, status, startedAt, completedAt, turnId, execution, notificationMode, deliveryStatus, deliveredAt, failure, deliveryError, resultChanged, result }) =>
    ({ id, kind, status, startedAt, completedAt: completedAt ?? null, turnId: turnId ?? null, execution: execution ?? null,
      notificationMode: notificationMode || 'always', deliveryStatus: deliveryStatus || 'pending',
      deliveredAt: deliveryStatus === 'sent' && Number.isFinite(deliveredAt) ? deliveredAt : null,
      failure: failure ?? null, deliveryError: deliveryError ?? null,
      resultChanged: resultChanged ?? null, result: result ? { status: result.status, key: result.key, summary: result.summary } : null }));
}

export function markRunResult(job, runId, changed) {
  const run = findRun(job, runId);
  if (!run) return null;
  run.resultChanged = Boolean(changed);
  return run;
}

export function setRunResult(job, runId, { key, status, summary } = {}) {
  if (typeof key !== 'string' || !key.trim() || key.length > 200 || !['ok', 'problem'].includes(status) ||
    (summary !== undefined && (typeof summary !== 'string' || summary.length > 2000))) throw new Error('Invalid structured automation result.');
  const run = findRun(job, runId);
  if (!run) return null;
  const signature = createHash('sha256').update(`${status}\0${key.trim()}`).digest('hex');
  run.result = { key: key.trim(), status, summary: summary || '', signature };
  run.resultChanged = job.lastNotifiedSignature !== signature;
  return run;
}

function findRun(job, id) { return (job.runs || []).find(run => run.id === id) || null; }
