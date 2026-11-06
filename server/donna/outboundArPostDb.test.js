// OUTBOUND AR post + reversal writers against a pattern-matching fake pg client
// (the finlandSalesInvoicePostDb.test.js style): the refusal gates fire BEFORE
// any ledger write; the happy path routes through the SAME shared journal-insert
// discipline (INV-1 — one backend) with the audit receipt in the same
// transaction; accounts come from the client's OWN chart resolved by canonical
// role — zero or many role rows REFUSE, never a guessed or minted account.
//   node --test server/donna/outboundArPostDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  postOutboundArJournalWithClient,
  __reverseOutboundArJournalWithClient
} from './firmDb.js';

// `seller` defaults to ABSENT, so `seller.taxRegistered` is undefined and the
// resolved status is UNKNOWN — the shape every invoice built before a
// registration record existed carries. Tests that exercise the 2026-07-27 tax
// leg pass one explicitly.
const invoice = ({ taxTotal = 0, total = 500, subtotal = 500, seller = undefined, lines = undefined } = {}) => ({
  invoiceNumber: '2026004',
  date: '2026-07-20',
  currency: 'USD',
  subtotal,
  taxTotal,
  total,
  ...(seller ? { seller } : {}),
  ...(lines ? { lines } : {}),
  buyer: { name: 'Acme LLC' },
  referenceNumber: null
});

const AR_ACCOUNT = {
  id: 'acc-ar', code: '1100', name: 'Accounts receivable', account_type: 'receivable',
  normal_balance: 'debit', currency: 'USD', tax_type: 'NONE', canonical_role: 'asset.accounts_receivable'
};
const REVENUE_ACCOUNT = {
  id: 'acc-rev', code: '4000', name: 'Sales revenue', account_type: 'revenue',
  normal_balance: 'credit', currency: 'USD', tax_type: 'NONE', canonical_role: 'revenue.operating'
};

// Pattern-matching fake client. `roleRows` maps canonical_role → ledger_accounts rows.
const VAT_ACCOUNT = {
  id: 'acc-vat', code: '2202', name: 'VAT payable', account_type: 'liability',
  normal_balance: 'credit', currency: 'GBP', tax_type: 'NONE', canonical_role: 'liability.sales_tax_payable'
};

const fakeClient = ({
  flags = { OUTBOUND_INVOICING: 'canary' },
  profile = { accounting_basis: 'accrual' },
  jurisdiction = 'us',
  roleRows = {
    'asset.accounts_receivable': [AR_ACCOUNT],
    'revenue.operating': [REVENUE_ACCOUNT]
  },
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
      // Canonical lineage reads the same unmarked client and role-backed chart.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction, profile }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] };
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: Object.values(roleRows).flat().sort((a, b) => a.id.localeCompare(b.id)) };
      if (sql.includes('from clients') && sql.includes('profile') && sql.includes('where firm_id = $1 and id = $2')) {
        return { rows: [{ jurisdiction, profile }] };
      }
      if (sql.includes('from ledger_accounts') && sql.includes('canonical_role = $3')) {
        return { rows: (roleRows[params[2]] || []).slice(0, 2) };
      }
      if (sql.includes('from ledger_journals lj')) return { rows: existingJournal ? [existingJournal] : [] };
      if (sql.includes('from close_periods')) return { rows: lockedAtDate ? [{ id: 'cp-1' }] : [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('incorporation_date, entity_type from clients')) return { rows: [{ incorporation_date: '2025-06-15', entity_type: 'us-llc' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 42 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const call = (client, overrides = {}) => postOutboundArJournalWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  invoice: invoice(),
  authorityBasis: { source: 'per_send_owner_approval', action_id: 'a-1' },
  model: 'test-model',
  actorId: 'kari',
  ...overrides
});

const wroteLedger = (client) => client.queries.some((q) => q.sql.includes('insert into ledger_journals'));

test('OUTBOUND_INVOICING dark refuses (409) before touching the ledger', async () => {
  const client = fakeClient({ flags: {} });
  await assert.rejects(call(client), (e) => e.code === 'OUTBOUND_INVOICING_DISABLED' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('cash-basis client refuses the AR post (the D-FI10-S1 posture, shared code) before touching the ledger', async () => {
  const client = fakeClient({ profile: { accounting_basis: 'cash' } });
  await assert.rejects(call(client), (e) => e.code === 'SALES_INVOICE_CASH_BASIS_NO_AR_POST' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

// 2026-07-27 — this test used to assert SALES_INVOICE_ALV_UNSUPPORTED for an
// invoice with NO seller. That was the right refusal for the wrong reason: the
// status was never resolved, so "not registered" was an assumption, not a fact.
// It now refuses for the honest reason. Both branches are pinned below.
test('a declared tax total with an UNRECORDED registration status refuses by name — never a guess in either direction', async () => {
  const client = fakeClient();
  await assert.rejects(
    call(client, { invoice: invoice({ taxTotal: 40, total: 540 }) }),
    (e) => e.code === 'SALES_INVOICE_TAX_REGISTRATION_UNKNOWN' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('a declared tax total from a RECORDED not-registered seller refuses as unsupported (the D-FI10-S2 boundary, unchanged)', async () => {
  const client = fakeClient();
  await assert.rejects(
    call(client, { invoice: invoice({ taxTotal: 40, total: 540, seller: { taxRegistered: false } }) }),
    (e) => e.code === 'SALES_INVOICE_ALV_UNSUPPORTED'
  );
  assert.equal(wroteLedger(client), false);
});

// The path that preserves every pre-2026-07-27 caller: unknown status, no tax.
// This is the US lane and every invoice built before registration records
// existed — it must stay byte-identical, which is why the tri-state refusal
// above is gated on taxTotal > 0 rather than on the status alone.
test('an unknown registration status with NO tax posts exactly as it always did', async () => {
  const client = fakeClient();
  const result = await call(client);
  assert.equal(result.journal_id, 'journal-1');
  const lines = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lines.length, 2, 'DR receivable / CR revenue — no tax leg, no third line');
});

test('a chart with NO role-resolved receivable account refuses with the named code — never a guessed account', async () => {
  const client = fakeClient({ roleRows: { 'revenue.operating': [REVENUE_ACCOUNT] } });
  await assert.rejects(call(client), (e) => e.code === 'OUTBOUND_AR_NO_RECEIVABLE_ACCOUNT' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a chart with TWO role-resolved revenue accounts refuses as ambiguous — never a guess between them', async () => {
  const client = fakeClient({
    roleRows: {
      'asset.accounts_receivable': [AR_ACCOUNT],
      'revenue.operating': [REVENUE_ACCOUNT, { ...REVENUE_ACCOUNT, id: 'acc-rev-2', code: '4100', name: 'Service revenue' }]
    }
  });
  await assert.rejects(call(client), (e) => e.code === 'OUTBOUND_AR_AMBIGUOUS_REVENUE_ACCOUNT' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('a locked period at the invoice date refuses (one-way-door) before touching the ledger', async () => {
  const client = fakeClient({ lockedAtDate: true });
  await assert.rejects(call(client), (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && e.statusCode === 409);
  assert.equal(wroteLedger(client), false);
});

test('happy path posts DR role-resolved AR / CR role-resolved revenue through the shared writer with the in-txn audit receipt', async () => {
  const client = fakeClient();
  const result = await call(client);

  assert.equal(result.journal_id, 'journal-1');
  assert.equal(result.invoice_number, '2026004');
  assert.equal(result.audit_event_id, '42');

  const chartLock = client.queries.findIndex((q) => q.sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update');
  const firstAccountWrite = client.queries.findIndex((q) => q.sql.includes('insert into ledger_accounts'));
  assert.ok(chartLock >= 0 && chartLock < firstAccountWrite, 'the scoped chart lock precedes account writes');

  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  assert.equal(journalInsert.params[3], 'sales_invoice', 'the SAME natural key family as the FI lane — one invoice, one journal, whatever lane');
  assert.equal(journalInsert.params[4], '2026004');
  const payload = JSON.parse(journalInsert.params[8]);
  assert.equal(payload.source, 'native_ledger_sales_invoice');
  assert.equal(payload.channel, 'outbound_pipeline');
  assert.equal(payload.model, 'test-model');

  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2);
  assert.deepEqual(
    lineInserts.map((q) => [q.params[5], q.params[8]]),
    [['1100', 'debit'], ['4000', 'credit']],
    'the CLIENT\'S chart codes, not a hardcoded pair'
  );
  assert.equal(lineInserts[0].params[9], 500);
  assert.equal(lineInserts[1].params[10], 500);

  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(audit.sql.includes('ledger.post_sales_invoice'));
  assert.ok(String(audit.params[4]).includes('outbound_pipeline'), 'the receipt names the channel');
});

// ── 2026-07-27: the VAT-registered GB seller ────────────────────────────────
// The hole this slice closed. Before it, this exact invoice BUILT and SENT and
// then skipped its AR post as `sales_tax_unwired` — a real consequence to a real
// counterparty resting on neither terminal state.
// Design: docs/design-donna-gb-vat-ar-posting.md.

const gbClient = (overrides = {}) => fakeClient({
  jurisdiction: 'gb',
  roleRows: {
    'asset.accounts_receivable': [AR_ACCOUNT],
    'revenue.operating': [REVENUE_ACCOUNT],
    'liability.sales_tax_payable': [VAT_ACCOUNT]
  },
  ...overrides
});

// The generic outbound model carries per-line `tax_rate`/`tax_amount` (gap 2's
// shape, camelCased on the built model). The mapping to the builder's vocabulary
// happens at THIS writer, which is what keeps the isolation-listed post path to
// one seam.
const gbVatInvoice = () => invoice({
  subtotal: 1000,
  taxTotal: 200,
  total: 1200,
  seller: { taxRegistered: true },
  lines: [{ description: 'consultancy', quantity: 1, unitPrice: 1000, net: 1000, taxRate: 20, taxAmount: 200 }]
});

test('a VAT-registered GB invoice posts the split: DR AR gross / CR revenue net coded / CR the ROLE-RESOLVED VAT account', async () => {
  const client = gbClient();
  const result = await call(client, { invoice: gbVatInvoice() });
  assert.equal(result.journal_id, 'journal-1');

  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 3, 'DR receivable + CR revenue + CR VAT control');
  assert.deepEqual(
    lineInserts.map((q) => [q.params[5], q.params[8]]),
    [['1100', 'debit'], ['4000', 'credit'], ['2202', 'credit']],
    'the VAT account is the CLIENT\'S own chart row resolved by canonical role — the UK ships no statutory chart to hardcode'
  );
  assert.equal(lineInserts[0].params[9], 1200, 'receivable carries the gross');
  assert.equal(lineInserts[1].params[10], 1000, 'revenue carries the net');
  assert.equal(lineInserts[2].params[10], 200, 'the control leg carries the whole VAT');
});

test('the GB revenue leg carries its rate\'s output VAT code, and the control leg carries none', async () => {
  const client = gbClient();
  await call(client, { invoice: gbVatInvoice() });
  const accountUpserts = client.queries.filter((q) => q.sql.includes('insert into ledger_accounts'));
  const byCode = new Map(accountUpserts.map((q) => [String(q.params.find((p) => p === '4000' || p === '2202') || ''), q]));
  assert.ok(byCode.has('4000') && byCode.has('2202'), 'both legs mint/upsert their account row');
  const revenueParams = byCode.get('4000').params.map(String);
  const controlParams = byCode.get('2202').params.map(String);
  assert.ok(revenueParams.includes('VAT_SR_20_OUTPUT'), 'the revenue leg is coded so a future MTD return engine can see the sale');
  assert.ok(!controlParams.includes('VAT_SR_20_OUTPUT'), 'no tax code on a control account — the invariant is market-neutral');
});

test('a GB client whose chart has NO sales-tax account refuses by name — never a guessed VAT account', async () => {
  const client = gbClient({
    roleRows: {
      'asset.accounts_receivable': [AR_ACCOUNT],
      'revenue.operating': [REVENUE_ACCOUNT]
    }
  });
  await assert.rejects(
    call(client, { invoice: gbVatInvoice() }),
    (e) => e.code === 'OUTBOUND_AR_NO_SALES_TAX_ACCOUNT' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

test('a GB client with TWO sales-tax accounts refuses as ambiguous (gap 10\'s role is single-valued by contract)', async () => {
  const client = gbClient({
    roleRows: {
      'asset.accounts_receivable': [AR_ACCOUNT],
      'revenue.operating': [REVENUE_ACCOUNT],
      'liability.sales_tax_payable': [VAT_ACCOUNT, { ...VAT_ACCOUNT, id: 'acc-vat-2', code: '2203' }]
    }
  });
  await assert.rejects(
    call(client, { invoice: gbVatInvoice() }),
    (e) => e.code === 'OUTBOUND_AR_AMBIGUOUS_SALES_TAX_ACCOUNT' && e.statusCode === 409
  );
  assert.equal(wroteLedger(client), false);
});

// A registered seller in a market with NO wired code map refuses BY NAME rather
// than posting net (which would drop the tax) or guessing a code. The honest
// state for an unwired regime — and the receipted skip says so.
test('a registered seller in an unwired market refuses by name — never a net-only post that drops the tax', async () => {
  const client = fakeClient({ jurisdiction: 'us' });
  await assert.rejects(
    call(client, { invoice: gbVatInvoice() }),
    (e) => e.code === 'SALES_INVOICE_TAX_POSTING_UNAVAILABLE'
  );
  assert.equal(wroteLedger(client), false);
});

// A GB seller who IS registered but whose invoice is entirely zero-rated: the
// revenue leg still carries VAT_ZR_OUTPUT (a zero-rated supply is REPORTED, not
// uncoded revenue) and there is no control leg, because there is no VAT.
test('an all-zero-rated GB invoice codes its revenue leg and posts NO control leg', async () => {
  const client = gbClient();
  await call(client, {
    invoice: invoice({
      subtotal: 500, taxTotal: 0, total: 500,
      seller: { taxRegistered: true },
      lines: [{ description: 'printed books', quantity: 1, unitPrice: 500, net: 500, taxRate: 0, taxAmount: 0 }]
    })
  });
  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2, 'no VAT, no control leg');
  assert.deepEqual(lineInserts.map((q) => q.params[5]), ['1100', '4000']);
});

// ── The reversal writer (the post_send_reversal books half) ─────────────────

const journalRow = (overrides = {}) => ({
  id: 'journal-1', firm_id: 'firm-1', client_id: 'client-1',
  source_type: 'sales_invoice', source_id: '2026004', journal_date: '2026-07-20',
  currency: 'USD', status: 'posted', memo: 'Invoice 2026004 — Acme LLC',
  ...overrides
});

const lineRows = [
  {
    id: 'l-1', journal_id: 'journal-1', firm_id: 'firm-1', client_id: 'client-1',
    account_id: 'acc-ar', account_code: '1100', account_name: 'Accounts receivable', line_no: 1,
    direction: 'debit', debit: 500, credit: 0, amount: 500, currency: 'USD',
    tax_type: 'NONE', memo: 'Invoice 2026004', payload: {}, account_type: 'receivable', normal_balance: 'debit'
  },
  {
    id: 'l-2', journal_id: 'journal-1', firm_id: 'firm-1', client_id: 'client-1',
    account_id: 'acc-rev', account_code: '4000', account_name: 'Sales revenue', line_no: 2,
    direction: 'credit', debit: 0, credit: 500, amount: 500, currency: 'USD',
    tax_type: 'NONE', memo: 'Invoice 2026004', payload: {}, account_type: 'revenue', normal_balance: 'credit'
  }
];

const reversalFakeClient = ({
  journal = journalRow(),
  priorReversal = false,
  lockedToday = false
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('from ledger_journals') && sql.includes('reversal_of_journal_id = $3')) {
        return { rows: priorReversal ? [{ id: 'journal-rev-old' }] : [] };
      }
      if (sql.includes('from ledger_journals')) return { rows: journal ? [journal] : [] };
      if (sql.includes('from close_periods')) return { rows: lockedToday ? [{ id: 'cp-1' }] : [] };
      if (sql.includes('from ledger_lines ll')) return { rows: lineRows };
      // This reversal fixture belongs to the same unmarked US client and accounts.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'us', profile: {} }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] };
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [AR_ACCOUNT, REVENUE_ACCOUNT] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 43 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const reverse = (client, overrides = {}) => __reverseOutboundArJournalWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  arJournalId: 'journal-1',
  reason: 'owner_post_send_reversal',
  actorId: 'kari',
  ...overrides
});

test('reversal: a missing journal refuses 404; a non-posted journal refuses 409 — nothing written', async () => {
  const missing = reversalFakeClient({ journal: null });
  await assert.rejects(reverse(missing), (e) => e.code === 'OUTBOUND_AR_JOURNAL_NOT_FOUND' && e.statusCode === 404);
  assert.equal(missing.queries.some((q) => q.sql.includes('insert into ledger_journals')), false);

  const voided = reversalFakeClient({ journal: journalRow({ status: 'void' }) });
  await assert.rejects(reverse(voided), (e) => e.code === 'OUTBOUND_AR_JOURNAL_NOT_POSTED' && e.statusCode === 409);
});

test('reversal: an already-reversed journal refuses (belt-and-braces under the action marker)', async () => {
  const client = reversalFakeClient({ priorReversal: true });
  await assert.rejects(reverse(client), (e) => e.code === 'OUTBOUND_AR_ALREADY_REVERSED' && e.statusCode === 409);
});

test('reversal: a locked period at the reversal date refuses (one-way-door)', async () => {
  const client = reversalFakeClient({ lockedToday: true });
  await assert.rejects(reverse(client, { journalDate: '2026-07-25' }), (e) => e.code === 'LEDGER_ADJUSTMENT_DATE_LOCKED' && e.statusCode === 409);
});

test('reversal happy path: line-mirrored correction journal with reversal_of linkage + the in-txn audit', async () => {
  const client = reversalFakeClient();
  const result = await reverse(client, { journalDate: '2026-07-25' });

  assert.equal(result.original_journal_id, 'journal-1');
  assert.ok(result.reversal_journal_id, 'a new correction journal id');
  assert.notEqual(result.reversal_journal_id, 'journal-1');
  assert.equal(result.journal_date, '2026-07-25');

  const journalInsert = client.queries.find((q) => q.sql.includes('insert into ledger_journals'));
  assert.ok(journalInsert.sql.includes('correction_type'), 'routes through the correction machinery');
  assert.equal(journalInsert.params[7], 'reversal');
  assert.equal(journalInsert.params[8], 'journal-1', 'correction_of the original');
  assert.equal(journalInsert.params[9], 'journal-1', 'reversal_of the original');

  const lineInserts = client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
  assert.equal(lineInserts.length, 2);
  // The mirror: AR (was DR 500) reverses as CR 500; revenue (was CR 500) as DR 500.
  const byCode = new Map(lineInserts.map((q) => [q.params[5], q]));
  assert.equal(byCode.get('1100').params[8], 'credit');
  assert.equal(byCode.get('1100').params[10], 500);
  assert.equal(byCode.get('4000').params[8], 'debit');
  assert.equal(byCode.get('4000').params[9], 500);

  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.ok(audit.sql.includes('ledger.adjustment_posted'));
  assert.ok(String(audit.params[4]).includes('outbound_pipeline'), 'the receipt names the channel');
});
