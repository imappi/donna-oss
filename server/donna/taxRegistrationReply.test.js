// The registration lane's contract, without a database: which asks it claims,
// the checks that do not depend on the model, and each country's record and
// wording behind the shared declaration (postingPolicy.js taxRegistration).
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStructuredOwnerReplyAdapter, supportsStructuredOwnerReply } from './statutoryRegistry.js';
import { checkTaxRegistrationAnswer, registrationAnswerEffect, validateTaxRegistrationAnswer, TAX_REGISTRATION_LANE } from './taxRegistrationReply.js';
import { resolvePostingPolicy } from './postingPolicy.js';

const ask = { evidence_type: 'business_purpose', transaction_id: 'tx-1', request_payload: { lane: TAX_REGISTRATION_LANE } };

test('the registration lane claims its line-anchored question and nothing else', () => {
  for (const jurisdiction of ['fi', 'gb']) {
    assert.equal(resolveStructuredOwnerReplyAdapter({ jurisdiction, evidenceType: 'business_purpose', request: ask })?.lane, TAX_REGISTRATION_LANE);
  }
  assert.equal(supportsStructuredOwnerReply(ask), true);
  // A plain business-purpose line question stays the coder's reply.
  for (const other of [{ ...ask, request_payload: {} }, { ...ask, evidence_type: 'supporting_document' }]) {
    assert.equal(resolveStructuredOwnerReplyAdapter({ jurisdiction: 'fi', evidenceType: other.evidence_type, request: other }), null);
  }
});

test('the answer shape is closed and the date checks do not depend on the model', () => {
  const today = '2026-11-10';
  const answer = (registered, from = null, until = null) => ({ registered, registered_from: from, registered_until: until });
  assert.equal(validateTaxRegistrationAnswer(answer('yes', '2026-01-01')), true);
  assert.equal(validateTaxRegistrationAnswer({ ...answer('yes', '2026-01-01'), vat_number: 'x' }), false);
  assert.equal(validateTaxRegistrationAnswer(answer('maybe')), false);
  assert.equal(validateTaxRegistrationAnswer(answer('yes', '1.1.2026')), false);
  assert.deepEqual(checkTaxRegistrationAnswer(answer('yes', '2026-01-01'), { today }), { registered: true, registeredFrom: '2026-01-01', registeredUntil: null });
  assert.deepEqual(checkTaxRegistrationAnswer(answer('no'), { today }), { registered: false, registeredFrom: null, registeredUntil: null });
  assert.deepEqual(checkTaxRegistrationAnswer(answer('no', '2025-01-01', '2026-03-31'), { today }), { registered: false, registeredFrom: '2025-01-01', registeredUntil: '2026-03-31' });
  assert.deepEqual(checkTaxRegistrationAnswer(answer('unclear'), { today }), { followUp: 'unclear' });
  assert.deepEqual(checkTaxRegistrationAnswer(answer('yes'), { today }), { followUp: 'date' }, 'yes without a date');
  assert.deepEqual(checkTaxRegistrationAnswer(answer('yes', '2026-02-30'), { today }), { followUp: 'date' }, 'not a real day');
  assert.deepEqual(checkTaxRegistrationAnswer(answer('yes', '2026-11-11'), { today }), { followUp: 'date' }, 'in the future');
  assert.deepEqual(checkTaxRegistrationAnswer(answer('yes', '2026-05-01', '2026-04-01'), { today }), { followUp: 'date' }, 'end before start');
  assert.deepEqual(checkTaxRegistrationAnswer(answer('no', '2026-05-01'), { today }), { followUp: 'unclear' });
  assert.deepEqual(checkTaxRegistrationAnswer(null, { today }), { followUp: 'unclear' });
});

test('each country builds its record through its own normaliser and words the follow-up in the owner\'s language', () => {
  const fi = resolvePostingPolicy({ jurisdiction: 'fi' }).taxRegistration;
  const gb = resolvePostingPolicy({ jurisdiction: 'gb' }).taxRegistration;
  assert.equal(fi.profileField, 'alv_registration');
  assert.equal(gb.profileField, 'vat_registration');
  assert.deepEqual(fi.recordLockedCodes, ['FI_PROFILE_PILOT_PREPARED']);
  assert.deepEqual(gb.recordLockedCodes, []);
  assert.deepEqual(fi.recordFromAnswer({ current: { status: 'not_registered' }, registered: true, registeredFrom: '2026-01-01', source: 'Owner answer to question q-1' }),
    { status: 'registered', registered_from: '2026-01-01', note: 'Owner answer to question q-1' });
  assert.deepEqual(fi.recordFromAnswer({ current: { status: 'registered', registered_from: '2024-01-01', tax_period: 'quarter', verified_at: '2024-02-01' }, registered: true, registeredFrom: '2025-01-01' }),
    { status: 'registered', registered_from: '2025-01-01', tax_period: 'quarter' }, 'the cadence stays; an owner answer is not primary verification');
  assert.equal(fi.recordFromAnswer({ registered: false, registeredUntil: '2026-03-31' }).status, 'deregistered');
  assert.equal(gb.recordFromAnswer({ current: { status: 'registered', registered_from: '2024-01-01', vat_registration_number: 'GB123456789' }, registered: false }).vat_registration_number, null,
    'a not-registered record carries no VAT number');
  assert.equal(gb.recordFromAnswer({ current: { status: 'registered', registered_from: '2024-01-01', vat_registration_number: 'GB123456789' }, registered: true, registeredFrom: '2025-01-01' }).vat_registration_number, 'GB123456789');
  for (const rule of [fi, gb]) for (const kind of ['date', 'unclear', 'exhausted']) {
    assert.notEqual(rule.answerQuestion({ language: 'fi', kind }), rule.answerQuestion({ language: 'en', kind }));
  }
  assert.equal(gb.recordedNotice({ language: 'en', record: { status: 'registered', registered_from: '2026-01-01' } }),
    'We recorded that the business has been VAT-registered since 2026-01-01. Reply here if that is not right.');
  assert.equal(fi.recordedNotice({ language: 'fi', record: { status: 'not_registered' } }),
    'Kirjasimme, että yritys ei ole arvonlisäverorekisterissä. Vastaa tähän, jos tieto ei ole oikein.');
  // The statement a surface without a reply shows: the same line, no invitation.
  assert.equal(gb.recordedNotice({ language: 'en', record: { status: 'registered', registered_from: '2026-01-01' }, replyInvitation: false }),
    'We recorded that the business has been VAT-registered since 2026-01-01.');
  assert.equal(fi.recordedNotice({ language: 'fi', record: { status: 'not_registered' }, replyInvitation: false }),
    'Kirjasimme, että yritys ei ole arvonlisäverorekisterissä.');
  for (const rule of [fi, gb]) for (const language of ['fi', 'en']) for (const record of [{ status: 'not_registered' },
    { status: 'registered', registered_from: '2026-01-01' }, { status: 'deregistered', registered_from: '2025-01-01', registered_until: '2026-03-31' }]) {
    const line = rule.recordedNotice({ language, record });
    const statement = rule.recordedNotice({ language, record, replyInvitation: false });
    assert.ok(line.startsWith(statement) && line.length > statement.length, `${language} ${record.status}`);
    assert.doesNotMatch(statement, /Reply here|Vastaa tähän/);
  }
  // Nothing recorded: a fixed line in the owner's language that never says it was recorded.
  for (const rule of [fi, gb]) {
    assert.notEqual(rule.notRecordedNotice({ language: 'fi' }), rule.notRecordedNotice({ language: 'en' }));
    for (const language of ['fi', 'en']) assert.doesNotMatch(rule.notRecordedNotice({ language }), /recorded that|Kirjasimme|Reply here|Vastaa tähän/);
  }
  assert.equal(gb.notRecordedNotice({ language: 'en' }),
    'Your answer is saved, but we did not change the VAT registration details we hold for the business. Your accountant needs to check it before the record is changed.');
});

test('a registration declaration without its answer contract is refused, never a silent no-op', async () => {
  const { POSTING_POLICY_REGISTRY } = await import('./postingPolicyRegistry.js');
  const fi = POSTING_POLICY_REGISTRY.fi;
  for (const omit of ['profileField', 'recordLockedCodes', 'recordFromAnswer', 'answerQuestion', 'recordedNotice', 'notRecordedNotice']) {
    const { [omit]: _dropped, ...taxRegistration } = fi.taxRegistration;
    assert.throws(() => resolvePostingPolicy({ jurisdiction: 'fi', registry: { fi: { ...fi, taxRegistration } } }),
      (error) => error.code === 'posting_policy_invalid', omit);
  }
});

test('an answer never removes a registered day the record holds', () => {
  const reg = (from, until = null) => ({ status: until ? 'deregistered' : 'registered', registered_from: from, registered_until: until });
  const no = { registered: false, registeredFrom: null, registeredUntil: null };
  const yes = (from, until = null) => ({ registered: true, registeredFrom: from, registeredUntil: until });
  const effect = (before, record, checked) => registrationAnswerEffect({ before, record, checked });
  assert.equal(effect(null, reg('2026-01-01'), yes('2026-01-01')), 'write', 'no record');
  assert.equal(effect({ status: 'not_registered' }, reg('2026-01-01'), yes('2026-01-01')), 'write', 'a record that covers no day');
  assert.equal(effect(null, { status: 'not_registered' }, no), 'write');
  assert.equal(effect(reg('2026-03-01'), reg('2026-01-01'), yes('2026-01-01')), 'write', 'an earlier start');
  assert.equal(effect(reg('2025-01-01', '2026-03-31'), reg('2025-01-01'), yes('2025-01-01')), 'write', 'an end removed');
  assert.equal(effect(reg('2026-03-01'), reg('2026-03-01'), yes('2026-03-01')), 'confirm', 'restated');
  assert.equal(effect(reg('2026-03-01'), { status: 'not_registered' }, no), 'confirm', 'a plain no when a record exists');
  assert.equal(effect({ status: 'not_registered' }, { status: 'not_registered' }, no), 'confirm');
  assert.equal(effect(reg('2026-03-01'), reg('2026-04-01'), yes('2026-04-01')), 'conflict', 'a later start');
  assert.equal(effect(reg('2026-03-01'), reg('2026-03-01', '2026-06-30'), yes('2026-03-01', '2026-06-30')), 'conflict', 'a new end');
  assert.equal(effect(reg('2025-01-01', '2026-03-31'), reg('2025-01-01', '2025-12-31'), yes('2025-01-01', '2025-12-31')), 'conflict', 'an earlier end');
  assert.equal(effect(reg('2025-01-01', '2026-03-31'), reg('2025-06-01', '2026-03-31'), { registered: false, registeredFrom: '2025-06-01', registeredUntil: '2026-03-31' }), 'conflict');
  // A deregistered record with only an end covers every day up to it (an open start).
  const endOnly = { status: 'deregistered', registered_from: null, registered_until: '2026-03-31' };
  assert.equal(effect(endOnly, reg('2026-06-01'), yes('2026-06-01')), 'conflict', 'yes since a later date');
  assert.equal(effect(endOnly, reg('2020-01-01'), yes('2020-01-01')), 'conflict', 'any dated start drops the open start');
  assert.equal(effect(endOnly, { status: 'not_registered' }, no), 'confirm', 'a plain no');
});
