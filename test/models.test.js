import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelSelection } from '../src/models.js';
import { Store } from '../src/store.js';
import { initializeState } from '../src/conversations.js';

function model(id, effort = 'low') {
  return { id, model: id, displayName: id, defaultReasoningEffort: effort,
    supportedReasoningEfforts: [{ reasoningEffort: effort }] };
}

function fixture(items = [model('gpt-sol'), model('gpt-luna', 'medium')]) {
  const calls = [], sent = [], state = {};
  initializeState(state);
  const bridge = { config: { guildId: 'guild', channelId: 'main', userId: 'owner' }, ready: true,
    cleanup: { isDeleted: () => false }, store: { state, save: async () => {} },
    rpc: { call: async (method, params) => { calls.push({ method, params }); return { data: items, nextCursor: null }; } } };
  const selection = new ModelSelection(bridge);
  const output = { send: async payload => { sent.push(payload); } };
  return { bridge, selection, output, calls, sent, state };
}

test('model catalog reads all pages, filters hidden entries and coalesces cached requests', async () => {
  const f = fixture();
  f.bridge.rpc.call = async (method, params) => {
    f.calls.push({ method, params });
    return params.cursor ? { data: [model('gpt-luna')], nextCursor: null } :
      { data: [model('gpt-sol'), { ...model('hidden'), hidden: true }], nextCursor: 'page-2' };
  };
  const [a, b] = await Promise.all([f.selection.list(), f.selection.list()]);
  assert.equal(a, b);
  assert.deepEqual(a.map(item => item.model), ['gpt-sol', 'gpt-luna']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].params.cursor, 'page-2');
  assert.equal(await f.selection.list(), a);
  assert.equal(f.calls.length, 2);
});

test('model picker paginates Discord choices and preserves the current selection', async () => {
  const f = fixture(Array.from({ length: 31 }, (_, i) => model(`model-${i}`)));
  await f.selection.show(f.output, 'main');
  const first = f.sent.at(-1).components.map(row => row.toJSON());
  assert.equal(first[0].components[0].options.length, 25);
  assert.equal(first[1].components[0].disabled, true);
  await f.selection.select(f.output, 'main', 'model-29');
  const last = f.sent.at(-1).components.map(row => row.toJSON());
  assert.equal(last[0].components[0].options.length, 6);
  assert.equal(last[0].components[0].options.find(item => item.default).value, 'model-29');
  assert.match(f.sent.at(-1).content, /strana 2\/2/);
});

test('selection validates the catalog and uses the new model default effort per destination', async () => {
  const f = fixture();
  await f.selection.select(f.output, 'main', 'gpt-luna');
  assert.deepEqual(f.selection.turnSettings('main'), { model: 'gpt-luna', effort: 'medium' });
  assert.deepEqual(f.selection.turnSettings('thread'), {});
  await f.selection.select(f.output, 'main', 'not-in-catalog');
  assert.equal(f.state.modelPreferences.main.model, 'gpt-luna');
  assert.match(f.sent.at(-1).content, /není v aktuální nabídce/);
  await f.selection.select(f.output, 'main', 'gpt-sol');
  assert.deepEqual(f.selection.turnSettings('main'), { model: 'gpt-sol', effort: 'low' });
});

test('model preference survives a real Store close and reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-model-'));
  const f = fixture();
  const store = new Store(dir);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.open();
  initializeState(store.state);
  f.bridge.store = store;
  await f.selection.select(f.output, 'thread', 'gpt-luna');
  await store.close();
  await store.open();
  assert.deepEqual(store.state.modelPreferences.thread, { model: 'gpt-luna', effort: 'medium' });
});

test('failed persistence does not claim success or leave an unapplied preference in memory', async () => {
  const f = fixture();
  f.bridge.store.save = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(f.selection.select(f.output, 'main', 'gpt-sol'));
  assert.equal(f.state.modelPreferences.main, undefined);
  assert.equal(f.sent.length, 0);
});

function interaction(overrides = {}) {
  const replies = [];
  return { replies, guildId: 'guild', channelId: 'thread', user: { id: 'owner' },
    channel: { isThread: () => true, parentId: 'main' }, customId: 'model:select', values: ['gpt-luna'],
    isStringSelectMenu: () => true, isButton: () => false,
    reply: async payload => replies.push({ reply: payload }),
    deferUpdate: async () => replies.push({ deferred: true }),
    editReply: async payload => replies.push({ edit: payload }), ...overrides };
}

test('model components enforce the same owner, guild and channel boundaries', async () => {
  for (const override of [{ user: { id: 'stranger' } }, { guildId: 'other' }, { channel: { isThread: () => false } }]) {
    const f = fixture(), event = interaction(override);
    await f.selection.interaction(event);
    assert.equal(event.replies[0].reply.flags, 64);
    assert.deepEqual(f.state.modelPreferences, {});
    assert.equal(f.calls.length, 0);
  }
});

test('authorized selection acknowledges before work and edits its private picker without mentions', async () => {
  const f = fixture(), event = interaction();
  f.bridge.store.save = async () => assert.deepEqual(event.replies[0], { deferred: true });
  await f.selection.interaction(event);
  assert.equal(f.state.modelPreferences.thread.model, 'gpt-luna');
  assert.deepEqual(event.replies.at(-1).edit.allowedMentions, { parse: [] });
});

test('a deleted destination cannot be changed after a delayed catalog read', async () => {
  const f = fixture();
  let resolve;
  f.bridge.rpc.call = () => new Promise(done => { resolve = done; });
  const change = f.selection.select(f.output, 'main', 'gpt-sol');
  f.bridge.cleanup.isDeleted = () => true;
  resolve({ data: [model('gpt-sol')], nextCursor: null });
  await change;
  assert.deepEqual(f.state.modelPreferences, {});
});

test('catalog errors are not exposed in interaction responses or cached forever', async () => {
  const f = fixture(), event = interaction();
  f.bridge.rpc.call = async () => { throw new Error('credential=PRIVATE'); };
  await f.selection.interaction(event);
  assert.match(event.replies.at(-1).edit.content, /nepodařilo/);
  assert.ok(!JSON.stringify(event.replies).includes('PRIVATE'));
  f.bridge.rpc.call = async () => ({ data: [model('gpt-sol')], nextCursor: null });
  assert.equal((await f.selection.list())[0].model, 'gpt-sol');
});
