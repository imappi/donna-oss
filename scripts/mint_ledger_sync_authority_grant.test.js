// Unit tests for the ledger-sync grant mint script — the PURE plan logic only
// (parseArgv + buildMintPlan), no live DB. Load-bearing properties:
//   - dry-run is the default (apply only when --apply present);
//   - fail-closed: missing client/system, unknown system, a malformed ceiling
//     or expiry, or a ceiling without a currency is REFUSED before any write;
//   - the time bound is ALWAYS present in an ok plan (explicit --expires, or
//     the default review-after window) — no perpetual export authority;
//   - --revoke plans status 'revoked' and still carries a time bound (the
//     store's mandatory-bound guard applies to every upsert).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgv, buildMintPlan } from './mint_ledger_sync_authority_grant.js';

test('parseArgv: dry-run by default; flags override', () => {
  const defaults = parseArgv([]);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.firmId, 'donna-production');
  assert.equal(defaults.clientId, null);
  assert.equal(defaults.reviewAfterDays, 90);

  const o = parseArgv([
    '--apply', '--client', 'honeybee-hills-apiary-llc', '--system', 'qbo',
    '--ceiling', '500', '--currency', 'usd', '--review-after-days', '30',
    '--actor', 'kari@books.example', '--reason', 'first grant'
  ]);
  assert.equal(o.apply, true);
  assert.equal(o.clientId, 'honeybee-hills-apiary-llc');
  assert.equal(o.system, 'qbo');
  assert.equal(o.ceiling, 500);
  assert.equal(o.currency, 'usd');
  assert.equal(o.reviewAfterDays, 30);
});

test('buildMintPlan: a good plan carries the grant id, normalized system/currency, and a time bound', () => {
  const p = buildMintPlan({
    firmId: 'donna-production', clientId: 'honeybee-hills-apiary-llc',
    system: 'QBO', ceiling: 500, currency: 'usd', reviewAfterDays: 30
  });
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.system, 'qbo');
  assert.equal(p.currency, 'USD');
  assert.match(p.grantId, /^sync-grant-honeybee-hills-apiary-llc-qbo-[0-9a-f]{16}$/);
  assert.equal(p.status, 'active');
  assert.ok(p.reviewAfter, 'default review-after bound present');
  assert.ok(new Date(p.reviewAfter).getTime() > Date.now(), 'bound is in the future');
});

test('buildMintPlan fails closed on every malformed request', () => {
  const cases = [
    [{ system: 'qbo' }, /missing clientId/],
    [{ clientId: 'c' }, /--system must be one of xero\|qbo/],
    [{ clientId: 'c', system: 'sage' }, /--system must be one of/],
    [{ clientId: 'c', system: 'qbo', ceiling: -5, currency: 'USD' }, /--ceiling must be a positive number/],
    [{ clientId: 'c', system: 'qbo', ceiling: 500 }, /--ceiling requires --currency/],
    [{ clientId: 'c', system: 'qbo', expires: 'not-a-date' }, /--expires must be a valid timestamp/],
    [{ clientId: 'c', system: 'qbo', reviewAfterDays: 0 }, /--review-after-days must be a positive number/]
  ];
  for (const [input, expected] of cases) {
    const p = buildMintPlan({ firmId: 'f', ...input });
    assert.equal(p.ok, false, JSON.stringify(input));
    assert.match(p.errors.join('; '), expected);
    assert.equal(p.grantId, null, 'no id computed for a refused plan');
  }
});

test('buildMintPlan: explicit --expires replaces the review-after default', () => {
  const p = buildMintPlan({ firmId: 'f', clientId: 'c', system: 'xero', expires: '2026-10-01T00:00:00Z' });
  assert.equal(p.ok, true);
  assert.equal(p.expiresAt, '2026-10-01T00:00:00.000Z');
  assert.equal(p.reviewAfter, null);
});

test('buildMintPlan: --revoke plans revoked status and STILL carries a time bound', () => {
  const p = buildMintPlan({ firmId: 'f', clientId: 'c', system: 'qbo', revoke: true });
  assert.equal(p.ok, true);
  assert.equal(p.status, 'revoked');
  assert.ok(p.reviewAfter, 'the store mandatory-bound guard applies to every upsert');
});
