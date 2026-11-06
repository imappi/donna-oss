import assert from 'node:assert/strict';
import test from 'node:test';
import { readAccountingProfile, normalizeAccountingProfilePatch, accountingProfileFailures } from '../../src/lib/accountingProfile.js';
import { readinessProfileCoordinate } from './runtimeReadiness.js';
import { clientAccountingBasisFromProfile } from './db/clients.js';

test('view and method are independent and historical omission/bytes survive', () => {
  const legacy = { companyName: 'Synthetic', accounting_basis: 'management_books', opening_balance: { currency: 'AED' } };
  assert.deepEqual(normalizeAccountingProfilePatch(legacy), legacy);
  for (const key of ['accountingBasis', 'accounting_basis']) {
    for (const method of ['cash', 'accrual']) {
      const profile = { [key]: method };
      assert.equal(readAccountingProfile(profile).view.value, 'management_books');
      assert.equal(clientAccountingBasisFromProfile({ profile }), method);
      assert.deepEqual(accountingProfileFailures(profile), []);
    }
  }
  assert.equal(readAccountingProfile({}).method.status, 'unspecified');
  assert.equal(clientAccountingBasisFromProfile({ profile: {} }), 'accrual');
});

test('explicit unknown never resurrects legacy fields and duplicate repairs are bounded', () => {
  assert.equal(readAccountingProfile({ accounting_view: null, bookBasis: 'management_books' }).view.value, null);
  assert.throws(() => clientAccountingBasisFromProfile({ profile: { accountingBasis: null, accounting_basis: 'cash' } }), /consistent cash or accrual/);
  assert.deepEqual(normalizeAccountingProfilePatch({ accountingBasis: 'cash' }, { accounting_basis: 'accrual' }), { accountingBasis: 'cash', accounting_basis: 'cash' });
  assert.deepEqual(normalizeAccountingProfilePatch({ accounting_view: null }, { bookBasis: 'management_books' }), { accounting_view: null });
  assert.throws(() => normalizeAccountingProfilePatch({ accounting_view: 'cash' }), { code: 'ACCOUNTING_PROFILE_INVALID' });
  assert.throws(() => normalizeAccountingProfilePatch({ accountingBasis: 'cash', accounting_basis: 'accrual' }), { code: 'ACCOUNTING_PROFILE_CONFLICT' });
  assert.throws(() => normalizeAccountingProfilePatch({ accounting_view: 'management_books', accountingView: 'statutory_books' }), { code: 'ACCOUNTING_PROFILE_CONFLICT' });
  assert.deepEqual(accountingProfileFailures({ accounting_view: 'statutory_books', accountingBasis: 'cash' }), ['accounting_view_unsupported']);
});

test('readiness coordinates never resurrect cleared jurisdiction/legal form or use method as view', () => {
  const coordinate = readinessProfileCoordinate({ client: { jurisdiction: null, entity_type: null, profile: { jurisdiction: 'AE', entityType: 'ae-llc', accounting_basis: 'cash' } }, creationPath: 'desktop_firm_intake' });
  assert.equal(coordinate.jurisdiction, '');
  assert.equal(coordinate.canonical_legal_form, '');
  assert.equal(coordinate.accounting_view, 'management_books');
});

test('repurposing the legacy slot preserves the otherwise-lost axis; clearing cannot graduate statutory', () => {
  assert.deepEqual(normalizeAccountingProfilePatch({ accounting_basis: 'cash' }, { accounting_basis: 'statutory_books' }), { accounting_basis: 'cash', accounting_view: 'statutory_books' });
  assert.deepEqual(normalizeAccountingProfilePatch({ accounting_basis: 'statutory_books' }, { accounting_basis: 'cash' }), { accounting_basis: 'statutory_books', accountingBasis: 'cash' });
  const cleared = normalizeAccountingProfilePatch({ accounting_basis: null }, { accounting_basis: 'statutory_books' });
  assert.equal(cleared.accounting_view, null);
  assert.ok(accountingProfileFailures(cleared).includes('accounting_view_unknown'));
});

test('legacy repurposing cannot hide contradictory or cleared sibling declarations', () => {
  for (const bookBasis of ['statutory_books', null, 'unknown']) {
    const stored = { accounting_basis: 'management_books', bookBasis };
    assert.throws(() => normalizeAccountingProfilePatch({ accounting_basis: 'cash' }, stored), { code: 'ACCOUNTING_PROFILE_CONFLICT' });
    assert.equal(normalizeAccountingProfilePatch({ accounting_basis: 'cash', accounting_view: 'statutory_books' }, stored).accounting_view, 'statutory_books');
    assert.equal(normalizeAccountingProfilePatch({ accounting_basis: null }, stored).accounting_view, null);
  }
  for (const accountingBasis of ['accrual', null, 'unknown']) {
    assert.throws(() => normalizeAccountingProfilePatch({ accounting_basis: 'statutory_books' }, { accounting_basis: 'cash', accountingBasis }), { code: 'ACCOUNTING_PROFILE_CONFLICT' });
  }
});
