import { randomUUID } from 'node:crypto';
import { ChannelType, escapeMarkdown } from 'discord.js';
import { authorized } from './config.js';
import { say } from './messages.js';
import { RETENTION_MS } from './archive-retention.js';
import { failureText } from './run-failure.js';
import { forgetMessages, hasPendingWork } from './conversations.js';

export function privateOutput(interaction) {
  let sent = false;
  return { send: async payload => {
    const safe = { ...payload, allowedMentions: { parse: [] } };
    const result = sent ? await interaction.followUp({ ...safe, flags: 64 }) : await interaction.editReply(safe);
    sent = true;
    return result;
  } };
}

export class ConversationUI {
  constructor(bridge) { this.bridge = bridge; this.actions = new Map(); }
  close() { this.actions.clear(); }

  action(channelId, run) {
    for (const [id, value] of this.actions) if (value.expires < Date.now()) this.actions.delete(id);
    const id = randomUUID();
    this.actions.set(id, { channelId, run, expires: Date.now() + 600_000 });
    return `conversation:${id}`;
  }

  button(channelId, label, run, danger = false) {
    return { type: 2, style: danger ? 4 : 2, label, custom_id: this.action(channelId, run) };
  }

  async interaction(interaction) {
    const id = interaction.customId.slice('conversation:'.length);
    const action = this.actions.get(id);
    if (!authorized(this.bridge.config, interaction) || !this.bridge.ready || this.bridge.cleanup.isDeleted(interaction.channelId) ||
      !action || action.channelId !== interaction.channelId || action.expires < Date.now()) {
      return interaction.reply({ content: 'Nabídka vypršela nebo není dostupná. Otevři příkaz znovu.', flags: 64 });
    }
    this.actions.delete(id); // Single-use, including double clicks and duplicate destructive requests.
    await interaction.deferReply({ flags: 64 });
    const output = privateOutput(interaction);
    try { await action.run(output, interaction.values?.[0]); }
    catch { await say(output, 'Operaci se nepodařilo dokončit. Historie nebyla automaticky znovu použita. Otevři přehled znovu a ověř stav.'); }
  }

  async menu(output, channelId, title, items, select, page = 0) {
    const start = page * 20;
    const visible = items.slice(start, start + 20);
    if (!visible.length) return say(output, `${title}\nŽádné položky.`);
    const id = this.action(channelId, async (out, value) => {
      if (!visible.some(item => item.value === value)) return say(out, 'Neplatný výběr.');
      return select(out, value);
    });
    const components = [{ type: 1, components: [{ type: 3, custom_id: id, placeholder: 'Vyber položku', options: visible }] }];
    const buttons = [];
    if (page > 0) buttons.push(this.button(channelId, 'Předchozí', out => this.menu(out, channelId, title, items, select, page - 1)));
    if (start + 20 < items.length) buttons.push(this.button(channelId, 'Další', out => this.menu(out, channelId, title, items, select, page + 1)));
    if (buttons.length) components.push({ type: 1, components: buttons });
    return output.send({ content: `${title} · strana ${page + 1}/${Math.ceil(items.length / 20)}`, components });
  }

  choose(output, channelId, name, argument, records) {
    return this.menu(output, channelId, 'Vyber konverzaci', records.map(r => ({ value: r.codexId,
      label: (r.title || (r.kind === 'automation' ? 'Automatizace' : 'Běžný chat')).slice(0, 100),
      description: `${r.kind === 'automation' ? 'Automatizace' : 'Chat'} · ${r.active ? 'pracuje' : r.uncertain ? 'ověř stav' : 'nepracuje'}`,
    })), (out, id) => this.bridge.control(name, argument, channelId, out, id));
  }

  async reset(output, channelId) {
    const b = this.bridge;
    const record = b.store.state.threads[channelId];
    if (hasPendingWork(b, channelId)) return say(output, 'Nejprve dokonči práci v tomto kanálu (včetně automatizací), vyřiď /queue a případně ověř /status. Potom použij /new znovu; reset se sám neprovede.');
    const plan = record && b.store.state.contextPlans[record.codexId];
    if (plan && plan.phase !== 'proposed') return say(output, 'Nejprve ověř rozpracovaný přenos kontextu přes /status.');
    b.busy.add(channelId);
    const release = b.cleanup.hold(channelId);
    try {
      if (record) {
        // Capture pending automation context before retiring its source.
        for (const job of Object.values(b.store.state.schedules)) {
          if (job.sourceId === record.codexId && job.contextPending && job.status !== 'deleted') await b.scheduler.prepare(job);
          if (job.sourceId === record.codexId && job.contextPending && job.status !== 'deleted') return say(output, 'Nejprve dokonči nebo ověř založení automatizace v /automations.');
        }
        await b.archives.retire(channelId, 'new');
      }
      if (record) delete b.store.state.contextPlans[record.codexId];
      delete b.store.state.contextSeeds[channelId];
      b.store.state.freshChannels[channelId] = true;
      await b.store.save();
      await say(output, 'Další zpráva začne čistou konverzaci. Předchozí historie je v /archive a po 90 dnech se smaže. Zprávy, soubory, ostatní konverzace a automatizace zůstávají.');
    } finally { release(); b.busy.delete(channelId); }
  }

  archives(output, channelId) {
    const records = Object.values(this.bridge.store.state.retiredThreads).sort((a, b) => b.deletedAt - a.deletedAt);
    return this.menu(output, channelId, 'Archivované konverzace', records.map(r => ({ value: r.codexId,
      label: (r.title || 'Konverzace').slice(0, 100),
      description: `${r.kind === 'main' ? 'Hlavní chat' : r.kind === 'automation' ? 'Automatizace' : 'Vlákno'} · archiv ${new Date(r.deletedAt).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' })} · smazání ${new Date(r.deletedAt + RETENTION_MS).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' })}`,
    })), (out, id) => this.archiveDetails(out, channelId, id));
  }

  async archiveDetails(output, channelId, id) {
    const r = this.bridge.store.state.retiredThreads[id];
    if (!r) return say(output, 'Konverzace již není v archivu.');
    const buttons = [
      this.button(channelId, 'Zobrazit historii', out => this.history(out, id)),
      this.button(channelId, 'Obnovit do vlákna', out => this.restore(out, id)),
      this.button(channelId, 'Trvale smazat', out => out.send({ content: 'Trvale smazat historii Codexu? Nelze vrátit. Soubory ve workspace zůstanou.',
        components: [{ type: 1, components: [this.button(channelId, 'Potvrdit trvalé smazání', target => this.remove(target, id, r.deletedAt), true)] }] }), true),
    ];
    return output.send({ content: `**${escapeMarkdown(r.title || 'Konverzace')}**\nArchivováno: <t:${Math.floor(r.deletedAt / 1000)}:f>\nSmazání: <t:${Math.floor((r.deletedAt + RETENTION_MS) / 1000)}:f>`, components: [{ type: 1, components: buttons }] });
  }

  async history(output, id) {
    return this.bridge.archives.locked(id, async () => {
      if (!this.bridge.store.state.retiredThreads[id]) return say(output, 'Konverzace již není v archivu.');
      const thread = await this.bridge.cleanup.readThread(id);
      const text = (thread.turns || []).flatMap(turn => (turn.items || []).flatMap(item => {
        if (item.type === 'agentMessage') return [`Agent:\n${item.text}`];
        if (item.type === 'userMessage') return [`Uživatel:\n${(item.content || []).map(c => c.text || `[${c.type}]`).join('\n')}`];
        return [];
      })).join('\n\n');
      await say(output, 'Historie zpráv (uživatel a agent):', { files: [{ attachment: Buffer.from(text || '(Prázdná konverzace)'), name: 'conversation.txt' }] });
    });
  }

  async restore(output, id) {
    const b = this.bridge;
    return b.archives.locked(id, async () => {
      const r = b.store.state.retiredThreads[id];
      if (!r) return say(output, 'Konverzace již není v archivu.');
      if (r.restoreCreating) return say(output, 'Předchozí založení vlákna má nejistý výsledek. Zkontroluj Discord; operaci nelze automaticky zopakovat.');
      if (!r.restoreTarget) {
        r.restoreCreating = true;
        await b.store.save();
        const parent = await b.discord.channels.fetch(b.config.channelId);
        const channel = await parent.threads.create({ name: (r.title || 'Obnovená konverzace').slice(0, 90), type: ChannelType.PublicThread, autoArchiveDuration: 1440 });
        r.restoreTarget = channel.id;
        r.restoreCreating = false;
        await b.store.save();
      }
      const channel = await b.discord.channels.fetch(r.restoreTarget, { force: true });
      if (!channel || b.cleanup.isDeleted(channel.id)) throw new Error('Restore destination was deleted.');
      if (await b.cleanup.isArchived(id)) await b.rpc.call('thread/unarchive', { threadId: id });
      await b.rpc.call('thread/resume', { threadId: id, ...b.threadSettings() });
      b.store.state.threads[channel.id] = { codexId: id, discordId: channel.id, title: r.title, kind: 'thread', active: false, tools: r.tools };
      delete b.store.state.retiredThreads[id];
      await b.store.save();
      await say(output, `Konverzace obnovena: <#${channel.id}>. Automatizace se samy znovu nespustily.`);
    });
  }

  async remove(output, id, expectedArchiveAt) {
    const b = this.bridge;
    return b.archives.locked(id, async () => {
      const record = b.store.state.retiredThreads[id];
      if (!record || (expectedArchiveAt !== undefined && record.deletedAt !== expectedArchiveAt) || record.restoreTarget || record.restoreCreating || b.record(id)) return say(output, 'Konverzace již není dostupná ke smazání.');
      if (!await b.cleanup.isArchived(id)) return say(output, 'Konverzace není archivovaná; nebyla smazána.');
      const thread = await b.cleanup.readThread(id);
      if (!['idle', 'notLoaded'].includes(thread.status?.type) || thread.turns?.some(t => t.status === 'inProgress')) return say(output, 'Konverzace není nečinná; nebyla smazána.');
      await b.rpc.call('thread/delete', { threadId: id });
      delete b.store.state.retiredThreads[id];
      forgetMessages(b.store.state, id);
      await b.store.save();
      await say(output, 'Historie byla trvale smazána. Soubory zůstaly zachované.');
    });
  }

  automations(output, channelId) {
    const jobs = Object.values(this.bridge.store.state.schedules).filter(j => j.discordId === channelId);
    return this.menu(output, channelId, 'Automatizace v tomto kanálu', jobs.map(j => ({ value: j.id, label: j.title.slice(0, 100),
      description: `${({ enabled: 'Zapnutá', paused: 'Pozastavená', attention: 'Vyžaduje kontrolu', completed: 'Dokončená', deleted: 'Zastavená po smazání vlákna' })[j.status]}${j.nextRun ? ` · ${new Date(j.nextRun).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })}` : ''}`.slice(0, 100),
    })), async (out, id) => {
      const job = this.bridge.store.state.schedules[id];
      if (!job || job.discordId !== channelId) return say(out, 'Automatizace již není dostupná.');
      await out.send({ content: `**${escapeMarkdown(job.title)}**\nStav: ${job.status}${job.status === 'attention' ? '\nDalší běhy jsou blokované do opětovného zapnutí.' : ''}${job.lastFailure ? `\n${escapeMarkdown(failureText(job.lastFailure))}\nČas chyby: <t:${Math.floor(job.lastFailure.at / 1000)}:f>` : ''}\nCíl: <#${job.discordId}>${job.pendingDestination ? `\nČeká na přesun do <#${job.pendingDestination}>. Původní vlákno zatím nemaž.` : ''}${job.destinationError ? `\n${job.destinationError}` : ''}\n${job.nextRun ? `${job.status === 'enabled' ? 'Další termín' : 'Uložený termín (neběží automaticky)'}: <t:${Math.floor(job.nextRun / 1000)}:f>` : 'Bez dalšího termínu.'}`,
        components: [{ type: 1, components: [
          this.button(channelId, job.status === 'enabled' ? 'Pozastavit' : 'Zapnout', async target => {
            if (job.discordId !== channelId) return say(target, 'Automatizace se mezitím přesunula. Otevři /automations v novém cíli.');
            await this.bridge.scheduler.setStatus(id, job.status === 'enabled' ? 'paused' : 'enabled');
            await say(target, `Stav automatizace: ${job.status}. Pozastavení nezastavuje právě běžící úkol; použij /stop.`);
          }),
          ...(channelId !== this.bridge.config.channelId && job.status !== 'deleted' ? [this.button(channelId, 'Posílat do hlavního chatu', async target => {
            try {
              const result = await this.bridge.scheduler.delivery.request(job, 'main', channelId);
              await say(target, result.note);
            } catch (error) { await say(target, error.message); }
          })] : []),
          ...(job.pendingDestination ? [this.button(channelId, 'Zrušit změnu cíle', async target => {
            try {
              const result = await this.bridge.scheduler.delivery.request(job, 'here', channelId);
              await say(target, result.note);
            } catch (error) { await say(target, error.message); }
          })] : []),
          { ...this.button(channelId, 'Stav konverzace', target => this.bridge.control('status', '', channelId, target, job.codexId)), disabled: !job.codexId },
        ] }] });
    });
  }
}
