// Audit L3 remainder — the suggestion-lane jurisdiction seam.
//
// Drive the real updateTransactionInDb enrichment writer. Registered GB/SG
// context may translate prose; missing/conflicting canonical identity cannot
// select a country policy. Synced connector defaults remain connector data.

import test from 'node:test';
import assert from 'node:assert/strict';

// Env BEFORE the module graph: apiSeamHarness pulls in api.js, whose load-time
// initialization must already see a configured DATABASE_URL — a static import
// would hoist above the env assignment and cache an unconfigured pool state.
//
// NO test.after cleanup, deliberately: with top-level `await test(...)`, an
// after-hook registered before the later tests exist fires after the FIRST
// test and interleaves into the next test's async run — it deleted
// DATABASE_URL and nulled the pool cache mid-call when this file tried it.
// The suite runner spawns one process per file, so env/pool state dies with
// the process and needs no restoration.
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';

const { createApiSeamPool } = await import('./testSupport/apiSeamHarness.js');
const { updateTransactionInDb, __setFirmDbPoolForTests } = await import('./firmDb.js');

const CHART = [
  { code: '400', name: 'Purchases', type: 'EXPENSE', status: 'ACTIVE', tax_type: 'INPUT2' },
  { code: '200', name: 'Sales', type: 'REVENUE', status: 'ACTIVE', tax_type: 'OUTPUT2' }
];

const runUpdate = async ({ clientRow, taxTreatment = 'VAT 5%' }) => {
  const pool = createApiSeamPool([
    [/^select \* from transactions where firm_id = \$1 and id = \$2 for update$/, {
      rows: [{ id: 'tx-1', firm_id: 'firm-1', client_id: 'c-1', coding_state: null, payload: { money_out: 10, description: 'Reduced-rate purchase' } }],
      rowCount: 1
    }],
    [/select jurisdiction, profile from clients/, { rows: clientRow ? [clientRow] : [], rowCount: clientRow ? 1 : 0 }],
    [/from xero_accounts/, { rows: CHART, rowCount: CHART.length }]
  ]);
  // The pool is set per-run and reset ONLY in test.after: updateTransactionInDb
  // leaves best-effort stragglers behind, and a reset between tests opens a
  // window where a straggler rebuilds the real pool from a null cache.
  __setFirmDbPoolForTests(pool);
  await updateTransactionInDb({
    firmId: 'firm-1',
    transactionId: 'tx-1',
    patch: { tax_treatment: taxTreatment, proposed_account: 'Purchases', account_code: '400' }
  });
  const update = pool.matching(/update transactions/).find(({ sql }) => /payload = \$13::jsonb/.test(sql));
  assert.ok(update, 'the real transaction UPDATE ran');
  return { pool, persisted: JSON.parse(update.params[12]) };
};

await test('a GB client\'s stored coding carries the GB reduced-rate code — never blank, never an SG code', async () => {
  const { pool, persisted } = await runUpdate({
    clientRow: { jurisdiction: 'GB', profile: {} }
  });
  assert.equal(persisted.xero_tax_type, 'INPUT3', 'VAT 5% on a purchase must persist the UK reduced-rate input code');
  assert.ok(
    pool.matching(/select jurisdiction, profile from clients/).length >= 1,
    'the jurisdiction read must actually run (the unmatched-SQL trap: an empty pool silently resolves legacy SG)'
  );
});

await test('a conflicting profile cannot override canonical country at the stored enrichment writer', async () => {
  for (const clientRow of [
    { jurisdiction: 'SG', profile: { jurisdiction: 'uk' } },
    { jurisdiction: null, profile: { jurisdiction: 'gb' } }
  ]) {
    const { persisted } = await runUpdate({ clientRow });
    assert.equal(persisted.xero_tax_type, 'INPUT2', 'only the synced chart code survives without admitted country context');
    assert.equal(persisted.tax_treatment, 'INPUT2', 'untranslated prose cannot label a different effective connector code');
  }
});

await test('only explicit Singapore identity translates SG prose; absent and missing identity preserve synced data', async () => {
  const sg = await runUpdate({ clientRow: { jurisdiction: 'SG', profile: {} }, taxTreatment: 'No GST' });
  const absent = await runUpdate({ clientRow: { jurisdiction: null, profile: {} }, taxTreatment: 'No GST' });
  const missing = await runUpdate({ clientRow: null, taxTreatment: 'No GST' });
  assert.equal(sg.persisted.xero_tax_type, 'OPINPUT', 'the registered SG translator remains active');
  assert.equal(absent.persisted.xero_tax_type, 'INPUT2', 'unknown country cannot translate No GST as Singapore');
  assert.equal(absent.persisted.tax_treatment, 'INPUT2');
  assert.deepEqual(absent.persisted, missing.persisted, 'optional missing-context enrichment remains readable without country inference');
  const { xero_tax_type: sgCode, tax_treatment: sgLabel, ...sgAccounting } = sg.persisted;
  const { xero_tax_type: unknownCode, tax_treatment: unknownLabel, ...unknownAccounting } = absent.persisted;
  assert.deepEqual(sgAccounting, unknownAccounting, 'country translation does not change the transaction or matched account');
});
