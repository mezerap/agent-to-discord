import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Incidents } from '../src/incidents.js';

async function fixture(t, { channelOverrides = {}, send = async () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'incident-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const fetches = [];
  const channel = {
    id: 'main',
    guildId: 'guild',
    type: ChannelType.GuildText,
    send: async payload => { sent.push(payload); return send(payload); },
    ...channelOverrides,
  };
  const bridge = {
    config: { workspace: root, channelId: 'main', guildId: 'guild' },
    store: { state: { incidents: {}, destinations: {} }, save: async () => {} },
    projects: { getProject: projectId => projectId === 'ops' ? ({ path: root }) : assert.fail(`unexpected project ${projectId}`) },
    cleanup: { isDeleted: () => false },
    rpc: { call: () => assert.fail('incident must not invoke Codex') },
    discord: { channels: { fetch: async (id, options) => { fetches.push({ id, options }); return channel; } } },
  };
  return { root, sent, fetches, bridge, incidents: new Incidents(bridge) };
}

function event(overrides = {}) {
  return {
    id: 'event-1',
    resource: 'api-service-1',
    source: 'coolify',
    destination: 'main',
    projectId: 'ops',
    status: 'problem',
    summary: '@everyone service is unhealthy',
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

test('verified incident transitions post concise messages in main and suppress repeats without inference', async t => {
  const f = await fixture(t);
  const first = event();
  await f.incidents.receive(first);
  await f.incidents.receive(first);
  await f.incidents.receive(event({ id: 'event-2', status: 'recovered', summary: 'Service is healthy.' }));

  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
  assert.match(f.sent[0].content, /api-service-1: problém/u);
  assert.match(f.sent[1].content, /api-service-1: obnoveno/u);
  assert.match(f.sent[1].content, /Zdroj: coolify/u);
  assert.doesNotMatch(f.sent[0].content, /artifacts|Model se automaticky|workspace/u);
  assert.deepEqual(f.fetches.map(item => item.id), ['main', 'main']);
  assert.deepEqual(f.bridge.store.state.destinations, {});

  const saved = Object.values(f.bridge.store.state.incidents)[0];
  assert.equal(saved.delivery, 'sent');
  assert.equal(JSON.parse(await readFile(join(f.root, 'artifacts/incidents', saved.id, 'latest.json'))).status, 'recovered');
});

test('legacy incidents keep their thread mapping but send new transitions only to main', async t => {
  const f = await fixture(t);
  const legacyId = 'legacy-thread';
  const incidentId = createHash('sha256').update('coolify:api-service-1').digest('hex').slice(0, 32);
  const savedMapping = { projectId: 'old-project', cwd: '/workspace/old', agent: 'agent2' };
  f.bridge.store.state.destinations[legacyId] = savedMapping;
  f.bridge.store.state.incidents[incidentId] = {
    id: incidentId, source: 'coolify', resource: 'api-service-1', projectId: 'ops',
    discordId: legacyId, fingerprint: 'prior-fingerprint', delivery: 'sent',
  };

  await f.incidents.receive(event({ status: 'recovered', summary: 'Service is healthy.' }));

  assert.equal(f.sent.length, 1);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].id, 'main');
  assert.equal(f.bridge.store.state.incidents[incidentId].discordId, legacyId);
  assert.equal(f.bridge.store.state.destinations[legacyId], savedMapping);
  assert.equal(Object.hasOwn(f.bridge.store.state.destinations, 'main'), false);
});

test('event destination and fetched main channel identity, guild, and type are validated', async t => {
  const wrongEventDestination = await fixture(t);
  await assert.rejects(wrongEventDestination.incidents.receive(event({ destination: 'elsewhere' })), /Invalid incident destination/u);
  assert.deepEqual(wrongEventDestination.bridge.store.state.incidents, {});

  for (const channelOverrides of [
    { id: 'other' },
    { guildId: 'other-guild' },
    { type: ChannelType.DM },
  ]) {
    const f = await fixture(t, { channelOverrides });
    await assert.rejects(f.incidents.receive(event()), /Configured incident destination is unavailable/u);
    assert.equal(Object.values(f.bridge.store.state.incidents)[0].delivery, 'uncertain');
    assert.equal(f.sent.length, 0);
  }
});

test('an uncertain main-channel send is never automatically retried', async t => {
  let calls = 0;
  const f = await fixture(t, { send: async () => { calls++; throw new Error('timeout'); } });
  const current = event();

  await assert.rejects(f.incidents.receive(current), /timeout/u);
  await assert.rejects(f.incidents.receive(current), /Previous incident delivery is uncertain/u);
  assert.equal(calls, 1);
  assert.equal(Object.values(f.bridge.store.state.incidents)[0].delivery, 'uncertain');
});
