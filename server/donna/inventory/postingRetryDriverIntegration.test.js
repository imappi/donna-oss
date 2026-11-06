// Donna Inventory I4·posting — P7 §12 retry re-post, real-Postgres integration (design §19). The
// fake-pg tests prove the drive/classify logic + gate ordering; this proves the driver against the
// real schema + the real P5 executor + the real gateway: a stuck integration-retry attempt, once
// its condition is met, RE-POSTS a real ledger journal at the same (operation, kind, basis) and the
// head flips to posted (so it stops draining); a still-unmet retry appends a fresh tracked attempt
// (advancing exhaustion) and writes no journal. SKIPS unless DATABASE_URL is set, and skips if 080
// isn't migrated. Runs in ONE rolled-back transaction — no trace left.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/postingRetryDriverIntegration.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { driveInventoryWaiterRetriesWithinTransaction } from './postingRetryDriver.js';
import { buildInventoryJournalDraft } from './posting.js';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped' };

const FAR_FUTURE = new Date('2027-01-01T00:00:00Z'); // past any backoff anchor → a retry is DUE

const roleAccounts = {
  'asset.inventory': { role: 'inventory_asset_inventory', code: '1400', name: 'Inventory', canonical_role: 'asset.inventory', normal_balance: 'debit' },
  'liability.grni': { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', normal_balance: 'credit' }
};

// A real, gateway-acceptable receipt draft (DR inventory / CR grni) for the given operation.
const receiptDraft = (operationId) => buildInventoryJournalDraft({
  effect: {
    operationId, effectType: 'receipt', functionalCurrency: 'EUR', dates: { accounting_date: '2026-07-02' },
    legs: [
      { bucket: 'inventory', direction: 'debit', amount: 40 },
      { bucket: 'grni', direction: 'credit', amount: 40 }
    ]
  },
  roleAccounts, valuationRunId: 'vrun-retry'
});

// A still-unmet refusal draft (the domain builder would return this when the condition is not yet
// resolvable) — a tracked integration_system_retry, no journal.
const unmetDraft = (operationId) => ({
  applied: false, operation_id: operationId, posting_kind: 'receipt', valuation_run_id: 'vrun-retry',
  reason: 'missing_close_fx_rate', waiter_type: 'integration_system_retry', detail: { next_action: 'await_fx_fact' }
});

const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-retry';
  const clientId = 'itest-client-inv-retry';
  try {
    await client.query('begin');
    if (!(await client.query("select to_regclass('public.inventory_posting_attempts') as t")).rows[0]?.t) { await client.query('rollback'); return { skipped: '080 not migrated' }; }
    await client.query(`insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`, [firmId, `itest-inv-retry-${firmId}`]);
    await client.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`, [clientId, firmId]);
    const result = await fn({ client, firmId, clientId });
    return { result };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end().catch(() => {});
  }
};

// Seed a stuck integration-retry refusal (the waiter head the driver drains).
const seedStuckRetry = (client, { firmId, clientId, operationId, postingKind = 'receipt' }) =>
  client.query(
    `insert into inventory_posting_attempts
       (firm_id, client_id, operation_id, posting_kind, posting_basis_version, valuation_run_id, outcome,
        waiter_type, reason_code, next_action, actor_id)
     values ($1,$2,$3,$4,1,$5,'refused','integration_system_retry','missing_close_fx_rate','await_fx_fact','itest')
     returning id`,
    [firmId, clientId, operationId, postingKind, `vrun-${operationId}`]
  );

test('P7 §12: a stuck integration-retry re-posts a real journal once its condition is met, then stops draining (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    await seedStuckRetry(client, { firmId, clientId, operationId: 'op-retry' });

    // Drive with the condition NOW MET (rebuild returns the real receipt draft).
    const driven = await driveInventoryWaiterRetriesWithinTransaction(client, {
      firmId, clientId, actorId: 'itest-retry-cron', now: FAR_FUTURE,
      rebuild: ({ item }) => ({ draft: receiptDraft(item.operation_id), valuationIdentity: { valuationRunId: 'vrun-retry' } })
    });

    const posted = (await client.query(
      "select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and operation_id='op-retry' and outcome='posted'",
      [firmId, clientId]
    )).rows[0].n;
    const journals = (await client.query(
      `select count(*)::int n from inventory_posting_journals j
         join inventory_posting_attempts a on a.id = j.posting_attempt_id
        where a.firm_id=$1 and a.client_id=$2 and a.operation_id='op-retry'`,
      [firmId, clientId]
    )).rows[0].n;
    const head = (await client.query(
      "select outcome, waiter_type from inventory_posting_heads where firm_id=$1 and client_id=$2 and operation_id='op-retry' and posting_kind='receipt'",
      [firmId, clientId]
    )).rows[0];

    // Drive again — the head is now posted (not drainable), so nothing is due to re-drive.
    const secondDrive = await driveInventoryWaiterRetriesWithinTransaction(client, {
      firmId, clientId, actorId: 'itest-retry-cron', now: FAR_FUTURE, rebuild: ({ item }) => ({ draft: receiptDraft(item.operation_id) })
    });

    return {
      reposted: driven.summary.reposted, dueRetries: driven.due_retries, ledgerJournalId: driven.results[0]?.ledger_journal_id,
      posted, journals, headOutcome: head?.outcome, headWaiter: head?.waiter_type,
      secondDue: secondDrive.due_retries
    };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.reposted, 1, 'the stuck retry re-posted');
  assert.equal(result.dueRetries, 1);
  assert.ok(result.ledgerJournalId, 'a real ledger journal id came back');
  assert.equal(result.posted, 1, 'a posted attempt now exists for the operation');
  assert.equal(result.journals, 1, 'the posting attempt links a real ledger journal');
  assert.equal(result.headOutcome, 'posted', 'the head flipped to posted');
  assert.equal(result.headWaiter, null, 'the posted head carries no waiter');
  assert.equal(result.secondDue, 0, 'a drained retry does not re-drive — it stops');
});

test('P7 §12: a still-unmet retry appends a fresh tracked attempt (advancing exhaustion), no journal (real Postgres)', opts, async (t) => {
  const { result, skipped } = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    await seedStuckRetry(client, { firmId, clientId, operationId: 'op-unmet' });

    const driven = await driveInventoryWaiterRetriesWithinTransaction(client, {
      firmId, clientId, actorId: 'itest-retry-cron', now: FAR_FUTURE,
      rebuild: ({ item }) => ({ draft: unmetDraft(item.operation_id) })
    });

    const retryCount = (await client.query(
      "select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and operation_id='op-unmet' and waiter_type='integration_system_retry'",
      [firmId, clientId]
    )).rows[0].n;
    const posted = (await client.query(
      "select count(*)::int n from inventory_posting_attempts where firm_id=$1 and client_id=$2 and operation_id='op-unmet' and outcome='posted'",
      [firmId, clientId]
    )).rows[0].n;
    return { stillWaiting: driven.summary.still_waiting, retryCount, posted };
  });
  if (skipped || result?.skipped) return t.skip(skipped || result.skipped);
  assert.equal(result.stillWaiting, 1, 'the unmet retry stays waiting');
  assert.equal(result.retryCount, 2, 'a fresh integration-retry attempt was appended (1 seeded + 1 re-post) — advances exhaustion');
  assert.equal(result.posted, 0, 'no journal posted while the condition is unmet');
});
