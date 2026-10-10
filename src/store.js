import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function processIdentity(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

export class Store {
  constructor(dir) { this.dir = dir; this.state = { version: 1, threads: {}, seen: [] }; this.writes = Promise.resolve(); }

  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // OS PID lock: a crash is recoverable; two live instances must not handle the same events.
    this.lockPath = join(this.dir, 'process.lock');
    try { this.lock = await open(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const { pid, started } = JSON.parse(await readFile(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process.lock; inspect before removing it.');
      if (processIdentity(pid) === started) throw new Error('Another bridge instance is running.');
      await rm(this.lockPath);
      this.lock = await open(this.lockPath, 'wx', 0o600);
    }
    const started = processIdentity(process.pid);
    if (!started) { await this.close(); throw new Error('ps is required for the bridge process lock.'); }
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, started }));
    try {
      this.state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8'));
      if (this.state.version !== 1 || !this.state.threads || !Array.isArray(this.state.seen)) throw new Error('Invalid bridge state.');
    } catch (error) { if (error.code !== 'ENOENT') { await this.close(); throw error; } }
  }

  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writes = this.writes.then(async () => {
      const file = join(this.dir, 'state.json');
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return this.writes;
  }

  async remember(id) {
    if (this.state.seen.includes(id)) return false;
    this.state.seen.push(id);
    this.state.seen = this.state.seen.slice(-10_000);
    await this.save();
    return true;
  }

  async close() {
    await this.writes.catch(() => {});
    if (this.lock) { await this.lock.close(); await rm(this.lockPath, { force: true }); this.lock = null; }
  }
}
