import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';

function fixture(call) {
  const record = { codexId: 'fresh', discordId: 'channel', kind: 'automation', scheduleId: 'job',
    automationRunId: 'run', runKind: 'scheduled', freshUnstarted: true, active: false };
  const run = { id: 'run', status: 'running' };
  const snapshots = [];
  const state = { threads: { 'automation:job': record }, schedules: { job: { id: 'job', runs: [run] } } };
  const store = { state, save: async () => { snapshots.push(structuredClone(state)); } };
  const bridge = new Bridge({ workspace: '/workspace' }, { channels: {} }, { call }, store);
  bridge.typing.start = () => {};
  bridge.typing.stop = () => {};
  return { bridge, record, run, snapshots };
}

test('accepted first turn persists its identity and clears the unstarted marker', async () => {
  const f = fixture(async (method) => {
    assert.equal(method, 'turn/start');
    const persisted = f.snapshots.at(-1).threads['automation:job'];
    assert.equal(persisted.active, true);
    assert.equal(persisted.uncertain, true);
    assert.equal(persisted.freshUnstarted, true);
    return { turn: { id: 'accepted-turn' } };
  });
  await f.bridge.startTurn(f.record, [{ type: 'text', text: 'Task' }], undefined, { settings: {} });
  assert.equal(f.record.freshUnstarted, undefined);
  assert.equal(f.record.uncertain, false);
  assert.equal(f.record.turnId, 'accepted-turn');
  assert.equal(f.run.turnId, 'accepted-turn');
  assert.equal(f.snapshots.at(-1).threads['automation:job'].freshUnstarted, undefined);
});

test('an ambiguous first turn keeps the durable uncertainty guard and is never treated as unused', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Codex request timed out'); });
  await assert.rejects(f.bridge.startTurn(f.record, [{ type: 'text', text: 'Task' }], undefined, { settings: {} }), /timed out/);
  assert.equal(calls, 1);
  assert.equal(f.record.active, false);
  assert.equal(f.record.uncertain, true);
  assert.equal(f.record.freshUnstarted, true);
  assert.equal(f.snapshots.at(-1).threads['automation:job'].uncertain, true);
});
