import { Routes } from 'discord.js';
import { authorized } from './config.js';

export const COMMANDS = [
  { name: 'project', description: 'Vybere projekt a pracovní adresář pro tento chat.', options: [
    { type: 3, name: 'projekt', description: 'ID projektu; bez zadání otevře nabídku' },
  ] },
  { name: 'task', description: 'Worktree úkolu, stav, příprava review, PR nebo místní sloučení.', options: [
    { type: 3, name: 'akce', description: 'Akce úkolu', choices: ['new', 'status', 'review', 'pr', 'merge'].map(value => ({ name: value, value })) },
    { type: 3, name: 'nazev', description: 'Pro new: krátký název malými písmeny, čísly a pomlčkami' },
  ] },
  { name: 'knowledge', description: 'Hledá a spravuje explicitní poznámky zvoleného projektu.', options: [
    { type: 3, name: 'akce', description: 'Akce poznámek', choices: ['search', 'add', 'update', 'delete'].map(value => ({ name: value, value })) },
    { type: 3, name: 'text', description: 'Dotaz pro hledání nebo celý text poznámky' },
    { type: 3, name: 'id', description: 'ID poznámky pro update/delete' },
    { type: 3, name: 'zdroj', description: 'Odkaz na zdrojovou zprávu Discordu' },
  ] },
  { name: 'model', description: 'Vybere model Codexu a úroveň přemýšlení pro další zadání v tomto kanálu nebo vlákně.' },
  { name: 'queue', description: 'Fronta zpráv: přehled, zahrnutí do běžícího úkolu, odebrání a pokračování.' },
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
      Object.entries(option).every(([key, value]) => JSON.stringify(actualOptions[index][key]) === JSON.stringify(value)));
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
      name === 'answer' ? interaction.options.getString('odpoved', true) :
      name === 'project' ? { project: interaction.options.getString('projekt') } :
      name === 'task' ? { action: interaction.options.getString('akce') || 'status', name: interaction.options.getString('nazev') } :
      name === 'knowledge' ? { action: interaction.options.getString('akce') || 'search', text: interaction.options.getString('text'), id: interaction.options.getString('id'), source: interaction.options.getString('zdroj') } : '';
    await bridge.control(name, argument, interaction.channelId, output);
  } catch {
    await output.send({ content: 'Příkaz se nepodařilo dokončit. Zkontroluj zadání; stav úkolu ověříš přes /status.' });
  }
}
