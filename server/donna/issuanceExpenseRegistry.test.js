import test from 'node:test';
import assert from 'node:assert/strict';
import * as publicDb from './firmDb.js';
import * as fi from './finland/issuanceDb.js';
import { createIssuanceRegistry, resolveIssuanceOperation } from './issuanceRegistry.js';
import { createOwnerExpenseRegistry } from './ownerExpenseRegistry.js';
import { buildOwnerMileageComputation } from './ownerMileageExpense.js';
import { resolveCountryCapability, discoverCountryCapabilities } from './countryCapabilities.js';

test('registered FI lifecycle preserves every existing public writer identity', () => {
  for (const [name, implementation] of Object.entries(fi)) {
    assert.equal(resolveIssuanceOperation({ jurisdiction: 'fi', operation: name }), implementation);
    if (!name.endsWith('EntryActsInDb')) assert.equal(publicDb[name], implementation, name);
  }
  for (const country of ['sg', 'gb', 'ae', 'us', 'au', null, 'zz']) {
    assert.throws(() => resolveIssuanceOperation({ jurisdiction: country, operation: 'createIssuedInvoiceDraftInDb' }), e => e.code.startsWith('issuance_jurisdiction_'));
  }
  assert.throws(() => resolveIssuanceOperation({ jurisdiction: 'fi', operation: 'toString' }), e => e.code === 'issuance_operation_unsupported');
  const operation = () => 'fixture';
  const registry = createIssuanceRegistry({ zz: { issue: operation } });
  assert.equal(resolveIssuanceOperation({ jurisdiction: 'zz', operation: 'issue', registry }), operation);
});

test('expense capability is explicit, separate from coding/outbound, and extensible', () => {
  for (const jurisdiction of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    assert.equal(Boolean(resolveCountryCapability({ jurisdiction, operation: 'owner_expense' })), ['fi', 'gb', 'us'].includes(jurisdiction));
  }
  assert.deepEqual(discoverCountryCapabilities('owner_expense').registrations.map(r => r.jurisdiction), ['fi', 'gb', 'us']);
  const registry = createOwnerExpenseRegistry({ zz: { mileage: ({ miles, year }) => ({ status: 'computed', deduction: miles * 2, year, currency: 'ZZZ' }) } });
  assert.deepEqual(buildOwnerMileageComputation({ jurisdiction: 'zz', miles: 3, date: '2025-01-02', registry }), { status: 'computed', deduction: 6, year: 2025, currency: 'ZZZ' });
  assert.equal(resolveCountryCapability({ jurisdiction: 'zz', operation: 'outbound' }), null);
});

test('dated FI allowances and unsupported US years retain exact limitations; GB provenance stays unverified', () => {
  for (const [year, rate] of [[2024, 0.57], [2025, 0.59], [2026, 0.55]]) {
    const value = buildOwnerMileageComputation({ jurisdiction: 'FI', km: 100, date: `${year}-12-31`, now: new Date('2030-01-01') });
    assert.equal(value.rate, rate); assert.equal(value.deduction, Math.round(rate * 100)); assert.equal(value.year, year);
  }
  for (const jurisdiction of ['FI', 'US']) {
    assert.equal(buildOwnerMileageComputation({ jurisdiction, miles: 20, date: '2027-01-01' }).reason, `missing_${jurisdiction.toLowerCase()}_rate_for_year`);
  }
  const gb = buildOwnerMileageComputation({ jurisdiction: 'UK', miles: 12000, date: '2026-09-05' });
  assert.equal(gb.deduction, 5000); assert.equal(gb.confirmedAgainstPrimary, false); assert.equal(gb.exactRate, false);
  assert.equal(buildOwnerMileageComputation({ jurisdiction: 'not United States', miles: 2 }).reason, 'unsupported_jurisdiction');
});
