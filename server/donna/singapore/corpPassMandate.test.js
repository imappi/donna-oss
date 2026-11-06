// SG G-3 — the pure CorpPass authorization evaluator: closed reasons, inclusive
// expiry, the throwing gate form.
// node --test server/donna/singapore/corpPassMandate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPPASS_SCOPE_GST,
  CORPPASS_SCOPE_CIT,
  CORPPASS_SCOPE_ACRA,
  CORPPASS_SCOPES,
  CORPPASS_MANDATE_STATUSES,
  CORPPASS_MANDATE_REASONS,
  evaluateCorpPassMandate,
  assertCorpPassMandateValidForFiling
} from './corpPassMandate.js';

const activeMandate = (overrides = {}) => ({
  id: 'corppass-mandate-1',
  scope: CORPPASS_SCOPE_GST,
  status: 'active',
  granted_on: '2026-01-15',
  expires_on: null,
  ...overrides
});

test('the closed vocabularies', () => {
  assert.deepEqual([...CORPPASS_SCOPES], ['iras_gst', 'iras_cit', 'acra_filing']);
  assert.equal(CORPPASS_SCOPE_CIT, 'iras_cit');
  assert.equal(CORPPASS_SCOPE_ACRA, 'acra_filing');
  assert.deepEqual([...CORPPASS_MANDATE_STATUSES], ['active', 'revoked']);
});

test('a live grant is valid; every miss lands on exactly one closed reason', () => {
  const at = '2026-07-23T12:00:00.000Z';
  assert.deepEqual(evaluateCorpPassMandate({ mandate: activeMandate(), onDate: at }), { valid: true, reason: 'valid' });
  assert.equal(evaluateCorpPassMandate({ mandate: null, onDate: at }).reason, 'no_mandate');
  assert.equal(evaluateCorpPassMandate({ mandate: activeMandate({ scope: 'acra_filing' }), onDate: at }).reason, 'wrong_scope');
  assert.equal(evaluateCorpPassMandate({ mandate: activeMandate({ status: 'revoked' }), onDate: at }).reason, 'revoked');
  assert.equal(evaluateCorpPassMandate({ mandate: activeMandate({ granted_on: '2026-08-01' }), onDate: at }).reason, 'not_yet_effective');
  assert.equal(evaluateCorpPassMandate({ mandate: activeMandate({ expires_on: '2026-07-22' }), onDate: at }).reason, 'expired');
  for (const probe of ['no_mandate', 'wrong_scope', 'revoked', 'not_yet_effective', 'expired', 'valid']) {
    assert.ok(CORPPASS_MANDATE_REASONS.includes(probe), `${probe} is in the closed vocabulary`);
  }
});

test('expiry is INCLUSIVE of the end date; a malformed granted_on fails closed', () => {
  assert.equal(
    evaluateCorpPassMandate({ mandate: activeMandate({ expires_on: '2026-07-23' }), onDate: '2026-07-23T23:59:00Z' }).valid,
    true,
    'valid through the end date itself'
  );
  assert.equal(
    evaluateCorpPassMandate({ mandate: activeMandate({ expires_on: '2026-07-23' }), onDate: '2026-07-24T00:01:00Z' }).reason,
    'expired'
  );
  assert.equal(
    evaluateCorpPassMandate({ mandate: activeMandate({ granted_on: 'not-a-date' }), onDate: '2026-07-23' }).reason,
    'not_yet_effective',
    'unparseable grant date is never treated as granted'
  );
});

test('the evaluator refuses to run without an onDate — a validity verdict must be dated', () => {
  assert.throws(() => evaluateCorpPassMandate({ mandate: activeMandate() }), /onDate/);
  assert.throws(() => evaluateCorpPassMandate({ mandate: activeMandate(), onDate: 'yesterday' }), /onDate/);
});

test('the gate form throws the single typed refusal with the reason attached', () => {
  const at = '2026-07-23';
  assert.deepEqual(
    assertCorpPassMandateValidForFiling({ mandate: activeMandate(), onDate: at }),
    { valid: true, reason: 'valid' }
  );
  try {
    assertCorpPassMandateValidForFiling({ mandate: activeMandate({ status: 'revoked' }), onDate: at });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.code, 'SG_FILING_CORPPASS_REQUIRED');
    assert.equal(error.mandateReason, 'revoked');
    assert.match(error.message, /iras_gst/);
  }
  // Scope routing: the CIT scope gates independently.
  assert.throws(
    () => assertCorpPassMandateValidForFiling({ mandate: activeMandate(), scope: CORPPASS_SCOPE_CIT, onDate: at }),
    (e) => e.code === 'SG_FILING_CORPPASS_REQUIRED' && e.mandateReason === 'wrong_scope'
  );
});
