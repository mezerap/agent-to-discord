import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveRetention, RETENTION_MS } from '../src/archive-retention.js';
import { ThreadCleanup } from '../src/thread-cleanup.js';
import { Store } from '../src/store.js';

function fixture() {
  const now = Date.UTC(2027, 0, 10);
  const calls = [];
  const state = { threads: {}, retiredThreads: {} };
  const archives = new Set();
  const store = { state, save: async () => {} };
  const bridge = { store, cancelPending() {}, rpc: { call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [...archives].map(id => ({ id })), nextCursor: null };
    if (method === 'thread/read') return { thread: { status: { type: 'notLoaded' }, turns: [] } };
    if (method === 'thread/delete') archives.delete(params.threadId);
    if (method === 'thread/archive') archives.add(params.threadId);
    return {};
  } } };
  bridge.cleanup = new ThreadCleanup(bridge);
  const retention = new ArchiveRetention(bridge, () => now);
  function add(id, age = RETENTION_MS) {
    archives.add(id);
    state.retiredThreads[id] = { codexId: id, discordId: `discord-${id}`, deletedAt: now - age };
  }
  return { now, calls, state, archives, store, bridge, retention, add,
    deleted: () => calls.filter(c => c.method === 'thread/delete').map(c => c.params.threadId) };
}

test('retention respects the exact 90-day boundary and only deletes tracked archives', async () => {
  const f = fixture();
  f.add('due');
  f.add('old', RETENTION_MS + 1);
  f.add('young', RETENTION_MS - 1);
  f.archives.add('unrelated');
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), ['due', 'old']);
  assert.deepEqual(Object.keys(f.state.retiredThreads), ['young']);
  assert.ok(f.archives.has('unrelated'));
});

test('missing, invalid or future deletion timestamps never authorize deletion', async () => {
  const f = fixture();
  for (const [i, value] of [undefined, null, 0, -1, '2020-01-01', NaN, Infinity, f.now + 1].entries()) {
    f.add(String(i));
    f.state.retiredThreads[i].deletedAt = value;
  }
  f.add('mismatch');
  f.state.retiredThreads.mismatch.codexId = 'other';
  await f.retention.sweep();
  assert.deepEqual(f.calls, []);
});

test('restored and already deleted conversations leave retention without a delete call', async () => {
  const f = fixture();
  f.add('restored');
  f.archives.clear();
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), []);
  assert.deepEqual(f.state.retiredThreads, {});
});

test('mapped or active conversations are preserved', async () => {
  const f = fixture();
  for (const id of ['mapped', 'active', 'unknown', 'turn']) f.add(id);
  f.state.threads.discord = { codexId: 'mapped' };
  const original = f.bridge.rpc.call;
  f.bridge.rpc.call = async (method, params) => {
    if (method === 'thread/read') return { thread: {
      status: { type: params.threadId === 'turn' ? 'notLoaded' : params.threadId },
      turns: params.threadId === 'turn' ? [{ status: 'inProgress' }] : [],
    } };
    return original(method, params);
  };
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), []);
  assert.equal(Object.keys(f.state.retiredThreads).length, 4);
});

test('pagination failure preserves every retention record and performs no deletion', async () => {
  const f = fixture();
  f.add('due');
  f.bridge.rpc.call = async (method, params) => {
    assert.equal(method, 'thread/list');
    assert.equal(params.archived, true);
    assert.deepEqual(params.modelProviders, []);
    if (params.cursor) throw new Error('Disconnected');
    return { data: [{ id: 'due' }], nextCursor: 'next' };
  };
  await f.retention.sweep();
  assert.ok(f.state.retiredThreads.due);
});

test('archives on later pages are found and checked again before deletion', async () => {
  const f = fixture();
  f.add('due');
  const original = f.bridge.rpc.call;
  let listings = 0;
  f.bridge.rpc.call = async (method, params) => {
    if (method === 'thread/list') {
      listings++;
      return params.cursor ? { data: [{ id: 'due' }], nextCursor: null } : { data: [], nextCursor: 'next' };
    }
    return original(method, params);
  };
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), ['due']);
  assert.equal(listings, 4);
});

test('restoration during the sweep cancels deletion after a fresh archive check', async () => {
  const f = fixture();
  f.add('due');
  const original = f.bridge.rpc.call;
  f.bridge.rpc.call = async (method, params) => {
    if (method === 'thread/read') f.archives.delete(params.threadId);
    return original(method, params);
  };
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), []);
  assert.deepEqual(f.state.retiredThreads, {});
});

test('failed delete retries on the next sweep without losing the original date', async () => {
  const f = fixture();
  f.add('due');
  const date = f.state.retiredThreads.due.deletedAt;
  const original = f.bridge.rpc.call;
  f.bridge.rpc.call = async (method, params) => {
    if (method === 'thread/delete') throw new Error('Unsupported or temporarily unavailable');
    return original(method, params);
  };
  await f.retention.sweep();
  assert.equal(f.state.retiredThreads.due.deletedAt, date);
  f.bridge.rpc.call = original;
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), ['due']);
});

test('successful delete with lost response is reconciled without repeating deletion', async () => {
  const f = fixture();
  f.add('due');
  const original = f.bridge.rpc.call;
  f.bridge.rpc.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/delete') throw new Error('Response lost');
    return result;
  };
  await f.retention.sweep();
  assert.ok(f.state.retiredThreads.due);
  await f.retention.sweep();
  assert.deepEqual(f.deleted(), ['due']);
  assert.deepEqual(f.state.retiredThreads, {});
});

test('overlapping sweeps share one operation; shutdown prevents deletion', async () => {
  const f = fixture();
  f.add('due');
  let release;
  const original = f.bridge.rpc.call;
  f.bridge.rpc.call = async (method, params) => {
    if (method === 'thread/list') await new Promise(resolve => { release = resolve; });
    return original(method, params);
  };
  const first = f.retention.sweep();
  assert.equal(f.retention.sweep(), first);
  f.bridge.closing = true;
  release();
  await first;
  assert.deepEqual(f.deleted(), []);
  assert.ok(f.state.retiredThreads.due);
});

test('Discord deletion persists its observation time through archive retries', async () => {
  const f = fixture();
  f.state.threads.discord = { codexId: 'due', discordId: 'discord' };
  const original = f.bridge.rpc.call;
  f.bridge.rpc.call = async (method, params) => {
    if (method === 'thread/archive') throw new Error('Unavailable');
    return original(method, params);
  };
  await f.bridge.cleanup.remove('discord');
  const date = f.state.threads.discord.deletedAt;
  assert.ok(Number.isSafeInteger(date));
  assert.deepEqual(f.state.retiredThreads, {});
  f.bridge.rpc.call = original;
  await f.bridge.cleanup.retry();
  assert.deepEqual(f.state.retiredThreads.due, { codexId: 'due', discordId: 'discord', deletedAt: date });
  assert.deepEqual(f.state.threads, {});
});

test('old state migrates without adopting unknown archives and retention survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2d-retention-'));
  const store = new Store(dir);
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, threads: {}, seen: [] }));
    await store.open();
    assert.deepEqual(store.state.retiredThreads, {});
    store.state.retiredThreads.example = { codexId: 'example', discordId: 'discord', deletedAt: 123456789 };
    await store.save();
    await store.close();
    await store.open();
    assert.equal(store.state.retiredThreads.example.deletedAt, 123456789);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).threads, {});
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
