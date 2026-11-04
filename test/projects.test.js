import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectManager } from '../src/projects.js';

const execFile = promisify(execFileCb);

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function fixture(t) {
  const tempWorkspace = await mkdtemp(join(tmpdir(), 'discord-projects-'));
  t.after(() => rm(tempWorkspace, { recursive: true, force: true }));
  const workspace = await realpath(tempWorkspace);
  const projectPath = join(workspace, 'sample');
  await mkdir(projectPath);
  await git(projectPath, 'init', '-b', 'main');
  await git(projectPath, 'config', 'user.name', 'Bridge Test');
  await git(projectPath, 'config', 'user.email', 'bridge-test@example.invalid');
  await writeFile(join(projectPath, 'README.md'), 'start\n');
  await git(projectPath, 'add', 'README.md');
  await git(projectPath, 'commit', '-m', 'initial');
  const bridge = {
    config: { workspace },
    store: { state: { projects: { sample: { id: 'sample', name: 'Sample', path: projectPath } }, destinations: {}, tasks: {}, threads: {}, schedules: {} }, save: async () => {} },
    busy: new Set(),
    queue: { has: () => false },
  };
  return { bridge, manager: new ProjectManager(bridge), projectPath, workspace };
}

test('project binding is isolated by channel and settings reject stale or external paths', async t => {
  const { bridge, manager, workspace, projectPath } = await fixture(t);
  await manager.bind('channel-a', 'sample');
  assert.deepEqual(manager.settings('channel-a'), { cwd: projectPath });
  assert.deepEqual(manager.settings('channel-b'), { cwd: workspace });
  assert.deepEqual(await manager.resolveSettings('channel-a'), { cwd: projectPath });

  bridge.store.state.destinations['channel-a'].cwd = join(workspace, 'removed');
  await assert.rejects(manager.resolveSettings('channel-a'), /missing/);
  const outside = await mkdtemp(join(tmpdir(), 'discord-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  bridge.store.state.destinations['channel-a'].cwd = outside;
  await assert.rejects(manager.resolveSettings('channel-a'), /outside the workspace/);
});

test('binding rejects symlink escapes and refuses channels with active or queued work', async t => {
  const { bridge, manager, workspace } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'discord-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(workspace, 'escape'));
  bridge.store.state.projects.escape = { id: 'escape', name: 'Escape', path: join(workspace, 'escape') };
  await assert.rejects(manager.bind('channel-a', 'escape'), /outside the workspace/);

  bridge.store.state.threads.chat = { discordId: 'channel-a', active: false, uncertain: true };
  await assert.rejects(manager.bind('channel-a', 'sample'), /active, uncertain, or queued/);
  delete bridge.store.state.threads.chat;
  bridge.queue.has = id => id === 'channel-a';
  await assert.rejects(manager.bind('channel-a', 'sample'), /active, uncertain, or queued/);
});

test('binding permits an allowlisted non-Git workspace directory', async t => {
  const { bridge, manager, workspace } = await fixture(t);
  const directory = join(workspace, 'documents');
  await mkdir(directory);
  bridge.store.state.projects.docs = { id: 'docs', name: 'Documents', path: directory };
  assert.equal((await manager.bind('channel-docs', 'docs')).cwd, directory);
  await assert.rejects(manager.createTask('channel-docs', 'docs', 'needs-git'), /not a git repository/i);
});

test('binding freezes unmapped automation records and jobs to their previous workspace', async t => {
  const { bridge, manager, workspace } = await fixture(t);
  bridge.store.state.threads['automation:one'] = { discordId: 'channel-a', kind: 'automation', active: false };
  bridge.store.state.schedules.job = { discordId: 'channel-a', status: 'enabled' };
  await manager.bind('channel-a', 'sample');
  assert.deepEqual(bridge.store.state.threads['automation:one'].workspace, { cwd: workspace });
  assert.deepEqual(bridge.store.state.schedules.job.workspace, { cwd: workspace });
});

test('binding and task creation reject a project while project operations hold its lock', async t => {
  const { bridge, manager } = await fixture(t);
  manager.projectLocks.add('sample');
  await assert.rejects(manager.bind('channel-a', 'sample'), /project operation is already running/);
  await assert.rejects(manager.createTask('channel-a', 'sample', 'locked'), /project operation is already running/);
  assert.equal(bridge.busy.has('channel-a'), false);
});

test('merge reservation blocks active automation records by their Discord channel id', async t => {
  const { bridge, manager } = await fixture(t);
  const task = await manager.createTask('task-channel', 'sample', 'guard-automation');
  bridge.store.state.threads['automation:job-id'] = { discordId: 'automation-channel', kind: 'automation', active: true, workspace: { projectId: 'sample', cwd: bridge.config.workspace } };
  await assert.rejects(manager.finishTask(task.id, { merge: true }), /active, uncertain, or queued/);
  assert.equal(bridge.busy.has('automation-channel'), false);
});

test('task worktrees use committed baselines, stay channel scoped, and produce review metadata', async t => {
  const { bridge, manager, projectPath, workspace } = await fixture(t);
  const task = await manager.createTask('channel-a', 'sample', 'fix-reservation');
  assert.equal(task.baseRef, 'main');
  assert.match(task.branch, /^codex\/fix-reservation-[a-f0-9]{8}$/);
  assert.deepEqual(manager.settings('channel-a'), { cwd: task.path });
  assert.deepEqual(manager.settings('channel-b'), { cwd: workspace });
  assert.equal(await realpath(task.path), task.path);

  await writeFile(join(task.path, 'change.txt'), 'work\n');
  await git(task.path, 'add', 'change.txt');
  await git(task.path, 'commit', '-m', 'task work');
  const info = await manager.taskInfo(task.id);
  assert.deepEqual(info.files, ['change.txt']);
  assert.match(info.stat, /change.txt/);
  const review = await manager.prepareReview(task.id);
  assert.equal(review.baseSha, task.baseSha);
  assert.ok((await readFile(review.patchFile, 'utf8')).endsWith('\n'));
  await git(projectPath, 'apply', '--check', review.patchFile);
  assert.equal(JSON.parse(await readFile(review.file, 'utf8')).head, info.head);
  assert.equal(await realpath(projectPath), projectPath);
  assert.equal(bridge.store.state.tasks[task.id].id, task.id);
});

test('task creation preserves dirty source and preserves worktree when state persistence fails', async t => {
  const { bridge, manager, projectPath } = await fixture(t);
  await writeFile(join(projectPath, 'uncommitted.txt'), 'draft');
  const first = await manager.createTask('channel-b', 'sample', 'dirty');
  assert.equal(first.sourceDirty, true);
  assert.equal(await readFile(join(projectPath, 'uncommitted.txt'), 'utf8'), 'draft');
  const firstTask = bridge.store.state.tasks[first.id];
  await git(projectPath, 'worktree', 'remove', '--force', firstTask.path);
  await git(projectPath, 'branch', '-D', firstTask.branch);
  delete bridge.store.state.tasks[first.id];
  delete bridge.store.state.destinations['channel-b'];
  await rm(join(projectPath, 'uncommitted.txt'));

  bridge.store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(manager.createTask('channel-a', 'sample', 'rollback'), /worktree was preserved/);
  const [task] = Object.values(bridge.store.state.tasks);
  assert.equal(task.status, 'attention');
  assert.equal(await realpath(task.path), task.path);
  assert.ok((await readdir(join(projectPath, '.git', 'refs', 'heads', 'codex'))).some(name => name.startsWith('rollback-')));
  assert.equal(bridge.store.state.destinations['channel-a'], undefined);
});

test('merge is explicit and checks source cleanliness and unchanged base', async t => {
  const { manager, projectPath } = await fixture(t);
  const task = await manager.createTask('channel-a', 'sample', 'merge-task');
  await assert.rejects(manager.finishTask(task.id), /explicit merge option/);
  await writeFile(join(task.path, 'merged.txt'), 'done');
  await git(task.path, 'add', 'merged.txt');
  await git(task.path, 'commit', '-m', 'task change');
  const result = await manager.finishTask(task.id, { merge: true });
  assert.equal(result.status, 'merged');
  assert.equal(await readFile(join(projectPath, 'merged.txt'), 'utf8'), 'done');
});
