import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildSchedules } from '../src/platform-migration.js';

function fixture() {
  return { version: 1, threads: { 'automation:old': { codexId: 'old-context', kind: 'automation', active: false } }, seen: ['1'],
    schedules: { old: { id: 'old', title: 'Daily', prompt: 'Read /workspace/old/history and keep results', discordId: 'channel', status: 'enabled', schedule: { type: 'cron', expression: '0 16 * * *', timezone: 'Europe/Prague' } },
      paused: { id: 'paused', status: 'paused' } }, modelPreferences: { channel: { model: 'model', effort: 'high' } } };
}
const options = { projects: { p: { id: 'p', path: '/workspace/projects/new', pathAliases: { '/workspace/old': '/workspace/projects/new' } } }, jobProjects: { old: 'p' }, now: Date.parse('2026-11-04T10:00:00Z') };

test('fresh schedules retain purpose, destination and cadence; old definitions archived without deleting histories', () => {
  const original = fixture(); const migrated = rebuildSchedules(original, options);
  const [job] = Object.values(migrated.schedules);
  assert.equal(Object.keys(migrated.schedules).length, 1); assert.notEqual(job.id, 'old');
  assert.equal(job.contextMode, 'fresh'); assert.equal(job.sourceId, undefined);
  assert.equal(job.prompt, 'Read /workspace/projects/new/history and keep results');
  assert.equal(job.discordId, 'channel'); assert.deepEqual(job.execution, { model: 'model', effort: 'high' });
  assert.equal(job.nextRun, Date.parse('2026-11-04T15:00:00Z')); assert.equal(job.notificationMode, 'always');
  assert.equal(migrated.scheduleArchive.paused.previousStatus, 'paused'); assert.equal(migrated.threads['automation:old'].retiring, 'migration');
  assert.equal(original.schedules.old.status, 'enabled'); assert.equal(original.threads['automation:old'].retiring, undefined);
  assert.throws(() => rebuildSchedules(migrated, options), /already/);
});

test('migration refuses unmapped, active, or uncertain work before changing definitions', () => {
  assert.throws(() => rebuildSchedules(fixture(), { ...options, jobProjects: {} }), /mapping/);
  const active = fixture(); active.threads['automation:old'].uncertain = true;
  assert.throws(() => rebuildSchedules(active, options), /pending/);
  assert.equal(active.schedules.old.status, 'enabled');
});
