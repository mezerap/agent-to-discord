import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, registerCommands, handleCommand } from '../src/commands.js';
import { TypingIndicator } from '../src/typing.js';
import { Bridge } from '../src/bridge.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('guild commands are registered without deleting unrelated commands or updating unchanged ones', async () => {
  const writes = [];
  const discord = { application: { id: 'app' }, rest: {
    get: async () => [...COMMANDS.slice(0, 2).map((command, i) => ({ ...command, id: String(i) })), { id: 'other', name: 'unrelated', type: 1 }],
    post: async (route, { body }) => writes.push({ route, name: body.name }),
    patch: async () => assert.fail('No update required'),
  } };
  await registerCommands(discord, 'guild');
  assert.deepEqual(writes.map(w => w.name), ['stop', 'file', 'answer']);
  assert.ok(writes.every(w => w.route.includes('/guilds/guild/commands')));
});

function interactionFixture() {
  const calls = [];
  const bridge = {
    config: { guildId: 'guild', channelId: 'parent', userId: 'owner' }, ready: true,
    cleanup: { isDeleted: () => false },
    control: async (name, arg, id, output) => { calls.push({ name, arg, id }); await output.send({ content: 'ok' }); },
  };
  const interaction = {
    guildId: 'guild', channelId: 'thread', user: { id: 'owner' },
    channel: { isThread: () => true, parentId: 'parent' }, commandName: 'stop',
    options: { getString: () => 'report.txt' },
    reply: async payload => calls.push({ reply: payload }),
    deferReply: async payload => calls.push({ defer: payload }),
    editReply: async payload => calls.push({ edit: payload }),
    followUp: async payload => calls.push({ followup: payload }),
  };
  return { bridge, interaction, calls };
}

test('slash commands acknowledge privately before running work and keep replies private', async () => {
  const f = interactionFixture();
  f.bridge.control = async (name, arg, id, output) => {
    assert.deepEqual(f.calls[0], { defer: { flags: 64 } });
    await output.send({ content: 'first' });
    await output.send({ content: 'second' });
  };
  await handleCommand(f.bridge, f.interaction);
  assert.equal(f.calls[1].edit.content, 'first');
  assert.deepEqual(f.calls[1].edit.allowedMentions, { parse: [] });
  assert.equal(f.calls[2].followup.flags, 64);
});

test('unauthorized slash commands cannot stop work or read files', async () => {
  for (const changed of [{ user: { id: 'stranger' } }, { guildId: 'other' }, { channelId: 'other', channel: { isThread: () => false } }]) {
    const f = interactionFixture();
    Object.assign(f.interaction, changed);
    await handleCommand(f.bridge, f.interaction);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].reply.flags, 64);
  }
});

test('slash file argument reaches the same guarded file handler', async () => {
  const f = interactionFixture();
  f.interaction.commandName = 'file';
  await handleCommand(f.bridge, f.interaction);
  assert.deepEqual(f.calls[1], { name: 'file', arg: 'report.txt', id: 'thread' });
});

test('slash command errors produce a private response without exposing raw errors', async () => {
  const f = interactionFixture();
  f.bridge.control = async () => { throw new Error('private diagnostic'); };
  await handleCommand(f.bridge, f.interaction);
  assert.match(f.calls.at(-1).edit.content, /nepodařilo/);
  assert.ok(!JSON.stringify(f.calls).includes('private diagnostic'));
});

test('typing refreshes every eight seconds and stops with the work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let working = true;
  let pulses = 0;
  const typing = new TypingIndicator({ channels: { fetch: async () => ({ sendTyping: async () => { pulses++; } }) }, isWorking: () => working });
  typing.start('thread');
  await flush();
  assert.equal(pulses, 1);
  t.mock.timers.tick(8_000);
  await flush();
  assert.equal(pulses, 2);
  working = false;
  t.mock.timers.tick(8_000);
  await flush();
  assert.equal(pulses, 2);
  assert.equal(typing.sessions.size, 0);
  typing.close();
});

test('typing fetch that finishes after cancellation cannot send a stale indicator', async () => {
  let resolve;
  let pulses = 0;
  const typing = new TypingIndicator({ channels: { fetch: () => new Promise(res => { resolve = res; }) }, isWorking: () => true });
  typing.start('thread');
  typing.stop('thread');
  resolve({ sendTyping: async () => { pulses++; } });
  await flush();
  assert.equal(pulses, 0);
});

test('typing errors do not reject tasks; a confirmed missing channel triggers cleanup', async () => {
  const deleted = [];
  const typing = new TypingIndicator({ channels: { fetch: async () => { throw { code: 10003 }; } }, isWorking: () => true, onMissing: id => deleted.push(id) });
  typing.start('thread');
  await flush();
  assert.deepEqual(deleted, ['thread']);
  assert.equal(typing.sessions.size, 0);
});

function bridgeFixture() {
  const messages = [];
  let pulses = 0;
  const channel = { id: 'thread', parentId: 'parent', isThread: () => true,
    sendTyping: async () => { pulses++; }, send: async payload => { messages.push(payload); return { edit: async () => {} }; } };
  const record = { discordId: 'thread', codexId: 'codex', turnId: 'turn', active: false };
  const store = { state: { threads: { thread: record } }, save: async () => {}, remember: async () => true };
  const rpc = { call: async () => ({ turn: { id: 'turn' } }), reply() {} };
  const bridge = new Bridge({ guildId: 'guild', channelId: 'parent', userId: 'owner' }, { channels: { fetch: async () => channel } }, rpc, store);
  return { bridge, channel, record, messages, pulses: () => pulses };
}

test('ordinary tasks use typing and the actual answer without working/done messages', async () => {
  const f = bridgeFixture();
  try {
    await f.bridge.message({ id: 'message', guildId: 'guild', channelId: 'thread', channel: f.channel,
      author: { id: 'owner', bot: false }, content: 'Hello', attachments: new Map() });
    await flush();
    assert.ok(f.pulses() > 0);
    assert.equal(f.messages.length, 0);
    await f.bridge.notification({ method: 'item/completed', params: { threadId: 'codex', item: { type: 'agentMessage', text: 'Actual answer' } } });
    await f.bridge.notification({ method: 'turn/completed', params: { threadId: 'codex', turn: { id: 'turn', status: 'completed' } } });
    assert.deepEqual(f.messages.map(m => m.content), ['Actual answer']);
    assert.equal(f.bridge.typing.sessions.size, 0);
  } finally { f.bridge.close(); }
});

test('typing pauses for an approval and resumes after the decision', async () => {
  const f = bridgeFixture();
  f.record.active = true;
  try {
    f.bridge.typing.start('thread');
    await f.bridge.request({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'codex', turnId: 'turn', command: 'echo hello' } });
    assert.equal(f.bridge.typing.sessions.size, 0);
    const key = [...f.bridge.approvals.keys()][0];
    await f.bridge.interaction({ isButton: () => true, customId: `approval:${key}:accept`, guildId: 'guild', channelId: 'thread', channel: f.channel,
      user: { id: 'owner' }, deferUpdate: async () => {}, editReply: async () => {} });
    assert.equal(f.bridge.typing.sessions.size, 1);
  } finally { f.bridge.close(); }
});

test('plain text and numeric answers work for a single question and resume typing', async () => {
  const f = bridgeFixture();
  f.record.active = true;
  try {
    for (const answer of ['ano', '123']) {
      f.bridge.questions.set('thread', { id: 9, questions: [{ id: 'q' }] });
      let result;
      f.bridge.rpc.reply = (id, value) => { result = value; };
      await f.bridge.control('answer', answer, 'thread', f.channel);
      assert.deepEqual(result, { answers: { q: { answers: [answer] } } });
      assert.equal(f.bridge.typing.sessions.size, 1);
    }
  } finally { f.bridge.close(); }
});
