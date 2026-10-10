import { randomUUID } from 'node:crypto';
import { say } from './messages.js';
import { recordsAt, referencedMessage, rememberMessage } from './conversations.js';

export class MessageQueue {
  constructor(bridge) { this.bridge = bridge; this.receipts = new Map(); this.operations = new Set(); }

  track(promise) {
    this.operations.add(promise);
    promise.then(() => this.operations.delete(promise), () => this.operations.delete(promise));
    return promise;
  }

  async settle() {
    while (this.operations.size || this.receipts.size) await Promise.allSettled([...this.operations, ...this.receipts.values()]);
  }

  entries(channelId) { return Object.values(this.bridge.store.state.queuedMessages).filter(e => e.discordId === channelId); }
  has(channelId) { return this.receipts.has(channelId) || this.entries(channelId).length > 0; }

  async recover() {
    for (const entry of Object.values(this.bridge.store.state.queuedMessages)) {
      if (['preparing', 'dispatching'].includes(entry.status)) entry.status = 'attention';
    }
    await this.bridge.store.save();
  }

  add(message) {
    const channelId = message.channelId;
    const previous = this.receipts.get(channelId) || Promise.resolve();
    const receipt = previous.catch(() => {}).then(() => this.saveMessage(message));
    this.receipts.set(channelId, receipt);
    return receipt.finally(() => {
      if (this.receipts.get(channelId) === receipt) this.receipts.delete(channelId);
      this.kick(channelId);
    });
  }

  async saveMessage(message) {
    const b = this.bridge, channelId = message.channelId;
    if (b.closing || b.cleanup.isDeleted(channelId) || !await b.store.remember(message.id)) return;
    if (b.closing || b.cleanup.isDeleted(channelId)) return;
    const entry = { id: randomUUID(), discordId: channelId, messageId: message.id, text: message.content.trim(), status: 'preparing', createdAt: Date.now() };
    b.store.state.queuedMessages[entry.id] = entry;
    await b.store.save();
    try {
      const quoted = await referencedMessage(b, message);
      const target = quoted?.ref && b.record(quoted.ref.codexId);
      const record = target?.kind === 'automation' && target.discordId === channelId && !target.deleted && !target.retiring
        ? target : b.store.state.threads[channelId];
      entry.targetId = b.idleContext.resetting && record?.kind === 'main' ? null : record?.codexId || null;
      entry.input = await b.messageInput(message, quoted);
      if (b.cleanup.isDeleted(channelId) || !b.store.state.queuedMessages[entry.id]) return;
      entry.status = 'queued';
      await b.store.save();
      await say(message.channel, `Zařazeno do fronty (${this.entries(channelId).length}). Po dokončení aktuálního úkolu zprávu zpracuji. Přehled: /queue.`, {
        components: [{ type: 1, components: this.buttons(entry) }],
      });
    } catch {
      if (!b.store.state.queuedMessages[entry.id]) return;
      // A failed acknowledgement does not invalidate an already persisted, ready entry.
      if (entry.status === 'preparing') { entry.status = 'attention'; await b.store.save(); }
      await say(message.channel, 'Zpráva je uložená ve frontě, ale vyžaduje kontrolu přes /queue.').catch(() => {});
    }
  }

  buttons(entry) {
    const b = this.bridge;
    return [
      ...(entry.status === 'queued' ? [b.ui.button(entry.discordId, 'Zahrnout hned', out => this.push(entry.id, out))] : []),
      b.ui.button(entry.discordId, 'Odebrat z fronty', out => this.remove(entry.id, out)),
    ];
  }

  async view(output, channelId) {
    const b = this.bridge, paused = b.store.state.queuePaused[channelId];
    if (paused) await say(output, 'Fronta je pozastavená. Pokračování ji znovu spustí, až bude konverzace připravená.', {
      components: [{ type: 1, components: [b.ui.button(channelId, 'Pokračovat ve frontě', async out => {
        delete b.store.state.queuePaused[channelId]; await b.store.save();
        await say(out, 'Fronta obnovena. Nejasné položky nejprve ověř a odeber; automaticky je neopakuji.');
        this.kick(channelId);
      })] }],
    });
    return b.ui.menu(output, channelId, 'Fronta zpráv', this.entries(channelId).map((e, i) => ({
      value: e.id, label: `${i + 1}. ${e.text || 'Přílohy'}`.slice(0, 100),
      description: { queued: 'Čeká na zpracování', preparing: 'Ukládám přílohy', dispatching: 'Předávám Codexu', attention: 'Ověř stav; automaticky se neopakuje' }[e.status],
    })), async (out, id) => {
      const entry = b.store.state.queuedMessages[id];
      if (!entry || entry.discordId !== channelId) return say(out, 'Položka už není ve frontě.');
      await say(out, entry.text || '(Zpráva s přílohami)', { components: [{ type: 1, components: this.buttons(entry) }] });
      if (entry.status === 'attention') await say(out, 'Příprava nebo předání se nepodařily potvrdit. Zpráva již mohla být zpracována. Ověř /status, pak ji odeber z fronty; nové odeslání je samostatné zadání.');
    });
  }

  async remove(id, output) {
    const b = this.bridge, entry = b.store.state.queuedMessages[id];
    if (!entry) return say(output, 'Položka už není ve frontě.');
    if (entry.status === 'dispatching') return say(output, 'Položka se právě předává. Pro zastavení běhu použij /stop.');
    delete b.store.state.queuedMessages[id];
    await b.store.save();
    await say(output, 'Odebráno z fronty. Původní zpráva a uložené přílohy zůstaly zachované.');
    this.kick(entry.discordId);
  }

  async pause(channelId) { this.bridge.store.state.queuePaused[channelId] = true; await this.bridge.store.save(); }

  drop(channelId) {
    const b = this.bridge;
    for (const entry of this.entries(channelId)) delete b.store.state.queuedMessages[entry.id];
    delete b.store.state.queuePaused[channelId];
  }

  kick(channelId) { void this.drain(channelId).catch(() => { console.error('Queued message needs inspection through /queue.'); }); }

  drain(channelId) { return this.track(this.runNext(channelId)); }

  async runNext(channelId) {
    const b = this.bridge;
    if (!b.ready || b.closing || b.busy.has(channelId) || this.receipts.has(channelId) || b.cleanup.isDeleted(channelId) || b.store.state.queuePaused[channelId]) return;
    if (recordsAt(b, channelId).some(r => r.active || r.uncertain || r.retiring)) return;
    const entry = this.entries(channelId)[0];
    if (!entry || entry.status !== 'queued') return;
    b.busy.add(channelId);
    const release = b.cleanup.hold(channelId);
    try {
      entry.status = 'dispatching';
      await b.store.save();
      const channel = await b.discord.channels.fetch(channelId);
      if (b.cleanup.isDeleted(channelId) || b.closing || b.store.state.queuePaused[channelId]) {
        if (b.store.state.queuedMessages[entry.id]) { entry.status = 'queued'; await b.store.save(); }
        return;
      }
      const record = entry.targetId ? b.record(entry.targetId) : b.store.state.threads[channelId];
      if (entry.targetId && (!record || record.discordId !== channelId || record.retiring || record.deleted)) throw new Error('Queue target changed.');
      await b.startPrepared(channel, entry, record);
      delete b.store.state.queuedMessages[entry.id];
      await b.store.save();
    } catch (error) {
      if (error.code === 10003) { void b.cleanup.remove(channelId); return; }
      if (b.store.state.queuedMessages[entry.id]) { entry.status = 'attention'; await b.store.save(); }
      const channel = await b.discord.channels.fetch(channelId).catch(() => null);
      if (channel && !b.cleanup.isDeleted(channelId)) await say(channel, 'Předání zprávy z fronty se nepodařilo potvrdit. Zkontroluj /status a /queue; zprávu automaticky neopakuji.').catch(() => {});
    } finally { release(); b.busy.delete(channelId); }
  }

  push(id, output) { return this.track(this.steer(id, output)); }

  async steer(id, output) {
    const b = this.bridge, entry = b.store.state.queuedMessages[id];
    if (!entry || entry.status !== 'queued') return say(output, 'Položka již byla předána nebo vyžaduje kontrolu přes /queue.');
    const channelId = entry.discordId;
    if (b.closing || b.cleanup.isDeleted(channelId) || b.busy.has(channelId)) return say(output, 'Konverzace právě mění stav. Zpráva zůstává ve frontě.');
    const record = entry.targetId ? b.record(entry.targetId) : b.store.state.threads[channelId];
    if (!record?.active || !record.turnId || record.uncertain || record.retiring || record.discordId !== channelId) {
      this.kick(channelId);
      return say(output, 'V cílové konverzaci není dostupný běžící úkol. Zpráva zůstává ve frontě.');
    }
    b.busy.add(channelId);
    const release = b.cleanup.hold(channelId);
    try {
      entry.status = 'dispatching';
      entry.delivery = 'steer';
      entry.targetId = record.codexId;
      entry.expectedTurnId = record.turnId;
      await b.store.save();
      if (b.cleanup.isDeleted(channelId) || b.closing) return;
      const result = await b.rpc.call('turn/steer', { threadId: record.codexId, expectedTurnId: entry.expectedTurnId, input: entry.input });
      b.idleContext.touch(record);
      await rememberMessage(b, entry.messageId, record, result.turnId);
      delete b.store.state.queuedMessages[id];
      await b.store.save();
      await say(output, 'Předáno do běžícího úkolu. Agent doplnění zahrne při dalším zpracování.');
    } catch (error) {
      if (b.store.state.queuedMessages[id]) {
        entry.status = error.rpcRejected ? 'queued' : 'attention';
        await b.store.save();
      }
      await say(output, error.rpcRejected ? 'Codex doplnění teď nepřijal. Zůstává ve frontě pro další úkol.' : 'Přijetí doplnění nelze potvrdit. Ověř /status a /queue; automaticky jej neopakuji.');
    } finally { release(); b.busy.delete(channelId); this.kick(channelId); }
  }
}
