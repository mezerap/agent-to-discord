import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { authorized } from './config.js';
import { say } from './messages.js';

const PAGE_SIZE = 25;
const CACHE_MS = 60_000;

export class ModelSelection {
  constructor(bridge) {
    this.bridge = bridge;
    this.cached = null;
    this.loadedAt = 0;
    this.loading = null;
  }

  preference(channelId) { return this.bridge.store.state.modelPreferences[channelId]; }

  turnSettings(channelId) {
    const selected = this.preference(channelId);
    return selected ? { model: selected.model, effort: selected.effort } : {};
  }

  async list() {
    if (this.loading) return this.loading;
    if (this.cached && Date.now() - this.loadedAt < CACHE_MS) return this.cached;
    this.loading = this.load().then(models => {
      this.cached = models;
      this.loadedAt = Date.now();
      return models;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  async load() {
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await this.bridge.rpc.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Invalid model catalog.');
      for (const item of page.data) {
        const model = item.model || item.id;
        if (item.hidden || typeof model !== 'string' || !model.length || model.length > 100) continue;
        const efforts = item.supportedReasoningEfforts?.map(value => value.reasoningEffort) || [];
        const effort = efforts.includes(item.defaultReasoningEffort) ? item.defaultReasoningEffort : null;
        models.set(model, { model, name: item.displayName || model, effort, isDefault: item.isDefault === true });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated model catalog cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!models.size) throw new Error('No selectable models.');
    return [...models.values()];
  }

  async show(output, channelId, page = 0, notice = '') {
    const models = await this.list();
    if (this.bridge.closing || this.bridge.cleanup.isDeleted(channelId)) return;
    const selected = this.preference(channelId);
    const lastPage = Math.ceil(models.length / PAGE_SIZE) - 1;
    page = Math.max(0, Math.min(page, lastPage));
    const options = models.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(item => ({
      label: item.name.slice(0, 100), value: item.model,
      description: `${item.model}${item.isDefault ? ' · výchozí v Codexu' : ''}`.slice(0, 100),
      default: selected?.model === item.model,
    }));
    const menu = new StringSelectMenuBuilder().setCustomId('model:select').setPlaceholder('Vyber model pro tento chat').addOptions(options);
    const components = [new ActionRowBuilder().addComponents(menu)];
    if (lastPage) {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`model:page:${page - 1}`).setLabel('Předchozí').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`model:page:${page + 1}`).setLabel('Další').setStyle(ButtonStyle.Secondary).setDisabled(page === lastPage),
      ));
    }
    const current = selected ? `**${selected.model}** (uvažování: ${selected.effort || 'výchozí'})` :
      `podle konverzace a konfigurace Codexu${this.bridge.config.model ? ` (${this.bridge.config.model})` : ''}`;
    return say(output, `${notice ? `${notice}\n` : ''}Volba tohoto chatu: ${current}.\n` +
      'Platí od dalšího zadání, také pro budoucí běhy automatizací v tomto chatu. Běžící úkol se nemění. Volba zůstává po /new i restartu.\n' +
      `Nabídka Codexu${lastPage ? ` · strana ${page + 1}/${lastPage + 1}` : ''}:`, { components });
  }

  async select(output, channelId, value) {
    const models = await this.list();
    if (this.bridge.closing || this.bridge.cleanup.isDeleted(channelId)) return;
    const item = models.find(model => model.model === value);
    if (!item) return say(output, 'Tento model není v aktuální nabídce Codexu. Otevři znovu /model.');
    const state = this.bridge.store.state.modelPreferences;
    const previous = state[channelId];
    const selected = { model: item.model, effort: item.effort };
    state[channelId] = selected;
    try { await this.bridge.store.save(); }
    catch (error) {
      if (state[channelId] === selected) {
        if (previous) state[channelId] = previous;
        else delete state[channelId];
      }
      throw error;
    }
    const page = Math.floor(models.indexOf(item) / PAGE_SIZE);
    return this.show(output, channelId, page, `Uloženo: **${item.name}**.`);
  }

  async control(output, channelId, argument = '') {
    return argument.trim() ? this.select(output, channelId, argument.trim()) : this.show(output, channelId);
  }

  async interaction(interaction) {
    const b = this.bridge;
    if (!authorized(b.config, interaction) || !b.ready || b.cleanup.isDeleted(interaction.channelId)) {
      return interaction.reply({ content: 'Tento výběr není dostupný nebo nemáš oprávnění.', flags: 64 });
    }
    if (interaction.customId !== 'model:select' && !/^model:page:\d{1,6}$/.test(interaction.customId)) return;
    if (interaction.customId === 'model:select' && !interaction.isStringSelectMenu?.()) return;
    if (interaction.customId.startsWith('model:page:') && !interaction.isButton?.()) return;
    await interaction.deferUpdate();
    const output = { send: payload => interaction.editReply({ ...payload, allowedMentions: { parse: [] } }) };
    try {
      if (interaction.customId === 'model:select') {
        if (interaction.values?.length !== 1) return;
        return await this.select(output, interaction.channelId, interaction.values[0]);
      }
      return await this.show(output, interaction.channelId, Number(interaction.customId.split(':')[2]));
    } catch {
      return output.send({ content: 'Výběr modelu se nepodařilo dokončit. Otevři znovu /model.', components: [] });
    }
  }
}
