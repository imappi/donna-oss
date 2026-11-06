// FI-10 send-half — postSalesInvoiceJournalWithClient against a pattern-matching
// fake pg client (same style as finlandAnnualReturnDb.test.js): the refusal gates
// fire BEFORE any ledger write, and the happy path routes through the shared
// journal-insert discipline with the audit receipt in the same transaction.
//   node --test server/donna/finlandSalesInvoicePostDb.test.js
// Design + acceptance criteria: docs/design-donna-finland-fi10-send-half.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { postSalesInvoiceJournalWithClient } from './firmDb.js';

const invoice = ({ alvTotal = 0, total = 500, subtotal = 500 } = {}) => ({
  invoiceNumber: '2026001',
  date: '2026-07-01',
  currency: 'EUR',
  subtotal,
  alvTotal,
  total,
  buyer: { name: 'Asiakas Oy' }
});

// Pattern-matching fake client. `flags` become client_capability_config rows;
// `queries` records every SQL for gate-ordering assertions.
const fakeClient = ({
  flags = { FINLAND_INVOICING: 'auto' },
  profile = { accounting_basis: 'accrual' },
  lockedAtDate = false,
  existingJournal = null
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update') {
        assert.deepEqual(params,['firm-1','client-1']);
        return {rows:[]};
      }
      // Canonical lineage observes this same unmarked client; no native birth is seeded.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'fi', entity_type: 'fi-toiminimi', profile }] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: 'fi', entity_type: 'fi-toiminimi', profile }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] }; // no client birth receipts in this fixture
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [] }; // no pre-existing chart is seeded
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
      if (sql.includes('from ledger_journals lj')) return { rows: existingJournal ? [existingJournal] : [] };
      if (sql.includes('from close_periods')) return { rows: lockedAtDate ? [{ id: 'cp-1' }] : [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('incorporation_date, entity_type from clients')) return { rows: [{ incorporation_date: '2025-06-15', entity_type: 'fi-toiminimi' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 42 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const call = (client, overrides = {}) => postSalesInvoiceJournalWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  invoice: invoice(),
  authorityBasis: { source: 'owner_whatsapp_confirmation', providerMessageId: 'wamid.1' },
  model: 'test-model',
  actorId: 'owner-1',
  ...overrides
});

const wroteLedger = (client) => client.queries.some((q) => q.sql.includes('insert into ledger_journals'));

test('flag off refuses (409) before touching the ledger', async () => {
  const client = fakeClient({ flags: {} });
  await assert.rejects(call(client), (e) => e.code === 'FINLAND_INVOICING_DISABLED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('cash-basis client refuses the AR post (D-FI10-S1) before touching the ledger', async () => {
  const client = fakeClient({ profile: { accounting_basis: 'cash' } });
  await assert.rejects(call(client), (e) => e.code === 'SALES_INVOICE_CASH_BASIS_NO_AR_POST' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a VAT total on a NON-registered invoice refuses (the seller cannot charge ALV)', async () => {
  // alvExempt is unset here (a non-registered/legacy invoice), so a stray VAT
  // total is refused. An ALV-REGISTERED invoice (alvExempt:false) posts the
  // split instead — see the ALV happy-path test below.
  const client = fakeClient();
  await assert.rejects(
    call(client, { invoice: invoice({ alvTotal: 127.5, total: 627.5 }) }),
    (e) => e.code === 'SALES_INVOICE_ALV_UNSUPPORTED'
  );
  assert.equal(wroteLedger(client), false);
});

test('an ALV-registered invoice posts the split DR 1700 / CR 3000 (coded) / CR 2939 (role alv_output) through the shared writer', async () => {
  const client = fakeClient();
  const alvInvoice = {
    invoiceNumber: '2026005', date: '2026-07-01', currency: 'EUR',
    subtotal: 1000, alvTotal: 255, total: 1255, alvExempt: false,
    buyer: { name: 'Asiakas Oy' },
    lines: [{ description: 'konsultointi', quantity: 1, unitPrice: 1000, alvRate: 25.5, net: 1000, alv: 255 }]
  };
  const result = await call(client, { invoice: alvInvoice });
  assert.equal(result.journal_id, 'journal-1');

  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 3);
  assert.deepEqual(
    lineInserts.map((q) => [q.params[5], q.params[8]]),
    [['1700', 'debit'], ['3000', 'credit'], ['2939', 'credit']]
  );
  assert.equal(lineInserts[0].params[9], 1255);   // 1700 DR = gross
  assert.equal(lineInserts[1].params[10], 1000);  // 3000 CR = net
  assert.equal(lineInserts[2].params[10], 255);   // 2939 CR = output VAT
  // The revenue leg is CODED (the return base-walk reads it); the control leg is
  // role-marked alv_output with tax_type NONE (D-FI3-A5: no code on a control account).
  assert.equal(lineInserts[1].params[13], 'ALV_25_5_OUTPUT');
  assert.equal(lineInserts[2].params[13], 'NONE');
  assert.equal(JSON.parse(lineInserts[2].params[15]).role, 'alv_output');
});

test('a locked period at the invoice date refuses (one-way-door) before touching the ledger', async () => {
  const client = fakeClient({ lockedAtDate: true });
  await assert.rejects(call(client), (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('an existing sales_invoice journal inside a locked period refuses re-post', async () => {
  const client = fakeClient({ existingJournal: { id: 'journal-old', close_period_id: 'cp-1' } });
  await assert.rejects(call(client), (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE');
  assert.equal(wroteLedger(client), false);
});

test('happy path posts DR 1700 / CR 3000 through the shared writer with the in-txn audit receipt', async () => {
  const client = fakeClient();
  const result = await call(client);

  assert.equal(result.journal_id, 'journal-1');
  assert.equal(result.invoice_number, '2026001');
  assert.equal(result.audit_event_id, '42');
  // tosite stays null: FI-4/FI-5 flags are off in this snapshot (allocator no-op).
  assert.equal(result.tosite_number, null);

  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  assert.equal(journalInsert.params[3], 'sales_invoice');
  assert.equal(journalInsert.params[4], '2026001');
  assert.equal(journalInsert.params[5], '2026-07-01');
  const payload = JSON.parse(journalInsert.params[8]);
  assert.equal(payload.source, 'native_ledger_sales_invoice');
  assert.equal(payload.invoice_number, '2026001');
  assert.equal(payload.model, 'test-model');
  assert.equal(payload.authority_basis.providerMessageId, 'wamid.1');

  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2);
  assert.deepEqual(lineInserts.map((q) => [q.params[5], q.params[8]]), [['1700', 'debit'], ['3000', 'credit']]);
  assert.equal(lineInserts[0].params[9], 500);
  assert.equal(lineInserts[1].params[10], 500);

  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(audit.sql.includes('ledger.post_sales_invoice'));
  assert.equal(audit.params[2], 'owner-1');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.invoice_number, '2026001');
  assert.equal(metadata.total, 500);
  assert.equal(metadata.model, 'test-model');
  assert.equal(metadata.authority_basis.providerMessageId, 'wamid.1');
});

test('re-post of the same invoice reuses the existing journal id (idempotent, no duplicate AR)', async () => {
  const client = fakeClient({ existingJournal: { id: 'journal-old', close_period_id: null } });
  const result = await call(client);
  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  // The existing row's id is passed through — the on-conflict upsert updates it.
  assert.equal(journalInsert.params[0], 'journal-old');
  assert.equal(result.journal_id, 'journal-1');
});
