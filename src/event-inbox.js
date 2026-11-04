import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const EVENT_MAX_BYTES = 64 * 1024;
export const EVENT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const EVENT_RATE_LIMIT = 10;
export const EVENT_RATE_WINDOW_MS = 60 * 1000;
export const EVENT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const EVENT_RECEIPT_MAX = 10_000;
const EVENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function unsignedEnvelope(envelope) {
  const { signature, ...unsigned } = envelope;
  return unsigned;
}

function configuredSource(sources, source) {
  if (sources instanceof Map) return sources.get(source);
  return sources && Object.hasOwn(sources, source) ? sources[source] : null;
}

function hasSources(sources) {
  return sources instanceof Map ? sources.size > 0 : Boolean(sources && Object.keys(sources).length);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function signEvent(envelope, key) {
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(String(key));
  return createHmac('sha256', secret).update(JSON.stringify(unsignedEnvelope(envelope))).digest('hex');
}

export function verifyEvent(envelope, key) {
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ''));
  if (secret.length < 32 || !envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(envelope.signature)) return false;
  const expected = Buffer.from(signEvent(envelope, key), 'hex');
  const supplied = Buffer.from(envelope.signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function normalizeEvent(envelope, { key, sources, now = Date.now, replayWindowMs = EVENT_REPLAY_WINDOW_MS } = {}) {
  if (!verifyEvent(envelope, key)) throw new Error('Invalid event signature.');
  if (Buffer.byteLength(JSON.stringify(envelope)) > EVENT_MAX_BYTES) throw new Error('Event exceeds the maximum size.');

  const source = envelope.source;
  if (typeof source !== 'string' || !SOURCE_ID.test(source)) throw new Error('Invalid event source.');
  const config = configuredSource(sources, source);
  if (!config || typeof config !== 'object') throw new Error('Event source is not configured.');
  if (typeof config.projectId !== 'string' || !PROJECT_ID.test(config.projectId)) throw new Error('Configured event project is invalid.');
  if (typeof config.destination !== 'string' || !/^\d{15,22}$/.test(config.destination)) throw new Error('Configured event destination is invalid.');

  const occurred = validTimestamp(envelope.occurredAt);
  if (occurred === null || Math.abs(now() - occurred) > replayWindowMs) throw new Error('Event timestamp is outside the accepted replay window.');
  if (typeof envelope.id !== 'string' || !EVENT_ID.test(envelope.id)) throw new Error('Invalid event id.');
  const resource = envelope.resource === undefined ? envelope.id : envelope.resource;
  if (envelope.resource !== undefined && (typeof resource !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(resource))) throw new Error('Invalid event resource.');
  if (typeof envelope.summary !== 'string' || !envelope.summary.trim() || envelope.summary.length > 8_000) throw new Error('Invalid event summary.');
  if (typeof envelope.status !== 'string' || !/^[a-zA-Z0-9 _.-]{1,64}$/.test(envelope.status)) throw new Error('Invalid event status.');

  return {
    id: envelope.id,
    resource,
    source,
    projectId: config.projectId,
    destination: config.destination,
    occurredAt: new Date(occurred).toISOString(),
    summary: envelope.summary.trim(),
    status: envelope.status,
  };
}

export class EventInbox {
  constructor(bridge, { directory, key, sources = {}, now = Date.now, onEvent = null,
    replayWindowMs = EVENT_REPLAY_WINDOW_MS, batchSize = 25 } = {}) {
    this.bridge = bridge;
    this.directory = directory ? resolve(directory) : null;
    this.key = key;
    this.sources = sources;
    this.now = now;
    this.onEvent = onEvent;
    this.replayWindowMs = replayWindowMs;
    this.batchSize = Math.max(1, Math.min(100, Number.isSafeInteger(batchSize) ? batchSize : 25));
    this.cursorName = '';
    this.enabled = Boolean(this.directory && key && hasSources(sources) && bridge?.store?.state && typeof bridge.store.save === 'function' &&
      (Buffer.isBuffer(key) ? key.length : Buffer.byteLength(String(key))) >= 32);
  }

  tick() {
    if (!this.running) {
      const running = this.processTick().finally(() => { if (this.running === running) this.running = null; });
      this.running = running;
    }
    return this.running;
  }

  async processTick() {
    if (!this.enabled) return [];
    await this.ensureDirectory();
    const available = (await readdir(this.directory)).filter(name => /^[a-zA-Z0-9._-]{1,180}\.json$/.test(name)).sort();
    const start = Math.max(0, available.findIndex(name => name > this.cursorName));
    const names = Array.from({ length: Math.min(available.length, this.batchSize) }, (_, index) => available[(start + index) % available.length]);
    if (names.length) this.cursorName = names.at(-1);
    const results = [];
    for (const name of names) {
      const path = resolve(this.directory, name);
      let retryable = false;
      try {
        const result = await this.ingest(path);
        results.push(result);
        retryable = result.status === 'rate-limited';
      } catch (error) {
        retryable = Boolean(error.retryable);
        results.push({ status: 'rejected', error: error.message });
      } finally {
        if (!retryable) await rm(path, { force: true }).catch(() => {});
      }
    }
    return results;
  }

  async ingest(path) {
    if (!this.enabled) throw new Error('Event inbox is disabled.');
    if (path && typeof path === 'object') return this.ingestEnvelope(path);

    const resolved = resolve(path);
    const rel = relative(this.directory, resolved);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || rel.includes(sep) || isAbsolute(rel)) throw new Error('Event file is outside the inbox.');
    await this.ensureDirectory();

    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Event file must be a regular file.');
      if (info.size > EVENT_MAX_BYTES) throw new Error('Event exceeds the maximum size.');
      const buffer = Buffer.alloc(EVENT_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > EVENT_MAX_BYTES) throw new Error('Event exceeds the maximum size.');
      contents = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
    const envelope = JSON.parse(contents);
    return this.ingestEnvelope(envelope);
  }

  async ingestEnvelope(envelope) {
    if (!this.enabled) throw new Error('Event inbox is disabled.');
    const event = normalizeEvent(envelope, { key: this.key, sources: this.sources, now: this.now, replayWindowMs: this.replayWindowMs });
    const receiptKey = `${event.source}:${event.id}`;
    const receipts = this.receipts();
    this.pruneReceipts(receipts);
    if (receipts[receiptKey]) {
      const existing = receipts[receiptKey];
      if (existing.status === 'processing') {
        existing.status = 'uncertain';
        existing.recoveredAt = this.now();
        await this.saveReceipts();
      }
      return { status: existing.status === 'uncertain' ? 'uncertain' : 'duplicate', event };
    }
    if (this.rateLimited(event.source, receipts)) return { status: 'rate-limited', event };

    const receipt = { source: event.source, id: event.id, receivedAt: this.now(), status: 'processing' };
    receipts[receiptKey] = receipt;
    this.pruneReceipts(receipts);
    try { await this.saveReceipts(); }
    catch (error) {
      delete receipts[receiptKey];
      error.retryable = true;
      throw error;
    }

    try {
      if (this.onEvent) await this.onEvent(event);
      receipt.status = this.onEvent ? 'notified' : 'pending';
      await this.saveReceipts();
      return { status: receipt.status, event };
    } catch (error) {
      receipt.status = 'uncertain';
      receipt.error = String(error?.message || error).slice(0, 300);
      await this.saveReceipts();
      return { status: 'uncertain', event };
    }
  }

  receipts() {
    const state = this.bridge?.store?.state;
    if (!state) throw new Error('Persistent event receipt storage is unavailable.');
    state.eventReceipts ??= {};
    if (!state.eventReceipts || typeof state.eventReceipts !== 'object' || Array.isArray(state.eventReceipts)) throw new Error('Invalid event receipt state.');
    return state.eventReceipts;
  }

  rateLimited(source, receipts) {
    const cutoff = this.now() - EVENT_RATE_WINDOW_MS;
    const recent = Object.values(receipts).filter(receipt => receipt.source === source && Number.isFinite(receipt.receivedAt) && receipt.receivedAt > cutoff);
    return recent.length >= EVENT_RATE_LIMIT;
  }

  pruneReceipts(receipts) {
    const cutoff = this.now() - EVENT_RECEIPT_TTL_MS;
    for (const [key, receipt] of Object.entries(receipts)) {
      if (!Number.isFinite(receipt.receivedAt) || receipt.receivedAt <= cutoff) delete receipts[key];
    }
    const keys = Object.keys(receipts);
    if (keys.length > EVENT_RECEIPT_MAX) {
      keys.sort((left, right) => receipts[left].receivedAt - receipts[right].receivedAt);
      for (const key of keys.slice(0, keys.length - EVENT_RECEIPT_MAX)) delete receipts[key];
    }
  }

  async saveReceipts() {
    if (typeof this.bridge?.store?.save === 'function') await this.bridge.store.save();
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Event inbox must be a real directory.');
    this.directory = await realpath(this.directory);
  }
}
