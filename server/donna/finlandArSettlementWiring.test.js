// F-G8-1 — the receivables-aware settlement leg, driven through the REAL
// posting seam (prepareLedgerTransactionPosting → commitPreparedLedgerPosting)
// against a pattern-matching fake pg client (the finlandApSettlementWiring
// style). What must hold (docs/design-donna-finland-ar-settlement-posting.md):
//   1. CR 1700 never posts unless the invoice's ISSUANCE journal exists
//      (KEEP: the swap clears a receivable that was actually booked).
//   2. The swap and the issuance journal share the SAME receivable account
//      (the ledger.js constant — D-AR-3, no drift).
//   3. A failed gate ⇒ byte-identical today's journal + a receipted typed
//      reason from the CLOSED plan vocabulary; the AR leg posts NO second
//      journal in ANY case (it is a pure coding swap).
//   4. Partial payments clear partially; prior applied swaps shrink the open
//      amount (the payload marker doubles as the settled-before source).
// Plus the machine-checked two-terminal-states matrix: every Donna money-in
// post ends applied (CR 1700) or fallback-with-reason (today's CR revenue) —
// no third state.
//   node --test server/donna/finlandArSettlementWiring.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __commitPreparedLedgerPosting,
  __prepareLedgerTransactionPosting
} from './firmDb.js';
import { SALES_INVOICE_RECEIVABLE_ACCOUNT } from './ledger.js';

const revenueVerdict = () => ({
  proposed_account: 'Myynti',
  account_code: '3000',
  account_type: 'revenue',
  confidence: 'high',
  model: 'test-coder-model'
});

const txRow = (over = {}, verdict = revenueVerdict()) => ({
  id: 'tx-101',
  client_id: 'client-1',
  transaction_date: '2026-07-09',
  description: 'SEPA SAAPUVA viite 20260013 Asiakas Oy',
  money_in: 620,
  money_out: 0,
  currency: 'EUR',
  status: 'accepted',
  payload: { ai_suggestion: verdict },
  ...over
});

const invoiceRow = (over = {}) => ({
  id: 'inv-001',
  buyer_name: 'Asiakas Oy',
  display_number: '2026001',
  total: '620',
  currency: 'EUR',
  reference_number: '20260013',
  ...over
});

const chart = [
  { id: 'acc-bank', code: '1910', name: 'Pankkitili', account_type: 'bank', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: 'asset.cash', status: 'active' },
  { id: 'acc-3000', code: '3000', name: 'Myynti', account_type: 'revenue', normal_balance: 'credit', currency: 'EUR', tax_type: null, canonical_role: null, status: 'active' }
];

// Pattern-matching fake pg client covering the full prepare→commit trail:
// seam reads, the AR plan's hydration queries, and the journal write.
const fakeClient = ({
  jurisdiction = 'fi',
  flags = { FINLAND_AR_SETTLEMENT: 'auto' },
  profile = { accounting_basis: 'accrual' },
  transaction = txRow(),
  invoices = [invoiceRow()],
  creditedTotal = 0,
  settledBefore = 0,
  issuanceJournal = { id: 'journal-issuance' }
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
      if (sql.includes('from reconciliation_matches m')) return { rows: [] };
      // These accepted bank codings resolve an issued invoice through the AR
      // writer; they have no uploaded-document reconciliation relationship.
      if (sql.includes('from reconciliation_matches rm') && sql.includes('join documents d')) return { rows: [] };
      if (sql.includes("kind = 'credit_note'")) return { rows: [{ credited: creditedTotal }] };
      if (sql.includes('from issued_invoices')) return { rows: invoices };
      if (sql.includes("source_type = 'sales_invoice'")) return { rows: issuanceJournal ? [issuanceJournal] : [] };
      if (sql.includes("payload->'ar_settlement'")) return { rows: [{ settled: settledBefore }] };
      if (sql.includes('from ledger_accounts')) return { rows: chart };
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: params[0] }] };
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
    transactionId: 'tx-101',
    dryRun: false,
    skipClientCheck: true
  });
  const result = await __commitPreparedLedgerPosting({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-101',
    prepared,
    actorId
  });
  return { prepared, result };
};

const journalInserts = (client) => client.queries.filter((q) => q.sql.includes('insert into ledger_journals'));
const lineInserts = (client) => client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));
// ledger_lines params: [1]=journal_id, [5]=account_code, [8]=direction, [9]=debit, [10]=credit
const linesFor = (client, journalId) => lineInserts(client).filter((q) => q.params[1] === journalId);
const postTransactionAudit = (client) => client.queries.find((q) => q.sql.includes('ledger.post_transaction'));
const postTransactionMetadata = (client) => JSON.parse(postTransactionAudit(client).params[4]);
const updateTransactionsCall = (client) => client.queries.find((q) => q.sql.includes('update transactions'));
const settlementLinePairs = (client) => {
  const [txInsert] = journalInserts(client);
  return linesFor(client, txInsert.params[0]).map((q) => [q.params[5], q.params[8]]).sort();
};

test('full payment: ONE journal with the credit side swapped to 1700 — the receivable clears, revenue books zero times', async () => {
  const client = fakeClient();
  const { prepared } = await post(client);

  assert.equal(prepared.arSettlement.planned, true);
  assert.equal(prepared.arSettlement.invoice_id, 'inv-001');
  assert.equal(prepared.arSettlement.open_before_eur, 620);
  assert.equal(prepared.arSettlement.open_after_eur, 0);
  // The preview coding stays the coder's verdict (the swap is commit-only).
  assert.equal(prepared.preview.coding.account_code, '3000');
  // The AR leg posts no second journal — EVER (unlike AP's invoice leg).
  assert.equal(journalInserts(client).length, 1);
  assert.deepEqual(settlementLinePairs(client), [
    [SALES_INVOICE_RECEIVABLE_ACCOUNT.code, 'credit'],
    ['1910', 'debit']
  ]);
  // No revenue line anywhere: the income accrued at issuance, not here.
  assert.equal(lineInserts(client).some((q) => q.params[5] === '3000'), false);

  // Columns + row payload follow the JOURNAL (1700); ai_suggestion untouched.
  const update = updateTransactionsCall(client);
  assert.equal(update.params[3], '1700');
  assert.equal(update.params[4], '1700 · Myyntisaamiset');
  const payloadPatch = JSON.parse(update.params[5]);
  assert.equal(payloadPatch.account_code, '1700');
  assert.equal(payloadPatch.ar_settlement.applied, true);
  assert.equal(payloadPatch.ar_settlement.invoice_id, 'inv-001');
  assert.equal(payloadPatch.ar_settlement.invoice_number, '2026001');
  assert.equal(payloadPatch.ar_settlement.reference_number, '20260013');
  assert.equal(payloadPatch.ar_settlement.amount_eur, 620);
  assert.equal('ai_suggestion' in payloadPatch, false, 'the coding verdict must stay untouched');

  // The receipt: ar_settlement applied with open-before/after, nothing silent.
  const metadata = postTransactionMetadata(client);
  assert.equal(metadata.ar_settlement.applied, true);
  assert.equal(metadata.ar_settlement.open_before_eur, 620);
  assert.equal(metadata.ar_settlement.open_after_eur, 0);
  assert.equal(metadata.account_code, '1700');
});

test('mis-staged Finnish settlement flags cannot swap a GB or AU bank line to Finnish receivables', async () => {
  for (const jurisdiction of ['gb', 'au']) {
    const client = fakeClient({ jurisdiction, flags: { FINLAND_AR_SETTLEMENT: 'auto', FINLAND_EINVOICE_RECEIVE: 'auto' } });
    const { prepared } = await post(client);
    assert.deepEqual(prepared.arSettlement, { planned: false, reason: 'flag_off' });
    assert.deepEqual(prepared.apSettlement, { planned: false, reason: 'flag_off' });
    assert.equal(client.queries.some(({ sql }) => sql.includes('from issued_invoices')), false);
    assert.equal(lineInserts(client).some(({ params }) => params[5] === '1700' || params[5] === '2870'), false);
    assert.equal(journalInserts(client).length, 1);
    assert.equal(postTransactionMetadata(client).ar_settlement.applied, false);
  }
});

test('partial payments: each installment clears partially; a prior applied swap shrinks the next open amount', async () => {
  const first = fakeClient({ transaction: txRow({ money_in: 200 }) });
  const { prepared: firstPrepared } = await post(first);
  assert.equal(firstPrepared.arSettlement.planned, true);
  assert.equal(firstPrepared.arSettlement.open_after_eur, 420);

  // The second installment sees the first via the payload marker (settled-before).
  const second = fakeClient({ transaction: txRow({ money_in: 420 }), settledBefore: 200 });
  const { prepared: secondPrepared } = await post(second);
  assert.equal(secondPrepared.arSettlement.planned, true);
  assert.equal(secondPrepared.arSettlement.open_before_eur, 420);
  assert.equal(secondPrepared.arSettlement.open_after_eur, 0);
});

// The baseline trail: the commit WITHOUT a plan (arSettlement: null — exactly
// the pre-wiring path). Fallbacks must be byte-identical to it.
const baselineTrail = async () => {
  const client = fakeClient();
  const prepared = await __prepareLedgerTransactionPosting({
    client, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-101', dryRun: false, skipClientCheck: true
  });
  const baseline = fakeClient();
  await __commitPreparedLedgerPosting({
    client: baseline, firmId: 'firm-1', clientId: 'client-1', transactionId: 'tx-101',
    prepared: { ...prepared, arSettlement: null }, actorId: 'operator-1'
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
  assert.deepEqual(prepared.arSettlement, { planned: false, reason: 'flag_off' });

  // Journal economics remain byte-identical; the new policy receipt honestly
  // distinguishes an off flag from the baseline's enabled-but-unused capability.
  const actualParams = journalInserts(client)[0].params;
  const baselineParams = journalInserts(baseline)[0].params;
  assert.deepEqual(actualParams.slice(0, -1), baselineParams.slice(0, -1));
  const actualPayload = JSON.parse(actualParams.at(-1));
  const baselinePayload = JSON.parse(baselineParams.at(-1));
  assert.equal(actualPayload.posting_policy.settlement_flags.arSettlementFlagKey, false);
  assert.equal(baselinePayload.posting_policy.settlement_flags.arSettlementFlagKey, true);
  baselinePayload.posting_policy.settlement_flags.arSettlementFlagKey = false;
  assert.deepEqual(actualPayload, baselinePayload);
  const txJournalId = journalInserts(client)[0].params[0];
  assert.deepEqual(
    linesFor(client, txJournalId).map((q) => q.params),
    linesFor(baseline, txJournalId).map((q) => q.params)
  );
  // Today's shape: DR bank / CR the coder's revenue account.
  assert.deepEqual(settlementLinePairs(client), [['1910', 'debit'], ['3000', 'credit']]);
  const update = updateTransactionsCall(client);
  const baselineUpdate = updateTransactionsCall(baseline);
  assert.equal(update.params[3], baselineUpdate.params[3]);
  assert.equal(update.params[4], baselineUpdate.params[4]);
  assert.deepEqual(stripPostedAt(update.params[5]), stripPostedAt(baselineUpdate.params[5]));
  // Nothing silent: the receipt says why the swap did not fire.
  assert.deepEqual(postTransactionMetadata(client).ar_settlement, { applied: false, reason: 'flag_off' });
  // The baseline (pre-wiring) receipt carries NO ar_settlement key at all.
  assert.equal('ar_settlement' in postTransactionMetadata(baseline), false);
});

test('prepare-gate fallbacks carry their typed reasons from the CLOSED vocabulary', async () => {
  const cases = [
    [{ profile: { accounting_basis: 'cash' } }, 'cash_basis'],
    [{ transaction: txRow({ money_in: 0, money_out: 620 }) }, 'not_money_in'],
    [{ transaction: txRow({ description: 'jotain ihan muuta' }) }, 'no_issued_invoice_match'],
    [{ invoices: [invoiceRow(), invoiceRow({ id: 'inv-002', display_number: '2026002', reference_number: '2026 0013' })] }, 'multiple_invoice_matches'],
    [{ issuanceJournal: null }, 'no_issuance_journal'],
    [{ invoices: [invoiceRow({ currency: 'GBP' })] }, 'currency_mismatch'],
    [{ invoices: [invoiceRow({ currency: null })] }, 'currency_mismatch'],
    [{ invoices: [invoiceRow({ currency: '' })] }, 'currency_mismatch'],
    [{ transaction: txRow({ money_in: 700 }) }, 'overpayment'],
    [{ creditedTotal: 620 }, 'overpayment']
  ];
  for (const [overrides, reason] of cases) {
    const client = fakeClient(overrides);
    const { prepared } = await post(client);
    assert.deepEqual(prepared.arSettlement, { planned: false, reason }, `expected ${reason}`);
    assert.deepEqual(postTransactionMetadata(client).ar_settlement, { applied: false, reason });
    // No 1700 anywhere on a fallback.
    assert.equal(lineInserts(client).some((q) => q.params[5] === '1700'), false, reason);
  }
});

test('mutual exclusion: with both settlement flags on, a money-in line plans AR and the AP plan refuses by direction', async () => {
  const client = fakeClient({ flags: { FINLAND_AR_SETTLEMENT: 'auto', FINLAND_EINVOICE_RECEIVE: 'auto' } });
  const { prepared } = await post(client);
  assert.equal(prepared.arSettlement.planned, true);
  assert.deepEqual(prepared.apSettlement, { planned: false, reason: 'not_money_out' });
});

test('machine-checked two-terminal-states: every Donna money-in post terminates applied (CR 1700) or fallback-with-reason (CR revenue) — never a third state, never a second journal', async () => {
  const scenarios = [
    ['applied', {}],
    ['partial', { transaction: txRow({ money_in: 150 }) }],
    ['flag_off', { flags: {} }],
    ['cash_basis', { profile: { accounting_basis: 'cash' } }],
    ['no_match', { transaction: txRow({ description: 'ei viitettä täällä' }) }],
    ['multi_match', { invoices: [invoiceRow(), invoiceRow({ id: 'inv-002' })] }],
    ['no_issuance_journal', { issuanceJournal: null }],
    ['currency_mismatch', { invoices: [invoiceRow({ currency: 'SEK' })] }],
    ['overpayment', { transaction: txRow({ money_in: 9999 }) }]
  ];
  for (const [label, overrides] of scenarios) {
    const client = fakeClient(overrides);
    await post(client);
    const metadata = postTransactionMetadata(client);
    assert.ok(metadata.ar_settlement, `${label}: every Donna money-in post carries the ar_settlement receipt`);
    assert.equal(typeof metadata.ar_settlement.applied, 'boolean', label);
    if (!metadata.ar_settlement.applied) {
      assert.ok(typeof metadata.ar_settlement.reason === 'string' && metadata.ar_settlement.reason, `${label}: fallback carries a typed reason`);
    }
    // The AR leg NEVER adds a journal — one settlement journal in every terminal.
    assert.equal(journalInserts(client).length, 1, label);
    // KEEP 1: CR 1700 ⟺ the swap applied.
    const cr1700 = linesFor(client, journalInserts(client)[0].params[0])
      .some((q) => q.params[5] === SALES_INVOICE_RECEIVABLE_ACCOUNT.code && q.params[8] === 'credit');
    assert.equal(cr1700, metadata.ar_settlement.applied, `${label}: CR 1700 ⟺ swap applied`);
  }
});
