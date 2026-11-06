import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichCodingWithXeroAccount } from '../xeroAccountMatcher.js';
import { GB_XERO_TAX_TYPE_PROVENANCE, GB_XERO_TAX_TYPES, resolveGbCoderTaxType } from './xeroTaxTypes.js';

const chart = [
  { code: '200', name: 'Sales', type: 'REVENUE', tax_type: 'OUTPUT2', status: 'ACTIVE' },
  { code: '400', name: 'Purchases', type: 'EXPENSE', tax_type: 'INPUT2', status: 'ACTIVE' }
];

test('GB client enrichment renders reduced VAT in both directions and no SG reverse-charge code', () => {
  const sale = enrichCodingWithXeroAccount({ jurisdiction: 'uk', coding: { proposed_account: 'Sales', tax_treatment: 'VAT 5%' }, transaction: { money_in: 10 }, xeroAccounts: chart });
  const purchase = enrichCodingWithXeroAccount({ jurisdiction: 'gb', coding: { proposed_account: 'Purchases', tax_treatment: 'VAT 5%' }, transaction: { money_out: 10 }, xeroAccounts: chart });
  assert.equal(sale.xero_tax_type, 'OUTPUT3');
  assert.equal(purchase.xero_tax_type, 'INPUT3');
  assert.equal(resolveGbCoderTaxType({ taxTreatment: 'Reverse charge', direction: 'out' }), 'REVERSECHARGES');
  assert.equal(resolveGbCoderTaxType({ taxType: 'OPINPUT' }), '', 'SG explicit code is jurisdiction-scoped out');
});

test('GB vocabulary and unconfirmed provenance are pinned', () => {
  assert.deepEqual(GB_XERO_TAX_TYPES.reduced, { out: 'OUTPUT3', in: 'INPUT3' });
  assert.equal(GB_XERO_TAX_TYPE_PROVENANCE.confirmedAgainstPrimary, false);
});
