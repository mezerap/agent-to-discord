import { randomUUID } from 'node:crypto';
import { initializeState } from './conversations.js';
import { nextRun } from './scheduler.js';

// Explicit operator migration: never runs merely because the bridge starts.
// Existing prompts/history stay private in the store; only active recurring jobs are recreated.
export function rebuildSchedules(state, { projects, jobProjects, now = Date.now() }) {
  initializeState(state);
  if (state.platformMigration) throw new Error('This platform migration has already been applied.');
  if (Object.values(state.threads).some(r => r.active || r.uncertain || r.retiring) || Object.keys(state.queuedMessages).length ||
    Object.values(state.schedules).some(j => j.preparing || j.contextPending)) throw new Error('Finish pending work before migration.');
  const result = structuredClone(state);
  result.projects = { ...result.projects, ...projects };
  result.scheduleArchive ??= {};
  const rebuilt = {};
  const mapping = {};
  for (const job of Object.values(result.schedules)) {
    result.scheduleArchive[job.id] = { ...job, archivedAt: now, previousStatus: job.status, status: 'archived' };
    if (job.status !== 'enabled') continue;
    if (!['cron', 'interval'].includes(job.schedule.type)) throw new Error('Review active one-shot schedules before rebuilding them.');
    const projectId = jobProjects[job.id];
    const project = result.projects[projectId];
    if (!project || !project.path) throw new Error('Every active schedule needs an explicit project mapping.');
    const execution = job.execution || result.modelPreferences[job.discordId];
    if (!execution?.model) throw new Error('Every rebuilt schedule needs an explicit verified model.');
    const id = randomUUID();
    const workspace = { projectId, cwd: project.path, agent: 'primary' };
    let prompt = job.prompt;
    for (const [oldPath, newPath] of Object.entries(project.pathAliases || {})) prompt = prompt.replaceAll(oldPath, newPath);
    rebuilt[id] = { id, title: job.title, prompt, schedule: structuredClone(job.schedule), discordId: job.discordId,
      status: 'enabled', nextRun: nextRun(job.schedule, now), createdAt: now, contextMode: 'fresh', contextPending: true,
      workspace, execution: structuredClone(execution), notificationMode: 'always', runs: [], migratedFrom: job.id };
    mapping[job.id] = id;
    result.destinations[job.discordId] = workspace;
    const chat = result.threads[job.discordId];
    if (chat && chat.kind !== 'automation') chat.workspace = structuredClone(workspace);
  }
  for (const record of Object.values(result.threads)) {
    if (record.kind === 'automation') { record.retiring = 'migration'; record.deletedAt = now; }
  }
  result.schedules = rebuilt;
  result.platformMigration = { version: 1, at: now, scheduleIds: mapping };
  return result;
}
