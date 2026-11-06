// SG — the effective-dated GST registration model: normalizer refusals,
// fail-safe reads, cadence resolution.
// node --test server/donna/singapore/gstRegistration.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GST_REGISTRATION_STATUSES,
  GST_REGISTRATION_BASES,
  GST_ACCOUNTING_PERIODS,
  DEFAULT_GST_ACCOUNTING_PERIOD,
  gstPeriodCadenceForProfile,
  normalizeGstRegistration,
  resolveGstRegistrationOnDate,
  normalizeNativeGstRegistration,
  createNativeRegistrationRevision,
  verifyNativeRegistrationRevisions,
  resolveNativeGstRegistrationOnDate,
  nativeRegistrationDigest
} from './gstRegistration.js';

test('the closed vocabularies', () => {
  assert.deepEqual([...GST_REGISTRATION_STATUSES], ['registered', 'not_registered', 'deregistered']);
  assert.deepEqual([...GST_REGISTRATION_BASES], ['mandatory', 'voluntary', 'other']);
  assert.deepEqual([...GST_ACCOUNTING_PERIODS], ['month', 'quarter']);
  assert.equal(DEFAULT_GST_ACCOUNTING_PERIOD, 'quarter');
});

const life = { firm_id: 'firm', client_id: 'client', created_at: '2026-01-01T00:00:00.000000Z', after_delete_id: '0' };
const source = { id: 'registration-letter', firm_id: 'firm', client_id: 'client',
  document_date: new Date(2024, 1, 29), created_at: new Date('2024-03-01T12:00:00Z'), payload: { text: 'Fixture evidence' } };
const nativeRecord = patch => normalizeNativeGstRegistration({ status: 'registered', registered_from: '2024-02-29',
  registered_until: '2024-12-31', verified_from: 'Fixture letter, page 1', verified_at: '2024-03-01',
  source_document_id: source.id, ...patch });
const auditFor = revision => ({ firm_id: life.firm_id, client_id: life.client_id, actor_id: revision.actor_id,
  actor_type: revision.actor_type, action: 'client.profile.update', resource_type: 'client', resource_id: life.client_id,
  metadata: { native_registration: revision } });
const revised = (after, { before = null, predecessorDigest = 'birth', sourceDocument = source } = {}) =>
  createNativeRegistrationRevision({ before, after, clientLife: life, predecessorDigest,
    actor: { id: 'member', type: 'firm_member' }, sourceDocument });
const verified = (revision, overrides = {}) => verifyNativeRegistrationRevisions({ registration: revision.after,
  storedRevision: revision, revisions: [auditFor(revision)], clientLife: life, birthDigest: 'birth', birthRecord: null,
  sourceDocument: source, ...overrides });

test('native registration validates calendar dates, closed facts and consistent explicit intervals', () => {
  assert.equal(nativeRecord().registered_from, '2024-02-29');
  for (const day of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-02-29T00:00:00Z']) {
    assert.throws(() => nativeRecord({ registered_from: day }), error => error.details.reason === 'registered_from_invalid');
  }
  assert.throws(() => nativeRecord({ registered_until: '2024-02-28' }), /interval_reversed/);
  assert.throws(() => nativeRecord({ covered_from: '2024-01-01' }), /conflicting_status_dates/);
  assert.throws(() => nativeRecord({ revision_digest: 'forged' }), /unsupported_or_server_owned_field/);
  assert.throws(() => nativeRecord({ status: 'not_registered' }), /conflicting_status_dates/);
  assert.throws(() => nativeRecord({ verified_from: {} }), /verified_from_invalid/);
  assert.equal(normalizeNativeGstRegistration(null), null);
});

test('native evidence resolves only the actual dated interval, never guesses No GST or tax authority', () => {
  const evidence = verified(revised(nativeRecord()));
  const resolve = (onDate, e = evidence) => resolveNativeGstRegistrationOnDate({ evidence: e, onDate });
  for (const day of ['2024-02-29', new Date(2024, 1, 29), '2024-12-31']) {
    const result = resolve(day);
    assert.equal(result.status, 'registered'); assert.equal(result.tax_authority, false);
  }
  for (const day of ['2024-02-28', '2025-01-01']) {
    assert.equal(resolve(day).status, 'outside_recorded_interval'); assert.equal(resolve(day).registered, null);
  }
  assert.equal(resolve(null).reason, 'business_date_missing');
  assert.equal(resolve('2023-02-29').reason, 'business_date_invalid');
  const nonRegistration = nativeRecord({ status: 'not_registered', registered_from: null, registered_until: null,
    covered_from: '2024-01-01', covered_until: '2024-02-28' });
  assert.equal(resolve('2024-02-28', verified(revised(nonRegistration))).status, 'not_registered');
  assert.equal(resolve('2024-02-29', verified(revised(nonRegistration))).registered, null);
  assert.equal(resolve('2024-06-01', verified(revised(nativeRecord({ status: 'deregistered' })))).registered, true);
  for (const [patch, reason] of [[{ verified_from: null }, 'verification_source_missing'],
    [{ verified_at: null }, 'unverified'], [{ registered_from: null }, 'covered_interval_missing']]) {
    const result = resolve('2024-06-01', verified(revised(nativeRecord(patch))));
    assert.equal(result.status, 'unknown'); assert.equal(result.registered, null); assert.equal(result.reason, reason);
  }
  assert.equal(resolve('2024-06-01', { registration: nativeRecord() }).reason, 'attributable_revision_missing');
  assert.equal(resolve('2024-06-01', null).reason, 'record_missing');
  assert.equal(resolve('2024-06-01', verified(revised(null))).reason, 'record_cleared');
});

test('native audit chain is scoped, attributable and immutable across edits, clear and source replacement', () => {
  const first = revised(nativeRecord());
  const cleared = revised(null, { before: first.after, predecessorDigest: first.revision_digest });
  assert.equal(verified(cleared, { revisions: [auditFor(first), auditFor(cleared)] }).registration, null);
  for (const changes of [{ registration: nativeRecord({ registered_from: '2024-03-01' }) },
    { revisions: [] }, { clientLife: { ...life, created_at: 'another-life' } },
    { revisions: [auditFor(cleared)] }, { revisions: [{ ...auditFor(first), actor_id: 'someone-else' }] }]) {
    assert.throws(() => verified(first, changes), error => error.code === 'SINGAPORE_NATIVE_REGISTRATION_INVALID');
  }
  const rewritten = { ...first, actor_id: 'system' };
  const { revision_digest, ...body } = rewritten;
  rewritten.revision_digest = nativeRegistrationDigest(body);
  assert.throws(() => verified(rewritten), /revision_chain_invalid/);
  const replacement = verified(first, { sourceDocument: { ...source, payload: { text: 'Replacement' } } });
  assert.equal(resolveNativeGstRegistrationOnDate({ evidence: replacement, onDate: '2024-06-01' }).reason, 'source_document_changed');
  const changedTimestamp = verified(first, { sourceDocument: { ...source, created_at: new Date('2024-03-01T12:00:01Z') } });
  assert.equal(changedTimestamp.source_current, false, 'timestamps must not collapse to empty objects');
  assert.equal(verified(first, { sourceDocument: { ...source, convergence_as_of: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z') } }).source_current, true, 'snapshot workflow observations are not new source evidence');
  assert.equal(verified(first, { sourceDocument: { ...source, document_date: '2024-02-29' } }).source_current, true,
    'PG calendar DATE and its literal have identical receipts in every timezone');
});

test('cadence resolution: quarterly default, alias tolerant, no annual period', () => {
  assert.equal(gstPeriodCadenceForProfile({}), 'quarter');
  assert.equal(gstPeriodCadenceForProfile({ gst_period: 'monthly' }), 'month');
  assert.equal(gstPeriodCadenceForProfile({ gst_period: 'Quarter' }), 'quarter');
  assert.equal(gstPeriodCadenceForProfile({ gst_period: 'year' }), 'quarter', 'no annual GST period — defaults');
});

test('the normalizer refuses unusable records at the boundary, typed', () => {
  assert.throws(() => normalizeGstRegistration({ status: 'maybe' }), (e) => e.code === 'SINGAPORE_GST_REGISTRATION_INVALID');
  assert.throws(() => normalizeGstRegistration({ status: 'registered' }), /registered_from/);
  assert.throws(() => normalizeGstRegistration({ status: 'deregistered' }), /registered_until/);
  const stored = normalizeGstRegistration({
    status: 'Registered',
    registered_from: '2025-04-01T00:00:00Z',
    registration_basis: 'MANDATORY',
    gst_period: 'quarterly',
    gst_registration_number: ' 201812345K ',
    verified_from: 'IRAS GST-registered businesses register lookup',
    verified_at: '2025-04-02'
  });
  assert.equal(stored.status, 'registered');
  assert.equal(stored.registered_from, '2025-04-01');
  assert.equal(stored.registration_basis, 'mandatory');
  assert.equal(stored.gst_period, 'quarter');
  assert.equal(stored.gst_registration_number, '201812345K');
  assert.equal(normalizeGstRegistration({ status: 'not_registered' }).registered_from, null);
  assert.equal(
    normalizeGstRegistration({ status: 'registered', registered_from: '2025-01-01', registration_basis: 'something-odd' }).registration_basis,
    'other',
    'unknown basis lands on the other escape, never invents a vocabulary entry'
  );
});

test('the read resolver is effective-dated and fail-safe (unusable → not registered)', () => {
  const reg = { status: 'registered', registered_from: '2025-04-01', verified_at: '2025-04-02' };
  assert.deepEqual(
    resolveGstRegistrationOnDate({ registration: reg, onDate: '2025-06-01' }),
    { registered: true, reason: 'registered', unverified: false }
  );
  assert.equal(resolveGstRegistrationOnDate({ registration: reg, onDate: '2025-03-31' }).reason, 'not_yet_effective');
  assert.equal(resolveGstRegistrationOnDate({ registration: null, onDate: '2025-06-01' }).reason, 'no_record');
  assert.equal(
    resolveGstRegistrationOnDate({ registration: { status: 'registered' }, onDate: '2025-06-01' }).reason,
    'no_effective_date',
    'a registered record without an effective date fails safe to no-GST'
  );
  const dereg = { status: 'deregistered', registered_from: '2023-01-01', registered_until: '2024-12-31' };
  assert.equal(resolveGstRegistrationOnDate({ registration: dereg, onDate: '2024-06-01' }).registered, true, 'still effective inside the bracket');
  assert.equal(resolveGstRegistrationOnDate({ registration: dereg, onDate: '2025-01-01' }).reason, 'deregistered');
  // Unverified records resolve but carry the flag.
  const unverified = resolveGstRegistrationOnDate({ registration: { status: 'registered', registered_from: '2025-01-01' }, onDate: '2025-06-01' });
  assert.equal(unverified.registered, true);
  assert.equal(unverified.unverified, true);
  assert.throws(() => resolveGstRegistrationOnDate({ registration: reg }), /onDate/);
});
