import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DISCORD_LINK = /^https:\/\/(?:discord\.com|discordapp\.com)\/channels\/[0-9]+\/[0-9]+(?:\/[0-9]+)?$/;
const MAX_TEXT_LENGTH = 20_000;
const MAX_SOURCE_LENGTH = 2_048;
const MAX_RESULTS = 20;

function validSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/.test(source)) return false;
  if (DISCORD_LINK.test(source)) return true;
  if (/^https:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  }
  if (source.startsWith('/') || source.startsWith('\\') || /^[a-zA-Z]:/.test(source)) return false;
  return source.split(/[\\/]/).every(part => part && part !== '.' && part !== '..');
}

export class Knowledge {
  constructor(root) {
    if (typeof root !== 'string' || !root.trim()) throw new TypeError('Knowledge root must be a non-empty path.');
    this.root = resolve(root);
    this.writes = new Map();
  }

  async add(projectId, { text, source }) {
    this.validateProjectId(projectId);
    const item = this.validateEntry({ text, source });

    return this.writeProject(projectId, entries => {
      const at = new Date().toISOString();
      const entry = { id: randomUUID(), text: item.text, source: item.source, createdAt: at, updatedAt: at };
      entries.push(entry);
      return { entries, result: entry };
    });
  }

  async update(projectId, id, { text, source }) {
    this.validateProjectId(projectId);
    if (typeof id !== 'string' || !id) throw new TypeError('Knowledge entry id is required.');
    const patch = this.validateEntry({ text, source });

    return this.writeProject(projectId, entries => {
      const index = entries.findIndex(entry => entry.id === id);
      if (index === -1) throw new Error('Knowledge entry not found.');
      const updated = { ...entries[index], ...patch, updatedAt: new Date().toISOString() };
      entries[index] = updated;
      return { entries, result: updated };
    });
  }

  async remove(projectId, id) {
    this.validateProjectId(projectId);
    if (typeof id !== 'string' || !id) throw new TypeError('Knowledge entry id is required.');

    return this.writeProject(projectId, entries => {
      const remaining = entries.filter(entry => entry.id !== id);
      if (remaining.length === entries.length) throw new Error('Knowledge entry not found.');
      return { entries: remaining, result: true };
    });
  }

  async search(projectId, query) {
    this.validateProjectId(projectId);
    if (typeof query !== 'string' || query.length > MAX_TEXT_LENGTH) throw new TypeError('Search query must be text within the configured limit.');
    const entries = await this.readProject(projectId);
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return entries.slice(-MAX_RESULTS).reverse();

    return entries
      .filter(entry => terms.every(term => `${entry.text}\n${entry.source}`.toLocaleLowerCase().includes(term)))
      .slice(-MAX_RESULTS)
      .reverse();
  }

  validateProjectId(projectId) {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new TypeError('Invalid project id.');
  }

  validateEntry({ text, source }) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) throw new TypeError(`Knowledge text must be non-empty and at most ${MAX_TEXT_LENGTH} characters.`);
    const reference = typeof source === 'string' ? source.trim() : source;
    if (!validSource(reference)) throw new TypeError('Knowledge source must be a bounded HTTPS URL, Discord message link, or safe project-relative path.');
    return { text: text.trim(), source: reference };
  }

  projectDirectory(projectId) {
    this.validateProjectId(projectId);
    return join(this.root, 'knowledge', projectId);
  }

  async ensureDirectory(projectId) {
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Knowledge root must be a real directory.');

    const knowledgePath = join(this.root, 'knowledge');
    await mkdir(knowledgePath, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const knowledgeInfo = await lstat(knowledgePath);
    if (!knowledgeInfo.isDirectory() || knowledgeInfo.isSymbolicLink()) throw new Error('Knowledge directory must not be a symlink.');

    const directory = this.projectDirectory(projectId);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const projectInfo = await lstat(directory);
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) throw new Error('Project knowledge directory must not be a symlink.');
    return directory;
  }

  async readProject(projectId) {
    this.validateProjectId(projectId);
    const directory = this.projectDirectory(projectId);
    try {
      const rootInfo = await lstat(this.root);
      const knowledgeInfo = await lstat(join(this.root, 'knowledge'));
      const projectInfo = await lstat(directory);
      if (![rootInfo, knowledgeInfo, projectInfo].every(info => info.isDirectory() && !info.isSymbolicLink())) throw new Error('Knowledge path contains a symlink or non-directory.');
      const file = join(directory, 'entries.json');
      const fileInfo = await lstat(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('Knowledge data must be a regular file.');
      const entries = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('Invalid knowledge data.');
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  writeProject(projectId, change) {
    const previous = this.writes.get(projectId) || Promise.resolve();
    const writing = previous.catch(() => {}).then(async () => {
      const directory = await this.ensureDirectory(projectId);
      const entries = await this.readProject(projectId);
      const { entries: next, result } = change(entries);
      const file = join(directory, 'entries.json');
      const temporary = join(directory, `.entries-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return result;
    });
    this.writes.set(projectId, writing);
    return writing.finally(() => { if (this.writes.get(projectId) === writing) this.writes.delete(projectId); });
  }
}
