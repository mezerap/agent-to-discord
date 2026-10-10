import { Routes } from 'discord.js';
import { authorized } from './config.js';

export const COMMANDS = [
  { name: 'new', description: 'Začne čistou konverzaci; předchozí archivuje na 90 dní.' },
  { name: 'archive', description: 'Soukromý přehled archivů: historie, obnovení a smazání.' },
  { name: 'automations', description: 'Přehled a pozastavení automatizací v tomto kanálu nebo vlákně.' },
  { name: 'help', description: 'Nápověda: zadávání úkolů, vlákna, přílohy a dostupné příkazy.' },
  { name: 'status', description: 'Zjistí stav úkolu v této konverzaci a zobrazí poslední odpověď.' },
  { name: 'stop', description: 'Zastaví běžící úkol v této konverzaci.' },
  { name: 'file', description: 'Stáhne soubor z pracovního adresáře agenta.', options: [
    { type: 3, name: 'cesta', description: 'Relativní cesta ve workspace, například web/index.html', required: true },
  ] },
  { name: 'answer', description: 'Odpoví na čekající otázku agenta.', options: [
    { type: 3, name: 'odpoved', description: 'Text pro jednu otázku; pro více otázek JSON podle zaslané šablony', required: true },
  ] },
].map(command => ({ type: 1, ...command }));

export async function registerCommands(discord, guildId) {
  const route = Routes.applicationGuildCommands(discord.application.id, guildId);
  const existing = await discord.rest.get(route);
  for (const command of COMMANDS) {
    const current = existing.find(item => item.type === 1 && item.name === command.name);
    if (!current) { await discord.rest.post(route, { body: command }); continue; }
    const desiredOptions = command.options || [];
    const actualOptions = current.options || [];
    const sameOptions = actualOptions.length === desiredOptions.length && desiredOptions.every((option, index) =>
      Object.entries(option).every(([key, value]) => actualOptions[index][key] === value));
    if (current.description === command.description && sameOptions) continue;
    await discord.rest.patch(Routes.applicationGuildCommand(discord.application.id, guildId, current.id), { body: command });
  }
}

export async function handleCommand(bridge, interaction) {
  if (!authorized(bridge.config, interaction)) {
    return interaction.reply({ content: 'Tento příkaz je dostupný jen povolenému uživateli v nastaveném kanálu a jeho vláknech.', flags: 64 });
  }
  if (!bridge.ready || bridge.cleanup.isDeleted(interaction.channelId)) {
    return interaction.reply({ content: 'Bot se připravuje nebo toto vlákno již bylo smazané.', flags: 64 });
  }
  await interaction.deferReply({ flags: 64 });
  let sent = false;
  const output = { send: async payload => {
    const safe = { ...payload, allowedMentions: { parse: [] } };
    const response = sent ? await interaction.followUp({ ...safe, flags: 64 }) : await interaction.editReply(safe);
    sent = true;
    return response;
  } };
  try {
    const name = interaction.commandName;
    const argument = name === 'file' ? interaction.options.getString('cesta', true) :
      name === 'answer' ? interaction.options.getString('odpoved', true) : '';
    await bridge.control(name, argument, interaction.channelId, output);
  } catch {
    await output.send({ content: 'Příkaz se nepodařilo dokončit. Zkontroluj zadání; stav úkolu ověříš přes /status.' });
  }
}
