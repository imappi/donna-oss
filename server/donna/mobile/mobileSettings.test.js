// DB-free tests for the Settings resource: every projection conforms to the
// pinned contract, unknown stays null (never the ALV engine's monthly default,
// never a guess from the legal form), the notification switches fall back to
// the product default only when nothing is stored, and the request shapes are
// closed. The PostgreSQL lifecycle is mobileSettingsPgLifecycle.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';

import { componentSchema, validateAgainst } from './contractSchema.js';
import {
  NOTIFICATION_DEFAULTS, projectFinancialYear, projectSettings, projectVatPeriod, validateSettingsAction
} from './mobileSettings.js';
import { projectReceipt } from './mobileProjection.js';

const conforms = (value, name) => assert.deepEqual(validateAgainst(value, componentSchema(name)), [], name);

test('vat_period: the recorded Finnish verokausi, then the registration record, else null', () => {
  assert.equal(projectVatPeriod({ jurisdiction: 'FI', verokausi: 'quarter' }), 'quarter');
  assert.equal(projectVatPeriod({ jurisdiction: 'FI', verokausi: 'Quarterly' }), 'quarter', 'the writer’s own aliases');
  assert.equal(projectVatPeriod({ jurisdiction: 'FI', verokausi: null, alv_tax_period: 'year' }), 'year');
  assert.equal(projectVatPeriod({ jurisdiction: 'FI', verokausi: 'month', alv_tax_period: 'year' }), 'month', 'verokausi is what the ALV engine reads');
  assert.equal(projectVatPeriod({ jurisdiction: 'FI', entity_type: 'fi-toiminimi' }), null, 'never the monthly default, never from the legal form');
  assert.equal(projectVatPeriod({ jurisdiction: 'FI', verokausi: 'fortnightly' }), null, 'an unreadable value is unknown');
  assert.equal(projectVatPeriod({ jurisdiction: 'GB', gb_vat_stagger: '2' }), 'quarter', 'an HMRC stagger is quarterly');
  assert.equal(projectVatPeriod({ jurisdiction: 'GB', gb_vat_stagger: null }), null);
  assert.equal(projectVatPeriod({ jurisdiction: 'GB', verokausi: 'month' }), null, 'a Finnish key on a UK book is not read');
  assert.equal(projectVatPeriod({ jurisdiction: null, verokausi: 'month' }), null);
  assert.equal(projectVatPeriod(null), null);
});

test('financial_year: persisted rows only; first needs the incorporation date to match', () => {
  const periods = [
    { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' },
    { label: '2025', starts_on: '2025-03-14', ends_on: '2025-12-31', status: 'closed' }
  ];
  assert.deepEqual(projectFinancialYear({ periods, incorporationDate: '2025-03-14', today: '2026-11-10', locale: 'en' }), {
    current: '1 Jan 2026–31 Dec 2026', first: '14 Mar 2025–31 Dec 2025', statements: '14 Mar 2025–31 Dec 2025: closed'
  });
  assert.deepEqual(projectFinancialYear({ periods, incorporationDate: '2025-03-14', today: '2026-11-10', locale: 'fi' }), {
    current: '1.1.2026–31.12.2026', first: '14.3.2025–31.12.2025', statements: '14.3.2025–31.12.2025: suljettu'
  });
  assert.equal(projectFinancialYear({ periods, incorporationDate: '2019-05-01', today: '2026-11-10' }).first, null,
    'a book adopted mid-life: its first year is not in Donna');
  assert.equal(projectFinancialYear({ periods, incorporationDate: null, today: '2026-11-10' }).first, null);
  assert.deepEqual(projectFinancialYear({ periods: [], today: '2026-11-10' }), { current: null, first: null, statements: null });
  assert.equal(projectFinancialYear({ periods: periods.slice(0, 1), today: '2027-02-01' }).current, null, 'no persisted year covers today');
  assert.equal(projectFinancialYear({ periods: periods.slice(0, 1), today: '2027-02-01' }).statements, '1 Jan 2026–31 Dec 2026: not closed yet');
});

test('the settings object conforms, with the product default only when nothing is stored', () => {
  const blank = projectSettings({ facts: { jurisdiction: 'FI' }, periods: [], preferences: null, phoneNumber: null, today: '2026-11-10', locale: 'en' });
  conforms(blank, 'MobileSettings');
  assert.deepEqual(blank, {
    source: 'backend', vat_period: null, notifications: { ...NOTIFICATION_DEFAULTS }, notification_delivery: 'not_configured',
    phone_number: null, financial_year: { current: null, first: null, statements: null }
  });
  assert.deepEqual(NOTIFICATION_DEFAULTS, { needs_you: true, due_dates: true, monthly_summary: false, every_receipt: false });
  const stored = projectSettings({
    facts: { jurisdiction: 'FI', verokausi: 'year', incorporation_date: '2026-01-01' },
    periods: [{ starts_on: '2026-01-01', ends_on: '2026-12-31', status: 'open' }],
    preferences: { needs_you: false, due_dates: false, monthly_summary: true, every_receipt: true },
    phoneNumber: '+358000000001', today: '2026-11-10', locale: 'en'
  });
  conforms(stored, 'MobileSettings');
  assert.equal(stored.vat_period, 'year');
  assert.deepEqual(stored.notifications, { needs_you: false, due_dates: false, monthly_summary: true, every_receipt: true });
  assert.equal(stored.notification_delivery, 'not_configured', 'no push sender exists');
  const result = { settings: stored, receipt: projectReceipt({ summary: 'Saved.', targets: [{ target: 'notifications', applied: true }],
    auditRows: [{ id: '7', created_at: '2026-11-10T08:00:00Z' }] }) };
  conforms(result, 'MobileSettingsResult');
});

test('request shapes are closed, exactly as the contract states them', () => {
  const prefs = { needs_you: true, due_dates: false, monthly_summary: false, every_receipt: true };
  assert.deepEqual(validateSettingsAction({ type: 'set_vat_period', vat_period: 'month' }), { type: 'set_vat_period', vat_period: 'month' });
  assert.deepEqual(validateSettingsAction({ type: 'set_notifications', notifications: prefs }), { type: 'set_notifications', notifications: prefs });
  for (const body of [
    null, [], {}, { type: 'grant_authority' },
    { type: 'set_vat_period' }, { type: 'set_vat_period', vat_period: 'monthly' }, { type: 'set_vat_period', vat_period: null },
    { type: 'set_vat_period', vat_period: 'month', extra: 1 },
    { type: 'set_notifications', notifications: { ...prefs, needs_you: 'yes' } },
    { type: 'set_notifications', notifications: { needs_you: true } },
    { type: 'set_notifications', notifications: { ...prefs, marketing: true } },
    { type: 'set_notifications', notifications: prefs, vat_period: 'month' }
  ]) {
    assert.throws(() => validateSettingsAction(body), (error) => error.statusCode === 400 && error.code === 'SETTINGS_INVALID', JSON.stringify(body));
  }
  // Valid by the contract's own schema too.
  assert.deepEqual(validateAgainst({ type: 'set_vat_period', vat_period: 'quarter' }, componentSchema('MobileSettingsAction')), []);
});
