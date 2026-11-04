import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Incidents } from '../src/incidents.js';

test('verified incidents group transitions, suppress repeats, and never start inference', async t => {
  const root = await mkdtemp(join(tmpdir(), 'incident-')); t.after(() => rm(root, { recursive: true, force: true }));
  let created = 0; const sent = [];
  const thread = { id: 'thread', guildId: 'guild', parentId: 'main', isThread: () => true, send: async p => { sent.push(p); } };
  const bridge = { config: { workspace: root, channelId: 'main', guildId: 'guild' },
    store: { state: { incidents: {}, destinations: {} }, save: async () => {} }, projects: { getProject: () => ({ path: root }) },
    cleanup: { isDeleted: () => false }, rpc: { call: () => assert.fail('incident must not invoke Codex') },
    discord: { channels: { fetch: async id => id === 'main' ? { threads: { create: async () => { created++; return thread; } } } : thread } } };
  const incidents = new Incidents(bridge);
  const event = { id: '1', resource: 'n8n', source: 'coolify', destination: 'main', projectId: 'ops', status: 'problem', summary: '@everyone unhealthy', occurredAt: new Date().toISOString() };
  await incidents.receive(event); await incidents.receive(event);
  await incidents.receive({ ...event, id: '2', status: 'recovered', summary: 'Healthy' });
  assert.equal(created, 1); assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  const saved = Object.values(bridge.store.state.incidents)[0]; assert.equal(saved.delivery, 'sent');
  assert.equal(JSON.parse(await readFile(join(root, 'artifacts/incidents', saved.id, 'latest.json'))).status, 'recovered');
});

test('unknown thread creation result is not retried', async () => {
  let calls = 0;
  const b = { config: { channelId: 'main' }, store: { state: { incidents: {}, destinations: {} }, save: async () => {} },
    projects: { getProject: () => ({ path: '/workspace' }) }, discord: { channels: { fetch: async () => ({ threads: { create: async () => { calls++; throw Error('timeout'); } } }) } } };
  const i = new Incidents(b), e = { resource: 'n8n', source: 'coolify', destination: 'main', projectId: 'ops', status: 'problem', summary: 'Down' };
  await assert.rejects(i.receive(e)); await assert.rejects(i.receive(e)); assert.equal(calls, 1);
});
