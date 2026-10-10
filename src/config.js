import { resolve } from 'node:path';
import { homedir } from 'node:os';

export function configFromEnv(env = process.env, { tokenRequired = true } = {}) {
  const config = {
    token: env.DISCORD_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    userId: env.DISCORD_USER_ID,
    workspace: resolve(env.AGENT_WORKSPACE || process.cwd()),
    stateDir: resolve(env.AGENT_STATE_DIR || `${env.CODEX_HOME || `${homedir()}/.codex`}/agent-to-discord`),
    codexBin: env.CODEX_BIN || 'codex',
    model: env.CODEX_MODEL || undefined,
    executionMode: env.AGENT_EXECUTION_MODE || 'sandboxed',
  };
  if (!['sandboxed', 'container'].includes(config.executionMode)) throw new Error('AGENT_EXECUTION_MODE must be sandboxed or container.');
  for (const [field, key] of [['guildId', 'DISCORD_GUILD_ID'], ['channelId', 'DISCORD_CHANNEL_ID'], ['userId', 'DISCORD_USER_ID']]) {
    if (!/^\d{17,20}$/.test(config[field] || '')) throw new Error(`Set ${key} to a Discord ID.`);
  }
  if (tokenRequired && !config.token) throw new Error('Set DISCORD_TOKEN. Never commit this token.');
  return config;
}

export function authorized(config, event) {
  return event.guildId === config.guildId &&
    (event.author?.id || event.user?.id) === config.userId &&
    (event.channelId === config.channelId ||
      (event.channel?.isThread?.() === true && event.channel.parentId === config.channelId));
}
