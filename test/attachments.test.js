import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAttachment, readWorkspaceFile } from '../src/files.js';
import { Bridge } from '../src/bridge.js';

const attachment = { id: '456', name: 'large.bin', url: 'https://cdn.discordapp.com/attachments/large.bin' };

test('incoming and outgoing files above the former 8 MiB limit are complete', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'a2d-large-file-'));
  const contents = Buffer.alloc(9 * 1024 * 1024 + 17, 0x61);
  t.mock.method(globalThis, 'fetch', async () => new Response(contents));
  try {
    const path = await downloadAttachment(dir, '123', { ...attachment, size: contents.length });
    assert.deepEqual(await readFile(path), contents);
    await writeFile(join(dir, 'export.bin'), contents);
    assert.deepEqual((await readWorkspaceFile(dir, 'export.bin')).attachment, contents);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed downloads remove partial files but never remove existing files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'a2d-partial-file-'));
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    pull(controller) { controller.error(new Error('Connection lost')); },
  })));
  try {
    await assert.rejects(downloadAttachment(dir, '123', attachment), /Connection lost/);
    assert.deepEqual(await readdir(join(dir, 'discord-uploads', '123')), []);
    const path = join(dir, 'discord-uploads', '123', '456-large.bin');
    await writeFile(path, 'existing');
    await assert.rejects(downloadAttachment(dir, '123', attachment), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'existing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a message with more than five attachments passes every saved file to Codex', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'a2d-many-files-'));
  t.mock.method(globalThis, 'fetch', async () => new Response('attachment data'));
  const channel = { id: 'thread', parentId: 'parent', isThread: () => true, sendTyping: async () => {} };
  const state = { threads: { thread: { discordId: 'thread', codexId: 'codex', active: false } } };
  const store = { state, save: async () => {}, remember: async () => true };
  const calls = [];
  const rpc = { call: async (method, params) => { calls.push({ method, params }); return { turn: { id: 'turn' } }; } };
  const bridge = new Bridge({ guildId: 'guild', channelId: 'parent', userId: 'owner', workspace: dir },
    { channels: { fetch: async () => channel } }, rpc, store);
  try {
    const attachments = new Map(Array.from({ length: 6 }, (_, i) => [String(i), { ...attachment, id: String(600 + i) }]));
    await bridge.message({ id: '123', guildId: 'guild', channelId: 'thread', channel,
      author: { id: 'owner', bot: false }, content: 'Use these files', attachments });
    const input = calls.find(c => c.method === 'turn/start').params.input;
    assert.equal(input.length, 7);
    for (const [i, item] of input.slice(1).entries()) {
      const path = join(dir, 'discord-uploads', '123', `${600 + i}-large.bin`);
      assert.ok(item.text.includes(path));
      assert.equal(await readFile(path, 'utf8'), 'attachment data');
    }
  } finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
});
