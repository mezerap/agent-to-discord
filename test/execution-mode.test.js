import test from 'node:test';
import assert from 'node:assert/strict';
import { configFromEnv } from '../src/config.js';
import { Bridge } from '../src/bridge.js';

const env = { DISCORD_TOKEN: 'test', DISCORD_GUILD_ID: '12345678901234567', DISCORD_CHANNEL_ID: '12345678901234568', DISCORD_USER_ID: '12345678901234569' };

test('default execution stays sandboxed and unknown mode fails closed', () => {
  const config = configFromEnv(env);
  const settings = Bridge.prototype.threadSettings.call({ config });
  assert.equal(settings.sandbox, 'workspace-write');
  assert.equal(settings.approvalPolicy, 'on-request');
  assert.throws(() => configFromEnv({ ...env, AGENT_EXECUTION_MODE: 'typo' }), /AGENT_EXECUTION_MODE/);
});

test('explicit container mode applies no-approval settings to new and resumed/forked threads', () => {
  const config = configFromEnv({ ...env, AGENT_EXECUTION_MODE: 'container' });
  const bridge = { config, threadSettings: Bridge.prototype.threadSettings };
  for (const settings of [bridge.threadSettings(), Bridge.prototype.newThreadSettings.call(bridge)]) {
    assert.equal(settings.sandbox, 'danger-full-access');
    assert.equal(settings.approvalPolicy, 'never');
    assert.equal(settings.cwd, config.workspace);
  }
});
