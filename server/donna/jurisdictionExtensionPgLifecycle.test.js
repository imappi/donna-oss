import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('registered seventh country crosses the actual database, provider, correction and posting path', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL not set — extension/replay proof incomplete'
}, async () => {
  const root = new URL('./testSupport/jurisdictionExtension/', import.meta.url);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ['--import', fileURLToPath(new URL('register.mjs', root)), '--test', '--test-reporter=tap', fileURLToPath(new URL('lifecycle.mjs', root))],
    { env: childEnv, maxBuffer: 4 * 1024 * 1024 });
  assert.match(stdout, /# fail 0/);
  assert.match(stdout, /# skipped 0/);
  assert.doesNotMatch(stderr, /unhandled/i);
});
