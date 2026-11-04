import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertProjectId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Invalid project id.');
  }
}

function assertSlug(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(value)) {
    throw new Error('Task slug must use lowercase letters, numbers, and hyphens.');
  }
}

async function git(cwd, args, { raw = false, ...options } = {}) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return raw ? stdout : stdout.trim();
}

export class ProjectManager {
  constructor(bridge) {
    this.bridge = bridge;
    this.locks = new Set();
    this.projectLocks = new Set();
  }

  get state() { return this.bridge.store.state; }

  settings(channelId, record) {
    const destination = this.state.destinations?.[channelId];
    const recordCwd = typeof record?.workspace === 'string' ? record.workspace : record?.workspace?.cwd;
    return { cwd: recordCwd || destination?.cwd || this.bridge.config.workspace };
  }

  async resolveSettings(channelId, record) {
    const root = await realpath(this.bridge.config.workspace);
    const cwd = this.settings(channelId, record).cwd;
    let canonical;
    try { canonical = await realpath(cwd); }
    catch { throw new Error(`The configured working directory is missing: ${cwd}`); }
    if (!within(root, canonical)) throw new Error('The configured working directory is outside the workspace.');

    const knownPaths = new Set();
    for (const project of Object.values(this.state.projects || {})) {
      try { knownPaths.add(await realpath(project.path)); } catch { /* The selected path below reports stale bindings. */ }
    }
    for (const task of Object.values(this.state.tasks || {})) knownPaths.add(resolve(task.path));
    if (canonical !== root && ![...knownPaths].some(path => canonical === path || within(path, canonical))) {
      throw new Error(`The configured working directory is not an allowed project or task path: ${canonical}`);
    }
    return { cwd: canonical };
  }

  listProjects() {
    return Object.values(this.state.projects || {}).map(project => ({ ...project }));
  }

  getProject(projectId) {
    assertProjectId(projectId);
    const project = this.state.projects?.[projectId];
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return { ...project };
  }

  async bind(channelId, projectId) {
    this.assertProjectUnlocked(projectId);
    const release = this.reserveChannel(channelId);
    try {
      const project = await this.canonicalProject(projectId, false);
      const previous = this.state.destinations[channelId];
      const previousWorkspace = this.state.threads?.[channelId]?.workspace;
      const restoreAutomationWorkspaces = this.freezeAutomationWorkspace(channelId);
      const destination = { projectId, cwd: project.path, agent: 'primary' };
      this.state.destinations[channelId] = destination;
      const record = this.state.threads?.[channelId];
      if (record && record.kind !== 'automation') record.workspace = { projectId, cwd: project.path };
      try { await this.bridge.store.save(); }
      catch (error) {
        if (previous) this.state.destinations[channelId] = previous;
        else delete this.state.destinations[channelId];
        if (record && record.kind !== 'automation') record.workspace = previousWorkspace;
        restoreAutomationWorkspaces();
        throw error;
      }
      return { ...destination };
    } finally { release(); }
  }

  async createTask(channelId, projectId, slug, baseRef) {
    assertSlug(slug);
    this.assertProjectUnlocked(projectId);
    const release = this.reserveChannel(channelId);

    let worktreePath;
    let branch;
    try {
      const project = await this.canonicalProject(projectId);
      const sourceBranch = await git(project.path, ['branch', '--show-current']);
      const sourceHead = await git(project.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      const selectedBase = baseRef || project.baseBranch;
      const baseSha = selectedBase ? await this.resolveLocalBranch(project.path, selectedBase) : sourceHead;
      const id = randomUUID();
      const shortId = id.slice(0, 8);
      branch = `codex/${slug}-${shortId}`;
      const workspace = await realpath(this.bridge.config.workspace);
      const parent = join(workspace, 'worktrees', project.id);
      await mkdir(parent, { recursive: true });
      if (!within(workspace, await realpath(parent))) throw new Error('Worktree directory escapes the workspace.');
      worktreePath = join(parent, id);

      await git(project.path, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
      const task = { id, projectId, projectPath: project.path, path: worktreePath, branch, baseRef: selectedBase || sourceBranch || 'HEAD', baseSha, sourceHead, sourceDirty: (await git(project.path, ['status', '--porcelain', '--untracked-files=all'])).length > 0, createdAt: new Date().toISOString(), channelId, status: 'open' };
      this.state.tasks ??= {};
      this.state.tasks[id] = task;
      const previous = this.state.destinations[channelId];
      const record = this.state.threads?.[channelId];
      const previousWorkspace = record?.workspace;
      const restoreAutomationWorkspaces = this.freezeAutomationWorkspace(channelId);
      this.state.destinations[channelId] = { projectId, cwd: worktreePath, branch, taskId: id, agent: 'primary' };
      if (record && record.kind !== 'automation') record.workspace = { projectId, cwd: worktreePath, branch, taskId: id };
      try { await this.bridge.store.save(); }
      catch (error) {
        task.status = 'attention';
        task.persistenceError = 'State save failed; preserve this worktree and branch for manual recovery.';
        if (previous) this.state.destinations[channelId] = previous;
        else delete this.state.destinations[channelId];
        if (record && record.kind !== 'automation') record.workspace = previousWorkspace;
        restoreAutomationWorkspaces();
        const failure = new Error(`State persistence failed; the task worktree was preserved at ${worktreePath}.`, { cause: error });
        throw failure;
      }
      return { ...task };
    } finally {
      release();
    }
  }

  async taskInfo(taskId) {
    const task = this.getTask(taskId);
    await this.assertTaskPath(task);
    const head = await git(task.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const status = await git(task.path, ['status', '--short', '--branch']);
    const stat = await git(task.path, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${task.baseSha}...HEAD`]);
    const files = await git(task.path, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', `${task.baseSha}...HEAD`]);
    return { ...task, head, gitStatus: status, stat, files: files ? files.split('\n') : [], compareUrl: await this.compareUrl(task) };
  }

  async prepareReview(taskId) {
    const task = this.getTask(taskId);
    const release = this.reserveProject(task);
    try {
      await this.assertTaskPath(task);
      const head = await git(task.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      const diff = await git(task.path, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${task.baseSha}...${head}`]);
      const files = await git(task.path, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', `${task.baseSha}...${head}`]);
      const root = await realpath(this.bridge.config.workspace);
      const directory = join(root, 'artifacts', 'reviews', task.id);
      await mkdir(directory, { recursive: true });
      if (!within(root, await realpath(directory))) throw new Error('Review artifact directory escapes the workspace.');
      const patch = await git(task.path, ['diff', '--no-ext-diff', '--no-textconv', '--binary', `${task.baseSha}...${head}`], { raw: true });
      const suffix = head.slice(0, 12);
      const patchFile = join(directory, `changes-${suffix}.patch`);
      await this.writeSafe(patchFile, patch);
      const clean = !(await git(task.path, ['status', '--porcelain', '--untracked-files=all']));
      const review = { taskId, projectId: task.projectId, branch: task.branch, baseRef: task.baseRef, baseSha: task.baseSha, head, diffStat: diff, files: files ? files.split('\n') : [], clean, patchFile, reviewerTarget: 'agent2', status: 'awaiting-connection', compareUrl: await this.compareUrl(task), preparedAt: new Date().toISOString() };
      const file = join(directory, 'review.json');
      await this.writeSafe(file, `${JSON.stringify(review, null, 2)}\n`);
      return { ...review, file };
    } finally { release(); }
  }

  async finishTask(taskId, { merge = false } = {}) {
    if (merge !== true) throw new Error('Task completion requires the explicit merge option.');
    const task = this.getTask(taskId);
    const release = this.reserveProject(task);
    try {
      await this.assertTaskPath(task);
      const taskBranch = await git(task.path, ['branch', '--show-current']);
      if (taskBranch !== task.branch) throw new Error(`The task worktree must be on ${task.branch} before merging.`);
      if (await git(task.path, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('The task worktree has uncommitted changes; commit or stash them before merging.');
      const taskHead = await git(task.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (await git(task.path, ['rev-parse', '--verify', `${task.branch}^{commit}`]) !== taskHead) throw new Error('The task branch no longer points to the worktree HEAD.');
      const source = task.projectPath;
      const dirty = await git(source, ['status', '--porcelain', '--untracked-files=all']);
      if (dirty) throw new Error('The source project has uncommitted changes; refusing to merge.');
      const currentBranch = await git(source, ['branch', '--show-current']);
      if (currentBranch !== task.baseRef) throw new Error(`Check out ${task.baseRef} in the source project before merging this task.`);
      const currentHead = await git(source, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (currentHead !== task.baseSha) throw new Error('The base branch changed after task creation; review and rebase before merging.');
      await git(source, ['merge-base', '--is-ancestor', task.baseSha, task.branch]);
      await git(source, ['merge', '--ff-only', task.branch]);
      task.status = 'merged';
      task.mergedHead = taskHead;
      await this.bridge.store.save();
      return { ...task };
    } finally { release(); }
  }

  async canonicalProject(projectId, requireGit = true) {
    const project = this.getProject(projectId);
    const root = await realpath(this.bridge.config.workspace);
    let path;
    try { path = await realpath(project.path); }
    catch { throw new Error(`The configured project path is missing: ${project.path}`); }
    if (!within(root, path)) throw new Error('The project path is outside the workspace.');
    if (requireGit) {
      const gitRoot = await git(path, ['rev-parse', '--show-toplevel']);
      if (await realpath(gitRoot) !== path) throw new Error(`Project ${projectId} must point to the Git repository root.`);
    }
    return { ...project, id: projectId, path };
  }

  async resolveLocalBranch(projectPath, branch) {
    if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw new Error('Base ref must be a local branch name.');
    const ref = `refs/heads/${branch}`;
    await git(projectPath, ['show-ref', '--verify', '--quiet', ref]);
    return git(projectPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  }

  assertChannelIdle(channelId) {
    const bridge = this.bridge;
    const active = Object.values(this.state.threads || {}).some(record => record.discordId === channelId && !record.deleted && (record.active || record.uncertain || record.retiring));
    if (bridge.closing || bridge.busy?.has(channelId) || bridge.queue?.has(channelId) || active) throw new Error('This channel has active, uncertain, or queued work.');
  }

  reserveChannel(channelId) {
    this.assertChannelIdle(channelId);
    if (this.locks.has(channelId)) throw new Error('A project operation is already running in this channel.');
    this.locks.add(channelId);
    this.bridge.busy?.add(channelId);
    const releaseCleanup = this.bridge.cleanup?.hold(channelId);
    return () => {
      releaseCleanup?.();
      this.bridge.busy?.delete(channelId);
      this.locks.delete(channelId);
    };
  }

  assertProjectUnlocked(projectId) {
    if (this.projectLocks.has(projectId)) throw new Error('A project operation is already running.');
  }

  freezeAutomationWorkspace(channelId) {
    const changedRecords = [];
    const changedJobs = [];
    for (const record of Object.values(this.state.threads || {})) {
      if (record.discordId !== channelId || record.kind !== 'automation' || record.workspace) continue;
      changedRecords.push([record, record.workspace]);
      record.workspace = { cwd: this.bridge.config.workspace };
    }
    for (const job of Object.values(this.state.schedules || {})) {
      if (job.discordId !== channelId || job.workspace) continue;
      changedJobs.push([job, job.workspace]);
      job.workspace = { cwd: this.bridge.config.workspace };
    }
    return () => {
      for (const [record, workspace] of changedRecords) record.workspace = workspace;
      for (const [job, workspace] of changedJobs) job.workspace = workspace;
    };
  }

  reserveProject(task) {
    if (this.projectLocks.has(task.projectId)) throw new Error('A project merge is already running.');
    const channels = new Set([task.channelId]);
    for (const [channelId, destination] of Object.entries(this.state.destinations || {})) {
      if (destination.taskId === task.id || destination.projectId === task.projectId) channels.add(channelId);
    }
    for (const record of Object.values(this.state.threads || {})) {
      const workspace = record.workspace;
      if (record.discordId && (workspace?.taskId === task.id || workspace?.projectId === task.projectId || workspace === task.path || workspace === task.projectPath || workspace?.cwd === task.path || workspace?.cwd === task.projectPath)) channels.add(record.discordId);
    }
    for (const channelId of channels) this.assertChannelIdle(channelId);
    this.projectLocks.add(task.projectId);
    const releases = [];
    for (const channelId of channels) {
      this.bridge.busy?.add(channelId);
      releases.push(this.bridge.cleanup?.hold(channelId));
    }
    return () => {
      for (const release of releases) release?.();
      for (const channelId of channels) this.bridge.busy?.delete(channelId);
      this.projectLocks.delete(task.projectId);
    };
  }

  async writeSafe(file, content) {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
  }

  getTask(taskId) {
    if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('Invalid task id.');
    const task = this.state.tasks?.[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  async assertTaskPath(task) {
    const root = await realpath(this.bridge.config.workspace);
    let path;
    try { path = await realpath(task.path); }
    catch { throw new Error(`The task worktree is missing: ${task.path}`); }
    if (!within(root, path) || path !== resolve(task.path)) throw new Error('Task worktree path is stale or outside the workspace.');
    const gitRoot = await git(path, ['rev-parse', '--show-toplevel']);
    if (await realpath(gitRoot) !== path) throw new Error('Task path is no longer a Git worktree.');
  }

  async compareUrl(task) {
    try {
      const remote = await git(task.projectPath, ['remote', 'get-url', 'origin']);
      const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
      return match ? `https://github.com/${match[1]}/compare/${encodeURIComponent(task.baseRef)}...${encodeURIComponent(task.branch)}` : null;
    } catch { return null; }
  }
}
