#!/usr/bin/env python3
"""Host-side read-only health sampler. Write signed events to the private bridge spool.
Run with a private JSON config {bridge_state_dir, containers:[names]}. No secrets in logs.
The bridge does not gain Docker access. A successful baseline stays silent.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone


def atomic(path, value):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    with temporary.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(',', ':'))
    os.replace(temporary, path)


def read_signing_config(bridge_fd):
    descriptor = os.open('events.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=bridge_fd)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024:
            raise ValueError('Invalid event signing configuration.')
        with os.fdopen(descriptor, 'r', encoding='utf-8') as stream:
            descriptor = None
            contents = stream.read(64 * 1024 + 1)
        if len(contents.encode('utf-8')) > 64 * 1024:
            raise ValueError('Event signing configuration is too large.')
        config = json.loads(contents)
        if not isinstance(config.get('key'), str) or len(config['key'].encode()) < 32:
            raise ValueError('Event signing key must contain at least 32 bytes.')
        return config
    finally:
        if descriptor is not None:
            os.close(descriptor)


def open_spool(bridge_fd):
    try:
        os.mkdir('event-inbox', mode=0o700, dir_fd=bridge_fd)
    except FileExistsError:
        pass
    spool_fd = os.open('event-inbox', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=bridge_fd)
    try:
        os.fchown(spool_fd, 1000, 1000)
        os.fchmod(spool_fd, 0o700)
    except Exception:
        os.close(spool_fd)
        raise
    return spool_fd


def write_event(spool_fd, event):
    filename = event['id'] + '.json'
    temporary = '.' + event['id'] + '.' + uuid.uuid4().hex + '.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=spool_fd)
    try:
        os.fchown(descriptor, 1000, 1000)
        body = json.dumps(event, ensure_ascii=False, separators=(',', ':')).encode()
        with os.fdopen(descriptor, 'wb') as stream:
            descriptor = None
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename, src_dir_fd=spool_fd, dst_dir_fd=spool_fd)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=spool_fd)
        except FileNotFoundError:
            pass


def main():
    os.umask(0o077)
    config_path = Path(sys.argv[1])
    config = json.loads(config_path.read_text())
    bridge = Path(config['bridge_state_dir'])
    bridge_fd = os.open(bridge, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    spool_fd = None
    try:
        signing = read_signing_config(bridge_fd)
        spool_fd = open_spool(bridge_fd)
    finally:
        os.close(bridge_fd)
    state_path = config_path.with_name('event-monitor-state.json')
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    current = {}
    try:
        for name in config['containers']:
            result = subprocess.run(['docker', 'inspect', '--format', '{{json .State}}', name], capture_output=True, text=True, timeout=15)
            if result.returncode:
                condition = 'missing'
                state = {}
            else:
                state = json.loads(result.stdout)
                condition = state.get('Health', {}).get('Status', state.get('Status', 'unknown'))
            good = condition in ('healthy', 'running')
            old = previous.get(name)
            if condition == 'starting':
                # Startup is transient: keep the last stable/problem state so
                # an already-reported outage still produces a real recovery.
                if old is not None:
                    current[name] = old
                continue
            current[name] = condition
            old_good = old in ('healthy', 'running')
            if condition == old or (good and (old is None or old == 'starting' or old_good)):
                continue
            event = {'id': str(uuid.uuid4()), 'source': 'coolify', 'resource': name,
                     'occurredAt': datetime.now(timezone.utc).isoformat(),
                     'summary': f'Kontejner {name}: {old or "prvni kontrola"} -> {condition}. ExitCode={state.get("ExitCode", "unknown")}; OOMKilled={state.get("OOMKilled", False)}.',
                     'status': 'recovered' if good else 'problem'}
            body = json.dumps(event, ensure_ascii=False, separators=(',', ':')).encode()
            event['signature'] = hmac.new(signing['key'].encode(), body, hashlib.sha256).hexdigest()
            write_event(spool_fd, event)
        atomic(state_path, current)
    finally:
        os.close(spool_fd)


if __name__ == '__main__':
    main()
