import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeEvent, verifyEvent } from '../src/event-inbox.js';

const key = 'producer-cross-language-test-key-long-enough';
const scriptPath = resolve('ops/coolify-events.py');
const pythonAvailable = (() => {
  try { execFileSync(process.env.PYTHON || 'python3', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'a2d-producer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'bridge-state');
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, 'events.json'), JSON.stringify({ key, sources: { coolify: { projectId: 'operations', destination: '123456789012345' } } }), { mode: 0o600 });
  const config = join(root, 'coolify-monitor.json');
  await writeFile(config, JSON.stringify({ bridge_state_dir: state, containers: ['api-service-1'] }), { mode: 0o600 });
  return { root, state, config, spool: join(state, 'event-inbox') };
}

function runMonitor(config, conditions) {
  const harness = String.raw`
import json, runpy, sys
from types import SimpleNamespace
import stat
module = runpy.run_path(sys.argv[1])
config_path = sys.argv[2]
conditions = iter(json.loads(sys.argv[3]))
chowns = []
def inspect(args, **kwargs):
    assert args[:4] == ['docker', 'inspect', '--format', '{{json .State}}']
    assert kwargs['timeout'] == 15
    condition = next(conditions)
    state = {'Status': condition, 'Health': {'Status': condition}, 'ExitCode': 0, 'OOMKilled': False}
    return SimpleNamespace(returncode=0, stdout=json.dumps(state, ensure_ascii=False))
module['subprocess'].run = inspect
module['os'].chown = lambda path, uid, gid: chowns.append((str(path), uid, gid))
module['os'].fchown = lambda fd, uid, gid: chowns.append((stat.S_ISDIR(module['os'].fstat(fd).st_mode), uid, gid))
for _ in range(len(json.loads(sys.argv[3]))):
    sys.argv = [sys.argv[1], config_path]
    module['main']()
print(json.dumps(chowns))
`;
  return execFileSync(process.env.PYTHON || 'python3', ['-c', harness, scriptPath, config, JSON.stringify(conditions)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

test('Coolify producer stays silent on healthy baseline and repeats, then signs only status transitions', { skip: !pythonAvailable }, async t => {
  const { state, config, spool } = await fixture(t);
  await mkdir(spool, { mode: 0o777 });
  await chmod(spool, 0o777);
  const chowns = JSON.parse(runMonitor(config, ['healthy', 'healthy', 'unhealthy', 'unhealthy', 'healthy']));
  const files = await readdir(spool);
  assert.equal(files.length, 2);
  assert.equal(chowns.some(([directory, uid, gid]) => directory && uid === 1000 && gid === 1000), true);
  assert.equal(chowns.some(([directory, uid, gid]) => !directory && uid === 1000 && gid === 1000), true);
  assert.equal((await stat(spool)).mode & 0o777, 0o700);

  const events = await Promise.all(files.map(async file => JSON.parse(await readFile(join(spool, file), 'utf8'))));
  for (const event of events) {
    assert.equal(verifyEvent(event, key), true);
    assert.match(event.summary, /Kontejner/);
    assert.equal(event.resource, 'api-service-1');
    assert.equal(event.source, 'coolify');
    const normalized = normalizeEvent(event, { key, sources: { coolify: { projectId: 'operations', destination: '123456789012345' } }, now: () => Date.parse(event.occurredAt) });
    assert.equal(normalized.destination, '123456789012345');
    assert.equal(normalized.projectId, 'operations');
  }
  assert.deepEqual(events.map(event => event.status).sort(), ['problem', 'recovered']);
  assert.deepEqual(JSON.parse(await readFile(join(dirname(config), 'event-monitor-state.json'), 'utf8')), { 'api-service-1': 'healthy' });
});

test('producer passes configured container names as one inspect argument, never through a shell', { skip: !pythonAvailable }, async t => {
  const { config } = await fixture(t);
  const harness = String.raw`
import json, runpy, sys
from types import SimpleNamespace
module = runpy.run_path(sys.argv[1])
config_path = sys.argv[2]
seen = []
def inspect(args, **kwargs):
    seen.append(args)
    return SimpleNamespace(returncode=0, stdout='{"Status":"healthy"}')
module['subprocess'].run = inspect
module['os'].chown = lambda *args: None
module['os'].fchown = lambda *args: None
sys.argv = [sys.argv[1], config_path]
module['main']()
print(json.dumps(seen))
`;
  const content = JSON.parse(await readFile(config, 'utf8'));
  content.containers = ['api; touch /tmp/should-not-exist'];
  await writeFile(config, JSON.stringify(content));
  const seen = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', harness, scriptPath, config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.deepEqual(seen[0], ['docker', 'inspect', '--format', '{{json .State}}', 'api; touch /tmp/should-not-exist']);
});

test('root producer refuses a spool symlink instead of writing outside bridge state', { skip: !pythonAvailable }, async t => {
  const { state, config } = await fixture(t);
  const outside = join(state, 'outside-spool');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, join(state, 'event-inbox'));

  assert.throws(() => runMonitor(config, ['unhealthy']));
  assert.deepEqual(await readdir(outside), []);
});

test('producer opens the bridge directory and signing config without following symlinks', { skip: !pythonAvailable }, async t => {
  const { root, state, config } = await fixture(t);
  const outside = join(state, 'outside-config.json');
  await writeFile(outside, JSON.stringify({ key }));
  await rm(join(state, 'events.json'));
  await symlink(outside, join(state, 'events.json'));
  assert.throws(() => runMonitor(config, ['healthy']));

  await rm(state, { recursive: true });
  const original = join(root, 'real-state');
  await mkdir(original, { mode: 0o700 });
  await writeFile(join(original, 'events.json'), JSON.stringify({ key }), { mode: 0o600 });
  await symlink(original, state);
  assert.throws(() => runMonitor(config, ['healthy']));
});
