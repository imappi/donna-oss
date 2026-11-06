import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://seam.invalid/donna';

const { createApiSeamPool } = await import('./testSupport/apiSeamHarness.js');
const { updateTransactionInDb, __setFirmDbPoolForTests } = await import('./firmDb.js');

await test('FI client Xero suggestion enrichment preserves the complete current stored envelope', async () => {
  const pool = createApiSeamPool([
    [/^select \* from transactions where firm_id = \$1 and id = \$2 for update$/, {
      rows: [{ id: 'tx-1', firm_id: 'firm-1', client_id: 'fi-1', coding_state: null, payload: { money_out: 10, description: 'Reduced-rate purchase' } }], rowCount: 1
    }],
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: {} }], rowCount: 1 }],
    [/from xero_accounts/, { rows: [
      { code: '400', name: 'Purchases', type: 'EXPENSE', status: 'ACTIVE', tax_type: 'INPUT2' },
      { code: '200', name: 'Sales', type: 'REVENUE', status: 'ACTIVE', tax_type: 'OUTPUT2' }
    ], rowCount: 2 }]
  ]);
  __setFirmDbPoolForTests(pool);
  await updateTransactionInDb({
    firmId: 'firm-1', transactionId: 'tx-1',
    patch: { tax_treatment: 'VAT 5%', proposed_account: 'Purchases', account_code: '400' }
  });
  const update = pool.matching(/update transactions/).find(({ sql }) => /payload = \$13::jsonb/.test(sql));
  assert.ok(update, 'the real transaction UPDATE ran');
  assert.equal(pool.matching(/select jurisdiction, profile from clients/).length, 1, 'the FI jurisdiction read ran');
  assert.deepEqual(JSON.parse(update.params[12]), {
    money_out: 10,
    description: 'Reduced-rate purchase',
    tax_treatment: 'INPUT2',
    proposed_account: 'Purchases',
    account_code: '400',
    account_name: 'Purchases',
    account_label: '400 · Purchases',
    xero_account_id: null,
    xero_account_code: '400',
    xero_account_name: 'Purchases',
    xero_account_type: 'EXPENSE',
    xero_tax_type: 'INPUT2',
    xero_account_match_status: 'matched'
    // RT-16: the coding state rides transactions.coding_state, never the payload.
  });
});
