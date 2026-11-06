// Pack-palette chart seed (Desert Rose round-4 review §D, 2026-09-01). Mock-pg
// harness (the hostPlaneSeed.test.js shape). Pins:
//   - a routed client (flag acts, jurisdiction resolves to an authored pack)
//     gets every palette account inserted by NAME-keyed id (the posting
//     upsert's code-less scheme) with type/normal balance from the role class,
//     the role itself, null code, and ONE audit receipt;
//   - an existing same-name row minted 'unknown' is FILLED (type + role),
//     never overwritten when already typed/roled;
//   - a second run is a no-op (already_complete, no receipt);
//   - flag inactive / no pack / synced external chart ⇒ nothing written.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  seedPackPaletteChartWithClient,
  ledgerRecordId,
  PACK_PALETTE_CHART_SEED_ACTION
} from './firmDb.js';
import { loadOutboundPack, fallbackAccountsForPack, JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY } from './outbound/packs.js';

const AE_PALETTE = fallbackAccountsForPack(loadOutboundPack('ae'));

const makeClient = ({
  clientRow = { jurisdiction: 'ae', profile: {} },
  flagRows = [{ flag_key: JURISDICTION_ACCOUNT_PALETTE_FLAG_KEY, stage: 'auto', source: 'default', client_id: 'client-1' }],
  syncedRows = [],
  ledgerRows = []
} = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes('select jurisdiction, entity_type, profile from clients')) return { rows: clientRow ? [clientRow] : [] };
      if (text.includes('from client_capability_config')) return { rows: flagRows };
      if (text.includes('from cohort_capability_config')) return { rows: [] };
      if (text.includes('from xero_accounts')) return { rows: syncedRows };
      if (text.includes('from ledger_accounts')) return { rows: ledgerRows };
      if (text.includes('insert into ledger_accounts')) return { rows: [{ id: params[0] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
};

const inserts = (client) => client.calls.filter((c) => c.sql.includes('insert into ledger_accounts'));
const updates = (client) => client.calls.filter((c) => c.sql.includes('update ledger_accounts'));
const audits = (client) => client.calls.filter((c) => c.sql.includes(PACK_PALETTE_CHART_SEED_ACTION));

test('a routed AE client gets the whole pack palette seeded by name, typed by role, receipted once', async () => {
  const client = makeClient();
  const result = await seedPackPaletteChartWithClient(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.seeded, true);
  assert.equal(result.pack_id, 'ae');
  assert.equal(result.inserted.length, AE_PALETTE.length);
  assert.deepEqual(result.filled, []);
  const rows = inserts(client);
  assert.equal(rows.length, AE_PALETTE.length);
  const byName = new Map(rows.map((c) => [c.params[3], c.params]));
  // The id scheme is the posting upsert's code-less one — a later posting by
  // this name lands on the seeded row instead of minting a twin.
  const fees = byName.get('Licence and statutory fees');
  assert.equal(fees[0], ledgerRecordId('account', 'firm-1', 'client-1', 'Licence and statutory fees'));
  assert.equal(fees[4], 'expense', 'type from the role class');
  assert.equal(fees[5], 'debit');
  assert.equal(fees[6], 'expense.statutory_fees');
  const motor = byName.get('Motor expenses');
  assert.equal(motor[4], 'expense');
  assert.equal(motor[6], 'expense.motor');
  const vat = byName.get('VAT payable');
  assert.equal(vat[4], 'liability');
  assert.equal(vat[5], 'credit');
  assert.equal(vat[6], 'liability.sales_tax_payable');
  // Clearing/control roles carry no class type; the read model places them by role.
  const suspense = byName.get('Suspense');
  assert.equal(suspense[4], 'unknown');
  assert.equal(suspense[6], 'control.suspense');
  for (const params of byName.values()) {
    assert.equal(JSON.parse(params[7]).source, 'pack_palette_seed');
    assert.equal(JSON.parse(params[7]).palette_pack_id, 'ae');
  }
  const receipts = audits(client);
  assert.equal(receipts.length, 1, 'one receipt per client per change');
  const meta = JSON.parse(receipts[0].params[2]);
  assert.equal(meta.pack_id, 'ae');
  assert.equal(meta.inserted.length, AE_PALETTE.length);
});

test('an existing half-typed row (minted unknown at posting) is filled, a settled row is left alone, the rest inserted', async () => {
  const client = makeClient({
    ledgerRows: [
      // The Desert Rose shape: minted by name at posting, no type, no role.
      { id: 'acct-fees', name: 'Licence and statutory fees', account_type: 'unknown', canonical_role: null },
      // Already typed AND roled — untouched.
      { id: 'acct-rent', name: 'Rent', account_type: 'expense', canonical_role: 'expense.rent' },
      // Typed but role-less — role filled, type kept.
      { id: 'acct-sales', name: 'sales', account_type: 'revenue', canonical_role: null }
    ]
  });
  const result = await seedPackPaletteChartWithClient(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.seeded, true);
  assert.deepEqual(result.filled.sort(), ['Licence and statutory fees', 'Sales']);
  assert.equal(result.inserted.length, AE_PALETTE.length - 3);
  assert.ok(!result.inserted.includes('Rent'));
  const fills = updates(client);
  assert.equal(fills.length, 2);
  const fees = fills.find((c) => c.params[0] === 'acct-fees');
  assert.equal(fees.params[2], 'expense');
  assert.equal(fees.params[3], 'debit');
  assert.equal(fees.params[4], 'expense.statutory_fees');
  // The fill SQL only ever replaces an unknown type and coalesces a null role.
  assert.match(fees.sql, /when account_type is null or account_type in \('', 'unknown'\) then \$3/);
  assert.match(fees.sql, /canonical_role = coalesce\(canonical_role, \$5\)/);
  const meta = JSON.parse(audits(client)[0].params[2]);
  assert.deepEqual(meta.filled.sort(), ['Licence and statutory fees', 'Sales']);
});

test('a complete chart is a no-op: nothing written, no receipt', async () => {
  const client = makeClient({
    ledgerRows: AE_PALETTE.map((a, i) => ({ id: `acct-${i}`, name: a.name, account_type: 'expense', canonical_role: a.role }))
  });
  const result = await seedPackPaletteChartWithClient(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.seeded, true);
  assert.equal(result.reason, 'already_complete');
  assert.equal(inserts(client).length, 0);
  assert.equal(updates(client).length, 0);
  assert.equal(audits(client).length, 0);
});

test('flag inactive, no pack, synced external chart, missing client: nothing written', async () => {
  const off = makeClient({ flagRows: [] });
  assert.equal((await seedPackPaletteChartWithClient(off, { firmId: 'firm-1', clientId: 'client-1' })).reason, 'palette_flag_inactive');
  assert.equal(inserts(off).length, 0);
  const noPack = makeClient({ clientRow: { jurisdiction: 'zz', profile: {} } });
  assert.equal((await seedPackPaletteChartWithClient(noPack, { firmId: 'firm-1', clientId: 'client-1' })).reason, 'no_pack_for_jurisdiction');
  assert.equal(inserts(noPack).length, 0);
  const synced = makeClient({ syncedRows: [{ ok: 1 }] });
  const syncedResult = await seedPackPaletteChartWithClient(synced, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(syncedResult.reason, 'external_chart_synced');
  assert.equal(syncedResult.pack_id, 'ae');
  assert.equal(inserts(synced).length, 0);
  const missing = makeClient({ clientRow: null });
  assert.equal((await seedPackPaletteChartWithClient(missing, { firmId: 'firm-1', clientId: 'client-1' })).reason, 'client_missing');
  assert.equal((await seedPackPaletteChartWithClient(null, { firmId: 'firm-1', clientId: 'client-1' })).reason, 'missing_scope');
});

test('the canonical uk alias resolves to the gb pack with a matching legacy profile', async () => {
  const client = makeClient({ clientRow: { jurisdiction: 'uk', profile: { jurisdiction: 'gb' } } });
  const result = await seedPackPaletteChartWithClient(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.pack_id, 'gb');
  assert.equal(result.reason, 'market_has_default_chart');
  assert.equal(inserts(client).length, 0);
});

test('a market with a Donna-native coded default chart (GB) is never seeded from its palette, and a coded chart is never padded', async () => {
  // Entity Certificate B pins a GB client's persisted chart to gb_default_chart.v1
  // (every row coded, exact set). The first version of this seed pre-empted
  // that chart at self-provision and failed the certificate.
  const gb = makeClient({ clientRow: { jurisdiction: 'gb', profile: {} } });
  const gbResult = await seedPackPaletteChartWithClient(gb, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(gbResult.reason, 'market_has_default_chart');
  assert.equal(gbResult.pack_id, 'gb');
  assert.equal(inserts(gb).length, 0);
  assert.equal(gb.calls.some((c) => c.sql.includes('from ledger_accounts')), false, 'decided before reading the chart');
  // Any coded row means a provisioned chart, whichever market — stand aside.
  const coded = makeClient({ ledgerRows: [{ id: 'a1', code: '6000', name: 'Rent', account_type: 'expense', canonical_role: 'expense.rent' }] });
  const codedResult = await seedPackPaletteChartWithClient(coded, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(codedResult.reason, 'coded_chart_present');
  assert.equal(inserts(coded).length, 0);
  assert.equal(updates(coded).length, 0);
});

for (const clientRow of [
  { jurisdiction: null, profile: { jurisdiction: 'ae' } },
  { jurisdiction: 'us', profile: { jurisdiction: 'ae' } },
  { jurisdiction: 'ae', entity_type: 'us-llc', profile: {} },
  { jurisdiction: 'ae', entity_type: 'ae-llc', profile: { entityType: 'us-llc' } }
]) test(`missing or conflicting country never seeds a chart: ${JSON.stringify(clientRow)}`, async () => {
  const client = makeClient({ clientRow });
  const result = await seedPackPaletteChartWithClient(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(result.reason, 'jurisdiction_context_required');
  assert.equal(result.seeded, false);
  assert.equal(inserts(client).length, 0);
  assert.equal(updates(client).length, 0);
  assert.equal(audits(client).length, 0);
});
