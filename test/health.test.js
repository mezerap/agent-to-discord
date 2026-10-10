import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { bridgeHealthy, serveHealth, checkHealth } from '../src/health.js';

test('health uses the existing Codex connection and rejects lost Discord/login', async () => {
  let ready = true;
  const discord = { isReady: () => ready };
  let auth = { account: { type: 'chatgpt' } };
  const rpc = { call: async (method, params, timeout) => {
    assert.equal(method, 'account/read');
    assert.deepEqual(params, { refreshToken: false });
    assert.equal(timeout, 5_000);
    return auth;
  } };
  assert.equal(await bridgeHealthy(discord, rpc), true);
  auth = { account: null, requiresOpenaiAuth: true };
  assert.equal(await bridgeHealthy(discord, rpc), false);
  auth = { account: null, requiresOpenaiAuth: false };
  assert.equal(await bridgeHealthy(discord, rpc), true);
  ready = false;
  assert.equal(await bridgeHealthy(discord, rpc), false);
  ready = true;
  rpc.call = async () => { throw new Error('RPC failed'); };
  assert.equal(await bridgeHealthy(discord, rpc), false);
});

test('private health socket reflects live state and fails after shutdown', async () => {
  const dir = await mkdtemp('/tmp/a2d-health-');
  let close;
  try {
    let healthy = true;
    close = await serveHealth(dir, () => healthy);
    assert.equal((await stat(`${dir}/health.sock`)).mode & 0o777, 0o600);
    assert.equal(await checkHealth(dir), true);
    healthy = false;
    assert.equal(await checkHealth(dir), false);
    await close(); close = null;
    assert.equal(await checkHealth(dir), false);
  } finally { await close?.(); await rm(dir, { recursive: true, force: true }); }
});

test('health client times out when a running server stops answering', async () => {
  const dir = await mkdtemp('/tmp/a2d-health-');
  const sockets = [];
  const server = createServer(socket => sockets.push(socket));
  try {
    await new Promise(resolve => server.listen(`${dir}/health.sock`, resolve));
    assert.equal(await checkHealth(dir, 30), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
