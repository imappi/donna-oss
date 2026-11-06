import test from 'node:test';
import assert from 'node:assert/strict';

import { accountMenuParts } from './donnaChatPresentation.js';

test('recognises the persisted chart-of-accounts list shape', () => {
  assert.deepEqual(
    accountMenuParts('Accounts: Bank · Sales · Office expenses · Suspense'),
    { lead: 'Accounts:', items: ['Bank', 'Sales', 'Office expenses', 'Suspense'] }
  );
  assert.deepEqual(
    accountMenuParts('Chart of accounts: 1000 Bank · 3000 Sales · 6100 Rent'),
    { lead: 'Chart of accounts:', items: ['1000 Bank', '3000 Sales', '6100 Rent'] }
  );
});

test('does not turn ordinary middot-separated prose into account tokens', () => {
  assert.equal(accountMenuParts('Today · across all ventures · three lines need review · one is waiting'), null);
  assert.equal(accountMenuParts('Summary: calm · current · complete · ready'), null);
  assert.equal(accountMenuParts('Accounts: Bank · Sales'), null);
});
