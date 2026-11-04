import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventInbox, signEvent, verifyEvent } from '../src/event-inbox.js';

const key = 'test-only-event-key-at-least-32-bytes';
const sources = { coolify: { projectId: 'operations', destination: '123456789012345' } };
const destinationTime = '2026-11-04T10:00:00.000Z';

function envelope(id, overrides = {}) {
  const value = {
    id,
    source: 'coolify',
    projectId: 'spoofed-project',
    destination: '999999999999999',
    resource: 'coolify_service',
    occurredAt: destinationTime,
    summary: 'Deployment failed in production.',
    status: 'failed',
    ...overrides,
  };
  return { ...value, signature: signEvent(value, key) };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'a2d-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = {};
  const saved = [];
  const bridge = { store: { state, save: async () => saved.push(structuredClone(state.eventReceipts || {})) } };
  const inbox = new EventInbox(bridge, { directory, key, sources, now: () => Date.parse(destinationTime), ...options });
  return { directory, bridge, inbox, saved };
}

test('event authentication signs the whole envelope and rejects tampering or stale timestamps', async t => {
  const { inbox } = await fixture(t);
  const valid = envelope('evt-1');
  assert.equal(verifyEvent(valid, key), true);
  const accepted = await inbox.ingest(valid);
  assert.equal(accepted.status, 'pending');
  assert.equal(accepted.event.projectId, 'operations');
  assert.equal(accepted.event.destination, sources.coolify.destination);
  assert.equal(accepted.event.resource, 'coolify_service');

  const tampered = { ...valid, summary: 'changed after signature' };
  await assert.rejects(inbox.ingest(tampered), /signature/i);
  await assert.rejects(inbox.ingest(envelope('old', { occurredAt: '2026-11-04T09:00:00.000Z' })), /replay window/i);
  await assert.rejects(inbox.ingest(envelope('bad-resource', { resource: '../container' })), /resource/i);
});

test('event receipt persists before callback and duplicate events never callback twice', async t => {
  let called = 0;
  const { inbox, bridge, saved } = await fixture(t, { onEvent: async event => {
    called++;
    assert.equal(event.projectId, 'operations');
    throw new Error('uncertain notification result');
  } });
  const signed = envelope('uncertain-1');
  assert.equal((await inbox.ingest(signed)).status, 'uncertain');
  assert.equal((await inbox.ingest(signed)).status, 'uncertain');
  assert.equal(called, 1);
  assert.equal(bridge.store.state.eventReceipts['coolify:uncertain-1'].status, 'uncertain');
  assert.equal(saved.length >= 2, true);
});

test('event inbox retains a spool file when the receipt save fails, then retries after recovery', async t => {
  const { directory, inbox, bridge } = await fixture(t);
  const path = join(directory, 'retry.json');
  await writeFile(path, JSON.stringify(envelope('save-retry')));
  let fail = true;
  bridge.store.save = async () => { if (fail) throw new Error('disk unavailable'); };

  const first = await inbox.tick();
  assert.equal(first[0].status, 'rejected');
  assert.equal(bridge.store.state.eventReceipts['coolify:save-retry'], undefined);
  assert.equal((await readFile(path, 'utf8')).length > 0, true);

  fail = false;
  assert.equal((await inbox.tick())[0].status, 'pending');
});

test('a persisted processing receipt is recovered as uncertain without replaying its callback', async t => {
  let called = 0;
  const { inbox, bridge } = await fixture(t, { onEvent: async () => { called++; } });
  bridge.store.state.eventReceipts = {
    'coolify:crashed': { source: 'coolify', id: 'crashed', receivedAt: Date.parse(destinationTime), status: 'processing' },
  };

  assert.equal((await inbox.ingest(envelope('crashed'))).status, 'uncertain');
  assert.equal(bridge.store.state.eventReceipts['coolify:crashed'].status, 'uncertain');
  assert.equal(called, 0);
});

test('event inbox coalesces overlapping spool ticks and rejects short keys', async t => {
  let release;
  let called = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { directory, inbox } = await fixture(t, { onEvent: async () => { called++; await gate; } });
  await writeFile(join(directory, 'coalesced.json'), JSON.stringify(envelope('coalesced')));
  const unconfigured = new EventInbox({}, { directory, key: 'short', sources, now: () => Date.parse(destinationTime) });
  assert.equal(unconfigured.enabled, false);

  const first = inbox.tick();
  const second = inbox.tick();
  assert.equal(first, second);
  release();
  assert.equal((await first).length, 1);
  assert.equal(called, 1);
});

test('event source rate is limited to ten accepted events per minute', async t => {
  const { inbox } = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await inbox.ingest(envelope(`rate-${i}`))).status, 'pending');
  assert.equal((await inbox.ingest(envelope('rate-10'))).status, 'rate-limited');
});

test('rate-limited spool events stay queued and are accepted after the source window expires', async t => {
  let current = Date.parse(destinationTime);
  const { directory, inbox } = await fixture(t, { now: () => current });
  for (let i = 0; i < 10; i++) assert.equal((await inbox.ingest(envelope(`queued-rate-${i}`))).status, 'pending');
  const path = join(directory, 'queued.json');
  await writeFile(path, JSON.stringify(envelope('queued-rate-10')));

  assert.equal((await inbox.tick())[0].status, 'rate-limited');
  assert.equal((await readFile(path, 'utf8')).length > 0, true);
  current += 60_001;
  assert.equal((await inbox.tick())[0].status, 'pending');
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
});

test('bounded spool batches rotate past rate-limited files so another source can progress', async t => {
  const multiSources = { ...sources, backup: { projectId: 'operations', destination: '123456789012346' } };
  const { directory, inbox } = await fixture(t, { sources: multiSources, batchSize: 2 });
  for (let i = 0; i < 10; i++) assert.equal((await inbox.ingest(envelope(`rotate-rate-${i}`))).status, 'pending');
  const first = envelope('rotate-a', { source: 'coolify' });
  first.signature = signEvent(first, key);
  const second = envelope('rotate-b', { source: 'coolify' });
  second.signature = signEvent(second, key);
  const other = envelope('rotate-other', { source: 'backup' });
  other.signature = signEvent(other, key);
  await writeFile(join(directory, 'a-01.json'), JSON.stringify(first));
  await writeFile(join(directory, 'a-02.json'), JSON.stringify(second));
  await writeFile(join(directory, 'z-01.json'), JSON.stringify(other));

  assert.deepEqual((await inbox.tick()).map(result => result.status), ['rate-limited', 'rate-limited']);
  assert.equal((await inbox.tick())[0].event.source, 'backup');
});

test('spool tick accepts signed files, deduplicates, and rejects traversal and symlinks', async t => {
  const { directory, inbox } = await fixture(t);
  await writeFile(join(directory, '01.json'), JSON.stringify(envelope('spooled')));
  const outside = join(directory, '..', 'outside.json');
  await writeFile(outside, JSON.stringify(envelope('outside')));
  await assert.rejects(inbox.ingest(outside), /outside the inbox/i);
  await symlink(outside, join(directory, '02.json'));

  const results = await inbox.tick();
  assert.deepEqual(results.map(result => result.status), ['pending', 'rejected']);
  assert.equal((await inbox.tick()).length, 0);
  await rm(outside, { force: true });
});

test('event inbox remains disabled without configuration', async () => {
  const inbox = new EventInbox({}, {});
  assert.deepEqual(await inbox.tick(), []);
  await assert.rejects(inbox.ingest(envelope('disabled')), /disabled/i);
  const noStore = new EventInbox({}, { directory: '/private/tmp/events', key, sources });
  assert.equal(noStore.enabled, false);
});

test('event sources must be own properties in the trusted source map', async t => {
  const { directory, bridge } = await fixture(t);
  const inherited = Object.assign(Object.create({ coolify: sources.coolify }), { unrelated: sources.coolify });
  const inbox = new EventInbox(bridge, { directory, key, sources: inherited, now: () => Date.parse(destinationTime) });
  await assert.rejects(inbox.ingest(envelope('inherited-source')), /not configured/i);
});
