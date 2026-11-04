import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorized } from '../src/config.js';
import { Store } from '../src/store.js';
import { Bridge, say } from '../src/bridge.js';
import { readWorkspaceFile, downloadAttachment } from '../src/files.js';
import { CodexClient } from '../src/rpc.js';

const config = { guildId: 'guild', channelId: 'channel', userId: 'user', workspace: '/workspace' };
function fixture() {
  const messages = [];
  const calls = [];
  const channel = { id: 'thread', send: async message => { messages.push(message); return { edit: async () => {} }; } };
  const store = { state: { threads: { thread: { discordId: 'thread', codexId: 'codex', active: true, turnId: 'turn' } } }, save: async () => {} };
  const rpc = { reply: (id, result) => calls.push({ id, result }), reject: id => calls.push({ id, rejected: true }), call: async () => ({}) };
  const bridge = new Bridge(config, { channels: { fetch: async () => channel } }, rpc, store);
  return { bridge, channel, store, calls, messages };
}

test('only the configured user, guild and channel (or child thread) are authorized', () => {
  const event = { guildId: 'guild', channelId: 'channel', author: { id: 'user' } };
  assert.equal(authorized(config, event), true);
  for (const change of [{ guildId: 'other' }, { author: { id: 'other' } }, { channelId: 'other' }, { guildId: null }]) assert.equal(authorized(config, { ...event, ...change }), false);
  assert.equal(authorized(config, { ...event, channelId: 'thread', channel: { parentId: 'channel', isThread: () => true } }), true);
});

test('long responses are split without triggering mentions', async () => {
  const { channel, messages } = fixture();
  const text = '@everyone ' + 'x'.repeat(4500);
  await say(channel, text);
  assert.equal(messages.map(m => m.content).join(''), text);
  assert.ok(messages.every(m => m.content.length <= 2000 && m.allowedMentions.parse.length === 0));
});

test('persisted messages are deduplicated across restart and a second process is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2d-'));
  const first = new Store(dir);
  try {
    await first.open();
    assert.equal(await first.remember('123'), true);
    await assert.rejects(new Store(dir).open(), /Another bridge/);
    await first.close();
    const second = new Store(dir);
    await second.open();
    assert.equal(await second.remember('123'), false);
    await second.close();
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'))).seen.length, 1);
  } finally { await first.close(); await rm(dir, { recursive: true, force: true }); }
});

test('file exports reject traversal, symlinks outside workspace and secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2d-files-'));
  try {
    await writeFile(join(dir, 'report.txt'), 'report');
    await writeFile(join(dir, '.env'), 'secret');
    await symlink('/etc/hosts', join(dir, 'outside'));
    assert.equal((await readWorkspaceFile(dir, 'report.txt')).attachment.toString(), 'report');
    await assert.rejects(readWorkspaceFile(dir, '.env'), /Hidden/);
    await assert.rejects(readWorkspaceFile(dir, 'outside'), /inside/);
    await assert.rejects(readWorkspaceFile(dir, '../missing'));
    await assert.rejects(downloadAttachment(dir, '1', { url: 'http://127.0.0.1/secret' }), /Discord attachments/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approval is bound to owner, channel and active turn, and is single use', async () => {
  const f = fixture();
  await f.bridge.request({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'codex', turnId: 'turn', command: 'echo hello' } });
  const key = [...f.bridge.approvals.keys()][0];
  const click = { isButton: () => true, customId: `approval:${key}:accept`, guildId: 'guild', channelId: 'thread',
    channel: { isThread: () => true, parentId: 'channel' }, user: { id: 'other' }, reply: async () => {}, deferUpdate: async () => {}, editReply: async () => {} };
  await f.bridge.interaction(click);
  assert.equal(f.calls.length, 0);
  click.user.id = 'user';
  f.store.state.threads.thread.turnId = 'different';
  await f.bridge.interaction(click);
  assert.equal(f.calls.length, 0);
  f.store.state.threads.thread.turnId = 'turn';
  await Promise.all([f.bridge.interaction(click), f.bridge.interaction(click)]);
  assert.deepEqual(f.calls, [{ id: 7, result: { decision: 'accept' } }]);
  f.bridge.close();
});

test('unknown permission requests never silently grant privileges', async () => {
  const f = fixture();
  await f.bridge.request({ id: 8, method: 'item/permissions/requestApproval', params: { threadId: 'codex', permissions: { network: { enabled: true } } } });
  assert.deepEqual(f.calls[0], { id: 8, result: { permissions: {}, scope: 'turn' } });
});

test('crash recovery marks tasks uncertain without replaying work', async () => {
  const f = fixture();
  await f.bridge.recover();
  assert.equal(f.store.state.threads.thread.active, false);
  assert.equal(f.store.state.threads.thread.uncertain, true);
  assert.equal(f.calls.length, 0);
});

test('failed turns are reported as failure, not successful completion', async () => {
  const f = fixture();
  await f.bridge.notification({ method: 'turn/completed', params: { threadId: 'codex', turn: { id: 'turn', status: 'failed' } } });
  assert.match(f.messages.at(-1).content, /selhal/);
  assert.equal(f.store.state.threads.thread.active, false);
});

test('status reads an empty fresh context without resuming or clearing its marker', async () => {
  const f = fixture();
  const record = { discordId: 'thread', codexId: 'fresh', active: false, turnId: null, uncertain: false, freshUnstarted: true };
  f.store.state.threads.thread = record;
  const rpcCalls = [];
  f.bridge.rpc.call = async (method, params) => { rpcCalls.push({ method, params }); return {}; };
  f.bridge.cleanup.readThread = async () => ({ status: { type: 'idle' }, turns: [] });
  f.bridge.idleContext.status = () => 'Idle context';
  f.bridge.handoff.show = async () => {};

  await f.bridge.status(f.channel, record);

  assert.deepEqual(rpcCalls, []);
  assert.equal(record.freshUnstarted, true);
  assert.equal(record.uncertain, false);
  assert.match(f.messages.at(-1).content, /čeká na první běh/u);
  f.bridge.close();
});

test('status distinguishes uncertain first-turn acceptance from an untouched fresh context', async () => {
  const f = fixture();
  const record = { discordId: 'thread', codexId: 'fresh', active: false, turnId: null, uncertain: true, freshUnstarted: true };
  f.store.state.threads.thread = record;
  f.bridge.cleanup.readThread = async () => ({ status: { type: 'notLoaded' }, turns: [] });
  f.bridge.idleContext.status = () => 'Idle context';

  await f.bridge.status(f.channel, record);

  assert.equal(record.freshUnstarted, true);
  assert.equal(record.uncertain, true);
  assert.match(f.messages.at(-1).content, /nejistý/u);
  assert.match(f.messages.at(-1).content, /nebylo opakováno/u);
  f.bridge.close();
});

test('status resumes an unloaded established context before displaying its history', async () => {
  const f = fixture();
  const record = { discordId: 'thread', codexId: 'established', active: false, turnId: null, uncertain: true };
  f.store.state.threads.thread = record;
  const rpcCalls = [];
  f.bridge.rpc.call = async (method, params) => { rpcCalls.push({ method, params }); return {}; };
  let reads = 0;
  f.bridge.cleanup.readThread = async () => ++reads === 1
    ? { status: { type: 'notLoaded' }, turns: [] }
    : { status: { type: 'idle' }, turns: [{ id: 'previous-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Previous answer' }] }] };
  f.bridge.idleContext.status = () => 'Idle context';
  f.bridge.handoff.show = async () => {};

  await f.bridge.status(f.channel, record);

  assert.deepEqual(rpcCalls.map(call => call.method), ['thread/resume']);
  assert.equal(record.turnId, 'previous-turn');
  assert.equal(record.uncertain, false);
  assert.match(f.messages.at(-1).content, /Previous answer/u);
  f.bridge.close();
});

test('status resolves an uncertain first start only after observing its persisted turn', async () => {
  const f = fixture();
  const record = { discordId: 'thread', codexId: 'fresh', active: false, turnId: null, uncertain: true, freshUnstarted: true };
  f.store.state.threads.thread = record;
  f.bridge.cleanup.readThread = async () => ({ status: { type: 'idle' },
    turns: [{ id: 'accepted-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Confirmed answer' }] }] });
  f.bridge.idleContext.status = () => 'Idle context';
  f.bridge.handoff.show = async () => {};

  await f.bridge.status(f.channel, record);

  assert.equal(record.freshUnstarted, undefined);
  assert.equal(record.uncertain, false);
  assert.equal(record.turnId, 'accepted-turn');
  assert.match(f.messages.at(-1).content, /Confirmed answer/u);
  f.bridge.close();
});

test('status safely reports a missing fresh rollout without changing the pending context', async () => {
  const f = fixture();
  const record = { discordId: 'thread', codexId: 'fresh-secret-id', active: false, turnId: null, uncertain: true, freshUnstarted: true };
  f.store.state.threads.thread = record;
  f.bridge.cleanup.readThread = async () => { throw Object.assign(new Error('No rollout found for thread fresh-secret-id'), { rpcRejected: true, code: -32600 }); };

  await f.bridge.status(f.channel, record);

  assert.equal(record.freshUnstarted, true);
  assert.equal(record.uncertain, true);
  assert.ok(!f.messages.at(-1).content.includes('fresh-secret-id'));
  assert.match(f.messages.at(-1).content, /nejistý/u);
  assert.match(f.messages.at(-1).content, /nebylo zopakováno/u);
  f.bridge.close();
});

test('RPC correlates responses and rejects outstanding requests on disconnect', async () => {
  const rpc = new CodexClient({});
  rpc.child = { stdin: { writable: true, write() {} } };
  const response = rpc.call('model/list');
  rpc.receive({ id: 1, result: { data: [] } });
  assert.deepEqual(await response, { data: [] });
  const pending = rpc.call('thread/read');
  rpc.fail(new Error('Disconnected'));
  await assert.rejects(pending, /Disconnected/);
});
