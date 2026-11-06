// G-3 (FI-15) — the pure Suomi.fi mandate evaluator: closed reasons, inclusive
// expiry, the throwing gate form.
// node --test server/donna/finland/suomifiMandate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUOMIFI_MANDATE_SCOPE_TAX,
  SUOMIFI_MANDATE_REASONS,
  evaluateSuomifiMandate,
  assertSuomifiMandateValidForFiling
} from './suomifiMandate.js';

const activeMandate = (overrides = {}) => ({
  id: 'suomifi-mandate-1',
  scope: SUOMIFI_MANDATE_SCOPE_TAX,
  status: 'active',
  granted_on: '2026-01-15',
  expires_on: null,
  ...overrides
});

test('a live grant is valid; every miss lands on exactly one closed reason', () => {
  const at = '2026-07-10T12:00:00.000Z';
  assert.deepEqual(evaluateSuomifiMandate({ mandate: activeMandate(), onDate: at }), { valid: true, reason: 'valid' });
  assert.equal(evaluateSuomifiMandate({ mandate: null, onDate: at }).reason, 'no_mandate');
  assert.equal(evaluateSuomifiMandate({ mandate: activeMandate({ scope: 'muu_asia' }), onDate: at }).reason, 'wrong_scope');
  assert.equal(evaluateSuomifiMandate({ mandate: activeMandate({ status: 'revoked' }), onDate: at }).reason, 'revoked');
  assert.equal(evaluateSuomifiMandate({ mandate: activeMandate({ granted_on: '2026-08-01' }), onDate: at }).reason, 'not_yet_effective');
  assert.equal(evaluateSuomifiMandate({ mandate: activeMandate({ expires_on: '2026-07-09' }), onDate: at }).reason, 'expired');
  for (const probe of ['no_mandate', 'wrong_scope', 'revoked', 'not_yet_effective', 'expired', 'valid']) {
    assert.ok(SUOMIFI_MANDATE_REASONS.includes(probe), `${probe} is in the closed vocabulary`);
  }
});

test('expiry is INCLUSIVE of the end date; a malformed granted_on fails closed', () => {
  assert.equal(
    evaluateSuomifiMandate({ mandate: activeMandate({ expires_on: '2026-07-10' }), onDate: '2026-07-10T23:59:00Z' }).valid,
    true,
    'valid through the end date itself'
  );
  assert.equal(
    evaluateSuomifiMandate({ mandate: activeMandate({ expires_on: '2026-07-10' }), onDate: '2026-07-11T00:01:00Z' }).reason,
    'expired'
  );
  assert.equal(
    evaluateSuomifiMandate({ mandate: activeMandate({ granted_on: 'not-a-date' }), onDate: '2026-07-10' }).reason,
    'not_yet_effective',
    'unparseable grant date is never treated as granted'
  );
});

test('the evaluator refuses to run without an onDate — a validity verdict must be dated', () => {
  assert.throws(() => evaluateSuomifiMandate({ mandate: activeMandate() }), /onDate/);
  assert.throws(() => evaluateSuomifiMandate({ mandate: activeMandate(), onDate: 'yesterday' }), /onDate/);
});

test('the gate form throws the single typed refusal with the reason attached', () => {
  const at = '2026-07-10';
  assert.deepEqual(
    assertSuomifiMandateValidForFiling({ mandate: activeMandate(), onDate: at }),
    { valid: true, reason: 'valid' }
  );
  try {
    assertSuomifiMandateValidForFiling({ mandate: activeMandate({ status: 'revoked' }), onDate: at });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.code, 'ALV_FILING_MANDATE_REQUIRED');
    assert.equal(error.mandateReason, 'revoked');
    assert.match(error.message, /veroasioiden_hoito/);
  }
});
