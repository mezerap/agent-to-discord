import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationUI } from '../src/automation-ui.js';

function fixture() {
  const state = { schedules: { job: { id: 'job', discordId: 'channel', title: 'Daily report', status: 'enabled',
    nextRun: 1000, execution: null, notificationMode: 'change', runs: [] } } };
  const sent = [], menus = [], buttons = [], configured = [], requests = [];
  const bridge = {
    config: { model: 'gpt-default' },
    cleanup: { isDeleted: () => false },
    store: { state },
    scheduler: {
      delivery: { destination: async (_value, id) => { if (id !== 'channel') throw new Error('invalid destination'); return id; } },
      requestRun: async (...args) => requests.push(args),
      setStatus: async () => {},
      configure: async (...args) => configured.push(args),
    },
    models: {
      preference: () => null,
      list: async () => [{ model: 'gpt-sol', name: 'GPT Sol', effort: 'medium', efforts: [
        { effort: 'low', description: 'Quick' }, { effort: 'medium', description: 'Balanced' },
      ] }],
    },
    ui: {
      button: (_channel, label, run) => { const button = { label, run }; buttons.push(button); return button; },
      menu: async (_output, _channel, title, items, select, page = 0) => { const menu = { title, items, select, page }; menus.push(menu); return menu; },
    },
  };
  const output = { send: async payload => { sent.push(payload); return payload; } };
  return { ui: new AutomationUI(bridge), bridge, output, sent, menus, buttons, configured, requests };
}

test('details shows model inheritance, notification mode, cadence and separate run outcomes', async () => {
  const f = fixture();
  f.bridge.store.state.schedules.job.runs = [{ id: 'run', kind: 'scheduled', status: 'completed', startedAt: 10, completedAt: 20,
    execution: null, deliveryStatus: 'suppressed', resultChanged: false }];
  await f.ui.details(f.output, 'channel', 'job');
  assert.match(f.sent[0].content, /Dědí model: \*\*gpt-default\*\*/);
  assert.match(f.sent[0].content, /pouze při změně výsledku/);
  assert.match(f.sent[0].content, /dokončeno · potlačeno jako nezměněné/);
  assert.equal(f.sent[0].components[0].components.length, 5);
});

test('run now rechecks the live destination and delegates without touching schedule', async () => {
  const f = fixture();
  const before = f.bridge.store.state.schedules.job.nextRun;
  await f.ui.runNow(f.output, 'channel', 'job');
  assert.deepEqual(f.requests, [['job', 'channel']]);
  assert.equal(f.bridge.store.state.schedules.job.nextRun, before);
  f.bridge.cleanup.isDeleted = () => true;
  await f.ui.runNow(f.output, 'channel', 'job');
  assert.equal(f.requests.length, 1);
  assert.match(f.sent.at(-1).content, /již není dostupný/);
});

test('model selection rejects a stale menu before writing its choice', async () => {
  const f = fixture();
  await f.ui.chooseModel(f.output, 'channel', 'job');
  f.bridge.store.state.schedules.job.execution = { model: 'other', effort: 'high' };
  await f.menus[0].select(f.output, 'gpt-sol');
  assert.equal(f.configured.length, 0);
  assert.match(f.sent.at(-1).content, /mezitím změnilo/);
});

test('model and effort menus persist only a still-supported selection', async () => {
  const f = fixture();
  await f.ui.chooseModel(f.output, 'channel', 'job');
  await f.menus[0].select(f.output, 'gpt-sol');
  const effortMenu = f.menus.at(-1);
  assert.deepEqual(effortMenu.items.map(item => item.value), ['__default__', 'low', 'medium']);
  await effortMenu.select(f.output, 'high');
  assert.equal(f.configured.length, 0);
  assert.match(f.sent.at(-1).content, /již není platná/);
  await effortMenu.select(f.output, 'medium');
  assert.deepEqual(f.configured.at(-1), ['job', 'channel', { execution: { model: 'gpt-sol', effort: 'medium' } }]);
});

test('history exposes completion and delivery independently', async () => {
  const f = fixture();
  f.bridge.store.state.schedules.job.runs = [
    { id: 'run1', kind: 'manual', status: 'completed', startedAt: 10, completedAt: 20, deliveryStatus: 'failed', deliveryError: 'discord down' },
  ];
  await f.ui.history(f.output, 'channel', 'job');
  assert.match(f.menus[0].items[0].label, /dokončeno/);
  assert.match(f.menus[0].items[0].description, /doručení selhalo/);
  await f.menus[0].select(f.output, 'run1');
  assert.match(f.sent.at(-1).content, /Doručení: doručení selhalo/);
  assert.match(f.sent.at(-1).content, /Chyba doručení: discord down/);
});
