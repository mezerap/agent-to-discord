import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.pending = new Map();
    this.sequence = 0;
  }

  async start() {
    // The Discord credential is not inherited by Codex or its shell commands.
    const env = { ...process.env };
    delete env.DISCORD_TOKEN;
    this.child = spawn(this.config.codexBin, ['app-server', '--stdio'], {
      cwd: this.config.workspace, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {}); // Do not copy prompts or credentials into Docker logs.
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex app-server disconnected.')));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Invalid Codex protocol message.')); }
    });
    const result = await this.call('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: { name: 'agent_to_discord', title: 'Agent to Discord', version: '0.2.2' },
    });
    this.write({ method: 'initialized', params: {} });
    return result;
  }

  write(message) {
    if (!this.child?.stdin.writable || this.failed) throw new Error('Codex is unavailable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method, params = {}, timeout = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}. Its outcome may be unknown; do not retry automatically.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.method) {
      this.emit(message.id === undefined ? 'notification' : 'request', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  reply(id, result) { this.write({ id, result }); }
  reject(id) { this.write({ id, error: { code: -32601, message: 'Unsupported request in Discord bridge.' } }); }

  fail(error) {
    if (this.failed || this.closed) return;
    this.failed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.emit('disconnected', error);
  }

  close() {
    this.fail(new Error('Codex connection closed.'));
    this.closed = true;
    this.child?.kill('SIGTERM');
  }
}
