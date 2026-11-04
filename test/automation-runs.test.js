import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, finishRun, markRunResult, recoverRuns, runHistory, setRunDelivery, shouldNotify } from '../src/automation-runs.js';

test('run history stays bounded and keeps execution and delivery status separate', () => {
  const job = { runs: [] };
  const first = createRun(job, { now: 100, execution: { model: 'gpt-sol', effort: 'high' } });
  first.status = 'running';
  finishRun(job, first.id, { id: 'turn-1', status: 'completed' }, 200);
  setRunDelivery(job, first.id, 'sent');
  assert.equal(first.status, 'completed');
  assert.equal(first.deliveryStatus, 'sent');
  assert.deepEqual(first.execution, { model: 'gpt-sol', effort: 'high' });
  for (let i = 0; i < 35; i++) createRun(job, { now: 300 + i });
  assert.equal(job.runs.length, 30);
  assert.equal(runHistory(job).length, 30);
});

test('recovery marks an in-flight run interrupted without retrying it', () => {
  const job = { runs: [] };
  const run = createRun(job, { now: 10 });
  assert.equal(recoverRuns(job, 20), true);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.failure.phase, 'restart');
  assert.equal(run.deliveryStatus, 'unknown');
  assert.equal(recoverRuns(job, 30), false);
});

test('recovery marks completion with an unconfirmed Discord delivery as unknown', () => {
  const job = { runs: [] };
  const run = createRun(job);
  finishRun(job, run.id, { id: 'turn-1', status: 'completed' });
  assert.equal(recoverRuns(job), true);
  assert.equal(run.status, 'completed');
  assert.equal(run.deliveryStatus, 'unknown');
});

test('change notification mode suppresses only completed unchanged results', () => {
  const job = { notificationMode: 'change' };
  const run = createRun(job);
  finishRun(job, run.id, { id: 'turn-1', status: 'completed' });
  markRunResult(job, run.id, false);
  assert.equal(shouldNotify(job, run), false);
  markRunResult(job, run.id, true);
  assert.equal(shouldNotify(job, run), true);
  run.status = 'failed';
  assert.equal(shouldNotify(job, run), true);
  job.notificationMode = 'always';
  run.status = 'completed';
  markRunResult(job, run.id, false);
  assert.equal(shouldNotify(job, run), false, 'changing job settings does not alter an already claimed run');
  const next = createRun(job);
  finishRun(job, next.id, { id: 'turn-2', status: 'completed' });
  markRunResult(job, next.id, false);
  assert.equal(shouldNotify(job, next), true);
});
