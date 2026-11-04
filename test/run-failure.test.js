import test from 'node:test';
import assert from 'node:assert/strict';
import { runFailure } from '../src/run-failure.js';

test('structured failures normalize protocol names and do not expose raw provider content', () => {
  for (const code of ['serverOverloaded', 'server_overloaded']) {
    const result = runFailure({ codexErrorInfo: code, message: 'SECRET' }, 'turn', 123, 'turn');
    assert.equal(result.code, 'serverOverloaded'); assert.equal(result.at, 123);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
  assert.equal(runFailure({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } }, 'turn').code, 'responseStreamDisconnected');
  assert.equal(runFailure({ message: 'SECRET', codexErrorInfo: 'unrecognized' }, 'turn').code, 'unknown');
});

test('classifies a missing Codex rollout without exposing its diagnostic text', () => {
  const failure = runFailure({ rpcRejected: true, code: -32600, message: 'No rollout found for thread SECRET_THREAD' }, 'status');

  assert.equal(failure.code, 'contextUnavailable');
  assert.match(failure.message, /kontext Codexu není dostupný/u);
  assert.ok(!JSON.stringify(failure).includes('SECRET_THREAD'));
  assert.equal(runFailure({ rpcRejected: true, code: -32600, message: 'thread not loaded: SECRET_THREAD' }, 'status').code, 'contextUnavailable');
  assert.equal(runFailure({ rpcRejected: true, code: -32600, message: 'Invalid request SECRET' }, 'status').code, 'unknown');
});
