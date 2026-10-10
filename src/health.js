import { createServer, createConnection } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function bridgeHealthy(discord, rpc) {
  if (!discord.isReady() || rpc.failed || rpc.closed) return false;
  try {
    const auth = await rpc.call('account/read', { refreshToken: false }, 5_000);
    return discord.isReady() && Boolean(auth.account || auth.requiresOpenaiAuth === false);
  } catch { return false; }
}

// Start only after acquiring the Store lock: a second process must not replace this socket.
export async function serveHealth(stateDir, probe) {
  const path = join(stateDir, 'health.sock');
  await rm(path, { force: true });
  const clients = new Set();
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    socket.setTimeout(6_000, () => socket.destroy());
    Promise.resolve().then(probe).then(
      healthy => socket.end(healthy ? 'ok\n' : 'unhealthy\n'),
      () => socket.end('unhealthy\n'),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  const close = async () => {
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(path, { force: true });
  };
  try { await chmod(path, 0o600); }
  catch (error) { await close(); throw error; }
  return close;
}

export function checkHealth(stateDir, timeout = 7_000) {
  return new Promise(resolve => {
    const socket = createConnection(join(stateDir, 'health.sock'));
    let response = '';
    const timer = setTimeout(() => finish(false), timeout);
    const finish = healthy => { clearTimeout(timer); socket.destroy(); resolve(healthy); };
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 32) finish(false);
    });
    socket.once('end', () => finish(response === 'ok\n'));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}
