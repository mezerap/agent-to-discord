import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';

function fixture({ deliveryFails = false, notificationMode = 'change' } = {}) {
  const messages = [];
  const channel = { id: 'thread', send: async message => { messages.push(message); return { id: `message-${messages.length}` }; } };
  const run = { id: 'run-1', kind: 'scheduled', status: 'running', startedAt: 10, turnId: 'turn-1',
    notificationMode, deliveryStatus: 'pending' };
  const record = { discordId: 'thread', codexId: 'codex', kind: 'automation', scheduleId: 'job', runKind: 'scheduled',
    automationRunId: run.id, active: true, turnId: 'turn-1' };
  const state = { threads: { 'automation:job': record }, schedules: { job: { id: 'job', discordId: 'thread', status: 'enabled',
    notificationMode, runs: [run] } }, toolResults: {}, modelPreferences: {} };
  const store = { state, save: async () => {} };
  const discord = { channels: { fetch: async () => channel }, user: { id: 'bot' } };
  const bridge = new Bridge({ guildId: 'guild', channelId: 'main', userId: 'owner', workspace: '/workspace' }, discord, { call: async () => ({}) }, store);
  bridge.cleanup.isDeleted = () => false;
  bridge.typing.stop = () => {};
  bridge.idleContext.touch = () => {};
  bridge.idleContext.warn = async () => {};
  bridge.handoff.show = async () => {};
  bridge.queue.pause = async () => {};
  bridge.queue.kick = () => {};
  bridge.deliver = async (_record, text) => {
    if (deliveryFails && text.includes('All clear')) throw new Error('Discord unavailable');
    messages.push({ content: text });
  };
  return { bridge, record, run, messages };
}

async function complete(bridge, record, run, status = 'completed') {
  await bridge.notification({ method: 'turn/completed', params: { threadId: record.codexId,
    turn: { id: run.turnId, status, ...(status === 'failed' ? { error: { codexErrorInfo: 'serverOverloaded' } } : {}) } } });
}

test('change-only automation buffers prose until completion and records the stable result key', async () => {
  const f = fixture();
  await f.bridge.notification({ method: 'item/completed', params: { threadId: 'codex', turnId: 'turn-1', item: { type: 'agentMessage', text: 'First draft' } } });
  assert.equal(f.messages.length, 0);
  await f.bridge.scheduler.setRunResult(f.record, { key: 'service:healthy', status: 'ok', summary: 'All clear' });
  await complete(f.bridge, f.record, f.run);
  assert.deepEqual(f.messages.map(item => item.content), ['First draft']);
  assert.equal(f.run.deliveryStatus, 'sent');
  assert.equal(f.bridge.store.state.schedules.job.lastNotifiedSignature, f.run.result.signature);
});

test('same verified result is suppressed but run history records both outcomes', async () => {
  const f = fixture();
  await f.bridge.scheduler.setRunResult(f.record, { key: 'service:healthy', status: 'ok', summary: 'All clear' });
  await complete(f.bridge, f.record, f.run);
  const next = { id: 'run-2', kind: 'scheduled', status: 'running', startedAt: 20, turnId: 'turn-2',
    notificationMode: 'change', deliveryStatus: 'pending' };
  f.bridge.store.state.schedules.job.runs.unshift(next);
  Object.assign(f.record, { active: true, turnId: 'turn-2', automationRunId: next.id });
  await f.bridge.scheduler.setRunResult(f.record, { key: 'service:healthy', status: 'ok', summary: 'Still clear' });
  await complete(f.bridge, f.record, next);
  assert.equal(f.messages.length, 1);
  assert.equal(next.deliveryStatus, 'suppressed');
  assert.equal(next.status, 'completed');
});

test('failed change-only runs always send the failure outcome', async () => {
  const f = fixture();
  await complete(f.bridge, f.record, f.run, 'failed');
  assert.match(f.messages.at(-1).content, /selhal/);
  assert.equal(f.run.status, 'failed');
  assert.equal(f.bridge.store.state.schedules.job.status, 'attention');
});

test('failed result delivery is marked unknown and never retried automatically', async () => {
  const f = fixture({ deliveryFails: true });
  await f.bridge.scheduler.setRunResult(f.record, { key: 'service:healthy', status: 'ok', summary: 'All clear' });
  await complete(f.bridge, f.record, f.run);
  assert.equal(f.messages.length, 0);
  assert.equal(f.run.deliveryStatus, 'unknown');
  assert.equal(f.bridge.store.state.schedules.job.lastNotifiedSignature, undefined);
});

test('always delivery records the timestamp of the latest confirmed message in a multi-message run', async () => {
  const f = fixture({ notificationMode: 'always' });
  let now = 100;
  f.bridge.scheduler.now = () => now;
  await f.bridge.notification({ method: 'item/completed', params: { threadId: 'codex', turnId: 'turn-1', item: { type: 'agentMessage', text: 'Report part one' } } });
  now = 200;
  await f.bridge.notification({ method: 'item/completed', params: { threadId: 'codex', turnId: 'turn-1', item: { type: 'agentMessage', text: 'Report part two' } } });
  await complete(f.bridge, f.record, f.run);

  const history = f.bridge.scheduler.history('thread', 'job').runs[0];
  assert.equal(history.status, 'completed');
  assert.equal(history.deliveryStatus, 'sent');
  assert.equal(history.deliveredAt, 200);
});

test('unknown message delivery cannot become a confirmed full-report timestamp later in the same run', async () => {
  const f = fixture({ deliveryFails: true, notificationMode: 'always' });
  let now = 100;
  f.bridge.scheduler.now = () => now;
  await assert.rejects(f.bridge.notification({ method: 'item/completed', params: { threadId: 'codex', turnId: 'turn-1', item: { type: 'agentMessage', text: 'All clear' } } }));
  now = 200;
  await f.bridge.notification({ method: 'item/completed', params: { threadId: 'codex', turnId: 'turn-1', item: { type: 'agentMessage', text: 'Follow-up delivered' } } });

  const history = f.bridge.scheduler.history('thread', 'job').runs[0];
  assert.equal(history.deliveryStatus, 'unknown');
  assert.equal(history.deliveredAt, null);
});
