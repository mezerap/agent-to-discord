import { createHash } from 'node:crypto';
import { readFile, mkdir, realpath, writeFile, rename, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { EventInbox } from './event-inbox.js';
import { isWithin } from './files.js';
import { say } from './messages.js';

export class Incidents {
  constructor(bridge) { this.bridge = bridge; }

  async load() {
    const b = this.bridge;
    if (!b.config.stateDir) return;
    let config;
    try {
      const file = await open(join(b.config.stateDir, 'events.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { config = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    } catch (error) { if (error.code === 'ENOENT') return; throw new Error('Invalid private event configuration.'); }
    for (const source of Object.values(config.sources || {})) {
      if (source.destination !== b.config.channelId || !b.store.state.projects[source.projectId]) throw new Error('Event source must target the configured main channel and an allowed project.');
    }
    this.inbox = new EventInbox(b, { directory: join(b.config.stateDir, 'event-inbox'), key: config.key, sources: config.sources,
      onEvent: event => this.receive(event) });
    if (!this.inbox.enabled) throw new Error('Event configuration requires a strong key and at least one source.');
  }

  tick() {
    if (!this.bridge.ready || this.bridge.closing) return Promise.resolve();
    return this.inbox?.tick().catch(() => { console.error('Event inbox requires inspection; events were not replayed.'); });
  }

  async receive(event) {
    const b = this.bridge;
    if (b.closing) throw new Error('Bridge is closing.');
    if (event.destination !== b.config.channelId) throw new Error('Invalid incident destination.');
    b.projects.getProject(event.projectId);
    const id = createHash('sha256').update(`${event.source}:${event.resource}`).digest('hex').slice(0, 32);
    const fingerprint = createHash('sha256').update(`${event.status}\0${event.summary}`).digest('hex');
    let incident = b.store.state.incidents[id];
    if (incident?.fingerprint === fingerprint && incident.delivery === 'sent') return;
    if (incident && ['creating', 'sending', 'uncertain'].includes(incident.delivery)) throw new Error('Previous incident delivery is uncertain; inspect it manually.');
    if (!incident && Object.keys(b.store.state.incidents).length >= 500) throw new Error('Incident registry is full; inspect retention.');
    incident ??= b.store.state.incidents[id] = { id, source: event.source, resource: event.resource, projectId: event.projectId, createdAt: Date.now() };
    incident.event = event;
    incident.fingerprint = fingerprint;
    incident.updatedAt = Date.now();
    incident.delivery = 'sending';
    await b.store.save();
    try {
      const channel = await b.discord.channels.fetch(b.config.channelId, { force: true });
      if (channel?.id !== b.config.channelId || channel.guildId !== b.config.guildId || channel.type !== ChannelType.GuildText) {
        throw new Error('Configured incident destination is unavailable.');
      }
      await this.artifact(id, event);
      const summary = event.summary.length > 1200 ? `${event.summary.slice(0, 1199)}…` : event.summary;
      const status = event.status === 'problem' ? 'problém' : event.status === 'recovered' ? 'obnoveno' : event.status;
      await say(channel, `**${event.resource}: ${status}**\n${summary}\nZdroj: ${event.source} · <t:${Math.floor(Date.parse(event.occurredAt) / 1000)}:f>`);
      incident.delivery = 'sent';
      await b.store.save();
    } catch (error) {
      incident.delivery = 'uncertain';
      await b.store.save();
      throw error;
    }
  }

  async artifact(id, event) {
    const root = await realpath(this.bridge.config.workspace);
    const directory = join(root, 'artifacts', 'incidents', id);
    await mkdir(directory, { recursive: true });
    if (!isWithin(root, await realpath(directory))) throw new Error('Incident path escapes workspace.');
    const file = join(directory, 'latest.json');
    const temporary = join(directory, `${createHash('sha256').update(event.id).digest('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify(event, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
    return file;
  }
}
