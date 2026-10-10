import { recordsAt } from './conversations.js';
import { say } from './messages.js';

export const MAIN_IDLE_MS = 24 * 60 * 60 * 1000;

export class IdleContext {
  constructor(bridge, now = Date.now) {
    this.bridge = bridge;
    this.now = now;
    this.resetting = false;
    // Older releases did not track activity. Give existing chats a full day
    // from migration instead of guessing their age and archiving immediately.
    const main = bridge.store.state.threads[bridge.config.channelId];
    if (main && !Number.isFinite(main.lastActivityAt)) main.lastActivityAt = now();
  }

  touch(record) {
    if (record?.kind === 'main') record.lastActivityAt = this.now();
  }

  // The caller holds the channel busy/cleanup lock. Queued work never enters
  // here; it finishes in its captured context and refreshes the activity time.
  async beforeMessage(channel, record) {
    const b = this.bridge;
    if (channel.id !== b.config.channelId || !record || record.kind !== 'main' ||
      !Number.isFinite(record.lastActivityAt) || this.now() - record.lastActivityAt < MAIN_IDLE_MS ||
      b.queue.has(channel.id) || recordsAt(b, channel.id).some(r => r.active || r.uncertain || r.retiring)) return record;

    this.resetting = true;
    try {
      for (const job of Object.values(b.store.state.schedules)) {
        if (job.sourceId !== record.codexId || !job.contextPending || job.status === 'deleted') continue;
        await b.scheduler.prepare(job);
        if (job.contextPending) return record;
      }
      if (b.closing || b.cleanup.isDeleted(channel.id)) throw new Error('Channel unavailable during idle reset.');
      await b.archives.retire(channel.id, 'idle');
      b.store.state.freshChannels[channel.id] = true;
      await b.store.save();
      await say(channel, 'Po 24 hodinách neaktivity začínám nový kontext. Předchozí konverzace je v /archive a po 90 dnech se smaže. Soubory a automatizace zůstávají.').catch(() => {
        console.error('Idle-context reset notice could not be delivered.');
      });
      return undefined;
    } finally { this.resetting = false; }
  }
}
