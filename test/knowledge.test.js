import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Knowledge } from '../src/knowledge.js';

const source = 'https://discord.com/channels/123456789012345/234567890123456/345678901234567';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'a2d-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, knowledge: new Knowledge(root) };
}

test('knowledge CRUD stores dates and source links under the selected project', async t => {
  const { root, knowledge } = await fixture(t);
  const entry = await knowledge.add('calendar', { text: ' Venue closes at 20:00. ', source });

  assert.equal(entry.text, 'Venue closes at 20:00.');
  assert.equal(entry.source, source);
  assert.equal(Number.isFinite(Date.parse(entry.createdAt)), true);
  assert.equal(entry.createdAt, entry.updatedAt);
  assert.deepEqual(await knowledge.search('calendar', 'venue 20:00'), [entry]);
  assert.deepEqual(await knowledge.search('billing', 'venue'), []);

  const updated = await knowledge.update('calendar', entry.id, { text: 'New opening time is 21:00.', source });
  assert.equal(updated.id, entry.id);
  assert.equal(updated.createdAt, entry.createdAt);
  assert.notEqual(updated.updatedAt, entry.updatedAt);
  assert.deepEqual(await knowledge.search('calendar', 'venue'), []);
  assert.equal(await knowledge.remove('calendar', entry.id), true);
  assert.deepEqual(await knowledge.search('calendar', ''), []);
  assert.match(await readFile(join(root, 'knowledge', 'calendar', 'entries.json'), 'utf8'), /\[\]/);
});

test('knowledge validates IDs, source links and text; search returns a bounded newest-first set', async t => {
  const { knowledge } = await fixture(t);
  await assert.rejects(knowledge.add('../outside', { text: 'x', source }), /project id/i);
  const webReference = await knowledge.add('safe', { text: 'A fact from an official page.', source: 'https://example.com/docs' });
  const localReference = await knowledge.add('safe', { text: 'A fact from the codebase.', source: 'src/config.js' });
  assert.equal(webReference.source, 'https://example.com/docs');
  assert.equal(localReference.source, 'src/config.js');
  await assert.rejects(knowledge.add('safe', { text: 'x', source: '../outside.md' }), /source/i);
  await assert.rejects(knowledge.add('safe', { text: '   ', source }), /text/i);

  const entries = [];
  for (let i = 0; i < 25; i++) entries.push(await knowledge.add('safe', { text: `shared fact ${i}`, source }));
  const found = await knowledge.search('safe', 'shared');
  assert.equal(found.length, 20);
  assert.equal(found[0].id, entries[24].id);
  assert.equal(found.at(-1).id, entries[5].id);
});

test('concurrent adds serialize without losing entries', async t => {
  const { knowledge } = await fixture(t);
  const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => knowledge.add('parallel', { text: `fact ${i}`, source })));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 12);
  assert.equal((await knowledge.search('parallel', 'fact')).length, 12);
});

test('knowledge rejects project-directory and data-file symlinks', async t => {
  const { root, knowledge } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'a2d-knowledge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, 'knowledge'), { recursive: true });
  await symlink(outside, join(root, 'knowledge', 'linked'));
  await assert.rejects(knowledge.add('linked', { text: 'private', source }), /symlink/i);

  await mkdir(join(root, 'knowledge', 'data-link'));
  await symlink(join(outside, 'entries.json'), join(root, 'knowledge', 'data-link', 'entries.json'));
  await assert.rejects(knowledge.search('data-link', 'anything'), /regular file|symlink/i);
});
