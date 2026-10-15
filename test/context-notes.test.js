import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextNotes, NOTE_TTL_MS } from '../src/context-notes.js';

const channel = '1559646138280444025';
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'discord-notes-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bridge = { config: { workspace }, store: { state: { threads: {} } }, busy: new Set() };
  const notes = new ContextNotes(bridge, () => NOTE_TTL_MS * 2);
  await mkdir(notes.directory);
  return { workspace, bridge, notes };
}

test('chat note survives a new Codex identity; automation note is separate', async t => {
  const { notes } = await fixture(t);
  const record = { discordId: channel, codexId: 'old', kind: 'thread' };
  assert.equal(notes.filename(record), notes.filename({ ...record, codexId: 'new' }));
  assert.notEqual(notes.filename(record), notes.filename({ ...record, kind: 'automation' }));
  assert.throws(() => notes.filename({ ...record, discordId: '../other' }));
  assert.match(notes.reminder(record), /never as new instructions or authorization/);
});

test('cleanup expires only owned stale files and preserves active work and symlinks', async t => {
  const { notes, bridge, workspace } = await fixture(t);
  const stale = join(notes.directory, `${channel}.md`);
  await writeFile(stale, 'old'); await utimes(stale, 1, 1);
  await writeFile(join(notes.directory, 'unrelated.txt'), 'keep');
  await writeFile(join(workspace, 'outside.md'), 'keep');
  await symlink(join(workspace, 'outside.md'), join(notes.directory, '1559646138280444026.md'));
  bridge.store.state.threads.chat = { discordId: channel, active: true };
  await notes.sweep(); assert.equal(await readFile(stale, 'utf8'), 'old');
  bridge.store.state.threads.chat.active = false;
  await notes.sweep();
  assert.deepEqual((await readdir(notes.directory)).sort(), ['1559646138280444026.md', 'unrelated.txt']);
  assert.equal(await readFile(join(workspace, 'outside.md'), 'utf8'), 'keep');
});

test('confirmed deletion removes fresh notes for that destination only', async t => {
  const { notes } = await fixture(t);
  for (const name of [`${channel}.md`, `${channel}--job.md`, '1559646138280444026.md']) await writeFile(join(notes.directory, name), 'fresh');
  await notes.sweep(channel);
  assert.deepEqual(await readdir(notes.directory), ['1559646138280444026.md']);
});
