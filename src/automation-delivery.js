import { PermissionFlagsBits } from 'discord.js';

// Delivery changes never fork history or alter a schedule. Persist intent first so
// an active turn (and messages already queued for it) can finish at the old place.
export class AutomationDelivery {
  constructor(bridge) { this.bridge = bridge; }

  async destination(value, currentId) {
    const b = this.bridge;
    const id = value === 'main' ? b.config.channelId : value === 'here' ? currentId : String(value).replace(/^<#(\d+)>$/, '$1');
    if (b.cleanup.isDeleted(id)) throw new Error('Cílové vlákno bylo smazáno.');
    const channel = await b.discord.channels.fetch(id, { force: true });
    if (!channel || channel.guildId !== b.config.guildId ||
      (id !== b.config.channelId && (!channel.isThread?.() || channel.parentId !== b.config.channelId))) {
      throw new Error('Cílem může být jen nastavený hlavní kanál nebo jeho vlákno.');
    }
    const permissions = channel.permissionsFor(b.discord.user);
    const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    if (channel.archived || channel.locked || !permissions?.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.ReadMessageHistory])) {
      throw new Error('Cíl musí být otevřený a bot v něm musí mít právo číst a psát.');
    }
    return id;
  }

  async request(job, value, channelId) {
    const b = this.bridge;
    const id = await this.destination(value, channelId);
    if (job.status === 'deleted' || job.discordId !== channelId || b.cleanup.isDeleted(channelId) || b.cleanup.isDeleted(id)) {
      throw new Error('Automatizace nebo její cíl se mezitím změnily. Otevři /automations znovu.');
    }
    const record = b.record(job.codexId);
    if (record?.uncertain || record?.retiring || job.preparing) throw new Error('Nejprve ověř konverzaci přes /status a /automations.');
    if (id === job.discordId) delete job.pendingDestination;
    else job.pendingDestination = id;
    delete job.destinationError;
    await b.store.save();
    await this.apply(job);
    return { id: job.id, destination: job.discordId, pendingDestination: job.pendingDestination || null, destinationError: job.destinationError || null,
      note: job.destinationError || (job.pendingDestination ? 'Změna je uložená. Provede se po dokončení běhu, přípravy kontextu a fronty; do té doby nemaž původní vlákno.' : 'Cíl je nastaven. Zadání, rozvrh a kontext zůstávají zachované.') };
  }

  async apply(job) {
    const b = this.bridge, from = job.discordId, to = job.pendingDestination;
    if (!to || job.destinationError || job.status === 'deleted' || b.closing || b.cleanup.isDeleted(from) ||
      b.busy.has(from) || b.queue?.has(from)) return;
    const record = b.record(job.codexId);
    if (job.contextPending || !record || record.active || record.uncertain || record.retiring || record.deleted) return;
    b.busy.add(from);
    const release = b.cleanup.hold(from);
    try {
      await b.chains.get(record.codexId); // Finish delivery/cleanup of the preceding turn.
      await this.destination(to, from);
      // REST validation yields: deletion, a replacement request or queued input
      // can arrive while it is in flight. Never strand that input at the old ID.
      if (b.closing || job.discordId !== from || job.pendingDestination !== to || job.status === 'deleted' ||
        b.cleanup.isDeleted(from) || b.cleanup.isDeleted(to) || b.queue?.has(from) || record.active || record.uncertain || record.retiring || record.deleted) return;
      job.discordId = record.discordId = to;
      delete job.pendingDestination;
      delete job.destinationError;
      await b.store.save();
    } catch (error) {
      if (job.pendingDestination === to && job.status !== 'deleted') {
        job.destinationError = 'Změnu cíle se nepodařilo ověřit. Oprav přístup a zadej cíl znovu; další běhy do té doby čekají.';
        await b.store.save();
      } else throw error;
    } finally { release(); b.busy.delete(from); b.queue?.kick(from); }
  }
}
