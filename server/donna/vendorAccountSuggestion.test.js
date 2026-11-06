import assert from 'node:assert/strict';
import test from 'node:test';

import { suggestAccountForVendor } from './vendorAccountSuggestion.js';

// IRS / federal — bias toward expense accounts AND require a tax-named
// account name (requiredNameContains: ['tax']) with a discriminating
// keyword (license / federal / income). The single keyword 'tax' alone
// caused false positives in two waves:
//
//   - Pre-#206: 'tax' tied "Sales tax payable" (liability) with any
//     expense tax account; CoA order broke the tie arbitrarily.
//   - Pre-#208: with the expense-type bonus added, any tax-named expense
//     account (e.g. "Property Tax") would score above zero and win by
//     elimination when no proper IRS-shaped account existed —
//     confidently wrong auto-categorisation.
//
// Post-#208 the IRS pattern refuses to auto-categorise unless an
// account name contains 'tax' AND at least one of (license / federal /
// income). If nothing strong matches, the row stays uncategorised for
// manual review — safer than routing IRS payments to "Property Tax".

const HONEYBEE_CHART = [
  { code: '2200', name: 'Sales tax payable',  account_type: 'liability' },
  { code: '5400', name: 'Taxes & licenses',   account_type: 'expense'   },
  { code: '5600', name: 'Federal income tax', account_type: 'expense'   },
  { code: '5500', name: 'Office Supplies',    account_type: 'expense'   }
];

await test('IRS payment prefers "Taxes & licenses" over "Sales tax payable" (regression)', () => {
  const result = suggestAccountForVendor('IRS', 'IRS USATAXPYMT', HONEYBEE_CHART);
  assert.ok(result);
  assert.equal(result.account.account_type, 'expense', 'should land on an expense account, not the sales-tax liability accrual');
  assert.ok(
    ['5400', '5600'].includes(result.account.code),
    `expected Taxes & licenses (5400) or Federal income tax (5600), got ${result.account.code} (${result.account.name})`
  );
});

await test('IRS bare descriptor matches the federal pattern', () => {
  const result = suggestAccountForVendor('', 'IRS PAYMENT 12345', HONEYBEE_CHART);
  assert.ok(result, 'IRS-only descriptor must trigger the federal-tax signal');
  assert.equal(result.account.account_type, 'expense');
});

await test('usataxpymt descriptor (typical bank statement form) matches', () => {
  const result = suggestAccountForVendor('', 'USATAXPYMT 04212026', HONEYBEE_CHART);
  assert.ok(result, 'USATAXPYMT must trigger the federal-tax signal — common bank-statement format');
  assert.equal(result.account.account_type, 'expense');
});

await test('"federal tax" descriptor matches the federal pattern', () => {
  const result = suggestAccountForVendor('', 'FEDERAL TAX PAYMENT Q2', HONEYBEE_CHART);
  assert.ok(result);
  assert.equal(result.account.account_type, 'expense');
});

await test('IRS payment returns null when no expense tax-licence account exists (conservative)', () => {
  // Pre-#208 fell back to "Sales tax payable" — but that's the wrong
  // home for an IRS federal-income-tax payment. Post-#208 the IRS
  // pattern refuses to auto-categorise unless an account with 'tax' in
  // its name AND a discriminating keyword (license / federal / income)
  // exists. Without that, the row stays uncategorised for manual review.
  const liabilityOnly = [
    { code: '2200', name: 'Sales tax payable',  account_type: 'liability' },
    { code: '5500', name: 'Office Supplies',    account_type: 'expense'   }
  ];
  const result = suggestAccountForVendor('IRS', 'IRS USATAXPYMT', liabilityOnly);
  assert.equal(result, null, 'should leave for manual review rather than route to Sales tax payable');
});

await test('IRS payment does NOT route to "Property Tax" (Honeybee post-#206 regression)', () => {
  // Honeybee's chart after #206 deploy: Property Tax (expense) +
  // Sales Tax Payable (liability), no Taxes & Licenses. Pre-#208 the
  // mapping picked Property Tax — only tax-named expense account, won
  // by elimination. Property Tax is NOT IRS federal income tax, so
  // auto-confirming there is confidently wrong. Post-#208 the IRS
  // pattern requires a discriminating keyword (license / federal /
  // income) on top of 'tax' — Property Tax has only 'tax', fails,
  // row stays uncategorised.
  const honeybeePropertyTaxOnly = [
    { code: '6110', name: 'Property Tax',      account_type: 'expense'   },
    { code: '2100', name: 'Sales Tax Payable', account_type: 'liability' },
    { code: '6040', name: 'Office Supplies',   account_type: 'expense'   }
  ];
  const result = suggestAccountForVendor('IRS', 'IRS USATAXPYMT', honeybeePropertyTaxOnly);
  assert.equal(result, null, 'Property Tax must NOT win an IRS payment by elimination');
});

await test('IRS payment does NOT route to "Software Licenses" (lookalike rejection)', () => {
  // "Software Licenses" contains 'license' but not 'tax'. The new
  // requiredNameContains:['tax'] filter excludes it before scoring.
  // Without that, license(7) + expense(10) = 17 would have had
  // Software Licenses winning over any tax-named account that scored
  // lower (or tying with Taxes & licenses and going to CoA order).
  const noTaxAccounts = [
    { code: '6120', name: 'Software Licenses',  account_type: 'expense' },
    { code: '6040', name: 'Office Supplies',    account_type: 'expense' }
  ];
  const result = suggestAccountForVendor('IRS', 'IRS USATAXPYMT', noTaxAccounts);
  assert.equal(result, null, 'Software Licenses lacks "tax" in the name — must not be eligible');
});

await test('IRS payment with Honeybee post-#207 chart routes to "Taxes & Licenses"', () => {
  // After #207's backfill, Honeybee's chart gains a 6115 "Taxes &
  // Licenses" entry alongside the existing 6110 Property Tax + 2100
  // Sales Tax Payable. With the conservative scorer:
  //   - Taxes & Licenses: required 'tax' passes + license(7) + expense(10) = 17  → WIN
  //   - Property Tax:     required 'tax' passes + no discriminator   = 0
  //   - Sales Tax Payable: required 'tax' passes + no discriminator  = 0
  const honeybeeWithFix = [
    { code: '6110', name: 'Property Tax',      account_type: 'expense'   },
    { code: '6115', name: 'Taxes & Licenses',  account_type: 'expense'   },
    { code: '2100', name: 'Sales Tax Payable', account_type: 'liability' },
    { code: '6040', name: 'Office Supplies',   account_type: 'expense'   }
  ];
  const result = suggestAccountForVendor('IRS', 'IRS USATAXPYMT', honeybeeWithFix);
  assert.ok(result, 'must route to a real account when Taxes & Licenses exists');
  assert.equal(result.account.code, '6115');
});

await test('State tax payment may land on a liability accrual (separate signal)', () => {
  // State/unspecified "tax payment" descriptors keep BOTH account types
  // eligible, because firms legitimately settle these to either a tax
  // expense or a tax-liability accrual depending on bookkeeping pattern.
  const result = suggestAccountForVendor('', 'STATE TAX PAYMENT CA', HONEYBEE_CHART);
  assert.ok(result);
  assert.ok(
    ['2200', '5400', '5600'].includes(result.account.code),
    `state tax payment should match a tax account, got ${result.account.code}`
  );
});

await test('Non-tax vendor signal is unaffected by the IRS split', () => {
  const fuelChart = [
    { code: '5100', name: 'Vehicle Fuel',     account_type: 'expense' },
    { code: '5200', name: 'Office Supplies',  account_type: 'expense' }
  ];
  const result = suggestAccountForVendor('', 'CHEVRON GAS STA #1234', fuelChart);
  assert.ok(result);
  assert.equal(result.account.code, '5100');
});

await test('"tax" alone (no IRS, no payment context) does not coerce to expense', () => {
  // Without "irs", "usataxpymt", "federal tax", "tax payment", or "state
  // tax" in the descriptor, neither tax pattern should fire — so a
  // generic "TAX" in a description shouldn't auto-categorize.
  const result = suggestAccountForVendor('', 'CONTRACTOR TAX FORM 1099', HONEYBEE_CHART);
  // 'contractor' doesn't hit the patterns; 'tax' alone shouldn't either.
  // Fallback word_overlap may still find a tax-named account from the
  // word 'tax' in vendorName, but vendor is empty here.
  assert.equal(result, null);
});
