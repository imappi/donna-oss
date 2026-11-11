// RT-21f — the settlement-row split on the Donna post path (docs/prompt-2026-09-08-
// rt-21-koontilasku-settlement-rows.md §2, §4 RT-21f; RT-18 §4 (i)–(iii)).
//
// A NETS credit settled by a koontilasku ROW (RT-21c: a decided match with
// matched_line_id; RT-21b: the row's gross / fee / net on the line) posts
//   Dr bank 2 452,72 · Dr Platform fees 27,28 (tax NONE) · Cr Sales 1 976,10
//   (ALV_25_5_OUTPUT) · Cr ALV control 503,90
// — the ALV base is the GROSS sale (2 480,00), never the bank receipt. The
// split is DERIVED from the matched row at prepare time and rebuilt at
// commit; it refuses by name whenever the row and the bank line disagree.
// Mock-pg harness mirrors finlandAlvSettlementWiring.test.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import { __commitPreparedLedgerPosting, __prepareLedgerTransactionPosting } from './firmDb.js';
import { resolveSettlementRowSplit, SETTLEMENT_SPLIT_FEE_ROLE } from './db/ledger.js';

const salesVerdict = (over = {}) => ({
  proposed_account: 'Sales',
  tax_treatment: 'ALV 25,5 %',
  confidence: 'high',
  model: 'test-coder-model',
  ...over
});

const txRow = ({ verdict = salesVerdict(), money_in = 2452.72 } = {}) => ({
  id: 'tx-nets-5',
  client_id: 'client-1',
  transaction_date: '2025-02-03',
  description: 'NETS FINLAND OY',
  money_in,
  money_out: 0,
  currency: 'EUR',
  status: 'accepted',
  coding_state: 'applied',
  payload: { ai_suggestion: verdict, reconciliation_match_id: 'recon-nets-row1', reconciliation_match_object_id: 'doc-nets' }
});

const ROW_MATCH = {
  match_id: 'recon-nets-row1', matched_line_id: 'doc-nets-ln-1', status: 'auto_matched',
  line_no: 1, row_label: 'VKO5 2025 (27.1.–2.2.)', row_net: '2452.72',
  settlement_row: { row_no: 1, period_label: 'VKO5 2025 (27.1.–2.2.)', paid_on: '2025-02-03', gross: 2480, fee: 27.28, fee_tax: 0, net: 2452.72, transaction_count: 31, reference: null },
  document_id: 'doc-nets', document_type: 'payout_statement', document_currency: 'EUR'
};

const FEE_ACCOUNT = { id: 'acc-4550', code: '4550', name: 'Platform and processor fees', account_type: 'expense', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: SETTLEMENT_SPLIT_FEE_ROLE, status: 'active' };
const chartWith = (extra = []) => [
  { id: 'acc-bank', code: '1910', name: 'Pankkitili', account_type: 'bank', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: 'asset.cash', status: 'active' },
  { id: 'acc-3000', code: '3000', name: 'Sales', account_type: 'revenue', normal_balance: 'credit', currency: 'EUR', tax_type: null, canonical_role: 'revenue.operating', status: 'active' },
  { id: 'acc-1890', code: '1890', name: 'Payment processor clearing', account_type: 'clearing', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: 'clearing.payment_processor', status: 'active' },
  ...extra
];

const fakeClient = ({
  flags = { FINLAND_ALV_CODING: 'auto' },
  transaction = txRow(),
  rowMatches = [ROW_MATCH],
  chart = chartWith([FEE_ACCOUNT])
} = {}) => {
  const queries = [];
  let auditId = 0;
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // The filed-VAT-return guard's reads (db/ledger.js assertJournalDateOutsideFiledReturn,
      // 2026-11-10): no stored chart for the journal's codes and no filed return in this fixture.
      if (sql.includes('select code, account_type from ledger_accounts')) return { rows: [] };
      if (sql.includes('from alv_returns')) return { rows: [] };
      if (sql.includes('as birth_created_at')) return { rows: [{ id: 'c', jurisdiction: 'fi', profile: {} }] };
      if (sql.includes('select id,code,name,account_type')) return { rows: chart };
      if (['savepoint runtime_policy_incident', 'release savepoint runtime_policy_incident',
        'rollback to savepoint runtime_policy_incident',
        'select pg_advisory_xact_lock(hashtextextended($1, 0))'].includes(sql)) return { rows: [] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: 'fi', entity_type: null, profile: { accounting_basis: 'cash', accounting_system: 'none', alv_registration: { status: 'registered', registered_from: '2020-01-01' } } }] };
      if (sql.includes('select id from transactions')) return { rows: transaction ? [{ id: transaction.id }] : [] };
      if (sql.includes('from audit_events') && sql.trimStart().startsWith('select')) return { rows: [] };
      if (sql.includes('select * from transactions')) return { rows: [transaction] };
      if (sql.includes('select coding_state from transactions')) return { rows: [{ coding_state: 'applied' }] };
      if (sql.includes('from transaction_review_queue') && sql.trimStart().startsWith('select')) return { rows: [] };
      if (sql.includes("lower(profile->>'accounting_system')")) return { rows: [{ accounting_system: 'none' }] };
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile: { accounting_basis: 'cash' } }] };
      // The final writer now rehydrates the same source through the shared
      // matched-document reader before preparing the settlement split.
      if (sql.includes('from reconciliation_matches rm') && sql.includes('join documents d')) return { rows: rowMatches.map(row => ({
        bank_transaction_id: transaction.id, match_status: row.status, matched_line_id: row.matched_line_id,
        document_id: row.document_id, document_type: row.document_type, currency: row.document_currency,
        total_amount: null, filename: 'settlements.pdf', document_date: '2025-02-03', parse_summary: {}
      })) };
      if (sql.includes('from document_lines') && sql.includes("payload->'raw_extraction'->'settlement_row'")) return { rows: rowMatches.map(row => ({
        id: row.matched_line_id, document_id: row.document_id, line_no: row.line_no,
        description: row.row_label, amount: row.row_net, settlement_row: row.settlement_row,
        payload: { raw_extraction: { settlement_row: row.settlement_row } }
      })) };
      if (sql.includes('join document_lines dl')) return { rows: rowMatches };
      if (sql.includes('from reconciliation_matches m')) return { rows: [] };
      if (sql.includes('from documents')) return { rows: [] };
      if (sql.includes('from ledger_accounts')) return { rows: chart };
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: params[0] }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('update transactions')) return { rows: [] };
      // RT-24: the post resolves the line's open asks; the harness returns one resolved id so the audit row is written.
      if (sql.includes('update client_evidence_requests')) return { rows: [{ id: 'ask-1' }] };
      if (sql.includes('update transaction_review_queue')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: ++auditId }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const prepare = (client) => __prepareLedgerTransactionPosting({
  client, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-nets-5', dryRun: false, skipClientCheck: true
});
const post = async (client) => {
  const prepared = await prepare(client);
  const result = await __commitPreparedLedgerPosting({ client, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-nets-5', prepared, actorId: 'owner-1' });
  return { prepared, result };
};
// ledger_lines params: [5]=account_code, [9]=debit, [10]=credit, [13]=tax_type
const lineInserts = (client) => client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
const updateTransactionsCall = (client) => client.queries.find((q) => q.sql.includes('update transactions'));

test('the NETS row posts Dr bank net · Dr platform fees · Cr sales gross split into base + output ALV — four legs footing to the bank amount, the row receipted', async () => {
  const client = fakeClient();
  const { prepared } = await post(client);

  assert.equal(prepared.settlementSplit.planned, true);
  assert.deepEqual(prepared.settlementSplit.receipt, {
    document_id: 'doc-nets', document_type: 'payout_statement', match_id: 'recon-nets-row1', line_id: 'doc-nets-ln-1', line_no: 1,
    label: 'VKO5 2025 (27.1.–2.2.)', gross: 2480, fee: 27.28, fee_tax: 0, net: 2452.72, fee_account_code: '4550'
  });
  assert.equal(prepared.preview.coding.xero_tax_type, 'ALV_25_5_OUTPUT', 'the sales coding carries the resolved ALV code');
  assert.deepEqual(prepared.ledgerPreview.settlement_split.row, { document_id: 'doc-nets', document_type: 'payout_statement', match_id: 'recon-nets-row1', line_id: 'doc-nets-ln-1', line_no: 1, label: 'VKO5 2025 (27.1.–2.2.)' });

  const lines = lineInserts(client);
  assert.equal(lines.length, 4, 'bank · fee · sales base · output ALV');
  const [bank, fee, sales, alv] = lines;
  assert.equal(bank.params[5], '1910');
  assert.equal(Number(bank.params[9]), 2452.72, 'Dr bank at the row NET');
  assert.equal(fee.params[5], '4550');
  assert.equal(Number(fee.params[9]), 27.28, 'Dr the processor fee');
  assert.equal(fee.params[13], 'NONE', 'a VAT-free financial service');
  assert.equal(sales.params[5], '3000');
  assert.equal(Number(sales.params[10]), 1976.1, 'Cr sales base = 2 480,00 / 1,255');
  assert.equal(sales.params[13], 'ALV_25_5_OUTPUT', 'the ALV code on the sales leg (alvReturn.js reads this column)');
  assert.equal(alv.params[5], '2939');
  assert.equal(Number(alv.params[10]), 503.9, 'output ALV on the GROSS sale, not on the bank receipt');
  assert.equal(alv.params[13], 'NONE');
  const debits = lines.reduce((s, l) => s + Number(l.params[9] || 0), 0);
  const credits = lines.reduce((s, l) => s + Number(l.params[10] || 0), 0);
  assert.equal(debits.toFixed(2), credits.toFixed(2), 'foots');

  const patch = JSON.parse(updateTransactionsCall(client).params[5]);
  assert.equal(patch.settlement_split.line_no, 1, 'the row rides the transaction receipt');
  assert.equal(patch.settlement_split.gross, 2480);
});

test('without FINLAND_ALV_CODING acting: three legs — bank net, fee, sales GROSS with no ALV code (the seed PR #2065 is what makes the return see it)', async () => {
  const client = fakeClient({ flags: {} });
  await post(client);
  const lines = lineInserts(client);
  assert.equal(lines.length, 3);
  assert.equal(Number(lines[2].params[10]), 2480, 'Cr sales at the gross');
  assert.notEqual(lines[2].params[13], 'ALV_25_5_OUTPUT');
});

test('refusals by name: the row net ≠ the bank amount; the line coded to clearing; no fee account; two decided rows on one line', async () => {
  await assert.rejects(prepare(fakeClient({ transaction: txRow({ money_in: 2480 }) })), (e) => e.code === 'SETTLEMENT_SPLIT_BANK_AMOUNT_MISMATCH', 'a credit equal to the GROSS is not the row');
  await assert.rejects(prepare(fakeClient({ transaction: txRow({ money_in: 2452.71 }) })), (e) => e.code === 'SETTLEMENT_SPLIT_BANK_AMOUNT_MISMATCH', 'one cent off is refused, never shaded');
  // Kari's manual "NETS FINLAND" → Payment processor clearing rule (2026-09-08):
  // a fee-and-gross split has no meaning on a clearing account — surfaced, never blessed.
  await assert.rejects(prepare(fakeClient({ transaction: txRow({ verdict: salesVerdict({ proposed_account: 'Payment processor clearing', tax_treatment: 'Ei ALV-käsittelyä' }) }) })), (e) => e.code === 'SETTLEMENT_SPLIT_CODING_NOT_REVENUE');
  await assert.rejects(prepare(fakeClient({ chart: chartWith([]) })), (e) => e.code === 'SETTLEMENT_SPLIT_FEE_ACCOUNT_MISSING');
  await assert.rejects(prepare(fakeClient({ rowMatches: [ROW_MATCH, { ...ROW_MATCH, match_id: 'recon-nets-row2', matched_line_id: 'doc-nets-ln-2', line_no: 2 }] })), (e) => e.code === 'SETTLEMENT_SPLIT_MULTIPLE_ROWS');
  await assert.rejects(prepare(fakeClient({ rowMatches: [{ ...ROW_MATCH, document_currency: 'SEK' }] })), (e) => e.code === 'SETTLEMENT_SPLIT_CURRENCY_MISMATCH');
});

test('not planned (the two-line journal as before): no decided row match, a document-level match, a money-out line', async () => {
  const none = fakeClient({ rowMatches: [] });
  const { prepared } = await post(none);
  assert.equal(prepared.settlementSplit.planned, false);
  assert.equal(prepared.settlementSplit.reason, 'no_settlement_row_match');
  assert.equal(lineInserts(none).length, 3, 'the ordinary ALV split on the bank amount (bank · sales base · ALV)');

  const docLevel = await resolveSettlementRowSplit({
    client: { query: async () => ({ rows: [{ match_id: 'm', matched_line_id: null, settlement_row: null }] }) },
    firmId: 'firm-1', clientId: 'client-1', transaction: { id: 't', money_in: 10 }, coding: {}, ledgerAccounts: []
  });
  assert.deepEqual(docLevel, { planned: false, reason: 'no_settlement_row_match' });
  const spend = await resolveSettlementRowSplit({ client: { query: async () => { throw new Error('never queried'); } }, firmId: 'f', clientId: 'c', transaction: { id: 't', money_out: 10 } });
  assert.deepEqual(spend, { planned: false, reason: 'not_money_in' });
});

test('RT-23: the NETS row under the coder\'s unsure marker (ALV-tarkistus) refuses by name at prepare — no journal, no uncoded sales leg', async () => {
  // The Kampaamo February book on the mini (2026-09-09): four Nets journals
  // posted Cr Sales gross with tax_type null under 'ALV-tarkistus'. The
  // Keep layer now refuses before any leg is shaped.
  const client = fakeClient({ transaction: txRow({ verdict: salesVerdict({ tax_treatment: 'ALV-tarkistus' }) }) });
  await assert.rejects(prepare(client), (e) => e.code === 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' && e.statusCode === 409 && /ALV-tarkistus/.test(e.message));
  assert.equal(lineInserts(client).length, 0, 'no ledger line was written');
  assert.equal(client.queries.some((q) => q.sql.includes('insert into ledger_journals')), false, 'no journal was written');
});

test('RT-24: the ledger post resolves every open owner ask on the line — a posted line never rests on the owner', async () => {
  const client = fakeClient();
  await post(client);
  const resolve = client.queries.find((q) => q.sql.includes('update client_evidence_requests') && q.sql.includes("set status = 'resolved'"));
  assert.ok(resolve, 'the post issued the ask resolve');
  assert.equal(resolve.params[2], 'tx-nets-5');
  assert.match(String(resolve.params[4]), /Superseded by ledger post/);
  const journalInsert = client.queries.findIndex((q) => q.sql.includes('insert into ledger_journals'));
  const resolveIdx = client.queries.indexOf(resolve);
  assert.ok(resolveIdx > journalInsert, 'the resolve follows the journal in the same transaction');
});
