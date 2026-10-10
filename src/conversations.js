export function initializeState(state) {
  state.threads ??= {};
  state.retiredThreads ??= {};
  state.messages ??= {};
  state.schedules ??= {};
  state.toolResults ??= {};
  state.freshChannels ??= {};
  for (const key of ['threads', 'retiredThreads', 'messages', 'schedules', 'toolResults', 'freshChannels']) {
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Invalid ${key} state.`);
  }
}

export function recordsAt(bridge, channelId) {
  return Object.values(bridge.store.state.threads).filter(r => r.discordId === channelId && !r.deleted && !r.retiring);
}

export function recordKey(bridge, record) {
  return Object.keys(bridge.store.state.threads).find(key => bridge.store.state.threads[key] === record);
}

export function forgetMessages(state, codexId) {
  for (const [id, ref] of Object.entries(state.messages || {})) if (ref.codexId === codexId) delete state.messages[id];
  for (const key of Object.keys(state.toolResults || {})) if (key.startsWith(`${codexId}:`)) delete state.toolResults[key];
  for (const [id, job] of Object.entries(state.schedules || {})) {
    if (job.status === 'deleted' && (job.codexId === codexId || (!job.codexId && job.sourceId === codexId))) delete state.schedules[id];
  }
}

export async function rememberMessage(bridge, messageId, record, turnId = record.turnId) {
  if (!messageId) return;
  bridge.store.state.messages[messageId] = { codexId: record.codexId, discordId: record.discordId, turnId, at: Date.now() };
  await bridge.store.save();
}

export async function referencedMessage(bridge, message) {
  const reference = message.reference;
  if (!reference?.messageId) return null;
  // Never fetch an arbitrary cross-channel reference supplied by another integration.
  if (reference.channelId && reference.channelId !== message.channelId) return null;
  try {
    const quoted = await message.channel.messages.fetch(reference.messageId);
    if (quoted.author?.id !== bridge.config.userId && quoted.author?.id !== bridge.discord.user?.id) return null;
    return { text: quoted.content || '(Příloha nebo prázdná zpráva)', ref: bridge.store.state.messages[quoted.id] };
  } catch (error) {
    if (error.code === 10008) return { text: '(Odkazovaná zpráva byla smazána.)' };
    throw error;
  }
}

export async function createConversation(bridge, channel, text) {
  let source;
  let quote;
  if (channel.isThread?.() && !bridge.store.state.freshChannels[channel.id]) {
    const ref = bridge.store.state.messages[channel.id];
    source = ref && bridge.record(ref.codexId) && !bridge.store.state.retiredThreads[ref.codexId] ? ref : null;
    const parent = await bridge.discord.channels.fetch(bridge.config.channelId);
    try {
      const starter = await parent.messages.fetch(channel.id);
      // A standalone thread has a ThreadCreated system notice, not a context-bearing message.
      // Check even mapped starters: older versions mistakenly processed these notices as prompts.
      if (starter.system) source = null;
      else if (!source && [bridge.config.userId, bridge.discord.user?.id].includes(starter.author?.id)) quote = starter.content;
    } catch (error) { if (![10008, 10003].includes(error.code)) throw error; }
  }
  let result;
  if (source?.turnId) {
    result = await bridge.archives.locked(source.codexId, () => bridge.rpc.call('thread/fork', { threadId: source.codexId, lastTurnId: source.turnId,
      deferGoalContinuation: true, ...bridge.threadSettings() }));
  } else {
    result = await bridge.rpc.call('thread/start', bridge.newThreadSettings());
  }
  const record = { discordId: channel.id, codexId: result.thread.id, active: false,
    title: (channel.isThread?.() ? channel.name || 'Vlákno' : text || 'Hlavní chat').slice(0, 90),
    kind: channel.isThread?.() ? 'thread' : 'main', tools: source ? bridge.record(source.codexId)?.tools : true };
  bridge.store.state.threads[channel.id] = record;
  delete bridge.store.state.freshChannels[channel.id];
  await bridge.store.save();
  return { record, quote };
}

export class ConversationArchives {
  constructor(bridge) { this.bridge = bridge; this.locks = new Map(); }

  locked(id, work) {
    const chain = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(id, chain);
    return chain.finally(() => { if (this.locks.get(id) === chain) this.locks.delete(id); });
  }

  async retire(key, reason, interrupt = false) {
    const { store } = this.bridge;
    const record = store.state.threads[key];
    if (!record) return;
    return this.locked(record.codexId, async () => {
      if (store.state.threads[key] !== record) return;
      record.retiring = reason;
      record.deletedAt ??= Date.now();
      await store.save();
      const thread = await this.bridge.cleanup.readThread(record.codexId);
      if (thread.status?.type === 'active' || thread.turns?.some(t => t.status === 'inProgress')) {
        if (!interrupt) { delete record.retiring; delete record.deletedAt; await store.save(); throw new Error('Nejprve zastav úkol přes /stop.'); }
        const turn = thread.turns?.find(t => t.status === 'inProgress');
        if (!turn) throw new Error('Waiting for active thread.');
        await this.bridge.rpc.call('turn/interrupt', { threadId: record.codexId, turnId: turn.id });
        const after = await this.bridge.cleanup.readThread(record.codexId);
        if (after.status?.type === 'active' || after.turns?.some(t => t.status === 'inProgress')) throw new Error('Waiting for interruption.');
      }
      try { await this.bridge.rpc.call('thread/archive', { threadId: record.codexId }); }
      catch (error) { if (!await this.bridge.cleanup.isArchived(record.codexId)) throw error; }
      store.state.retiredThreads[record.codexId] = { codexId: record.codexId, discordId: record.discordId,
        deletedAt: reason === 'new' ? Date.now() : record.deletedAt, title: record.title || 'Konverzace', kind: record.kind || 'thread', reason, tools: record.tools };
      delete store.state.threads[key];
      await store.save();
    });
  }
}
