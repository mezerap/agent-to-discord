import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge } from '../src/bridge.js';
import { nextRun } from '../src/scheduler.js';
import { RETENTION_MS } from '../src/archive-retention.js';

export function fixture() {
  let sequence = 0;
  const calls = [], sent = [], replies = [], histories = new Map(), archived = new Set(), messages = new Map();
  const channel = id => ({ id, name: `Topic ${id}`, guildId: 'guild', parentId: id === 'main' ? null : 'main', isThread: () => id !== 'main',
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
  assert.equal(f.calls.at(-1).params.input.length, 1);
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
