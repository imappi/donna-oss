import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGbStatutoryViewModel } from './gbStatutoryView.js';

test('mounted statutory view model preserves sole-trader dates and owner refusals', () => {
  const view = buildGbStatutoryViewModel({ entity_type: 'gb-sole-trader', deadlines: [
    { key: 'return', label: 'Online return', due_date: '2027-01-31', terminal: 'scheduled' },
    { key: 'registration', label: 'Registration', terminal: 'on_owner', reason_code: 'GB_SOLE_TRADER_TRADING_START_NOT_ESTABLISHED' }
  ] });
  assert.deepEqual(view.deadlines, [
    { key: 'return', label: 'Online return', dueDate: '2027-01-31', terminal: 'scheduled', reasonCode: null },
    { key: 'registration', label: 'Registration', dueDate: null, terminal: 'on_owner', reasonCode: 'GB_SOLE_TRADER_TRADING_START_NOT_ESTABLISHED' }
  ]);
});

test('Ltd statutory envelope mapping remains byte-identical when entity dispatch is absent', () => {
  assert.deepEqual(buildGbStatutoryViewModel({ deadlines: [{ key: 'accounts', label: 'Accounts', due_date: '2027-09-30' }] }), {
    entityType: null, threshold: null,
    deadlines: [{ key: 'accounts', label: 'Accounts', dueDate: '2027-09-30', terminal: null, reasonCode: null }]
  });
});

test('partnership scheduled and owner rows share the statutory view contract', () => {
  assert.deepEqual(buildGbStatutoryViewModel({ entity_type: 'gb-partnership', deadlines: [
    { key: 'return', label: 'SA800 return', due_date: '2027-01-31', terminal: 'scheduled' },
    { key: 'vat_registration', label: 'VAT registration status', terminal: 'on_owner', reason_code: 'GB_PARTNERSHIP_VAT_REGISTRATION_NOT_ESTABLISHED' }
  ] }), {
    entityType: 'gb-partnership', threshold: null,
    deadlines: [
      { key: 'return', label: 'SA800 return', dueDate: '2027-01-31', terminal: 'scheduled', reasonCode: null },
      { key: 'vat_registration', label: 'VAT registration status', dueDate: null, terminal: 'on_owner', reasonCode: 'GB_PARTNERSHIP_VAT_REGISTRATION_NOT_ESTABLISHED' }
    ]
  });
});

test('Ltd VAT rows preserve scheduled and on-owner terminals', () => {
  const scheduled = buildGbStatutoryViewModel({ entity_type: 'gb-ltd', deadlines: [
    { key: 'vat_1', label: 'VAT return', due_date: '2026-03-07', terminal: 'scheduled' }
  ] });
  assert.deepEqual(scheduled.deadlines[0], {
    key: 'vat_1', label: 'VAT return', dueDate: '2026-03-07', terminal: 'scheduled', reasonCode: null
  });
  const unknown = buildGbStatutoryViewModel({ entity_type: 'gb-ltd', deadlines: [
    { key: 'vat_registration', label: 'VAT registration status', terminal: 'on_owner', reason_code: 'GB_LTD_VAT_REGISTRATION_NOT_ESTABLISHED' }
  ] });
  assert.deepEqual(unknown.deadlines[0], {
    key: 'vat_registration', label: 'VAT registration status', dueDate: null, terminal: 'on_owner', reasonCode: 'GB_LTD_VAT_REGISTRATION_NOT_ESTABLISHED'
  });
});

test('the feed keeps only statutory rows that ask something now', async () => {
  const { selectGbStatutoryAttention } = await import('./gbStatutoryView.js');
  const today = new Date('2026-08-01T09:00:00Z');
  const view = buildGbStatutoryViewModel({ entity_type: 'gb-ltd', deadlines: [
    { key: 'accounts', label: 'Companies House accounts', due_date: '2027-12-31', terminal: 'scheduled' },
    { key: 'confirmation', label: 'Confirmation statement', due_date: '2026-08-31', terminal: 'scheduled' },
    { key: 'vat_1', label: 'VAT return', due_date: '2026-07-07', terminal: 'scheduled' },
    { key: 'dla_s455', label: "Director's loan account", terminal: 'on_owner', reason_code: 'GB_DLA_S455_ATTENTION' }
  ] });
  assert.deepEqual(selectGbStatutoryAttention(view, { today }).deadlines.map((d) => d.key), ['confirmation', 'vat_1', 'dla_s455']);
  const farOnly = buildGbStatutoryViewModel({ deadlines: [{ key: 'accounts', label: 'Accounts', due_date: '2027-09-30' }] });
  assert.equal(selectGbStatutoryAttention(farOnly, { today }), null);
  const asked = buildGbStatutoryViewModel({ thresholdWatch: { status: 'approaching' }, deadlines: [{ key: 'accounts', label: 'Accounts', due_date: '2027-09-30' }] });
  assert.deepEqual(selectGbStatutoryAttention(asked, { today }).deadlines, []);
  assert.equal(selectGbStatutoryAttention(null), null);
});
