// 308-settlement follow-up (slice-S design §what-this-does-NOT-do) — the
// OmaVero settlement payment driven through the REAL posting seam
// (prepareLedgerTransactionPosting → commitPreparedLedgerPosting) against the
// finlandApSettlementWiring-style fake pg client. What must hold:
//   1. The coder's 'Suoritettava arvonlisävero' verdict resolves to the CODED
//      2939 control account even when the chart has no such row yet (the
//      settlement-account union at the writeback universe) — never a code-less
//      mint-by-name row the return engine's control tracking can't see.
//   2. The posted control leg carries tax_type 'NONE' whatever the treatment
//      verdict said — an ALV code on a control account is the D-FI3-A5
//      blocker, never something we post — and it never splits.
//   3. Flag off ⇒ byte-identical legacy behavior (no union, no NONE stamp).
//   node --test server/donna/finlandAlvSettlementWiring.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __commitPreparedLedgerPosting,
  __prepareLedgerTransactionPosting
} from './firmDb.js';

const settlementVerdict = (over = {}) => ({
  proposed_account: 'Suoritettava arvonlisävero',
  tax_treatment: 'Ei ALV-käsittelyä',
  confidence: 'high',
  model: 'test-coder-model',
  ...over
});

const txRow = (verdict = settlementVerdict()) => ({
  id: 'tx-308',
  client_id: 'client-1',
  transaction_date: '2026-08-12',
  description: 'OMAVERO VEROHALLINTO RF48 1234 5678 9012 3',
  money_in: 0,
  money_out: 812.4,
  currency: 'EUR',
  status: 'accepted',
  payload: { ai_suggestion: verdict }
});

// Deliberately NO 2939 row: the union at the resolution universe must supply it.
const chart = [
  { id: 'acc-bank', code: '1910', name: 'Pankkitili', account_type: 'bank', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: 'asset.cash', status: 'active' },
  { id: 'acc-4400', code: '4400', name: 'Ulkopuoliset palvelut', account_type: 'expense', normal_balance: 'debit', currency: 'EUR', tax_type: null, canonical_role: null, status: 'active' }
];

const fakeClient = ({
  flags = { FINLAND_ALV_CODING: 'auto' },
  transaction = txRow()
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
      // Canonical native-lineage probe observes the same unmarked FI client.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: 'client-1', firm_id: 'firm-1', jurisdiction: 'fi', entity_type: null, profile: { accounting_basis: 'accrual', accounting_system: 'none' }, birth_created_at: null }] };
      if (sql.includes('select jurisdiction, entity_type, profile from clients')) return { rows: [{ jurisdiction: 'fi', entity_type: null, profile: { accounting_basis: 'accrual', accounting_system: 'none' } }] };
      if (sql.includes('select id from transactions')) return { rows: transaction ? [{ id: transaction.id }] : [] };
      if (sql.includes('from audit_events') && sql.trimStart().startsWith('select')) return { rows: [] };
      if (sql.includes('select * from transactions')) return { rows: [transaction] };
      // RT-16: the ONE coding writer's lock read at commit (applyCodingTransition → 'posted').
      if (sql.includes('select coding_state from transactions')) return { rows: [{ coding_state: 'applied' }] };
      if (sql.includes('from transaction_review_queue') && sql.trimStart().startsWith('select')) return { rows: [] };
      if (sql.includes("lower(profile->>'accounting_system')")) return { rows: [{ accounting_system: 'none' }] };
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('select profile from clients')) return { rows: [{ profile: { accounting_basis: 'accrual' } }] };
      if (sql.includes('from reconciliation_matches rm') && sql.includes('join documents d')) return { rows: [] };
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
      if (sql.includes('update client_evidence_requests')) return { rows: [] }; // RT-24: the post resolves the line's open asks
      if (sql.includes('update transaction_review_queue')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: ++auditId }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const post = async (client) => {
  const prepared = await __prepareLedgerTransactionPosting({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-308',
    dryRun: false,
    skipClientCheck: true
  });
  const result = await __commitPreparedLedgerPosting({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    transactionId: 'tx-308',
    prepared,
    actorId: 'operator-1'
  });
  return { prepared, result };
};

// ledger_lines params: [1]=journal_id, [5]=account_code, [9]=debit, [10]=credit, [13]=tax_type
const lineInserts = (client) => client.queries.filter((q) => q.sql.includes('insert into ledger_lines'));

test('the OmaVero settlement posts DR coded 2939 (tax NONE) / CR bank — resolved via the union, never mint-by-name', async () => {
  const client = fakeClient();
  const { prepared } = await post(client);

  assert.equal(prepared.preview.coding.account_code, '2939', 'the verdict resolved to the CODED control account');
  assert.equal(prepared.preview.coding.xero_tax_type, 'NONE', 'the control-account guard posts uncoded');

  const lines = lineInserts(client);
  assert.equal(lines.length, 2, 'two-line journal — the settlement never splits');
  const [settlementLeg, bankLeg] = lines;
  assert.equal(settlementLeg.params[5], '2939');
  assert.equal(Number(settlementLeg.params[9]), 812.4, 'DR 2939 for the gross payment');
  assert.equal(settlementLeg.params[13], 'NONE', 'no ALV code rests on the control account (D-FI3-A5)');
  assert.equal(bankLeg.params[5], '1910');
  assert.equal(Number(bankLeg.params[10]), 812.4, 'CR bank gross');
});

test('even a (wrong) rate-carrying verdict on the control account posts uncoded and unsplit', async () => {
  const client = fakeClient({
    transaction: txRow(settlementVerdict({ tax_treatment: 'ALV 25,5 %' }))
  });
  const { prepared } = await post(client);
  assert.equal(prepared.preview.coding.account_code, '2939');
  assert.equal(prepared.preview.coding.xero_tax_type, 'NONE');
  const lines = lineInserts(client);
  assert.equal(lines.length, 2, 'the guard also kills the would-be split');
  assert.equal(lines[0].params[13], 'NONE');
});

test('flag off: no union, no guard — the verdict mints by name exactly as before this slice', async () => {
  const client = fakeClient({ flags: {} });
  const { prepared } = await post(client);
  assert.notEqual(prepared.preview.coding.account_code, '2939', 'no canonical row injected when the flag is off');
  assert.notEqual(prepared.preview.coding.xero_tax_type, 'NONE');
  const lines = lineInserts(client);
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].params[5], '2939');
});
