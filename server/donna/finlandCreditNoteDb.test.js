// FI-15 G-8 — the credit-note DB surfaces against pattern-matching fake pg
// clients (the finlandSalesInvoicePostDb.test.js style):
//   • postCreditNoteJournalWithClient — the AR-reversal sibling writer: every
//     refusal gate fires BEFORE any ledger write; the happy path routes through
//     the shared journal-insert discipline with the in-txn audit receipt;
//   • getIssuedInvoiceCreditContextInDb — the intake's original-invoice lookup;
//   • getFinlandIssuedInvoicesFromDb — the Half-B read (payment states at read
//     time; flag-gated typed 403).
//   node --test server/donna/finlandCreditNoteDb.test.js
// Design: docs/design-donna-finland-fi15-g8-credit-notes.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFinlandIssuedInvoicesFromDb,
  getIssuedInvoiceCreditContextInDb,
  postCreditNoteJournalWithClient
} from './firmDb.js';

const creditNote = ({ alvTotal = 0, total = 200, subtotal = 200 } = {}) => ({
  invoiceNumber: '2026002',
  creditsInvoiceNumber: '2026001',
  kind: 'credit_note',
  date: '2026-07-11',
  currency: 'EUR',
  subtotal,
  alvTotal,
  total,
  buyer: { name: 'Asiakas Oy' }
});

// ----- postCreditNoteJournalWithClient ----------------------------------------------

const fakePostClient = ({
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
        assert.deepEqual(params, ['firm-1', 'client-1']);
        return { rows: [] };
      }
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      // Canonical lineage observes the same unmarked client and empty initial chart.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'FI', entity_type: 'fi-toiminimi', profile }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] };
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: 'FI', entity_type: 'fi-toiminimi', profile }] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
      if (sql.includes('from ledger_journals lj')) return { rows: existingJournal ? [existingJournal] : [] };
      if (sql.includes('from close_periods')) return { rows: lockedAtDate ? [{ id: 'cp-1' }] : [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-cn-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('incorporation_date, entity_type from clients')) return { rows: [{ incorporation_date: '2025-06-15', entity_type: 'fi-toiminimi' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 43 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const callPost = (client, overrides = {}) => postCreditNoteJournalWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  creditNote: creditNote(),
  authorityBasis: { source: 'owner_whatsapp_invoice_confirmation', providerMessageId: 'wamid.2' },
  model: 'test-model',
  actorId: 'owner-1',
  ...overrides
});

const wroteLedger = (client) => client.queries.some((q) => q.sql.includes('insert into ledger_journals'));

test('flag off refuses (409) before touching the ledger', async () => {
  const client = fakePostClient({ flags: {} });
  await assert.rejects(callPost(client), (e) => e.code === 'FINLAND_INVOICING_DISABLED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('cash-basis client refuses the reversal post (D-G8-5, the D-FI10-S1 mirror) with its OWN typed code', async () => {
  const client = fakePostClient({ profile: { accounting_basis: 'cash' } });
  await assert.rejects(callPost(client), (e) => e.code === 'CREDIT_NOTE_CASH_BASIS_NO_POST' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a VAT total refuses before touching the ledger (non-ALV boundary unchanged)', async () => {
  const client = fakePostClient();
  await assert.rejects(
    callPost(client, { creditNote: creditNote({ alvTotal: 51, total: 251 }) }),
    (e) => e.code === 'CREDIT_NOTE_ALV_UNSUPPORTED'
  );
  assert.equal(wroteLedger(client), false);
});

test('a locked period at the credit-note date refuses (one-way-door) before touching the ledger', async () => {
  const client = fakePostClient({ lockedAtDate: true });
  await assert.rejects(callPost(client), (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('happy path posts the MIRROR (DR 3000 / CR 1700) through the shared writer + in-txn receipt', async () => {
  const client = fakePostClient();
  const result = await callPost(client);

  assert.equal(result.journal_id, 'journal-cn-1');
  assert.equal(result.credit_note_number, '2026002');
  assert.equal(result.audit_event_id, '43');
  const chartLock = client.queries.findIndex((q) => q.sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update');
  const firstAccountWrite = client.queries.findIndex((q) => q.sql.includes('insert into ledger_accounts'));
  assert.ok(chartLock >= 0 && chartLock < firstAccountWrite, 'the shared chart order is locked before credit-note account upserts');

  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  assert.equal(journalInsert.params[3], 'credit_note');
  assert.equal(journalInsert.params[4], '2026002');
  assert.equal(journalInsert.params[5], '2026-07-11');
  const payload = JSON.parse(journalInsert.params[8]);
  assert.equal(payload.source, 'native_ledger_credit_note');
  assert.equal(payload.credits_invoice_number, '2026001');
  assert.equal(payload.model, 'test-model');
  assert.equal(payload.authority_basis.providerMessageId, 'wamid.2');

  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2);
  // The exact mirror of the AR post: revenue debited, receivable credited.
  assert.deepEqual(lineInserts.map((q) => [q.params[5], q.params[8]]), [['3000', 'debit'], ['1700', 'credit']]);
  assert.equal(lineInserts[0].params[9], 200);
  assert.equal(lineInserts[1].params[10], 200);

  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(audit.sql.includes('ledger.post_credit_note'));
  assert.equal(audit.params[2], 'owner-1');
  const metadata = JSON.parse(audit.params[4]);
  assert.equal(metadata.credit_note_number, '2026002');
  assert.equal(metadata.credits_invoice_number, '2026001');
  assert.equal(metadata.total, 200);
});

test('re-post of the same credit note reuses the existing journal id (idempotent)', async () => {
  const client = fakePostClient({ existingJournal: { id: 'journal-old', close_period_id: null } });
  await callPost(client);
  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  assert.equal(journalInsert.params[0], 'journal-old');
});

// ----- getIssuedInvoiceCreditContextInDb --------------------------------------------

const fakeContextClient = ({ original = null, credited = 0 } = {}) => ({
  async query(sql) {
    if (sql.includes("draft->'invoice'->>'invoiceNumber' = $3")) {
      return { rows: original ? [original] : [] };
    }
    if (sql.includes('coalesce(sum(')) return { rows: [{ credited }] };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

test('credit context resolves the issued original by DISPLAY number + the prior credit sum', async () => {
  const original = {
    id: 'orig-1', firm_id: 'firm-1', client_id: 'client-1', invoice_number: 1,
    status: 'issued', kind: 'invoice',
    draft: { invoice: { invoiceNumber: '2026001', total: 500 } }
  };
  const ctx = await getIssuedInvoiceCreditContextInDb({
    firmId: 'firm-1', clientId: 'client-1', originalInvoiceNumber: '2026001',
    withFirmDbClientFn: async (fn) => fn(fakeContextClient({ original, credited: '150' }))
  });
  assert.equal(ctx.originalRow.id, 'orig-1');
  assert.equal(ctx.originalRow.kind, 'invoice');
  assert.equal(ctx.priorCreditedTotal, 150);
});

test('an unknown display number resolves to a null original (classify escalates, never guesses)', async () => {
  const ctx = await getIssuedInvoiceCreditContextInDb({
    firmId: 'firm-1', clientId: 'client-1', originalInvoiceNumber: '2026099',
    withFirmDbClientFn: async (fn) => fn(fakeContextClient({ original: null }))
  });
  assert.deepEqual(ctx, { originalRow: null, priorCreditedTotal: 0 });
});

// ----- getFinlandIssuedInvoicesFromDb (Half B) --------------------------------------

const issuedRow = ({ id = 'inv-1', number = '2026001', reference = '20260013', total = 500, dueDate = '2026-07-15' } = {}) => ({
  id, firm_id: 'firm-1', client_id: 'client-1', invoice_number: 1, status: 'issued', kind: 'invoice',
  buyer_name: 'Asiakas Oy',
  draft: {
    invoice: { invoiceNumber: number, date: '2026-07-01', dueDate, total, currency: 'EUR' },
    finvoice: { invoiceDetails: { referenceNumber: reference }, paymentDetails: { referenceNumber: reference } }
  }
});

const fakeReadClient = ({ flags = { FINLAND_INVOICING: 'auto' }, invoices = [], credits = [], transactions = [] } = {}) => ({
  async query(sql) {
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('from client_capability_config')) {
      return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes("coalesce(kind, 'invoice') = 'invoice'")) return { rows: invoices };
    if (sql.includes("kind = 'credit_note'")) return { rows: credits };
    if (sql.includes('from transactions')) return { rows: transactions };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const callRead = (client) => getFinlandIssuedInvoicesFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  readAt: '2026-07-20T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(client)
});

test('flag off is a typed 403 (the surface hides)', async () => {
  await assert.rejects(
    callRead(fakeReadClient({ flags: {} })),
    (e) => e.statusCode === 403 && e.code === 'FINLAND_INVOICING_DISABLED'
  );
});

test('payment states compute at read time: viitenumero-matched money-in + issued credit notes net', async () => {
  const envelope = await callRead(fakeReadClient({
    invoices: [
      issuedRow(), // 500 due 2026-07-15
      issuedRow({ id: 'inv-2', number: '2026002', reference: '20260026', total: 300 })
    ],
    credits: [
      { credits_invoice_id: 'inv-2', credited: '100', credit_note_numbers: ['2026003'] }
    ],
    transactions: [
      // Pays inv-1 partially by viitenumero (with bank spacing noise).
      { id: 'tx-1', description: 'SEPA VIITE 2026 0013', raw_description: null, money_in: '200', transaction_date: '2026-07-16' },
      // Pays inv-2's remaining 200 by invoice number in free text.
      { id: 'tx-2', description: 'maksu 2026002 kiitos', raw_description: null, money_in: '200', transaction_date: '2026-07-17' },
      // Unrelated money-in matches nothing.
      { id: 'tx-3', description: 'jotain muuta', raw_description: null, money_in: '999', transaction_date: '2026-07-18' }
    ]
  }));

  const [first, second] = envelope.issued_invoices.invoices;
  assert.equal(first.invoice_number, '2026001');
  assert.equal(first.settlement.payment_state, 'partially_paid');
  assert.equal(first.settlement.paid_total, 200);
  assert.equal(first.settlement.open_amount, 300);
  assert.deepEqual(first.settlement.flags, ['overdue']); // due 07-15, read 07-20
  assert.equal(first.matched_payment_count, 1);

  assert.equal(second.settlement.payment_state, 'paid'); // 300 − 100 credited − 200 paid
  assert.equal(second.settlement.credited_total, 100);
  assert.deepEqual(second.credit_note_numbers, ['2026003']);

  assert.equal(envelope.issued_invoices.summary.total, 2);
  assert.equal(envelope.issued_invoices.summary.overdue, 1);
  assert.match(envelope.issued_invoices.banner_fi, /erääntynyt/);
  assert.equal(envelope.provenance.deterministic, true);
});

test('no issued invoices ⇒ an empty, quiet envelope (banner null)', async () => {
  const envelope = await callRead(fakeReadClient({ invoices: [] }));
  assert.deepEqual(envelope.issued_invoices.invoices, []);
  assert.equal(envelope.issued_invoices.summary.total, 0);
  assert.equal(envelope.issued_invoices.banner_fi, null);
});
