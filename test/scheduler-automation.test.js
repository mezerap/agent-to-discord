import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function model(id, efforts = ['low', 'high']) {
  return { model: id, effort: efforts[0] || null, efforts: efforts.map(effort => ({ effort })) };
}

function fixture({ jobOverrides = {}, recordOverrides = {}, rpc, startTurn } = {}) {
  let now = 10_000;
  const calls = [], saved = [];
  const job = { id: 'job', title: 'Daily', prompt: 'Make report', discordId: 'channel', codexId: 'codex',
    schedule: { type: 'interval', minutes: 60 }, nextRun: 9_000, status: 'enabled', contextPending: false,
    execution: { model: 'gpt-sol', effort: 'high' }, notificationMode: 'always', workspace: { projectId: 'sports', cwd: '/workspace/sports' }, runs: [], ...jobOverrides };
  const record = { codexId: 'codex', discordId: 'channel', kind: 'automation', scheduleId: 'job', active: false, ...recordOverrides };
  const state = { schedules: { job }, threads: { 'automation:job': record }, toolResults: {} };
  const bridge = {
    ready: true, closing: false, config: { channelId: 'main', workspace: '/workspace' }, store: { state, save: async () => { saved.push(JSON.parse(JSON.stringify(state))); } },
    cleanup: { isDeleted: () => false, hold: () => () => {}, remove: async () => {}, readThread: async () => ({ turns: [] }) },
    queue: { has: () => false }, busy: new Set(),
    delivery: null,
    discord: { channels: { fetch: async id => id === 'channel' ? { send: async () => {} } : null } },
    models: { turnSettings: () => ({ model: 'gpt-luna', effort: 'low' }), list: async () => [model('gpt-sol'), model('gpt-luna')] },
    workspaceSnapshot: () => ({ projectId: 'sports', cwd: '/workspace/sports' }),
    projects: { resolveSettings: async (_channelId, { workspace }) => ({ cwd: workspace.cwd }) },
    threadSettings: (_channelId, target) => ({ cwd: target?.workspace?.cwd || '/workspace', model: 'gpt-luna' }),
    newThreadSettings: () => ({ cwd: '/workspace', dynamicTools: ['tool'] }),
    record: id => Object.values(state.threads).find(item => item.codexId === id),
    rpc: { call: async (method, params) => { calls.push({ method, params }); return rpc ? rpc(method, params, record) : {}; } },
    startTurn: async (...args) => { calls.push({ method: 'startTurn', args }); await startTurn?.(...args); },
  };
  const scheduler = new Scheduler(bridge, () => now);
  return { bridge, scheduler, job, record, calls, saved, setNow: value => { now = value; } };
}

test('scheduled run snapshots and revalidates its pinned model and effort before resume/start', async () => {
  const f = fixture();
  await f.scheduler.runDue();
  assert.deepEqual(f.calls.find(call => call.method === 'thread/resume').params, {
    threadId: 'codex', cwd: '/workspace/sports', model: 'gpt-sol',
  });
  const started = f.calls.find(call => call.method === 'startTurn').args;
  assert.deepEqual(started[3], { settings: { model: 'gpt-sol', effort: 'high' } });
  assert.deepEqual(f.job.runs[0].execution, { model: 'gpt-sol', effort: 'high' });
  assert.equal(f.job.runs[0].notificationMode, 'always');
  const metadata = started[1][0].text.match(/Bridge metadata pro evidenci souborů .*: (\{[^\n]+\})/);
  assert.deepEqual(JSON.parse(metadata[1]), { automationId: 'job', runId: f.job.runs[0].id });
  assert.equal(f.job.nextRun, 3_610_000);
});

test('unsupported pinned model is recorded as attention without resuming the thread', async () => {
  const f = fixture({ jobOverrides: { execution: { model: 'removed', effort: 'high' } } });
  await f.scheduler.runDue();
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.job.status, 'attention');
  assert.equal(f.job.runs[0].status, 'failed');
  assert.equal(f.job.runs[0].failure.phase, 'model');
});

test('invalid saved workspace blocks resume before any remote conversation change', async () => {
  const f = fixture();
  f.bridge.projects.resolveSettings = async () => { throw new Error('workspace is no longer allowed'); };
  await f.scheduler.runDue();
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.job.status, 'attention');
  assert.equal(f.job.runs[0].failure.phase, 'workspace');
});

test('manual run can run a paused job without changing its saved cadence or status', async () => {
  const f = fixture({ jobOverrides: { status: 'paused', nextRun: 1234, pendingRun: { id: 'manual', requestedAt: 8000 } } });
  await f.scheduler.runDue();
  assert.equal(f.job.nextRun, 1234);
  assert.equal(f.job.status, 'paused');
  assert.equal(f.job.pendingRun, undefined);
  assert.equal(f.job.runs[0].kind, 'manual');
});

test('manual tool request key survives before claim so a retry cannot queue another run', async () => {
  const f = fixture();
  const first = await f.scheduler.requestRun('job', 'channel', 'thread:call');
  const retry = await f.scheduler.requestRun('job', 'channel', 'thread:call');
  assert.deepEqual(first, retry);
  assert.equal(f.job.pendingRun.requestKey, 'thread:call');
  assert.equal(f.job.runs.length, 0);
  await f.scheduler.runDue();
  const afterClaimRetry = await f.scheduler.requestRun('job', 'channel', 'thread:call');
  assert.equal(afterClaimRetry.runId, f.job.runs[0].id);
  assert.equal(f.job.runs.length, 1);
});

test('create tool stores workspace snapshot and persists its receipt before returning', async () => {
  const f = fixture();
  f.record.runKind = 'user';
  const params = { threadId: 'codex', callId: 'create-call', turnId: 'turn', arguments: {
    action: 'create', title: 'Created job', prompt: 'Check report', schedule: { type: 'interval', minutes: 60 },
    execution: { model: 'gpt-sol', effort: 'high' }, notificationMode: 'always',
  } };
  const created = await f.scheduler.tool(f.record, params);
  const job = f.bridge.store.state.schedules[created.id];
  assert.deepEqual(job.workspace, { projectId: 'sports', cwd: '/workspace/sports' });
  assert.equal(f.bridge.store.state.toolResults['codex:create-call'].id, created.id);
  assert.deepEqual(await f.scheduler.tool(f.record, params), created);
  assert.equal(Object.keys(f.bridge.store.state.schedules).length, 2);
});

test('fresh-context job creates its own Codex thread with the saved workspace', async () => {
  const f = fixture({ jobOverrides: { contextMode: 'fresh', contextPending: true, codexId: undefined, sourceId: undefined } });
  f.bridge.rpc.call = async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'fresh-codex' } };
    if (method === 'thread/resume') throw Object.assign(new Error('no rollout found for zero-turn thread'), { code: -32600 });
    return {};
  };
  f.bridge.record = id => Object.values(f.bridge.store.state.threads).find(item => item.codexId === id);
  f.bridge.startTurn = async (...args) => {
    f.calls.push({ method: 'startTurn', args });
    delete args[0].freshUnstarted;
  };
  await f.scheduler.runDue();
  assert.equal(f.job.codexId, 'fresh-codex');
  assert.deepEqual(f.calls.find(call => call.method === 'thread/start').params, {
    cwd: '/workspace/sports', dynamicTools: ['tool'], model: 'gpt-sol',
  });
  assert.equal(f.calls.find(call => call.method === 'startTurn').args[0].codexId, 'fresh-codex');
  assert.deepEqual(f.calls.find(call => call.method === 'startTurn').args[3], {
    settings: { model: 'gpt-sol', effort: 'high' },
  });
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.bridge.record('fresh-codex').freshUnstarted, undefined);
});

test('fresh-context thread is not created before its first due or manual run', async () => {
  const f = fixture({ jobOverrides: { contextMode: 'fresh', contextPending: true, codexId: undefined,
    sourceId: undefined, nextRun: 20_000 } });

  await f.scheduler.runDue();

  assert.equal(f.job.contextPending, true);
  assert.equal(f.job.codexId, undefined);
  assert.equal(f.calls.some(call => call.method === 'thread/start'), false);
  assert.equal(f.job.runs.length, 0);
});

test('fresh-context marker survives restart and ambiguous first-turn start without recreation', async () => {
  const f = fixture({ jobOverrides: { contextMode: 'fresh', contextPending: true, codexId: undefined,
    sourceId: undefined, nextRun: 20_000 } });
  f.bridge.rpc.call = async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'fresh-codex' } };
    if (method === 'thread/resume') throw Object.assign(new Error('no rollout found for zero-turn thread'), { code: -32600 });
    return {};
  };
  await f.scheduler.prepare(f.job);
  const record = f.bridge.record('fresh-codex');
  assert.equal(record.freshUnstarted, true);

  f.job.pendingRun = { id: 'manual-after-restart', requestedAt: 15_000 };
  const restartedScheduler = new Scheduler(f.bridge, () => 16_000);
  f.bridge.startTurn = async current => {
    current.active = false;
    current.uncertain = true;
    throw new Error('connection lost while starting first turn');
  };
  await restartedScheduler.runDue();

  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.job.status, 'attention');
  assert.equal(record.freshUnstarted, true);
  assert.equal(record.uncertain, true);
  assert.equal(f.job.runs[0].failure.phase, 'start');
});

test('stale fresh preparation claim enters attention and cannot be bypassed by a manual run', async () => {
  const f = fixture({ jobOverrides: { contextMode: 'fresh', contextPending: true, preparing: true,
    codexId: undefined, sourceId: undefined, pendingRun: { id: 'manual', requestedAt: 9_500 } } });

  await f.scheduler.runDue();

  assert.equal(f.job.status, 'attention');
  assert.equal(f.job.contextPending, true);
  assert.equal(f.calls.some(call => call.method === 'thread/start'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.calls.some(call => call.method === 'startTurn'), false);
});

test('missing saved automation context enters attention instead of creating a replacement', async () => {
  const f = fixture({ jobOverrides: { codexId: 'missing-codex', contextPending: false } });
  f.bridge.store.state.threads = {};
  f.bridge.record = () => undefined;

  await f.scheduler.runDue();

  assert.equal(f.job.status, 'attention');
  assert.equal(f.job.lastFailure.phase, 'context');
  assert.equal(f.calls.some(call => call.method === 'thread/start'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(f.calls.some(call => call.method === 'startTurn'), false);
});

test('failed resume claims once and a subsequent check never repeats the run', async () => {
  const f = fixture({ rpc: async method => { if (method === 'thread/resume') throw new Error('resume failed'); } });
  await f.scheduler.runDue();
  await f.scheduler.runDue();
  assert.equal(f.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(f.job.status, 'attention');
  assert.equal(f.job.runs[0].status, 'failed');
});

test('run result writes require the current active scheduled turn', async () => {
  const f = fixture({ recordOverrides: { active: false, automationRunId: 'old-run', runKind: 'user' } });
  f.job.runs = [{ id: 'old-run', status: 'completed' }];
  assert.equal(await f.scheduler.setRunResult(f.record, { key: 'daily', status: 'ok' }), null);
  f.record.runKind = 'scheduled';
  f.record.active = true;
  const run = { id: 'current-run', status: 'running' };
  f.job.runs.unshift(run);
  f.record.automationRunId = run.id;
  const result = await f.scheduler.setRunResult(f.record, { key: 'daily', status: 'ok', summary: 'All good' });
  assert.equal(result, run);
  assert.equal(run.resultChanged, true);
  await f.scheduler.deliveryStatus(f.record, 'sent');
  assert.equal(f.job.lastNotifiedSignature, run.result.signature);
});
