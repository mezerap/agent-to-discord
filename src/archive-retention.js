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
    const { store, rpc } = this.bridge;
    const cutoff = this.now() - RETENTION_MS;
    const due = Object.entries(store.state.retiredThreads || {}).filter(([id, record]) =>
      record.codexId === id && Number.isSafeInteger(record.deletedAt) && record.deletedAt > 0 && record.deletedAt <= cutoff);
    if (!due.length || this.bridge.closing) return;

    // Complete pagination before changing anything. A partial or failed listing proves nothing.
    const archived = await this.archivedIds();
    for (const [id, record] of due) {
      if (this.bridge.closing) return;
      if (Object.values(store.state.threads).some(thread => thread.codexId === id)) continue;
      try {
        if (archived.has(id)) {
          const thread = await this.bridge.cleanup.readThread(id);
          if (!['idle', 'notLoaded'].includes(thread.status?.type) ||
            thread.turns?.some(turn => turn.status === 'inProgress')) continue;
          // An external client may have restored it since the initial paginated listing.
          if (!await this.bridge.cleanup.isArchived(id)) {
            delete store.state.retiredThreads[id];
            await store.save();
            continue;
          }
          if (this.bridge.closing) return;
          await rpc.call('thread/delete', { threadId: id });
          console.log('Deleted Discord thread: archived Codex history removed after 90 days.');
        }
        // Restored or already deleted outside the bridge: cancel retention, never re-archive it.
        if (store.state.retiredThreads[id] === record) delete store.state.retiredThreads[id];
        await store.save();
      } catch {
        // Includes an unknown delete outcome. Next sweep verifies the archive index before retrying.
        console.error('Could not remove an expired conversation; retention will retry.');
      }
    }
  }
}
