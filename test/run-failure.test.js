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
