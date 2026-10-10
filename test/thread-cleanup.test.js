import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.js';

function fixture({ active = false } = {}) {
  const calls = [];
  const replies = [];
  const record = { discordId: 'discord', codexId: 'codex', active, turnId: 'turn' };
  const store = { state: { threads: { discord: record }, seen: [] }, save: async () => {} };
  const discord = new EventEmitter();
  discord.channels = { fetch: async () => ({ archived: true }) };
  const rpc = new EventEmitter();
  rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/interrupt') active = false;
    if (method === 'thread/read') return { thread: { archived: false, status: { type: active ? 'active' : 'idle' }, turns: [{ id: 'turn', status: active ? 'inProgress' : 'completed' }] } };
    if (method === 'thread/list') return { data: [], nextCursor: null };
    return {};
  };
  rpc.reply = (id, result) => replies.push({ id, result });
  rpc.reject = id => replies.push({ id, rejected: true });
  const bridge = new Bridge({ guildId: 'guild', channelId: 'parent', userId: 'owner' }, discord, rpc, store);
  return { bridge, store, rpc, discord, record, calls, replies };
}

test('deleting an idle thread archives only its conversation and removes its mapping', async () => {
  const f = fixture();
  f.store.state.threads.other = { discordId: 'other', codexId: 'other-codex' };
  await f.bridge.cleanup.remove('discord');
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'thread/archive']);
  assert.deepEqual(Object.keys(f.store.state.threads), ['other']);
  assert.ok(f.calls.every(c => c.params.threadId === 'codex'));
});

test('deletion interrupts active work and verifies termination before archiving', async () => {
  const f = fixture({ active: true });
  await f.bridge.cleanup.remove('discord');
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'turn/interrupt', 'thread/read', 'thread/archive']);
  assert.equal(f.calls[1].params.turnId, 'turn');
  assert.equal(f.store.state.threads.discord, undefined);
});

test('failed interruption keeps a durable tombstone and retries without archiving live work', async () => {
  const f = fixture({ active: true });
  const original = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'turn/interrupt') throw new Error('Network unavailable');
    return original(method, params);
  };
  await f.bridge.cleanup.remove('discord');
  assert.equal(f.record.deleted, true);
  assert.ok(!f.calls.some(c => c.method === 'thread/archive'));
  f.rpc.call = original;
  await f.bridge.cleanup.retry();
  assert.equal(f.store.state.threads.discord, undefined);
});

test('archive failures preserve the mapping for a later retry', async () => {
  const f = fixture();
  const original = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'thread/archive') throw new Error('Unavailable');
    return original(method, params);
  };
  await f.bridge.cleanup.remove('discord');
  assert.equal(f.record.deleted, true);
  f.rpc.call = original;
  await f.bridge.cleanup.retry();
  assert.equal(f.store.state.threads.discord, undefined);
});

test('startup removes confirmed missing threads, preserves archived threads, access errors and outages', async () => {
  for (const code of [10003, 50001, 50013, 'ECONNRESET', undefined]) {
    const f = fixture();
    f.discord.channels.fetch = async (id, options) => {
      assert.equal(options.force, true);
      if (code !== undefined) throw Object.assign(new Error('Discord error'), { code });
      return { archived: true };
    };
    await f.bridge.recover();
    assert.equal(!!f.store.state.threads.discord, code !== 10003);
  }
});

test('uncached raw deletion events are scoped and duplicate events share cleanup', async () => {
  const f = fixture();
  f.bridge.attach();
  try {
    f.discord.emit('raw', { t: 'THREAD_DELETE', d: { id: 'discord', guild_id: 'other', parent_id: 'parent' } });
    f.discord.emit('raw', { t: 'THREAD_UPDATE', d: { id: 'discord', guild_id: 'guild', parent_id: 'parent', archived: true } });
    assert.equal(f.bridge.cleanup.isDeleted('discord'), false);
    const event = { t: 'THREAD_DELETE', d: { id: 'discord', guild_id: 'guild', parent_id: 'parent' } };
    f.discord.emit('raw', event);
    f.discord.emit('raw', event);
    await f.bridge.cleanup.jobs.get('discord');
    assert.equal(f.calls.filter(c => c.method === 'thread/archive').length, 1);
  } finally { f.bridge.close(); }
});

test('deletion waits for an in-flight turn/start, then cancels the resulting turn', async () => {
  const f = fixture({ active: true });
  const release = f.bridge.cleanup.hold('discord');
  const cleanup = f.bridge.cleanup.remove('discord');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.record.deleted, true);
  assert.equal(f.calls.length, 0);
  release();
  await cleanup;
  assert.ok(f.calls.some(c => c.method === 'turn/interrupt'));
});

test('deletion during thread/start finds a mapping created after the delete event', async () => {
  const f = fixture();
  delete f.store.state.threads.discord;
  const release = f.bridge.cleanup.hold('discord');
  const cleanup = f.bridge.cleanup.remove('discord');
  await new Promise(resolve => setImmediate(resolve));
  f.store.state.threads.discord = f.record;
  release();
  await cleanup;
  assert.ok(f.calls.some(c => c.method === 'thread/archive'));
  assert.equal(f.store.state.threads.discord, undefined);
});

test('deletion denies pending approvals/questions and late permission requests', async () => {
  const f = fixture();
  f.bridge.approvals.set('button', { id: 1, discordId: 'discord' });
  f.bridge.questions.set('discord', { id: 2 });
  const release = f.bridge.cleanup.hold('discord');
  const cleanup = f.bridge.cleanup.remove('discord');
  await f.bridge.request({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'codex' } });
  assert.deepEqual(f.replies, [{ id: 1, result: { decision: 'decline' } }, { id: 2, result: { answers: {} } }, { id: 3, result: { decision: 'decline' } }]);
  assert.equal(f.bridge.approvals.size, 0);
  assert.equal(f.bridge.questions.size, 0);
  release();
  await cleanup;
});

test('a request whose channel disappeared is denied instead of hanging', async () => {
  const f = fixture();
  f.discord.channels.fetch = async () => { throw Object.assign(new Error('Gone'), { code: 10003 }); };
  await f.bridge.request({ id: 4, method: 'item/tool/requestUserInput', params: { threadId: 'codex' } });
  assert.deepEqual(f.replies[0], { id: 4, result: { answers: {} } });
  await f.bridge.cleanup.jobs.get('discord');
  assert.equal(f.store.state.threads.discord, undefined);
});

test('already archived Codex history is not archived twice after restart', async () => {
  const f = fixture();
  f.record.deleted = true;
  f.rpc.call = async (method, params) => {
    if (method === 'thread/archive') throw new Error('no rollout found');
    if (method === 'thread/list') { assert.equal(params.archived, true); return { data: [{ id: 'codex' }] }; }
    assert.equal(method, 'thread/read');
    return { thread: { status: { type: 'notLoaded' }, turns: [] } };
  };
  await f.bridge.cleanup.reconcile();
  assert.equal(f.store.state.threads.discord, undefined);
});

test('empty threads can be archived even when Codex cannot list their turns yet', async () => {
  const f = fixture();
  f.rpc.call = async (method, params) => {
    if (method === 'thread/read' && params.includeTurns) throw new Error('list_turns is not supported yet');
    if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [] } };
    assert.equal(method, 'thread/archive');
    return {};
  };
  await f.bridge.cleanup.remove('discord');
  assert.equal(f.store.state.threads.discord, undefined);
});
