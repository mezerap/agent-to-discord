import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { authorized } from './config.js';
import { say } from './messages.js';

const PAGE_SIZE = 25;
const CACHE_MS = 60_000;

function modelKey(model) { return createHash('sha256').update(model).digest('hex').slice(0, 24); }

function pageButtons(prefix, page, lastPage) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:${Math.max(0, page - 1)}`).setLabel('Předchozí').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`${prefix}:${page + 1}`).setLabel('Další').setStyle(ButtonStyle.Secondary).setDisabled(page === lastPage),
  );
}

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
        const efforts = new Map();
        for (const option of item.supportedReasoningEfforts || []) {
          const value = option?.reasoningEffort;
          if (typeof value !== 'string' || !value.length || value.length > 100 || efforts.has(value)) continue;
          efforts.set(value, { effort: value, description: typeof option.description === 'string' ? option.description : '' });
        }
        const effort = efforts.has(item.defaultReasoningEffort) ? item.defaultReasoningEffort : (efforts.keys().next().value ?? null);
        models.set(model, { model, name: item.displayName || model, effort, efforts: [...efforts.values()], isDefault: item.isDefault === true });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated model catalog cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!models.size) throw new Error('No selectable models.');
    return [...models.values()];
  }

  async show(output, channelId, page = 0, notice = '', effortPage = 0) {
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
    if (lastPage) components.push(pageButtons('model:page', page, lastPage));

    const currentModel = models.find(item => item.model === selected?.model);
    let effortHint = 'Po výběru modelu můžeš vybrat i úroveň přemýšlení.';
    if (currentModel?.efforts.length) {
      const lastEffortPage = Math.ceil(currentModel.efforts.length / PAGE_SIZE) - 1;
      effortPage = Math.max(0, Math.min(effortPage, lastEffortPage));
      const key = modelKey(currentModel.model);
      const effortOptions = currentModel.efforts.slice(effortPage * PAGE_SIZE, (effortPage + 1) * PAGE_SIZE).map(option => ({
        label: option.effort, value: option.effort,
        description: (option.description || `Úroveň přemýšlení: ${option.effort}`).slice(0, 100),
        default: selected.effort === option.effort,
      }));
      const effortMenu = new StringSelectMenuBuilder().setCustomId(`model:effort:${key}`)
        .setPlaceholder('Vyber úroveň přemýšlení').addOptions(effortOptions);
      components.push(new ActionRowBuilder().addComponents(effortMenu));
      if (lastEffortPage) components.push(pageButtons(`model:effort-page:${key}`, effortPage, lastEffortPage));
      effortHint = `Úroveň přemýšlení vyber ve druhé nabídce${lastEffortPage ? ` · strana ${effortPage + 1}/${lastEffortPage + 1}` : ''}.`;
    } else if (selected) {
      effortHint = 'Pro tento model katalog nenabízí volitelnou úroveň přemýšlení.';
    }
    const current = selected ? `**${selected.model}** (uvažování: ${selected.effort || 'výchozí'})` :
      `podle konverzace a konfigurace Codexu${this.bridge.config.model ? ` (${this.bridge.config.model})` : ''}`;
    return say(output, `${notice ? `${notice}\n` : ''}Volba tohoto chatu: ${current}.\n` +
      'Platí od dalšího zadání, také pro budoucí běhy automatizací v tomto chatu. Běžící úkol se nemění. Volba zůstává po /new i restartu.\n' +
      `${effortHint}\nNabídka Codexu${lastPage ? ` · strana ${page + 1}/${lastPage + 1}` : ''}:`, { components });
  }

  async save(channelId, selected) {
    const state = this.bridge.store.state.modelPreferences;
    const previous = state[channelId];
    state[channelId] = selected;
    try { await this.bridge.store.save(); }
    catch (error) {
      if (state[channelId] === selected) {
        if (previous) state[channelId] = previous;
        else delete state[channelId];
      }
      throw error;
    }
  }

  async select(output, channelId, value) {
    const models = await this.list();
    if (this.bridge.closing || this.bridge.cleanup.isDeleted(channelId)) return;
    const item = models.find(model => model.model === value);
    if (!item) return say(output, 'Tento model není v aktuální nabídce Codexu. Otevři znovu /model.');
    const previous = this.preference(channelId);
    const effort = previous?.model === item.model && item.efforts.some(option => option.effort === previous.effort) ? previous.effort : item.effort;
    await this.save(channelId, { model: item.model, effort });
    const page = Math.floor(models.indexOf(item) / PAGE_SIZE);
    return this.show(output, channelId, page, `Uloženo: **${item.name}**.`);
  }

  async selectEffort(output, channelId, model, effort) {
    const models = await this.list();
    if (this.bridge.closing || this.bridge.cleanup.isDeleted(channelId)) return;
    const item = models.find(item => item.model === model);
    if (this.preference(channelId)?.model !== model || !item?.efforts.some(option => option.effort === effort)) {
      return say(output, 'Tato volba už není platná pro vybraný model. Otevři znovu /model.', { components: [] });
    }
    await this.save(channelId, { model, effort });
    const page = Math.floor(models.indexOf(item) / PAGE_SIZE);
    const effortPage = Math.floor(item.efforts.findIndex(option => option.effort === effort) / PAGE_SIZE);
    return this.show(output, channelId, page, `Uloženo: **${item.name}**, přemýšlení **${effort}**.`, effortPage);
  }

  async control(output, channelId, argument = '') {
    return argument.trim() ? this.select(output, channelId, argument.trim()) : this.show(output, channelId);
  }

  async interaction(interaction) {
    const b = this.bridge;
    if (!authorized(b.config, interaction) || !b.ready || b.cleanup.isDeleted(interaction.channelId)) {
      return interaction.reply({ content: 'Tento výběr není dostupný nebo nemáš oprávnění.', flags: 64 });
    }
    const effortControl = /^model:(effort|effort-page):([a-f0-9]{24})(?::(\d{1,6}))?$/.exec(interaction.customId);
    if (effortControl && (effortControl[1] === 'effort' ? effortControl[3] !== undefined : effortControl[3] === undefined)) return;
    const isSelection = interaction.customId === 'model:select' || effortControl?.[1] === 'effort';
    if (!isSelection && !/^model:page:\d{1,6}$/.test(interaction.customId) && effortControl?.[1] !== 'effort-page') return;
    if (isSelection && (!interaction.isStringSelectMenu?.() || interaction.values?.length !== 1)) return;
    if (!isSelection && !interaction.isButton?.()) return;
    await interaction.deferUpdate();
    const output = { send: payload => interaction.editReply({ ...payload, allowedMentions: { parse: [] } }) };
    try {
      if (interaction.customId === 'model:select') {
        return await this.select(output, interaction.channelId, interaction.values[0]);
      }
      if (effortControl) {
        const selected = this.preference(interaction.channelId);
        if (!selected || modelKey(selected.model) !== effortControl[2]) {
          return output.send({ content: 'Model se od otevření nabídky změnil. Otevři znovu /model.', components: [] });
        }
        if (effortControl[1] === 'effort') return await this.selectEffort(output, interaction.channelId, selected.model, interaction.values[0]);
        const models = await this.list();
        return await this.show(output, interaction.channelId, Math.max(0, Math.floor(models.findIndex(item => item.model === selected.model) / PAGE_SIZE)), '', Number(effortControl[3] || 0));
      }
      return await this.show(output, interaction.channelId, Number(interaction.customId.split(':')[2]));
    } catch {
      return output.send({ content: 'Výběr modelu nebo přemýšlení se nepodařilo dokončit. Otevři znovu /model.', components: [] });
    }
  }
}
