import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgv, MODES } from './role_employment.js';

test('parseArgv: mode is the first positional and flags land where they belong', () => {
  const opts = parseArgv([
    'approve-grant', '--client', 'c-1', '--role', 'invoicing_collections',
    '--shape', 'standing_send_authority', '--action', 'send_receivable_reminder',
    '--scope-key', 'party-9', '--ceiling', '500', '--currency', 'GBP', '--apply'
  ]);
  assert.equal(opts.mode, 'approve-grant');
  assert.equal(opts.clientId, 'c-1');
  assert.equal(opts.roleId, 'invoicing_collections');
  assert.equal(opts.shape, 'standing_send_authority');
  assert.equal(opts.action, 'send_receivable_reminder');
  assert.equal(opts.scopeKind, 'counterparty');
  assert.equal(opts.scopeKey, 'party-9');
  assert.equal(opts.ceiling, 500);
  assert.equal(opts.currency, 'GBP');
  assert.equal(opts.apply, true);
});

test('parseArgv: unknown first arg means no mode (the runner refuses), dry-run is the default', () => {
  const opts = parseArgv(['--client', 'c-1']);
  assert.equal(opts.mode, null);
  assert.equal(opts.apply, false);
  assert.ok(MODES.includes('hire'));
});
