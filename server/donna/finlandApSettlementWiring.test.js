// FI-9 trigger wiring — the AP post call site + the payables-aware settlement
// leg, driven through the REAL posting seam (prepareLedgerTransactionPosting →
// commitPreparedLedgerPosting) against a pattern-matching fake pg client (the
// finlandSupplierBillPostDb.test.js style). What must hold (KEEP invariants,
// docs/design-donna-finland-fi9-trigger-wiring.md):
//   1. DR 2870 never posts unless the AP journal posted in the SAME txn.
//   2. Both legs use the SAME payables account (the shared ledger.js constant).
//   3. Typed AP refusal ⇒ byte-identical today's journal + a receipted reason;
//      unexpected error ⇒ the whole post fails.
//   4. Flag-off / non-accrual / unmatched / mismatch ⇒ byte-identical today.
//   5. The AP leg's DR side is the line's PERSISTED ai_suggestion verdict.
// Plus the machine-checked two-terminal-states matrix: every Donna post ends
// applied (two journals) or fallback-with-reason (one journal) — no third state.
//   node --test server/donna/finlandApSettlementWiring.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __commitPreparedLedgerPosting,
  __prepareLedgerTransactionPosting
} from './firmDb.js';
import { SUPPLIER_BILL_PAYABLES_ACCOUNT } from './ledger.js';

const confidentVerdict = () => ({
  proposed_account: 'Ulkopuoliset palvelut',
  account_code: '4400',
  account_type: 'expense',
  confidence: 'high',
  model: 'test-coder-model'
});

const txRow = (over = {}, verdict = confidentVerdict()) => ({
  id: 'tx-001',
  client_id: 'client-1',
  transaction_date: '2026-07-08',
  description: 'Maksu Toimittaja Oy RF18539007547034',
  money_in: 0,
  money_out: 620,
  currency: 'EUR',
  status: 'accepted',
  payload: { ai_suggestion: verdict, ai_suggestion_status: 'accepted' },
  ...over
});

const billRow = (over = {}) => ({
  id: 'doc-001',
  document_type: 'supplier_bill',
  parse_status: 'completed',
  duplicate_of: null,
  vendor_name: 'Toimittaja Oy',
  total_amount: 620,
  tax_amount: 120,
  document_date: '2026-07-02',
  currency: 'EUR',
  reference_number: 'RF18539007547034',
  ...over
});

const matchRow = (doc = billRow()) => ({
  id: doc.id,
  currency: doc.currency,
  reference_number: doc.reference_number,
  vendor_name: doc.vendor_name
});

const chart = [
  { id: 'acc-bank', code: '1910', name: 'Pankkitili', account_type: 'bank', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: 'asset.cash', status: 'active' },
  { id: 'acc-4400', code: '4400', name: 'Ulkopuoliset palvelut', account_type: 'expense', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: null, status: 'active' }
];

// Pattern-matching fake pg client covering the full prepare→commit trail:
// seam reads, plan resolution, the AP writer's gates, and both journal writes.
const fakeClient = ({
  jurisdiction = 'fi',
  flags = { FINLAND_EINVOICE_RECEIVE: 'auto' },
  profile = { accounting_basis: 'accrual', alv_registration: { status: 'registered', registered_from: '2020-01-01' } },
  transaction = txRow(),
  matches = [matchRow()],
  document = billRow(),
  existingApJournal = null,
  failApJournalInsert = false
} = {}) => {
  const queries = [];
  let auditId = 0;
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      // Policy receipt shares the caller-owned posting transaction and lock.
      if (['savepoint runtime_policy_incident', 'release savepoint runtime_policy_incident',
        'rollback to savepoint runtime_policy_incident',
        'select pg_advisory_xact_lock(hashtextextended($1, 0))'].includes(sql)) return { rows: [] };
      // Canonical lineage observes this same unmarked client; no native birth is seeded.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction, entity_type: null, profile: { ...profile, accounting_system: 'none' } }] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction, entity_type: null, profile: { ...profile, accounting_system: 'none' } }] };
      if (sql.includes('select id from transactions')) return { rows: transaction ? [{ id: transaction.id }] : [] };
      if (sql.includes('from audit_events') && sql.trimStart().startsWith('select')) return { rows: [] };
      if (sql.includes('select * from transactions')) return { rows: transaction ? [transaction] : [] };
      // RT-16: the ONE coding writer's lock read at commit (applyCodingTransition → 'posted').
      if (sql.includes('select coding_state from transactions')) return { rows: [{ coding_state: 'applied' }] };
      if (sql.includes('from transaction_review_queue') && sql.trimStart().startsWith('select')) return { rows: [] };
      if (sql.includes("lower(profile->>'accounting_system')")) return { rows: [{ accounting_system: 'none' }] };
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile }] };
      if (sql.includes('from reconciliation_matches rm')) return { rows: document && matches.length
        ? [{...document,document_id:document.id,bank_transaction_id:transaction.id,match_status:'confirmed'}] : [] };
      if (sql.includes('from document_lines')) return {rows:[]};
      if (sql.includes('from reconciliation_matches m')) return { rows: matches };
      if (sql.includes('from documents')) return { rows: document ? [document] : [] };
      if (sql.includes('from ledger_accounts')) return { rows: chart };
      if (sql.includes('from ledger_journals lj')) {
        // params[2] = source_type — only a pre-existing AP journal is modelled.
        return { rows: params[2] === 'supplier_bill' && existingApJournal ? [existingApJournal] : [] };
      }
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) {
        if (failApJournalInsert && params[3] === 'supplier_bill') throw new Error('connection reset (unexpected)');
        return { rows: [{ id: params[0] }] };
      }
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('update transactions')) return { rows: [] };
      if (sql.includes('update client_evidence_requests')) return { rows: [] }; // RT-24: the post resolves the line's open asks
      if (sql.includes('update transaction_review_queue')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: ++auditId }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const post = async (client, { actorId = 'operator-1' } = {}) => {
  const prepared = await __prepareLedgerTransactionPosting({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-001',
    dryRun: false,
    skipClientCheck: true
  });
  const result = await __commitPreparedLedgerPosting({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-001',
    prepared,
    actorId
  });
  return { prepared, result };
};

const journalInserts = (client) => client.queries.filter((q) => q.sql.includes('insert into ledger_journals'));
const journalInsertBySource = (client, sourceType) => journalInserts(client).filter((q) => q.params[3] === sourceType);
const lineInserts = (client) => client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
// ledger_lines params: [1]=journal_id, [5]=account_code, [8]=direction, [9]=debit, [10]=credit
const linesFor = (client, journalId) => lineInserts(client).filter((q) => q.params[1] === journalId);
const postTransactionAudit = (client) => client.queries.find((q) => q.sql.includes('ledger.post_transaction'));
const postTransactionMetadata = (client) => JSON.parse(postTransactionAudit(client).params[4]);
const updateTransactionsCall = (client) => client.queries.find((q) => q.sql.includes('update transactions'));

test('confident matched bill: TWO journals in one trail — AP invoice-dated DR expense/CR 2870, settlement payment-dated DR 2870/CR bank; 2870 sums to zero; expense once', async () => {
  const client = fakeClient();
  const { prepared } = await post(client);

  assert.equal(prepared.apSettlement.planned, true);
  assert.equal(prepared.apSettlement.document_id, 'doc-001');
  // The preview coding stays the coder's verdict (the swap is commit-only).
  assert.equal(prepared.preview.coding.account_code, '4400');

  const [apInsert] = journalInsertBySource(client, 'supplier_bill');
  const [txInsert] = journalInsertBySource(client, 'transaction');
  assert.ok(apInsert, 'AP journal must post');
  assert.ok(txInsert, 'settlement journal must post');
  assert.equal(apInsert.params[4], 'doc-001');
  assert.equal(apInsert.params[5], '2026-07-02'); // invoice date
  assert.equal(txInsert.params[4], 'tx-001');
  assert.equal(txInsert.params[5], '2026-07-08'); // payment date

  const apLines = linesFor(client, apInsert.params[0]);
  const txLines = linesFor(client, txInsert.params[0]);
  assert.deepEqual(apLines.map((q) => [q.params[5], q.params[8]]), [['4400', 'debit'], ['2870', 'credit']]);
  assert.deepEqual(txLines.map((q) => [q.params[5], q.params[8]]), [['2870', 'debit'], ['1910', 'credit']]);

  // KEEP 2: both legs on the SAME payables account — 2870 nets to zero.
  const on2870 = [...apLines, ...txLines].filter((q) => q.params[5] === SUPPLIER_BILL_PAYABLES_ACCOUNT.code);
  const net = on2870.reduce((sum, q) => sum + Number(q.params[9] || 0) - Number(q.params[10] || 0), 0);
  assert.equal(net, 0);
  // The expense books exactly once (the double-count this wiring exists to kill).
  assert.equal([...apLines, ...txLines].filter((q) => q.params[5] === '4400').length, 1);

  // D-FI9-P4: columns + row payload follow the JOURNAL (2870); ai_suggestion untouched.
  const update = updateTransactionsCall(client);
  assert.equal(update.params[3], '2870');
  assert.equal(update.params[4], '2870 · Ostovelat');
  const payloadPatch = JSON.parse(update.params[5]);
  assert.equal(payloadPatch.account_code, '2870');
  assert.equal(payloadPatch.ap_settlement.applied, true);
  assert.equal(payloadPatch.ap_settlement.document_id, 'doc-001');
  assert.equal(payloadPatch.ap_settlement.reference_number, 'RF18539007547034');
  assert.equal('ai_suggestion' in payloadPatch, false, 'the coding verdict must stay untouched');

  // The receipt: ap_settlement applied + the coder model id, on the same audit.
  const metadata = postTransactionMetadata(client);
  assert.equal(metadata.ap_settlement.applied, true);
  assert.equal(metadata.ap_settlement.journal_id, apInsert.params[0]);
  assert.equal(metadata.account_code, '2870');
  assert.equal(metadata.coding_model, 'test-coder-model');
  // The bill-specific receipt posted too, actor-attributed.
  const apAudit = client.queries.find((q) => q.sql.includes('ledger.post_supplier_bill'));
  assert.ok(apAudit);
  assert.equal(apAudit.params[2], 'operator-1');
  const apMetadata = JSON.parse(apAudit.params[4]);
  assert.equal(apMetadata.coding.model, 'test-coder-model');
  assert.equal(apMetadata.authority_basis.source, 'ap_settlement');
  assert.equal(apMetadata.authority_basis.transaction_id, 'tx-001');
});

test('second installment: the AP journal re-upserts the SAME row (count stays 1), 2870 keeps clearing', async () => {
  const client = fakeClient({
    transaction: txRow({ money_out: 300 }),
    existingApJournal: { id: 'journal-ap-old', close_period_id: null }
  });
  await post(client);
  const apInserts = journalInsertBySource(client, 'supplier_bill');
  assert.equal(apInserts.length, 1);
  // The existing row's id rides the on-conflict upsert — no duplicate AP journal.
  assert.equal(apInserts[0].params[0], 'journal-ap-old');
  const txLines = linesFor(client, journalInsertBySource(client, 'transaction')[0].params[0]);
  assert.deepEqual(txLines.map((q) => [q.params[5], q.params[8], q.params[11]]), [['2870', 'debit', 300], ['1910', 'credit', 300]]);
});

// D-FI9-P2 / KEEP 3+4 — a failed gate or an enumerated AP refusal posts
// byte-identically to today. The baseline trail is the commit WITHOUT a plan
// (apSettlement: null — exactly the pre-wiring path).
const baselineTrail = async () => {
  const client = fakeClient();
  const prepared = await __prepareLedgerTransactionPosting({
    client, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-001', dryRun: false, skipClientCheck: true
  });
  const baseline = fakeClient();
  await __commitPreparedLedgerPosting({
    client: baseline, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-001',
    prepared: { ...prepared, apSettlement: null }, actorId: 'operator-1'
  });
  return baseline;
};

const stripPostedAt = (json) => {
  const parsed = JSON.parse(json);
  delete parsed.ledger_posted_at;
  return parsed;
};

test('fallback (flag off) posts byte-identical to the pre-wiring path, with the reason receipted', async () => {
  const baseline = await baselineTrail();
  const client = fakeClient({ flags: {} });
  const { prepared } = await post(client);
  assert.deepEqual(prepared.apSettlement, { planned: false, reason: 'flag_off' });

  assert.equal(journalInsertBySource(client, 'supplier_bill').length, 0);
  // Journal economics remain byte-identical; the new policy receipt honestly
  // distinguishes an off flag from the baseline's enabled-but-unused capability.
  const actualParams = journalInsertBySource(client, 'transaction')[0].params;
  const baselineParams = journalInsertBySource(baseline, 'transaction')[0].params;
  assert.deepEqual(actualParams.slice(0, -1), baselineParams.slice(0, -1));
  const actualPayload = JSON.parse(actualParams.at(-1));
  const baselinePayload = JSON.parse(baselineParams.at(-1));
  assert.equal(actualPayload.posting_policy.settlement_flags.supplierBillAdmissionFlagKey, false);
  assert.equal(baselinePayload.posting_policy.settlement_flags.supplierBillAdmissionFlagKey, true);
  baselinePayload.posting_policy.settlement_flags.supplierBillAdmissionFlagKey = false;
  assert.deepEqual(actualPayload, baselinePayload);
  const txJournalId = journalInsertBySource(client, 'transaction')[0].params[0];
  assert.deepEqual(
    linesFor(client, txJournalId).map((q) => q.params),
    linesFor(baseline, txJournalId).map((q) => q.params)
  );
  // Columns + payload patch identical too (modulo the posted-at timestamp).
  const update = updateTransactionsCall(client);
  const baselineUpdate = updateTransactionsCall(baseline);
  assert.equal(update.params[3], baselineUpdate.params[3]);
  assert.equal(update.params[4], baselineUpdate.params[4]);
  assert.deepEqual(stripPostedAt(update.params[5]), stripPostedAt(baselineUpdate.params[5]));
  // Today's shape: DR the coder's expense / CR bank.
  assert.deepEqual(linesFor(client, txJournalId).map((q) => [q.params[5], q.params[8]]), [['4400', 'debit'], ['1910', 'credit']]);
  // Nothing silent: the receipt says why the AP leg did not fire.
  const metadata = postTransactionMetadata(client);
  assert.deepEqual(metadata.ap_settlement, { applied: false, reason: 'flag_off' });
  // The baseline (pre-wiring) receipt carries NO ap_settlement key at all.
  assert.equal('ap_settlement' in postTransactionMetadata(baseline), false);
});

test('a below-high-confidence verdict: the WRITER refuses at commit and the post falls back with the typed code', async () => {
  const client = fakeClient({ transaction: txRow({}, { ...confidentVerdict(), confidence: 'medium' }) });
  const { prepared } = await post(client);
  assert.equal(prepared.apSettlement.planned, true); // the bar lives in ONE place — the writer
  assert.equal(journalInsertBySource(client, 'supplier_bill').length, 0);
  assert.deepEqual(postTransactionMetadata(client).ap_settlement, { applied: false, reason: 'SUPPLIER_BILL_CODING_NOT_CONFIDENT' });
  const txLines = linesFor(client, journalInsertBySource(client, 'transaction')[0].params[0]);
  assert.deepEqual(txLines.map((q) => [q.params[5], q.params[8]]), [['4400', 'debit'], ['1910', 'credit']]);
});

test('an ALV-coding client with an UNRESOLVABLE treatment: RT-23 refuses the WHOLE post by name — no AP journal, no gross uncoded expense', async () => {
  // confidentVerdict carries no tax treatment → no resolvable ALV code. Until
  // RT-23 (2026-09-09) the AP leg refused (SUPPLIER_BILL_ALV_SPLIT_UNSUPPORTED)
  // and the settlement fell back to the two-line journal — an uncoded expense
  // leg the ALV return could not see. The Keep layer now refuses at prepare;
  // the line stays applied-but-unposted, receipted by the auto-post sweep and
  // visible to convergence as hanging (RT-23's real-PG proof).
  const client = fakeClient({ flags: { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_ALV_CODING: 'auto' } });
  await assert.rejects(post(client), (e) => e.code === 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' && e.statusCode === 409);
  assert.equal(journalInserts(client).length, 0, 'no journal of any source');
  // A resolved rate whose arithmetic contradicts the source cannot fall back
  // to a different deductible amount in the cash journal.
  const mismatch = fakeClient({
    flags: { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_ALV_CODING: 'auto' },
    transaction: txRow({}, { ...confidentVerdict(), tax_treatment: 'ALV 25,5 %' }),
    document: billRow({ tax_amount: 99 })
  });
  await assert.rejects(post(mismatch),{code:'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH'});
  assert.equal(journalInserts(mismatch).length,0,'a source contradiction leaves no journal of either kind');
});

test('slice S E2E: an ALV-coding client with a domestic-rate verdict applies BOTH legs — split AP journal + gross 2870 settlement', async () => {
  // 620 gross at 25.5% → net 494.02 + vat 125.98; the bill states 125.98.
  const client = fakeClient({
    flags: { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_ALV_CODING: 'auto' },
    transaction: txRow({}, { ...confidentVerdict(), tax_treatment: 'ALV 25,5 %' }),
    document: billRow({ tax_amount: 125.98 })
  });
  await post(client);
  assert.equal(postTransactionMetadata(client).ap_settlement.applied, true);
  // The AP journal is SPLIT: DR 4400 net + DR 2940 vat / CR 2870 gross (D-FI3-S4).
  const apLines = linesFor(client, journalInsertBySource(client, 'supplier_bill')[0].params[0]);
  assert.deepEqual(
    apLines.map((q) => [q.params[5], q.params[9], q.params[10]]),
    [['4400', 494.02, 0], ['2940', 125.98, 0], ['2870', 0, 620]]
  );
  assert.equal(JSON.parse(apLines[1].params[15]).role, 'alv_input_deductible', 'the cross-check handle persists');
  // The settlement leg still clears the payable at GROSS — 2870 carries no ALV
  // code, so it never splits (the expense and its VAT live on the AP journal).
  const txLines = linesFor(client, journalInsertBySource(client, 'transaction')[0].params[0]);
  assert.deepEqual(
    txLines.map((q) => [q.params[5], q.params[9], q.params[10]]),
    [[SUPPLIER_BILL_PAYABLES_ACCOUNT.code, 620, 0], ['1910', 0, 620]]
  );
});

test('prepare-gate fallbacks carry their typed reasons', async () => {
  const cases = [
    [{ profile: { accounting_basis: 'cash' } }, 'cash_basis'],
    [{ transaction: txRow({ money_in: 620, money_out: 0 }) }, 'not_money_out'],
    [{ matches: [] }, 'no_decided_match'],
    [{ matches: [matchRow(), matchRow(billRow({ id: 'doc-002' }))] }, 'multiple_bill_matches'],
    [{ matches: [matchRow(billRow({ currency: 'GBP' }))] }, 'currency_mismatch']
  ];
  for (const [overrides, reason] of cases) {
    const client = fakeClient(overrides);
    const { prepared } = await post(client);
    assert.deepEqual(prepared.apSettlement, { planned: false, reason }, `expected ${reason}`);
    assert.equal(journalInsertBySource(client, 'supplier_bill').length, 0);
    assert.deepEqual(postTransactionMetadata(client).ap_settlement, { applied: false, reason });
  }
});

test('an UNEXPECTED AP-leg error fails the whole post — no settlement journal, no laundered accrual gap', async () => {
  const client = fakeClient({ failApJournalInsert: true });
  await assert.rejects(post(client), /connection reset/);
  assert.equal(journalInsertBySource(client, 'transaction').length, 0);
  assert.equal(postTransactionAudit(client), undefined);
});

test('mis-staged Finnish receive and AR flags cannot plan a supplier accrual for GB or AU', async () => {
  for (const jurisdiction of ['gb', 'au']) {
    const client = fakeClient({ jurisdiction, flags: { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_AR_SETTLEMENT: 'auto' } });
    const { prepared } = await post(client);
    assert.deepEqual(prepared.apSettlement, { planned: false, reason: 'flag_off' });
    assert.deepEqual(prepared.arSettlement, { planned: false, reason: 'flag_off' });
    assert.equal(client.queries.some(({ sql }) => sql.includes('from reconciliation_matches m')), false);
    assert.equal(journalInsertBySource(client, 'supplier_bill').length, 0);
    assert.equal(journalInsertBySource(client, 'transaction').length, 1);
    assert.equal(postTransactionMetadata(client).ap_settlement.applied, false);
  }
});

test('machine-checked two-terminal-states: every Donna post terminates applied (two journals), fallback-with-reason (today\'s journal), or a REFUSAL by name with no journal at all — never an uncoded P&L post', async () => {
  // RT-23: an ALV-coding client whose verdict carries no resolvable treatment
  // is the one scenario that leaves NO journal — the refusal is typed, the
  // sweep receipts it on the row, convergence hangs under its code.
  const refused = fakeClient({ flags: { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_ALV_CODING: 'auto' } });
  await assert.rejects(post(refused), (e) => e.code === 'TRANSACTION_ALV_TREATMENT_UNRESOLVED');
  assert.equal(journalInserts(refused).length, 0, 'refused ⇒ no journal of any source');
  const scenarios = [
    ['applied', {}],
    ['flag_off', { flags: {} }],
    ['cash_basis', { profile: { accounting_basis: 'cash' } }],
    ['not_money_out', { transaction: txRow({ money_in: 620, money_out: 0 }) }],
    ['no_decided_match', { matches: [] }],
    ['multiple_bill_matches', { matches: [matchRow(), matchRow(billRow({ id: 'doc-002' }))] }],
    ['currency_mismatch', { matches: [matchRow(billRow({ currency: 'GBP' }))] }],
    ['not_confident', { transaction: txRow({}, { ...confidentVerdict(), confidence: 'medium' }) }],
    ['alv_coding_resolved_mismatch', { flags: { FINLAND_EINVOICE_RECEIVE: 'auto', FINLAND_ALV_CODING: 'auto' }, transaction: txRow({}, { ...confidentVerdict(), tax_treatment: 'ALV 25,5 %' }), document: billRow({ tax_amount: 99 }) }],
    ['duplicate_bill', { document: billRow({ duplicate_of: 'doc-000' }) }],
    ['unparsed_bill', { document: billRow({ parse_status: 'processing' }) }]
  ];
  for (const [label, overrides] of scenarios) {
    const client = fakeClient(overrides);
    if(label==='alv_coding_resolved_mismatch') {
      await assert.rejects(post(client),{code:'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH'});
      assert.equal(journalInserts(client).length,0,'mismatched source VAT is a typed refusal, never a fallback deduction');
      continue;
    }
    await post(client);
    const metadata = postTransactionMetadata(client);
    // Terminal one-of-two: the receipt ALWAYS says which, with a reason when not applied.
    assert.ok(metadata.ap_settlement, `${label}: every Donna post carries the ap_settlement receipt`);
    assert.equal(typeof metadata.ap_settlement.applied, 'boolean', label);
    const apCount = journalInsertBySource(client, 'supplier_bill').length;
    if (metadata.ap_settlement.applied) {
      assert.equal(apCount, 1, `${label}: applied ⇒ the AP journal exists`);
    } else {
      assert.equal(apCount, 0, `${label}: fallback ⇒ no AP journal`);
      assert.ok(typeof metadata.ap_settlement.reason === 'string' && metadata.ap_settlement.reason, `${label}: fallback carries a typed reason`);
    }
    // KEEP 1: DR 2870 on the settlement leg never without the AP journal.
    const txInsert = journalInsertBySource(client, 'transaction')[0];
    const drPayables = linesFor(client, txInsert.params[0])
      .some((q) => q.params[5] === SUPPLIER_BILL_PAYABLES_ACCOUNT.code && q.params[8] === 'debit');
    assert.equal(drPayables, metadata.ap_settlement.applied, `${label}: DR 2870 ⟺ AP journal posted`);
  }
});
