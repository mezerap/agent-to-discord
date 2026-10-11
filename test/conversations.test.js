import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { nextRun } from '../src/scheduler.js';
import { RETENTION_MS } from '../src/archive-retention.js';

export function fixture() {
  let sequence = 0;
  const calls = [], sent = [], replies = [], histories = new Map(), archived = new Set(), messages = new Map();
  const channel = id => ({ id, name: `Topic ${id}`, guildId: 'guild', parentId: id === 'main' ? null : 'main', isThread: () => id !== 'main', permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {}, messages: { fetch: async id => { if (!messages.has(id)) throw { code: 10008 }; return messages.get(id); } },
    send: async payload => { const message = { id: `sent-${++sequence}`, ...payload, author: { id: 'bot', bot: true }, edit: async () => {} }; messages.set(message.id, message); sent.push({ channelId: id, ...message }); return message; },
    threads: { create: async () => { const c = channel(`restored-${++sequence}`); channels.set(c.id, c); return c; } },
  });
  const channels = new Map([['main', channel('main')], ['thread', channel('thread')]]);
  const discord = new EventEmitter();
  discord.user = { id: 'bot' };
  discord.channels = { fetch: async id => { if (!channels.has(id)) throw { code: 10003 }; return channels.get(id); } };
  const rpc = new EventEmitter();
  rpc.reply = (id, value) => replies.push({ id, value });
  rpc.reject = id => replies.push({ id, rejected: true });
  rpc.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/fork') {
      const thread = { id: `codex-${++sequence}`, status: { type: 'idle' }, turns: [] };
      if (method === 'thread/fork') {
        const source = histories.get(params.threadId);
        const index = source.turns.findIndex(t => t.id === params.lastTurnId);
        thread.turns = structuredClone(source.turns.slice(0, index + 1));
      }
      histories.set(thread.id, thread); return { thread };
    }
    if (method === 'thread/read') return { thread: histories.get(params.threadId) };
    if (method === 'thread/list') return { data: [...archived].map(id => ({ id })), nextCursor: null };
    if (method === 'thread/archive') archived.add(params.threadId);
    if (method === 'thread/unarchive') archived.delete(params.threadId);
    if (method === 'thread/delete') { archived.delete(params.threadId); histories.delete(params.threadId); }
    if (method === 'turn/start') {
      const thread = histories.get(params.threadId), turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [{ type: 'userMessage', content: params.input }] };
      thread.turns.push(turn); thread.status.type = 'active'; return { turn };
    }
    if (method === 'turn/interrupt') { const h = histories.get(params.threadId); h.turns.at(-1).status = 'interrupted'; h.status.type = 'idle'; }
    return {};
  };
  const state = { version: 1, threads: {}, retiredThreads: {}, seen: [] };
  const store = { state, save: async () => {}, remember: async id => { if (state.seen.includes(id)) return false; state.seen.push(id); return true; } };
  const bridge = new Bridge({ channelId: 'main', guildId: 'guild', userId: 'owner', workspace: '/workspace' }, discord, rpc, store);
  bridge.ready = true;
  const output = { send: async payload => { sent.push(payload); return payload; } };
  async function message(text, channelId = 'main', referenceId) {
    const m = { id: `input-${++sequence}`, guildId: 'guild', channelId, channel: channels.get(channelId), author: { id: 'owner', bot: false }, content: text, attachments: new Map(),
      ...(referenceId ? { reference: { messageId: referenceId, channelId } } : {}) };
    messages.set(m.id, m); await bridge.message(m); return m;
  }
  async function finish(record, text = 'Answer') {
    const h = histories.get(record.codexId), turn = h.turns.at(-1);
    turn.items.push({ type: 'agentMessage', text }); turn.status = 'completed'; h.status.type = 'idle';
    await bridge.notification({ method: 'item/completed', params: { threadId: record.codexId, turnId: turn.id, item: { type: 'agentMessage', text } } });
    await bridge.notification({ method: 'turn/completed', params: { threadId: record.codexId, turn } });
  }
  return { bridge, rpc, state, calls, sent, replies, histories, archived, channels, channel, messages, output, message, finish };
}

test('main channel keeps context, sends directly, and persists reply references for every chunk', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('First'); const r = f.state.threads.main;
  await f.finish(r, 'x'.repeat(4000));
  assert.equal(f.sent.length, 3);
  for (const m of f.sent) assert.equal(f.state.messages[m.id].codexId, r.codexId);
  await f.message('Follow up', 'main', f.sent[0].id);
  assert.equal(f.state.threads.main, r);
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.match(f.calls.at(-1).params.input[1].text, /Citovaný/);
});

test('manual thread forks through the starter turn and excludes later conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Early'); const main = f.state.threads.main; await f.finish(main, 'Early answer');
  const starter = f.sent.at(-1), firstTurn = main.turnId;
  await f.message('Later'); await f.finish(main, 'Later answer');
  f.channels.set(starter.id, f.channel(starter.id));
  await f.message('Continue here', starter.id);
  const fork = f.calls.find(c => c.method === 'thread/fork');
  assert.equal(fork.params.lastTurnId, firstTurn);
  assert.equal(f.state.threads.main, main);
  assert.notEqual(f.state.threads[starter.id].codexId, main.codexId);
  assert.equal(f.histories.get(f.state.threads[starter.id].codexId).turns.length, 2);
});

test('new archives only the current conversation and old replies do not resume it', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Old'); const old = f.state.threads.main; await f.finish(old);
  const answer = f.sent.at(-1).id;
  f.state.schedules.job = { id: 'job', status: 'enabled', discordId: 'main', contextPending: false };
  await f.bridge.control('new', '', 'main', f.output);
  assert.equal(f.state.threads.main, undefined); assert.ok(f.state.retiredThreads[old.codexId]);
  assert.equal(f.state.schedules.job.status, 'enabled');
  f.calls.length = 0;
  await f.message('About your old answer', 'main', answer);
  assert.notEqual(f.state.threads.main.codexId, old.codexId);
  assert.ok(!f.calls.some(c => c.params.threadId === old.codexId));
  assert.match(f.calls.at(-1).params.input[1].text, /Answer/);
});

test('new refuses active and uncertain work and preserves the conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); const r = f.state.threads.main;
  await f.bridge.control('new', '', 'main', f.output); assert.equal(f.state.threads.main, r);
  await f.finish(r); r.uncertain = true;
  await f.bridge.control('new', '', 'main', f.output); assert.equal(f.state.threads.main, r);
  assert.equal(Object.keys(f.state.retiredThreads).length, 0);
});

test('reply to an automation routes to its own history, ordinary messages stay in main', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Main'); const main = f.state.threads.main; await f.finish(main);
  const { thread } = await f.rpc.call('thread/start', {});
  const r = f.state.threads['automation:job'] = { codexId: thread.id, discordId: 'main', kind: 'automation', title: 'Job' };
  await f.bridge.startTurn(r, [{ type: 'text', text: 'Run' }]); await f.finish(r, 'Job result');
  const answer = f.sent.at(-1).id;
  await f.message('Why?', 'main', answer); assert.equal(f.calls.at(-1).params.threadId, r.codexId);
  await f.finish(r); await f.message('General'); assert.equal(f.calls.at(-1).params.threadId, main.codexId);
});

test('cron honors Prague timezone and daylight saving; invalid schedules are rejected', () => {
  assert.equal(new Date(nextRun({ type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Prague' }, Date.parse('2026-10-24T08:00:00Z'))).toISOString(), '2026-10-25T08:00:00.000Z');
  assert.throws(() => nextRun({ type: 'interval', minutes: 0 }));
  assert.throws(() => nextRun({ type: 'cron', expression: '* * * * * *' }));
  assert.throws(() => nextRun({ type: 'cron', expression: '0 9 * * *', timezone: 'bad' }));
});

async function createJob(f, channelId = 'main') {
  await f.message('Every hour do a check', channelId); const source = f.state.threads[channelId];
  const params = { threadId: source.codexId, turnId: source.turnId, callId: 'create', arguments: { action: 'create', title: 'Check', prompt: 'Only say checked', schedule: { type: 'interval', minutes: 60 } } };
  const result = await f.bridge.scheduler.tool(source, params);
  assert.deepEqual(await f.bridge.scheduler.tool(source, params), result);
  await f.finish(source);
  await f.bridge.scheduler.tick();
  return f.state.schedules[result.id];
}

test('schedules retain destination and independent context, deduplicate tool calls and survive new', async t => {
  for (const channelId of ['main', 'thread']) {
    const f = fixture(); t.after(() => f.bridge.close());
    const job = await createJob(f, channelId), source = f.state.threads[channelId];
    assert.equal(Object.keys(f.state.schedules).length, 1);
    assert.equal(job.discordId, channelId); assert.notEqual(job.codexId, source.codexId);
    await f.bridge.control('new', '', channelId, f.output);
    assert.equal(job.status, 'enabled');
    job.nextRun = Date.now() - 1;
    await Promise.all([f.bridge.scheduler.tick(), f.bridge.scheduler.tick()]);
    const record = f.bridge.record(job.codexId); assert.equal(record.active, true);
    assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === job.codexId).length, 1);
    await f.finish(record, 'Scheduled result'); assert.equal(f.sent.at(-1).channelId, channelId);
  }
});

test('scheduler claims before execution and never replays unknown results', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f);
  const original = f.rpc.call; let attempts = 0;
  f.rpc.call = async (method, params) => { if (method === 'turn/start') { attempts++; assert.ok(job.nextRun > Date.now()); throw new Error('Lost response'); } return original(method, params); };
  job.nextRun = Date.now() - 1;
  await f.bridge.scheduler.tick(); await f.bridge.scheduler.tick();
  assert.equal(attempts, 1); assert.equal(job.status, 'attention'); assert.equal(f.bridge.record(job.codexId).uncertain, true);
});

test('deleting a destination cancels all of its schedules and archives every mapped conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f, 'thread');
  const ids = Object.values(f.state.threads).map(r => r.codexId);
  await f.bridge.cleanup.remove('thread');
  assert.equal(job.status, 'deleted'); assert.equal(Object.keys(f.state.threads).length, 0);
  for (const id of ids) assert.ok(f.state.retiredThreads[id]);
  await assert.rejects(f.bridge.scheduler.setStatus(job.id, 'enabled'));
});

test('scheduled runs cannot create or modify schedules and cannot select another destination', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f);
  const record = f.bridge.record(job.codexId); record.runKind = 'scheduled';
  await assert.rejects(f.bridge.scheduler.tool(record, { threadId: record.codexId, callId: 'new', arguments: { action: 'pause', id: job.id } }));
  await f.message('Other conversation', 'thread');
  await assert.rejects(f.bridge.scheduler.tool(f.state.threads.thread, { threadId: 'other', callId: 'other', arguments: { action: 'pause', id: job.id } }));
});

test('archive restore cancels retention, creates a separate thread and does not resume schedules', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.message('History'); const old = f.state.threads.main; await f.finish(old);
  await f.bridge.control('new', '', 'main', f.output);
  await f.message('New main'); const current = f.state.threads.main; await f.finish(current);
  f.state.retiredThreads[old.codexId].deletedAt = Date.now() - RETENTION_MS - 1000;
  await Promise.all([f.bridge.ui.restore(f.output, old.codexId), f.bridge.retention.sweep()]);
  assert.equal(f.state.threads.main, current); assert.ok(f.bridge.record(old.codexId));
  assert.ok(!f.state.retiredThreads[old.codexId]); assert.ok(f.histories.has(old.codexId));
});

test('archive menus are private, scoped and deletion requires a separate single-use confirmation', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.message('History'); const old = f.state.threads.main; await f.finish(old);
  await f.bridge.control('new', '', 'main', f.output);
  await f.bridge.ui.archiveDetails(f.output, 'main', old.codexId);
  let payload = f.sent.at(-1), customId = payload.components[0].components[2].custom_id;
  const click = user => ({ customId, channelId: 'main', guildId: 'guild', channel: f.channels.get('main'), user: { id: user }, reply: async p => f.sent.push(p), deferReply: async p => assert.equal(p.flags, 64), editReply: async p => f.sent.push(p), followUp: async p => f.sent.push(p) });
  await f.bridge.ui.interaction(click('stranger')); assert.ok(f.histories.has(old.codexId));
  await f.bridge.ui.interaction(click('owner')); assert.ok(f.histories.has(old.codexId));
  customId = f.sent.at(-1).components[0].components[0].custom_id;
  await Promise.all([f.bridge.ui.interaction(click('owner')), f.bridge.ui.interaction(click('owner'))]);
  assert.ok(!f.histories.has(old.codexId)); assert.equal(f.calls.filter(c => c.method === 'thread/delete').length, 1);
});

test('archive history is displayed without resuming, and archive pages cover more than 20 records', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.message('Question'); const r = f.state.threads.main; await f.finish(r, 'Answer');
  await f.bridge.control('new', '', 'main', f.output); f.calls.length = 0;
  await f.bridge.ui.history(f.output, r.codexId);
  assert.match(f.sent.at(-1).files[0].attachment.toString(), /Question[\s\S]*Answer/);
  assert.ok(!f.calls.some(c => c.method === 'thread/resume'));
  for (let i = 0; i < 25; i++) f.state.retiredThreads[`old-${i}`] = { codexId: `old-${i}`, title: 'Archive', deletedAt: Date.now() };
  await f.bridge.ui.archives(f.output, 'main');
  assert.equal(f.sent.at(-1).components[0].components[0].options.length, 20);
  assert.equal(f.sent.at(-1).components[1].components[0].label, 'Další');
});

test('new inside a forked Discord thread stays clean instead of re-forking its original starter', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Main history'); await f.finish(f.state.threads.main);
  const id = f.sent.at(-1).id; f.channels.set(id, f.channel(id));
  await f.message('Branch', id); await f.finish(f.state.threads[id]);
  await f.bridge.ui.reset(f.output, id); f.calls.length = 0;
  await f.message('Clean start', id);
  assert.ok(f.calls.some(c => c.method === 'thread/start'));
  assert.ok(!f.calls.some(c => c.method === 'thread/fork'));
  assert.equal(f.calls.at(-1).params.input.length, 2);
  assert.match(f.calls.at(-1).params.input.at(-1).text, /Bridge capability notice/);
});

test('reset and incoming message cannot race into a soon-to-be-archived conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Old'); await f.finish(f.state.threads.main);
  let release; const original = f.rpc.call;
  f.rpc.call = async (method, params) => { if (method === 'thread/archive') await new Promise(r => { release = r; }); return original(method, params); };
  const reset = f.bridge.ui.reset(f.output, 'main');
  await new Promise(r => setImmediate(r));
  const before = f.calls.filter(c => c.method === 'turn/start').length;
  await f.message('Concurrent');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, before);
  release(); await reset;
});

test('unknown fork outcome suspends automation preparation instead of creating duplicate histories', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Schedule'); const source = f.state.threads.main;
  const result = await f.bridge.scheduler.tool(source, { threadId: source.codexId, turnId: source.turnId, callId: 'create', arguments: { action: 'create', title: 'Check', prompt: 'Check', schedule: { type: 'interval', minutes: 60 } } });
  await f.finish(source);
  let forks = 0; const original = f.rpc.call;
  f.rpc.call = async (method, params) => { if (method === 'thread/fork') { forks++; throw new Error('Unknown result'); } return original(method, params); };
  await f.bridge.scheduler.tick();
  const job = f.state.schedules[result.id]; assert.equal(job.status, 'attention');
  await f.bridge.scheduler.setStatus(job.id, 'enabled'); await f.bridge.scheduler.tick();
  assert.equal(forks, 1); assert.equal(job.status, 'attention');
});

test('archive retention preserves incomplete restores after process restart', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('History'); const record = f.state.threads.main; await f.finish(record);
  await f.bridge.ui.reset(f.output, 'main');
  const archived = f.state.retiredThreads[record.codexId]; archived.deletedAt = Date.now() - RETENTION_MS - 1;
  for (const field of ['restoreCreating', 'restoreTarget']) {
    archived[field] = field === 'restoreCreating' ? true : 'discord-restored';
    await f.bridge.retention.sweep(); assert.ok(f.histories.has(record.codexId));
    delete archived[field];
  }
});

test('a newly created owned thread captures context before the parent is reset', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Context'); await f.finish(f.state.threads.main);
  const id = f.sent.at(-1).id, thread = f.channel(id); thread.ownerId = 'owner'; f.channels.set(id, thread);
  f.bridge.attach();
  f.bridge.discord.emit('threadCreate', thread, true);
  await f.bridge.initializations.get(id);
  const branch = f.state.threads[id]; assert.ok(branch);
  await f.bridge.ui.reset(f.output, 'main');
  await f.message('Continue', id); assert.equal(f.state.threads[id], branch);
});

test('a stale archive confirmation cannot delete a later archival of the same conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('History'); const r = f.state.threads.main; await f.finish(r); await f.bridge.ui.reset(f.output, 'main');
  const date = f.state.retiredThreads[r.codexId].deletedAt;
  f.state.retiredThreads[r.codexId] = { ...f.state.retiredThreads[r.codexId], deletedAt: date + 1 };
  await f.bridge.ui.remove(f.output, r.codexId, date);
  assert.ok(f.histories.has(r.codexId));
});

test('standalone thread system notice never starts a parent task; first thread message starts fresh', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const id = 'standalone', thread = f.channel(id); thread.ownerId = 'owner'; f.channels.set(id, thread);
  const notice = { id, type: 18, system: true, guildId: 'guild', channelId: 'main', channel: f.channels.get('main'),
    author: { id: 'owner', bot: false }, content: 'New project', attachments: new Map() };
  f.messages.set(id, notice);
  await f.bridge.message(notice);
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.messages[id], undefined);
  f.bridge.attach();
  f.bridge.discord.emit('threadCreate', thread, true);
  await f.message('First task inside the thread', id);
  const record = f.state.threads[id];
  assert.ok(record.active);
  assert.equal(f.state.threads.main, undefined);
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.ok(!f.calls.some(c => c.method === 'thread/fork'));
  const input = f.calls.find(c => c.method === 'turn/start').params.input;
  assert.deepEqual(input.slice(0, -1), [{ type: 'text', text: 'First task inside the thread' }]);
  await f.finish(record);
  await f.message('Follow up', id);
  assert.equal(f.state.threads[id], record);
});

test('legacy mapping of a ThreadCreated notice cannot fork an unrelated active parent task', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Existing parent work'); const main = f.state.threads.main;
  const id = 'standalone-legacy'; f.channels.set(id, f.channel(id));
  f.messages.set(id, { id, type: 18, system: true, author: { id: 'owner' }, content: 'Thread title' });
  f.state.messages[id] = { codexId: main.codexId, discordId: 'main', turnId: main.turnId };
  await f.message('Independent task', id);
  assert.ok(f.state.threads[id].active);
  assert.notEqual(f.state.threads[id].codexId, main.codexId);
  assert.equal(f.state.threads.main, main);
  assert.ok(main.active);
  assert.ok(!f.calls.some(c => c.method === 'thread/fork'));
  assert.equal(f.calls.at(-1).params.input.length, 2);
  assert.match(f.calls.at(-1).params.input.at(-1).text, /Bridge capability notice/);
});

const flushQueue = async f => { await new Promise(resolve => setImmediate(resolve)); await f.bridge.queue.settle(); };

test('busy messages run FIFO without stop and keep the same conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('First'); const record = f.state.threads.main;
  await Promise.all([f.message('Second'), f.message('Third')]);
  assert.deepEqual(f.bridge.queue.entries('main').map(e => e.text), ['Second', 'Third']);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(f.sent.filter(m => m.components?.length).length, 2);
  await f.finish(record); await flushQueue(f);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text, 'Second');
  await f.finish(record); await flushQueue(f);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text, 'Third');
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(f.bridge.queue.entries('main').length, 0);
});

test('push uses turn/steer exactly once, preserves turn identity and reply mapping', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); const record = f.state.threads.main, turnId = record.turnId;
  const m = await f.message('Important correction'); const entry = f.bridge.queue.entries('main')[0];
  const call = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'turn/steer') { f.calls.push({ method, params }); return { turnId }; }
    return call(method, params);
  };
  await Promise.all([f.bridge.queue.push(entry.id, f.output), f.bridge.queue.push(entry.id, f.output)]);
  const steer = f.calls.filter(c => c.method === 'turn/steer');
  assert.equal(steer.length, 1);
  assert.equal(steer[0].params.expectedTurnId, turnId);
  assert.equal(steer[0].params.input[0].text, 'Important correction');
  assert.equal(record.turnId, turnId);
  assert.equal(f.state.messages[m.id].turnId, turnId);
  assert.equal(f.bridge.queue.entries('main').length, 0);
  assert.ok(!f.calls.some(c => c.method === 'turn/interrupt'));
});

test('a definite steer rejection retains the queue; a lost response never replays it', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); const record = f.state.threads.main;
  await f.message('Correction'); const entry = f.bridge.queue.entries('main')[0];
  const call = f.rpc.call;
  let rejected = true;
  f.rpc.call = async (method, params) => {
    if (method === 'turn/steer') throw Object.assign(new Error('test'), rejected ? { rpcRejected: true } : {});
    return call(method, params);
  };
  await f.bridge.queue.push(entry.id, f.output); assert.equal(entry.status, 'queued');
  rejected = false;
  await f.bridge.queue.push(entry.id, f.output); assert.equal(entry.status, 'attention');
  await f.finish(record); await flushQueue(f);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('stop pauses the queue and new cannot move pending messages into another conversation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); const record = f.state.threads.main;
  await f.message('Later');
  await f.bridge.control('stop', '', 'main', f.output);
  await f.bridge.notification({ method: 'turn/completed', params: { threadId: record.codexId, turn: { id: record.turnId, status: 'interrupted' } } });
  await flushQueue(f);
  assert.equal(f.state.queuePaused.main, true);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  await f.bridge.ui.reset(f.output, 'main'); assert.equal(f.state.threads.main, record);
  delete f.state.queuePaused.main;
  await f.bridge.queue.drain('main');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 2);
});

test('recovery preserves ready items but never replays dispatching entries', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); await f.message('Unknown'); await f.message('Ready');
  const entries = f.bridge.queue.entries('main'); entries[0].status = 'dispatching';
  const reloaded = JSON.parse(JSON.stringify(f.state));
  f.bridge.store.state = reloaded;
  await f.bridge.recover(); await flushQueue(f);
  assert.equal(reloaded.queuedMessages[entries[0].id].status, 'attention');
  assert.equal(reloaded.queuedMessages[entries[1].id].status, 'queued');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('deleting a destination removes queued prompts and never starts them', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work', 'thread'); await f.message('Pending', 'thread');
  await f.bridge.cleanup.remove('thread'); await flushQueue(f);
  assert.equal(f.bridge.queue.entries('thread').length, 0);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('queue buttons are owner/channel-bound and cancelled items never run', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); await f.message('Pending');
  const button = f.sent.at(-1).components[0].components[1];
  const click = { customId: button.custom_id, channelId: 'main', guildId: 'guild', channel: f.channels.get('main'),
    user: { id: 'other' }, reply: async () => {}, deferReply: async () => {}, editReply: async () => {}, followUp: async () => {} };
  await f.bridge.interaction(click); assert.equal(f.bridge.queue.entries('main').length, 1);
  click.user.id = 'owner'; await f.bridge.interaction(click);
  assert.equal(f.bridge.queue.entries('main').length, 0);
});

test('queue does not steer ordinary chat messages into an automation context', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Main history'); const main = f.state.threads.main; await f.finish(main);
  const { thread } = await f.rpc.call('thread/start', {});
  const auto = { codexId: thread.id, discordId: 'main', kind: 'automation', active: true, turnId: 'auto-turn' };
  f.state.threads['automation:test'] = auto;
  await f.message('Normal chat message'); const entry = f.bridge.queue.entries('main')[0];
  await f.bridge.queue.push(entry.id, f.output);
  assert.equal(entry.targetId, main.codexId);
  assert.ok(!f.calls.some(c => c.method === 'turn/steer'));
  assert.equal(f.bridge.queue.entries('main').length, 1);
});

test('queued attachments are downloaded once and survive until dispatch', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp('/tmp/a2d-queue-files-');
  const f = fixture(); f.bridge.config.workspace = dir;
  t.after(async () => { f.bridge.close(); await rm(dir, { recursive: true, force: true }); });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response('saved attachment'); });
  await f.message('Work'); const record = f.state.threads.main;
  await f.bridge.message({ id: '123456', guildId: 'guild', channelId: 'main', channel: f.channels.get('main'), author: { id: 'owner', bot: false }, content: 'Use this file',
    attachments: new Map([['9', { id: '9', name: 'note.txt', url: 'https://cdn.discordapp.com/attachments/note.txt' }]]) });
  const entry = f.bridge.queue.entries('main')[0];
  assert.equal(downloads, 1);
  assert.match(entry.input[1].text, /discord-uploads/);
  assert.equal(await readFile(`${dir}/discord-uploads/123456/9-note.txt`, 'utf8'), 'saved attachment');
  await f.finish(record); await flushQueue(f);
  assert.equal(downloads, 1);
  assert.deepEqual(f.calls.filter(c => c.method === 'turn/start').at(-1).params.input.slice(0, -1), entry.input);
});

test('queues in separate destinations progress independently', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Main work'); await f.message('Thread work', 'thread');
  await f.message('Main queued'); await f.message('Thread queued', 'thread');
  await f.finish(f.state.threads.thread); await flushQueue(f);
  assert.equal(f.bridge.queue.entries('thread').length, 0);
  assert.equal(f.bridge.queue.entries('main').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').at(-1).params.input[0].text, 'Thread queued');
});

test('a failed queued turn/start is not replayed by repeated drains', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); await f.message('Queued'); const record = f.state.threads.main;
  const call = f.rpc.call;
  let attempts = 0;
  f.rpc.call = async (method, params) => {
    if (method === 'turn/start') { attempts++; throw new Error('Connection lost after possible acceptance'); }
    return call(method, params);
  };
  await f.finish(record); await flushQueue(f);
  await f.bridge.queue.drain('main'); await f.bridge.queue.drain('main');
  assert.equal(attempts, 1);
  assert.equal(f.bridge.queue.entries('main')[0].status, 'attention');
  assert.equal(record.uncertain, true);
});

test('shutdown while preparing a queued dispatch preserves it for inspection', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Work'); await f.message('Queued'); const record = f.state.threads.main;
  const call = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === 'thread/resume') f.bridge.close();
    return call(method, params);
  };
  await f.finish(record); await flushQueue(f);
  assert.equal(f.bridge.queue.entries('main')[0].status, 'attention');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('changing automation destination preserves history, task and next occurrence; old thread deletion is independent', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const job = await createJob(f, 'thread'), before = structuredClone(job), record = f.bridge.record(job.codexId);
  const result = await f.bridge.scheduler.delivery.request(job, 'main', 'thread');
  assert.equal(result.pendingDestination, null);
  assert.equal(job.discordId, 'main'); assert.equal(record.discordId, 'main');
  for (const key of ['codexId', 'prompt', 'schedule', 'nextRun', 'status', 'sourceId', 'sourceTurnId']) assert.deepEqual(job[key], before[key]);
  await f.bridge.cleanup.remove('thread');
  assert.equal(job.status, 'enabled'); assert.equal(f.bridge.record(job.codexId), record);
  job.nextRun = Date.now() - 1; await f.bridge.scheduler.tick(); await f.finish(record, 'Moved result');
  assert.equal(f.sent.at(-1).channelId, 'main');
  await f.message('Explain the result', 'main', f.sent.at(-1).id);
  assert.equal(f.calls.at(-1).params.threadId, job.codexId);
  await f.finish(record);
  await f.bridge.cleanup.remove('main'); assert.equal(job.status, 'deleted');
});

test('old persisted tool schema can move through update ID without resetting schedule; tool call is idempotent', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f, 'thread');
  const source = f.state.threads.thread, before = job.nextRun;
  const params = { threadId: source.codexId, callId: 'move', arguments: { action: 'update', id: `${job.id}@main` } };
  const result = await f.bridge.scheduler.tool(source, params);
  assert.equal(result.destination, 'main'); assert.equal(job.nextRun, before);
  assert.deepEqual(await f.bridge.scheduler.tool(source, params), result);
  assert.equal(f.bridge.scheduler.list('thread').length, 0);
  assert.equal(f.bridge.scheduler.list('main')[0].destination, 'main');
});

test('active automation finishes at its original destination and waits for queued follow-ups before moving', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f, 'thread');
  job.nextRun = Date.now() - 1; await f.bridge.scheduler.tick(); const record = f.bridge.record(job.codexId);
  const result = await f.bridge.scheduler.delivery.request(job, 'main', 'thread');
  assert.equal(result.pendingDestination, 'main'); assert.equal(record.discordId, 'thread');
  f.state.queuedMessages.pending = { id: 'pending', discordId: 'thread', targetId: record.codexId, status: 'attention' };
  await f.finish(record, 'Still here'); assert.equal(f.sent.at(-1).channelId, 'thread');
  await f.bridge.scheduler.tick(); assert.equal(job.discordId, 'thread');
  delete f.state.queuedMessages.pending;
  job.status = 'paused'; await f.bridge.scheduler.tick();
  assert.equal(job.discordId, 'main'); assert.equal(job.status, 'paused');
});

test('pending move survives restart state and waits for creation context before original history can be deleted', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Schedule', 'thread'); const source = f.state.threads.thread;
  const result = await f.bridge.scheduler.tool(source, { threadId: source.codexId, turnId: source.turnId, callId: 'create-pending', arguments: { action: 'create', title: 'Pending', prompt: 'Check', schedule: { type: 'interval', minutes: 60 } } });
  const job = f.state.schedules[result.id]; await f.bridge.scheduler.delivery.request(job, 'main', 'thread');
  assert.equal(job.contextPending, true); assert.equal(job.pendingDestination, 'main');
  await f.finish(source); await f.bridge.scheduler.tick(); await f.bridge.scheduler.tick();
  assert.equal(job.discordId, 'main'); assert.equal(job.contextPending, false);
  const persisted = JSON.parse(JSON.stringify(f.state));
  assert.equal(persisted.threads[`automation:${job.id}`].discordId, 'main');
  await f.bridge.cleanup.remove('thread'); assert.ok(f.bridge.record(job.codexId));
});

test('destination updates reject other guilds, other parents, locked or unwritable threads and combined changes', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f);
  const source = f.state.threads.main;
  for (const patch of [{ guildId: 'other' }, { parentId: 'other' }, { locked: true }, { archived: true }, { permissionsFor: () => ({ has: () => false }) }]) {
    f.channels.set('thread', { ...f.channel('thread'), ...patch });
    await assert.rejects(f.bridge.scheduler.delivery.request(job, 'thread', 'main'));
    assert.equal(job.discordId, 'main'); assert.equal(job.pendingDestination, undefined);
  }
  f.channels.set('thread', f.channel('thread'));
  await assert.rejects(f.bridge.scheduler.tool(source, { threadId: source.codexId, callId: 'mixed', arguments: { action: 'update', id: job.id, destination: 'thread', prompt: 'changed' } }));
  const record = f.bridge.record(job.codexId); record.runKind = 'scheduled';
  await assert.rejects(f.bridge.scheduler.tool(record, { threadId: record.codexId, callId: 'scheduled-move', arguments: { action: 'update', id: job.id, destination: 'thread' } }));
  record.uncertain = true;
  await assert.rejects(f.bridge.scheduler.delivery.request(job, 'thread', 'main'));
  record.uncertain = false;
  await f.bridge.scheduler.tool(source, { threadId: source.codexId, callId: 'valid-move', arguments: { action: 'update', id: job.id, destination: 'thread' } });
  assert.equal(job.discordId, 'thread');
});

test('destination validation cannot resurrect a job whose source is deleted concurrently', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f, 'thread');
  const fetch = f.bridge.discord.channels.fetch;
  f.bridge.discord.channels.fetch = async (id, options) => { await f.bridge.cleanup.remove('thread'); return fetch(id, options); };
  await assert.rejects(f.bridge.scheduler.delivery.request(job, 'main', 'thread'));
  assert.equal(job.status, 'deleted'); assert.equal(job.discordId, 'thread');
});

test('failed deferred target validation holds future executions and can be cancelled without altering schedule', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f);
  const record = f.bridge.record(job.codexId); record.active = true;
  await f.bridge.scheduler.delivery.request(job, 'thread', 'main');
  record.active = false; f.channels.delete('thread'); job.nextRun = Date.now() - 1;
  const before = job.nextRun; await f.bridge.scheduler.tick();
  assert.ok(job.destinationError); assert.equal(job.discordId, 'main'); assert.equal(record.active, false); assert.equal(job.nextRun, before);
  await f.bridge.scheduler.delivery.request(job, 'here', 'main');
  assert.equal(job.pendingDestination, undefined); assert.equal(job.destinationError, undefined); assert.equal(job.nextRun, before);
});

test('scheduler never starts an old-destination run while a move waits for its context fork', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const job = await createJob(f, 'thread');
  job.contextPending = true; delete job.codexId; delete f.state.threads[`automation:${job.id}`];
  job.pendingDestination = 'main'; job.nextRun = Date.now() - 1;
  const starts = () => f.calls.filter(c => c.method === 'turn/start').length;
  const before = starts(); await f.bridge.scheduler.tick();
  assert.equal(starts(), before); assert.equal(job.discordId, 'thread');
  await f.bridge.scheduler.tick();
  assert.equal(job.discordId, 'main'); assert.equal(starts(), before + 1);
});

test('pending destination is recovered from serialized state without recreating the automation', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f, 'thread');
  const record = f.bridge.record(job.codexId); record.active = true;
  await f.bridge.scheduler.delivery.request(job, 'main', 'thread'); record.active = false;
  const state = JSON.parse(JSON.stringify(f.state));
  const b = new Bridge(f.bridge.config, f.bridge.discord, f.rpc, { state, save: async () => {} });
  t.after(() => b.close()); b.ready = true;
  const forks = f.calls.filter(c => c.method === 'thread/fork').length;
  await b.scheduler.tick();
  assert.equal(state.schedules[job.id].discordId, 'main');
  assert.equal(b.record(job.codexId).discordId, 'main');
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, forks);
});

test('input arriving during final destination validation stays queued at the original place', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); const job = await createJob(f, 'thread');
  job.pendingDestination = 'main'; const fetch = f.bridge.discord.channels.fetch;
  f.bridge.discord.channels.fetch = async (id, options) => {
    f.state.queuedMessages.race = { id: 'race', discordId: 'thread', targetId: job.codexId, status: 'attention' };
    return fetch(id, options);
  };
  await f.bridge.scheduler.delivery.apply(job);
  assert.equal(job.discordId, 'thread'); assert.equal(job.pendingDestination, 'main');
  assert.equal(f.state.queuedMessages.race.targetId, job.codexId);
});


test('100k warning uses last input not accumulated usage and never archives automatically', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); await f.message('Work'); const r = f.state.threads.main;
  await f.bridge.notification({method:'thread/tokenUsage/updated',params:{threadId:r.codexId,tokenUsage:{last:{inputTokens:99999},total:{totalTokens:999999},modelContextWindow:200000}}});
  await f.finish(r); assert.equal(Object.keys(f.state.retiredThreads).length,0);
  assert.ok(!f.sent.some(m => m.content?.includes('hranice upozornění')));
  await f.message('More'); await f.bridge.idleContext.update(r,{last:{inputTokens:100000},total:{totalTokens:1000000},modelContextWindow:200000}); await f.finish(r);
  assert.equal(f.sent.filter(m => m.content?.includes('hranice upozornění')).length,1);
  await f.message('Continue'); await f.finish(r); assert.equal(f.sent.filter(m => m.content?.includes('hranice upozornění')).length,1);
  assert.equal(f.state.threads.main,r); assert.match(f.bridge.idleContext.status(r),/100.?000/);
});

test('24 idle hours now warn but keep the same context; threads do not warn', async t => {
  const f = fixture(); t.after(() => f.bridge.close()); let now=Date.now(); f.bridge.idleContext.now=()=>now;
  await f.message('Old'); const r=f.state.threads.main; await f.finish(r); now+=86400000;
  await f.message('Today'); assert.equal(f.state.threads.main,r); assert.equal(Object.keys(f.state.retiredThreads).length,0);
  assert.ok(f.sent.some(m=>m.content?.includes('Bez potvrzení nic nearchivuji')));
});

async function planFor(f, args = {}) {
  const r=f.state.threads.main;
  return f.bridge.handoff.prepare(r,{threadId:r.codexId,callId:`plan-${f.calls.length}`,arguments:{action:'prepare',archiveSource:true,keep:'Selected project constraints',transfers:[],...args}});
}

test('a prepared handoff changes nothing until confirmation, then preserves only selected context', async t => {
  const f=fixture(); t.after(()=>f.bridge.close()); await f.message('Old topic'); const old=f.state.threads.main;
  const result=await planFor(f); await f.finish(old);
  assert.equal(f.state.threads.main,old); assert.equal(result.status,'awaiting_human_confirmation'); assert.equal(Object.keys(f.state.retiredThreads).length,0);
  await f.bridge.handoff.confirm(old,result.planId,f.output);
  assert.ok(f.state.retiredThreads[old.codexId]); assert.equal(f.state.contextSeeds.main,'Selected project constraints');
  await f.message('Continue selected topics'); const fresh=f.state.threads.main;
  assert.notEqual(fresh.codexId,old.codexId); assert.match(f.calls.at(-1).params.input[0].text,/Selected project constraints/);
  assert.equal(f.state.contextSeeds.main,undefined); assert.equal(f.histories.get(fresh.codexId).turns.length,1);
});

test('topic transfer supports new and existing threads without copying full history', async t => {
  const f=fixture(); t.after(()=>f.bridge.close()); await f.message('Existing thread','thread');const existing=f.state.threads.thread;await f.finish(existing);
  await f.message('Source');const source=f.state.threads.main;
  const result=await planFor(f,{archiveSource:false,keep:'',transfers:[{name:'Topic A',summary:'Only A'},{name:'Topic B',summary:'Only B',channelId:'thread'}]});await f.finish(source);
  assert.match(f.sent.find(m => m.files?.[0]?.name === 'navrh-prenosu.txt').files[0].attachment.toString(), /pokračuje současná konverzace/);
  await f.bridge.handoff.confirm(source,result.planId,f.output);
  assert.equal(f.state.threads.main,source);assert.equal(f.state.threads.thread,existing);
  const newId=Object.keys(f.state.contextSeeds).find(id=>id!=='thread');assert.ok(newId);
  await f.message('Continue A',newId);assert.match(f.calls.at(-1).params.input[0].text,/Only A/);
  assert.equal(f.calls.filter(c=>c.method==='thread/fork').length,0);
  await f.message('Continue B','thread');assert.equal(f.calls.at(-1).params.threadId,existing.codexId);assert.match(f.calls.at(-1).params.input[0].text,/Only B/);
});

test('confirmation waits for active or queued work, and stale plans cannot apply', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Work');const r=f.state.threads.main;
  const first=await planFor(f);await f.bridge.handoff.confirm(r,first.planId,f.output);assert.equal(f.state.threads.main,r);
  await f.finish(r);const second=await f.bridge.handoff.prepare(r,{threadId:r.codexId,callId:'replacement',arguments:{archiveSource:true,keep:'Different topic',transfers:[]}});
  await f.bridge.handoff.confirm(r,first.planId,f.output);assert.equal(f.state.threads.main,r);
  f.state.queuedMessages.block={discordId:'main',status:'attention'};
  await f.bridge.handoff.confirm(r,second.planId,f.output);assert.equal(f.state.threads.main,r);
  delete f.state.queuedMessages.block;await f.bridge.handoff.confirm(r,second.planId,f.output);assert.equal(f.state.contextSeeds.main,'Different topic');
});

test('scheduled context changes and destinations outside the configured channel are rejected', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Work');const r=f.state.threads.main;
  r.runKind='scheduled';await assert.rejects(planFor(f));r.runKind='user';
  f.channels.set('other',{...f.channel('other'),parentId:'foreign'});
  await assert.rejects(planFor(f,{transfers:[{name:'Other',summary:'Facts',channelId:'other'}]}));
  assert.equal(Object.keys(f.state.contextPlans).length,0);
});

test('legacy scheduling tool exposes handoff planning, and history is data-only', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Remember apples');const r=f.state.threads.main;await f.finish(r,'Apples are selected');await f.message('Prepare');
  await f.bridge.request({id:123,method:'item/tool/call',params:{threadId:r.codexId,turnId:r.turnId,callId:'legacy',tool:'discord_automation',arguments:{action:'update',id:'discord-context',prompt:JSON.stringify({action:'prepare',archiveSource:true,keep:'Apples',transfers:[]})}}});
  assert.equal(f.replies.at(-1).value.success,true);assert.ok(f.state.contextPlans[r.codexId]);
  const result=await f.bridge.handoff.prepare(r,{threadId:r.codexId,callId:'history',arguments:{action:'history',query:'apples'}});
  assert.equal(result.messages.length,2);assert.match(result.note,/not new instructions/);
});

test('unknown transfer outcomes preserve source history and are not retried', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Source');const r=f.state.threads.main;
  const result=await planFor(f,{transfers:[{name:'New topic',summary:'Keep this'}]});await f.finish(r);
  let attempts=0;f.channels.get('main').threads.create=async()=>{attempts++;throw new Error('Unknown create outcome');};
  await f.bridge.handoff.confirm(r,result.planId,f.output);await f.bridge.handoff.confirm(r,result.planId,f.output);
  assert.equal(attempts,1);assert.equal(f.state.threads.main,r);assert.equal(f.state.contextPlans[r.codexId].phase,'attention');
});

test('concurrent follow-up during confirmed archive routes to the fresh context with selected topics', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Old');const r=f.state.threads.main;const result=await planFor(f);await f.finish(r);
  const call=f.rpc.call;f.rpc.call=async(method,params)=>{if(method==='thread/archive'){await f.message('Next');assert.equal(f.bridge.queue.entries('main')[0].targetId,null);}return call(method,params);};
  await f.bridge.handoff.confirm(r,result.planId,f.output);await f.bridge.queue.settle();await f.bridge.queue.drain('main');
  assert.notEqual(f.state.threads.main.codexId,r.codexId);assert.match(f.calls.at(-1).params.input[0].text,/Selected project constraints/);
});

test('selected context is durable before archive and survives a failed archive response', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Source');const r=f.state.threads.main;const result=await planFor(f);await f.finish(r);
  const call=f.rpc.call;f.rpc.call=async(method,params)=>{if(method==='thread/archive'){assert.equal(f.state.contextSeeds.main,'Selected project constraints');throw new Error('Uncertain archive');}return call(method,params);};
  await f.bridge.handoff.confirm(r,result.planId,f.output);
  assert.equal(f.state.contextPlans[r.codexId].phase,'attention');assert.equal(f.state.contextSeeds.main,'Selected project constraints');
  const restored=JSON.parse(JSON.stringify(f.state));assert.equal(restored.contextSeeds.main,'Selected project constraints');
});

test('explicit new discards a proposed handoff and unconsumed selected context', async t => {
  const f=fixture();t.after(()=>f.bridge.close());await f.message('Source');const r=f.state.threads.main;await planFor(f);await f.finish(r);
  f.state.contextSeeds.main='Old pending selection';await f.bridge.control('new','','main',f.output);
  assert.equal(f.state.contextSeeds.main,undefined);assert.equal(f.state.contextPlans[r.codexId],undefined);
});

test('new and handoff both wait for other automation work; completion never resets automatically', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const job = await createJob(f), source = f.state.threads.main, automation = f.bridge.record(job.codexId);
  const plan = await planFor(f); const schedule = structuredClone(job);
  for (const flag of ['active', 'uncertain', 'retiring']) {
    automation[flag] = true;
    await f.bridge.ui.reset(f.output, 'main');
    await f.bridge.handoff.confirm(source, plan.planId, f.output);
    assert.equal(f.state.threads.main, source);
    assert.equal(f.state.contextPlans[source.codexId].phase, 'proposed');
    delete automation[flag];
  }
  assert.equal(f.state.threads.main, source);
  await f.bridge.ui.reset(f.output, 'main');
  assert.ok(f.state.retiredThreads[source.codexId]);
  assert.equal(f.bridge.record(job.codexId), automation);
  assert.deepEqual(job, schedule);
});

test('snooze persists and uses latest input growth instead of time or cumulative usage', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  let now = Date.now(); f.bridge.idleContext.now = () => now;
  await f.message('Work'); const r = f.state.threads.main;
  const update = inputTokens => f.bridge.idleContext.update(r, { last: { inputTokens }, total: { totalTokens: 99999999 } });
  const warnings = () => f.sent.filter(m => m.content?.includes('hranice upozornění'));
  await update(100000); await f.finish(r);
  const button = warnings()[0].components[0].components[0];
  await f.bridge.ui.actions.get(button.custom_id.slice('conversation:'.length)).run(f.output);
  assert.equal(r.contextSnoozeUntil, 110000);
  assert.equal(JSON.parse(JSON.stringify(f.state)).threads.main.contextSnoozeUntil, 110000);
  now += 2 * 86400000;
  for (const input of [50000, 100000, 109999]) { await update(input); await f.bridge.idleContext.warn(r); }
  assert.equal(warnings().length, 1);
  await update(110000); await f.bridge.idleContext.warn(r); assert.equal(warnings().length, 2);
  assert.equal(r.contextSnoozeUntil, undefined);
  const nextButton = warnings()[1].components[0].components[0];
  await f.bridge.ui.actions.get(nextButton.custom_id.slice('conversation:'.length)).run(f.output);
  await update(120000); await f.bridge.idleContext.warn(r); assert.equal(warnings().length, 3);
  assert.equal(Object.keys(f.state.retiredThreads).length, 0);
  const stale = warnings()[2].components[0].components[0];
  await f.bridge.ui.reset(f.output, 'main'); await f.message('Fresh');
  await f.bridge.ui.actions.get(stale.custom_id.slice('conversation:'.length)).run(f.output);
  assert.equal(f.state.threads.main.contextSnoozeUntil, undefined);
  assert.match(f.sent.at(-1).content, /není aktuální/);
});

test('handoff preview shows review and destinations inline and preserves complete attachment', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.message('Review topics'); const r = f.state.threads.main;
  const omittedWork = 'Unfinished BETA validation. '.repeat(40);
  await planFor(f, { archiveOnly: 'BETA background', omittedWork,
    transfers: [{ name: 'ALFA', summary: 'Selected facts with file /workspace/alfa.md and next steps' }] });
  await f.finish(r);
  const preview = f.sent.find(m => m.files?.[0]?.name === 'navrh-prenosu.txt');
  assert.match(preview.content, /Zůstane zde/); assert.match(preview.content, /Půjde do vlákna/);
  assert.match(preview.content, /Zůstane pouze v archivu/);
  assert.match(preview.content, /BETA background/); assert.match(preview.content, /Unfinished BETA validation/);
  assert.ok(preview.files[0].attachment.toString().includes(omittedWork));
  assert.equal(Object.keys(f.state.retiredThreads).length, 0);
  await assert.rejects(f.bridge.handoff.prepare(r, { threadId: r.codexId, callId: 'invalid-review', arguments: {
    archiveSource: true, keep: '', transfers: [], omittedWork: '', archiveOnly: 'BETA',
  } }), /omittedWork/);
});

async function fileFixture(t) {
  const f = fixture(), workspace = await mkdtemp(join(tmpdir(), 'a2d-send-file-'));
  f.bridge.config.workspace = workspace;
  await writeFile(join(workspace, 'report.md'), '# Complete report\n');
  t.after(async () => { f.bridge.close(); await f.bridge.fileDelivery.settle(); await rm(workspace, { recursive: true, force: true }); });
  return { ...f, workspace };
}

async function requestFile(f, record, { legacy = false, path = 'report.md', callId = 'file-call', turnId = record.turnId, ...extra } = {}) {
  const arguments_ = { path, caption: 'Report', ...extra };
  await f.bridge.request({ id: 901, method: 'item/tool/call', params: {
    threadId: record.codexId, turnId, callId, tool: legacy ? 'discord_automation' : 'discord_file',
    arguments: legacy ? { action: 'update', id: 'discord-file', prompt: JSON.stringify(arguments_) } : arguments_,
  } });
  return f.replies.at(-1).value;
}

test('native file tool sends complete bytes and maps attachment replies to the source turn', async t => {
  const f = await fileFixture(t); await f.message('Send report'); const r = f.state.threads.main;
  assert.ok(f.calls.find(c => c.method === 'thread/start').params.dynamicTools.some(tool => tool.name === 'discord_file'));
  assert.equal((await requestFile(f, r, { path: join(f.workspace, 'report.md') })).success, true);
  const sent = f.sent.at(-1);
  assert.equal(sent.channelId, 'main'); assert.equal(sent.files[0].name, 'report.md');
  assert.equal(sent.files[0].attachment.toString(), '# Complete report\n');
  assert.deepEqual(sent.allowedMentions, { parse: [] });
  assert.equal(f.state.messages[sent.id].turnId, r.turnId);
  await requestFile(f, r); await requestFile(f, r, { callId: 'model-retry' });
  assert.equal(f.sent.filter(m => m.files).length, 1);
});

test('legacy scheduled file delivery stays in each job destination and does not edit schedules', async t => {
  for (const channelId of ['main', 'thread']) {
    const f = await fileFixture(t), job = await createJob(f, channelId);
    job.nextRun = Date.now() - 1; await f.bridge.scheduler.tick();
    const r = f.bridge.record(job.codexId), before = structuredClone(f.state.schedules);
    assert.equal(r.runKind, 'scheduled');
    assert.equal((await requestFile(f, r, { legacy: true })).success, true);
    const attachment = f.sent.at(-1);
    assert.equal(attachment.channelId, channelId); assert.deepEqual(f.state.schedules, before);
    await f.finish(r); await f.message('About this report', channelId, attachment.id);
    assert.equal(f.calls.at(-1).params.threadId, r.codexId);
  }
});

test('file tool rejects secret paths, external symlinks, arbitrary destinations and stale turns', async t => {
  const f = await fileFixture(t); await f.message('Send report'); const r = f.state.threads.main;
  await writeFile(join(f.workspace, '.env'), 'private'); await writeFile(join(f.workspace, 'auth.json'), 'private');
  await symlink('/etc/hosts', join(f.workspace, 'outside'));
  for (const path of ['.env', 'auth.json', 'outside', '/etc/hosts', '../missing', 'missing.md']) {
    assert.equal((await requestFile(f, r, { path })).success, false);
  }
  assert.equal((await requestFile(f, r, { destination: 'foreign' })).success, false);
  assert.equal((await requestFile(f, r, { turnId: 'stale-turn' })).success, false);
  assert.equal(f.sent.filter(m => m.files).length, 0);
});

test('missing attachment permission and deletion during validation prevent upload', async t => {
  const f = await fileFixture(t); await f.message('Send report'); const r = f.state.threads.main;
  f.channels.get('main').permissionsFor = () => ({ has: value => Array.isArray(value) });
  assert.equal((await requestFile(f, r)).success, false);
  f.channels.get('main').permissionsFor = () => ({ has: () => { r.deleted = true; return true; } });
  assert.equal((await requestFile(f, r)).success, false);
  assert.equal(f.sent.filter(m => m.files).length, 0);
});

test('unknown file upload is not replayed after restart or under a new call ID', async t => {
  const f = await fileFixture(t); await f.message('Send report'); const r = f.state.threads.main;
  let attempts = 0; f.channels.get('main').send = async () => { attempts++; throw new Error('Response lost'); };
  assert.equal((await requestFile(f, r)).success, false);
  const saved = JSON.parse(JSON.stringify(f.state)); Object.assign(f.state, saved);
  const restored = f.state.threads.main;
  assert.equal((await requestFile(f, restored)).success, false);
  assert.equal((await requestFile(f, restored, { callId: 'retry' })).success, false);
  assert.equal(attempts, 1);
});

test('file upload intent is durable before network side effects', async t => {
  const f = await fileFixture(t); await f.message('Send report'); const r = f.state.threads.main;
  let attempts = 0; f.channels.get('main').send = async () => { attempts++; };
  f.bridge.store.save = async () => { throw new Error('Disk full'); };
  assert.equal((await requestFile(f, r)).success, false); assert.equal(attempts, 0);
});

test('every resumed user and scheduled turn receives file compatibility independently of developer instructions', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const job = await createJob(f);
  await f.message('Follow up'); await f.finish(f.state.threads.main);
  job.nextRun = Date.now() - 1; await f.bridge.scheduler.tick();
  const starts = f.calls.filter(c => c.method === 'turn/start');
  assert.equal(starts.length, 3);
  for (const call of starts) {
    assert.match(call.params.input.at(-1).text, /EXISTING discord_automation/);
    assert.match(call.params.input.at(-1).text, /does NOT modify a schedule/);
    assert.match(call.params.input.at(-1).text, /does not request sending any file/);
  }
  assert.equal(f.sent.filter(m => m.files).length, 0);
});
