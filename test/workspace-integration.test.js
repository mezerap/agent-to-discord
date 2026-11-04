import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { ConversationUI } from '../src/conversation-ui.js';
import { createConversation, initializeState } from '../src/conversations.js';
import { ProjectManager } from '../src/projects.js';
import { WorkspaceUI } from '../src/workspace-ui.js';

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function fixture(t) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'discord-workspace-integration-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const workspace = await realpath(temporaryRoot);
  const projectPath = join(workspace, 'project');
  await mkdir(projectPath);
  await git(projectPath, 'init', '-b', 'main');
  await git(projectPath, 'config', 'user.name', 'Integration Test');
  await git(projectPath, 'config', 'user.email', 'integration@example.invalid');
  await writeFile(join(projectPath, 'README.md'), 'baseline\n');
  await git(projectPath, 'add', 'README.md');
  await git(projectPath, 'commit', '-m', 'baseline');

  const state = {};
  initializeState(state);
  state.projects.sample = { id: 'sample', name: 'Sample', path: projectPath, baseBranch: 'main' };
  const store = { state, save: async () => {} };
  const bridge = Object.create(Bridge.prototype);
  Object.assign(bridge, {
    config: { workspace, model: 'configured-model', executionMode: 'sandboxed', guildId: 'guild' },
    store,
    busy: new Set(),
    queue: { has: () => false, kick: () => {} },
    cleanup: { hold: () => () => {}, isDeleted: () => false },
    rpc: { calls: [], async call(method, params) { this.calls.push({ method, params }); return { turn: { id: 'turn-1' }, thread: { id: 'forked-thread' } }; } },
    projects: null,
    models: { turnSettings: () => ({ model: 'selected-model', effort: 'high' }) },
    idleContext: { touch() {} },
    contextNotes: { reminder: () => '' },
    typing: { start() {}, stop() {} },
    discord: { user: { id: 'bot' }, channels: { async fetch() {
      return { messages: { async fetch() { return { system: false, author: { id: 'human' }, content: 'starter' }; } } };
    } } },
    closing: false,
    contextNotes: { reminder: () => '' },
    idleContext: { touch() {} },
    handoff: {},
  });
  bridge.projects = new ProjectManager(bridge);
  bridge.archives = { locked: async (_id, work) => work() };
  bridge.record = id => Object.values(state.threads).find(record => record.codexId === id);
  return { bridge, projectPath, state, workspace };
}

test('old saved state initializes workspace maps without losing conversations', () => {
  const state = { version: 1, threads: { channel: { codexId: 'thread-1' } }, seen: [] };
  initializeState(state);
  assert.deepEqual(state.projects, {});
  assert.deepEqual(state.destinations, {});
  assert.deepEqual(state.tasks, {});
  assert.equal(state.threads.channel.codexId, 'thread-1');
});

test('project binding updates an ordinary conversation and leaves automation workspace unchanged', async t => {
  const { bridge, projectPath, state } = await fixture(t);
  state.threads.chat = { discordId: 'chat', codexId: 'chat-codex', kind: 'main', workspace: { cwd: bridge.config.workspace } };
  state.threads.automation = { discordId: 'automation', codexId: 'auto-codex', kind: 'automation', workspace: { projectId: 'old', cwd: '/old/path' } };
  await bridge.projects.bind('chat', 'sample');
  await bridge.projects.bind('automation', 'sample');
  assert.deepEqual(state.threads.chat.workspace, { projectId: 'sample', cwd: projectPath });
  assert.deepEqual(state.threads.automation.workspace, { projectId: 'old', cwd: '/old/path' });
  assert.equal(state.destinations.automation.projectId, 'sample');
});

test('startPrepared resumes with the project cwd and selected model, then starts in that cwd', async t => {
  const { bridge, projectPath, state } = await fixture(t);
  const record = { discordId: 'chat', codexId: 'codex-thread', kind: 'main', active: false, workspace: { projectId: 'sample', cwd: projectPath } };
  state.threads.chat = record;
  state.modelPreferences.chat = { model: 'selected-model' };
  await bridge.startPrepared({ id: 'chat' }, { input: [{ type: 'text', text: 'continue' }], text: 'continue' }, record);
  const resume = bridge.rpc.calls.find(call => call.method === 'thread/resume');
  const start = bridge.rpc.calls.find(call => call.method === 'turn/start');
  assert.equal(resume.params.cwd, projectPath);
  assert.equal(resume.params.model, 'selected-model');
  assert.equal(start.params.cwd, projectPath);
  assert.equal(start.params.model, 'selected-model');
});

test('archive restore retains a task worktree snapshot and resumes there', async t => {
  const { bridge, projectPath, state } = await fixture(t);
  const worktree = join(bridge.config.workspace, 'worktrees', 'sample', 'task-id');
  await mkdir(worktree, { recursive: true });
  const snapshot = { projectId: 'sample', cwd: worktree, taskId: 'task-id', branch: 'codex/task' };
  state.tasks['00000000-0000-4000-8000-000000000001'] = { id: '00000000-0000-4000-8000-000000000001', projectId: 'sample', path: worktree };
  state.modelPreferences['restored-channel'] = { model: 'selected-model' };
  state.retiredThreads['codex-old'] = { title: 'Archived', deletedAt: Date.now(), restoreTarget: 'restored-channel', workspace: snapshot };
  bridge.discord.channels.fetch = async id => ({ id, threads: { create: async () => ({ id: 'unused' }) } });
  bridge.cleanup.isArchived = async () => false;
  const ui = new ConversationUI(bridge);
  await ui.restore({ send: async () => {} }, 'codex-old');
  const resume = bridge.rpc.calls.find(call => call.method === 'thread/resume');
  assert.equal(resume.params.cwd, worktree);
  assert.equal(resume.params.model, 'selected-model');
  assert.deepEqual(state.threads['restored-channel'].workspace, snapshot);
  assert.deepEqual(state.destinations['restored-channel'], snapshot);
});

test('fork inherits the source task worktree scope', async t => {
  const { bridge, projectPath, state } = await fixture(t);
  const taskPath = join(bridge.config.workspace, 'worktrees', 'sample', 'task-source');
  await mkdir(taskPath, { recursive: true });
  const source = { discordId: 'source-channel', codexId: 'source-codex', turnId: 'turn-3', kind: 'main', workspace: { projectId: 'sample', cwd: taskPath, taskId: 'source-task', branch: 'codex/source' } };
  state.tasks['00000000-0000-4000-8000-000000000002'] = { id: '00000000-0000-4000-8000-000000000002', projectId: 'sample', path: taskPath };
  state.threads['source-channel'] = source;
  state.messages['new-thread'] = { codexId: 'source-codex', turnId: 'turn-3' };
  const channel = { id: 'new-thread', name: 'New task thread', isThread: () => true };
  await createConversation(bridge, channel, 'new thread');
  const fork = bridge.rpc.calls.find(call => call.method === 'thread/fork');
  assert.equal(fork.params.cwd, taskPath);
  assert.equal(state.threads['new-thread'].workspace.taskId, 'source-task');
  assert.equal(state.destinations['new-thread'].taskId, 'source-task');
  assert.equal(fork.params.cwd === projectPath, false);
});

test('bind is blocked by active and queued work', async t => {
  const { bridge, state } = await fixture(t);
  state.threads.chat = { discordId: 'chat', active: true };
  await assert.rejects(bridge.projects.bind('chat', 'sample'), /active, uncertain, or queued/);
  delete state.threads.chat;
  bridge.queue.has = id => id === 'chat';
  await assert.rejects(bridge.projects.bind('chat', 'sample'), /active, uncertain, or queued/);
});

test('knowledge is scoped to the selected project and scheduled writes are denied', async t => {
  const { bridge, state } = await fixture(t);
  const seen = [];
  bridge.knowledge = {
    async search(projectId) { seen.push(['search', projectId]); return []; },
    async add(projectId) { seen.push(['add', projectId]); return { id: 'note' }; },
  };
  const ui = new WorkspaceUI(bridge);
  const record = { discordId: 'chat', kind: 'main', workspace: { projectId: 'sample', cwd: bridge.config.workspace } };
  await ui.knowledgeTool(record, { action: 'search', query: 'topic' });
  assert.deepEqual(seen, [['search', 'sample']]);
  await assert.rejects(ui.knowledgeTool({ ...record, runKind: 'scheduled' }, { action: 'add', text: 'note' }), /pouze uživatelské zadání/);
  assert.equal(seen.length, 1);
});

test('PR preparation targets only the bound task branch and commit', async t => {
  const { bridge, state } = await fixture(t);
  const task = await bridge.projects.createTask('chat', 'sample', 'pr-target');
  const taskInfo = await bridge.projects.taskInfo(task.id);
  const calls = [];
  bridge.discord.channels.fetch = async id => ({ id });
  bridge.startPrepared = async (_channel, prepared) => calls.push(prepared.input[0].text);
  const ui = new WorkspaceUI(bridge);
  state.destinations.chat = { projectId: 'sample', cwd: task.path, taskId: task.id, branch: task.branch, agent: 'primary' };
  task.compareUrl = 'https://github.com/owner/repo/compare/main...task';
  bridge.projects.taskInfo = async id => {
    assert.equal(id, task.id);
    return { ...task, ...taskInfo, compareUrl: task.compareUrl };
  };
  await ui.task({ send: async () => {} }, 'chat', { action: 'pr' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`worktree ${task.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(calls[0].includes(`větev ${task.branch}`));
  assert.ok(calls[0].includes(`commit ${taskInfo.head}`));
  assert.ok(calls[0].includes(`základ ${task.baseRef} (${task.baseSha})`));
  assert.equal(calls[0].includes('source project'), false);
});
