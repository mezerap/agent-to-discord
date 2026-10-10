import { forgetMessages } from './conversations.js';
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const RETENTION_CHECK_MS = 60 * 60 * 1000;

export class ArchiveRetention {
  constructor(bridge, now = Date.now) {
    this.bridge = bridge;
    this.now = now;
  }

  sweep() {
    if (!this.running) this.running = this.prune().catch(() => {
      console.error('Archived conversation retention is pending; it will be retried.');
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async archivedIds() {
    const ids = new Set();
    let cursor;
    do {
      const page = await this.bridge.rpc.call('thread/list', { archived: true, modelProviders: [], limit: 100, cursor });
      for (const thread of page.data) ids.add(thread.id);
      cursor = page.nextCursor;
    } while (cursor);
    return ids;
  }

  async prune() {
    const { store } = this.bridge;
    const cutoff = this.now() - RETENTION_MS;
    const due = Object.entries(store.state.retiredThreads || {}).filter(([id, record]) =>
      record.codexId === id && Number.isSafeInteger(record.deletedAt) && record.deletedAt > 0 && record.deletedAt <= cutoff);
    if (!due.length || this.bridge.closing) return;

    // Complete pagination before changing anything. A partial or failed listing proves nothing.
    const archived = await this.archivedIds();
    for (const [id, record] of due) {
      if (this.bridge.closing) return;
      const work = () => this.pruneOne(id, record, archived);
      try {
        if (this.bridge.archives) await this.bridge.archives.locked(id, work);
        else await work();
      } catch {
        console.error('Could not remove an expired conversation; retention will retry.');
      }
    }
  }

  async pruneOne(id, record, archived) {
    const { store, rpc } = this.bridge;
    if (this.bridge.closing || store.state.retiredThreads[id] !== record || record.restoreTarget || record.restoreCreating ||
      Object.values(store.state.threads).some(thread => thread.codexId === id)) return;
    if (archived.has(id)) {
      const thread = await this.bridge.cleanup.readThread(id);
      if (!['idle', 'notLoaded'].includes(thread.status?.type) || thread.turns?.some(turn => turn.status === 'inProgress')) return;
      if (!await this.bridge.cleanup.isArchived(id)) {
        delete store.state.retiredThreads[id];
        await store.save();
        return;
      }
      if (this.bridge.closing) return;
      await rpc.call('thread/delete', { threadId: id });
      console.log('Archived Codex history removed after 90 days.');
    }
    if (store.state.retiredThreads[id] === record) delete store.state.retiredThreads[id];
    forgetMessages(store.state, id);
    await store.save();
  }
}
