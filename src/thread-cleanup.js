export function isUnknownChannel(error) {
  return error?.code === 10003; // Discord's explicit Unknown Channel, not 403 or a network failure.
}

export class ThreadCleanup {
  constructor(bridge) {
    this.bridge = bridge;
    this.deleted = new Set();
    this.operations = new Map();
    this.jobs = new Map();
  }

  isDeleted(id) {
    return this.deleted.has(id) || this.bridge.store.state.threads[id]?.deleted === true;
  }

  hold(id) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this.operations.set(id, promise);
    return () => { if (this.operations.get(id) === promise) this.operations.delete(id); release(); };
  }

  async remove(id) {
    this.deleted.add(id); // Suppress new work and approvals immediately, even while thread/start is pending.
    const record = this.bridge.store.state.threads[id];
    if (record) record.deleted = true;
    this.bridge.cancelPending(id);
    if (this.jobs.has(id)) return this.jobs.get(id);

    const job = this.finish(id).catch(() => {
      console.error('Deleted thread cleanup is pending; it will be retried.');
    }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }

  async finish(id) {
    const { store, rpc } = this.bridge;
    await store.save();
    await this.operations.get(id); // A turn/start already in flight must settle before cancellation.
    const record = store.state.threads[id];
    if (!record) return;
    record.deleted = true;
    await store.save();
    this.bridge.cancelPending(id);

    let thread = await this.readThread(record.codexId);
    const active = thread.turns?.find(turn => turn.status === 'inProgress');
    if (active && thread.status?.type !== 'notLoaded') {
      try { await rpc.call('turn/interrupt', { threadId: record.codexId, turnId: active.id }); }
      catch { /* The turn may have completed concurrently; verify its state below. */ }
      thread = await this.readThread(record.codexId);
      if (thread.status?.type !== 'notLoaded' && thread.turns?.some(turn => turn.status === 'inProgress')) {
        throw new Error('Waiting for turn cancellation.');
      }
    }
    if (thread.status?.type === 'active') throw new Error('Waiting for thread to become idle.');
    try { await rpc.call('thread/archive', { threadId: record.codexId }); }
    catch (error) {
      // Codex 0.162.1 rejects a repeated archive. Confirm the prior success through its archive index.
      if (!await this.isArchived(record.codexId)) throw error;
    }
    delete store.state.threads[id];
    await store.save();
    console.log('Deleted Discord thread: Codex conversation archived; workspace files preserved.');
  }

  async readThread(threadId) {
    try { return (await this.bridge.rpc.call('thread/read', { threadId, includeTurns: true })).thread; }
    catch (error) {
      // A newly created, empty thread may not support reading turns yet.
      const { thread } = await this.bridge.rpc.call('thread/read', { threadId, includeTurns: false });
      if (!['idle', 'notLoaded'].includes(thread.status?.type)) throw error;
      return thread;
    }
  }

  async isArchived(threadId) {
    let cursor;
    do {
      const page = await this.bridge.rpc.call('thread/list', { archived: true, limit: 100, cursor });
      if (page.data.some(thread => thread.id === threadId)) return true;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }

  reconcile() {
    if (!this.reconciliation) this.reconciliation = this.checkThreads().finally(() => { this.reconciliation = null; });
    return this.reconciliation;
  }

  async checkThreads() {
    for (const record of Object.values(this.bridge.store.state.threads)) {
      if (this.isDeleted(record.discordId)) { await this.remove(record.discordId); continue; }
      try {
        // Force REST: archived threads can be absent from the Gateway cache and still exist.
        await this.bridge.discord.channels.fetch(record.discordId, { force: true });
      } catch (error) {
        if (isUnknownChannel(error)) await this.remove(record.discordId);
        else console.error('Could not check a Discord thread; its conversation was preserved.');
      }
    }
  }

  async retry() {
    for (const record of Object.values(this.bridge.store.state.threads)) {
      if (this.isDeleted(record.discordId)) await this.remove(record.discordId);
    }
  }
}
