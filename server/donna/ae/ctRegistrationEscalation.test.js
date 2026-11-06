// AE ae_corporate_tax_registration — the registry watch's pure half.
//   node --test server/donna/ae/ctRegistrationEscalation.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AE_CT_REGISTRATION_DEADLINE_EVIDENCE_TYPE,
  AE_CT_REGISTRATION_DEADLINE_LEAD_DAYS,
  AE_CT_REGISTRATION_REFUSAL_CODES,
  AE_CT_REGISTRATION_STATUS_EVIDENCE_TYPE,
  aeCtRegistrationDeadlineAskId,
  aeCtRegistrationStatusAskId,
  buildAeCtRegistrationDeadlineQuestion,
  buildAeCtRegistrationStatusQuestion,
  classifyAeCtRegistrationDeadline
} from './ctRegistrationEscalation.js';
import { buildAeCtRegistrationDeadlineRows } from './ctRegistrationDeadlines.js';

test('the vocabulary is the binding contract — evidence types, refusal codes', () => {
  assert.equal(AE_CT_REGISTRATION_STATUS_EVIDENCE_TYPE, 'ct_registration_status');
  assert.equal(AE_CT_REGISTRATION_DEADLINE_EVIDENCE_TYPE, 'ct_registration_deadline');
  assert.deepEqual(AE_CT_REGISTRATION_REFUSAL_CODES, {
    ctRegistration: 'AE_CT_REGISTRATION_STATUS_UNKNOWN',
    ctRegistrationDeadline: 'AE_CT_REGISTRATION_DEADLINE_UNRESOLVED'
  });
  assert.ok(Object.isFrozen(AE_CT_REGISTRATION_REFUSAL_CODES));
});

test('classification is pure calendar arithmetic against the computed due date', () => {
  const row = { key: 'ct_registration', due_date: '2026-10-15', terminal: 'scheduled' };
  assert.deepEqual(classifyAeCtRegistrationDeadline({ row, asOf: '2026-08-31' }),
    { state: 'scheduled', daysUntilDue: 45 });
  assert.deepEqual(classifyAeCtRegistrationDeadline({ row, asOf: '2026-09-20' }),
    { state: 'due_soon', daysUntilDue: 25 });
  assert.deepEqual(classifyAeCtRegistrationDeadline({ row, asOf: '2026-10-15' }),
    { state: 'due_soon', daysUntilDue: 0 });
  assert.deepEqual(classifyAeCtRegistrationDeadline({ row, asOf: '2026-10-20' }),
    { state: 'overdue', daysUntilDue: -5 });
  // Exactly at the lead-window edge is inside it.
  assert.equal(AE_CT_REGISTRATION_DEADLINE_LEAD_DAYS, 30);
  assert.equal(classifyAeCtRegistrationDeadline({
    row: { due_date: '2026-10-15' }, asOf: '2026-09-15'
  }).state, 'due_soon');
  assert.throws(() => classifyAeCtRegistrationDeadline({ row: {}, asOf: '2026-08-31' }), /ISO dates/);
  assert.throws(() => classifyAeCtRegistrationDeadline({ row, asOf: null }), /ISO dates/);
});

test('ask ids are deterministic per client-year — dedupe by construction', () => {
  assert.equal(aeCtRegistrationStatusAskId({ firmId: 'f1', clientId: 'c1', year: 2026 }),
    'ct-registration-status-f1-c1-2026');
  assert.equal(aeCtRegistrationDeadlineAskId({ firmId: 'f1', clientId: 'c1', year: 2026 }),
    'ct-registration-deadline-f1-c1-2026');
});

test('the status ask requests the status itself — TRN if registered, tracking if not', () => {
  const q = buildAeCtRegistrationStatusQuestion();
  assert.match(q, /corporate tax TRN/);
  assert.match(q, /separately from VAT/);
  assert.match(q, /AED 10,000/);
});

test('a due_soon computed deadline states the date, the penalty, and who registers', () => {
  const row = { key: 'ct_registration', due_date: '2026-10-15', terminal: 'scheduled' };
  const q = buildAeCtRegistrationDeadlineQuestion({
    row, classification: { state: 'due_soon', daysUntilDue: 25 }, registration: { reason: 'not_registered' }
  });
  assert.match(q, /due by 2026-10-15/);
  assert.match(q, /AED 10,000/);
  assert.match(q, /I cannot register on your behalf/);
});

test('an overdue computed deadline carries the seven-month waiver note', () => {
  const row = { key: 'ct_registration', due_date: '2026-06-30', terminal: 'scheduled' };
  const q = buildAeCtRegistrationDeadlineQuestion({
    row, classification: { state: 'overdue', daysUntilDue: -62 }, registration: { reason: 'not_registered' }
  });
  assert.match(q, /was due 2026-06-30/);
  assert.match(q, /overdue/);
  assert.match(q, /seven months/);
});

test('a scheduled classification returns null — the caller must not ask', () => {
  const row = { key: 'ct_registration', due_date: '2026-10-15', terminal: 'scheduled' };
  assert.equal(buildAeCtRegistrationDeadlineQuestion({
    row, classification: { state: 'scheduled', daysUntilDue: 45 }, registration: { reason: 'not_registered' }
  }), null);
  assert.equal(buildAeCtRegistrationDeadlineQuestion({ row }), null);
});

test('an on_owner refusal row names the missing facts — deregistration gets its own wording', () => {
  const refusalRow = {
    key: 'ct_registration_deadline', due_date: null, terminal: 'on_owner',
    reason_code: AE_CT_REGISTRATION_REFUSAL_CODES.ctRegistrationDeadline
  };
  const blocked = buildAeCtRegistrationDeadlineQuestion({
    row: refusalRow, registration: { reason: 'not_registered' }
  });
  assert.match(blocked, /incorporation date and licence details/);
  assert.match(blocked, /AED 1,000,000/);
  assert.match(blocked, /I cannot register on your behalf/);
  const dereg = buildAeCtRegistrationDeadlineQuestion({
    row: refusalRow, registration: { reason: 'deregistered' }
  });
  assert.match(dereg, /deregistered/);
  assert.match(dereg, /re-register/);
});

test('the refusal-code vocabulary round-trips through the row builder', () => {
  // Unknown status → the status refusal, carrying THIS binding's code.
  const unknownRows = buildAeCtRegistrationDeadlineRows({
    profile: {}, onDate: '2026-08-31', refusalCodes: AE_CT_REGISTRATION_REFUSAL_CODES
  });
  assert.equal(unknownRows.length, 1);
  assert.equal(unknownRows[0].key, 'ct_registration');
  assert.equal(unknownRows[0].reason_code, 'AE_CT_REGISTRATION_STATUS_UNKNOWN');
  // Live duty, computable limb → a scheduled row this module can classify.
  const scheduled = buildAeCtRegistrationDeadlineRows({
    profile: { ct_registration: { status: 'not_registered' }, incorporation_date: '2026-07-15' },
    onDate: '2026-08-31',
    refusalCodes: AE_CT_REGISTRATION_REFUSAL_CODES
  });
  assert.equal(scheduled[0].terminal, 'scheduled');
  assert.equal(scheduled[0].due_date, '2026-10-15');
  assert.equal(classifyAeCtRegistrationDeadline({ row: scheduled[0], asOf: '2026-09-20' }).state, 'due_soon');
});
