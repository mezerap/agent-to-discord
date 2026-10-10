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
