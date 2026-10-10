#!/usr/bin/env node
import { loadEnvFile } from 'node:process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Client, GatewayIntentBits, PermissionFlagsBits, REST, Routes, ChannelType } from 'discord.js';
import { configFromEnv } from './config.js';
import { CodexClient } from './rpc.js';
import { Store } from './store.js';
import { Bridge } from './bridge.js';
import { registerCommands } from './commands.js';

const command = process.argv[2] || 'help';
const envIndex = process.argv.indexOf('--env-file');
if (envIndex !== -1 && !process.argv[envIndex + 1]) throw new Error('--env-file requires a path.');
const envFile = envIndex === -1
  ? resolve(process.env.AGENT_STATE_DIR || `${process.env.CODEX_HOME || `${homedir()}/.codex`}/agent-to-discord`, '.env')
  : resolve(process.argv[envIndex + 1]);
try { loadEnvFile(envFile); }
catch (error) { if (error.code !== 'ENOENT' || (envIndex !== -1 && command !== 'setup')) throw error; }

async function setup() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const prompts = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  try {
    const channelId = (await prompts.question('Discord channel ID: ')).trim();
    const userId = (await prompts.question('Your Discord user ID: ')).trim();
    const workspace = resolve((await prompts.question('Workspace directory [/workspace]: ')).trim() || '/workspace');
    const stateDir = dirname(envFile);
    const answer = prompts.question('Bot token (hidden): ');
    muted = true;
    const token = (await answer).trim();
    muted = false;
    console.log();
    const rest = new REST({ version: '10' }).setToken(token);
    const channel = await rest.get(Routes.channel(channelId));
    if (channel.type !== ChannelType.GuildText) throw new Error('Choose a server text channel.');
    const guildId = channel.guild_id;
    configFromEnv({ DISCORD_TOKEN: token, DISCORD_GUILD_ID: guildId, DISCORD_CHANNEL_ID: channelId, DISCORD_USER_ID: userId, AGENT_WORKSPACE: workspace, AGENT_STATE_DIR: stateDir });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(envFile, `DISCORD_TOKEN=${token}\nDISCORD_GUILD_ID=${guildId}\nDISCORD_CHANNEL_ID=${channelId}\nDISCORD_USER_ID=${userId}\nAGENT_WORKSPACE=${JSON.stringify(workspace)}\nAGENT_STATE_DIR=${JSON.stringify(stateDir)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Saved private configuration: ${envFile}\nRun agent-to-discord doctor, then agent-to-discord start.`);
  } catch (error) {
    console.error(error.code === 'EEXIST' ? '.env already exists; it was not overwritten.' : 'Setup failed. Check bot token, channel access and configuration paths.');
    process.exitCode = 1;
  } finally { muted = false; prompts.close(); }
}

async function run() {
  const config = configFromEnv();
  await access(config.workspace);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const rpc = new CodexClient(config);
  const discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], allowedMentions: { parse: [] } });
  const store = new Store(config.stateDir);
  let bridge;
  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    bridge?.close();
    discord.destroy();
    rpc.close();
    await store.close();
    process.exitCode = code;
  };
  rpc.on('disconnected', () => {
    if (!closing) { console.error('Codex disconnected. Restart required; previous prompts will not be replayed.'); shutdown(1); }
  });
  process.once('SIGTERM', () => shutdown());
  process.once('SIGINT', () => shutdown());

  try {
    const server = await rpc.start();
    const auth = await rpc.call('account/read', { refreshToken: false });
    if (!auth.account && auth.requiresOpenaiAuth !== false) throw new Error('Codex is not logged in. Run codex login first.');
    await discord.login(config.token);
    if (!discord.isReady()) await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Discord readiness timeout.')), 30_000);
      discord.once('clientReady', () => { clearTimeout(timer); res(); });
    });
    const channel = await discord.channels.fetch(config.channelId);
    if (!channel || channel.guildId !== config.guildId || channel.type !== ChannelType.GuildText) throw new Error('Configured channel must be a server text channel.');
    const permissions = channel.permissionsFor(discord.user);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
    if (!permissions?.has(required)) throw new Error('Bot is missing channel permissions. See README.');
    console.log(`Codex connected: ${server.userAgent}; Discord channel access verified.`);
    if (command === 'doctor') { console.log('Doctor passed. No Discord message was sent.'); await shutdown(); return; }

    await store.open();
    await registerCommands(discord, config.guildId);
    console.log('Discord slash commands registered: /help, /status, /stop, /file, /answer.');
    bridge = new Bridge(config, discord, rpc, store);
    bridge.attach();
    await bridge.recover();
    console.log('Agent to Discord is ready.');
  } catch (error) {
    // Errors can contain remote/user text. Never log environment or raw API payloads.
    const safe = String(error.message).replaceAll(config.token, '[REDACTED]');
    console.error(safe);
    await shutdown(1);
  }
}

if (command === 'setup') await setup();
else if (command === 'start' || command === 'doctor') await run();
else if (command === 'status') {
  const { readFile } = await import('node:fs/promises');
  const config = configFromEnv(process.env, { tokenRequired: false });
  const state = JSON.parse(await readFile(resolve(config.stateDir, 'state.json'), 'utf8'));
  console.log(JSON.stringify({ conversations: Object.keys(state.threads).length, activeAtLastSave: Object.values(state.threads).filter(t => t.active).length }, null, 2));
} else console.log('agent-to-discord <setup|start|doctor|status> [--env-file /absolute/path/to/.env]');
