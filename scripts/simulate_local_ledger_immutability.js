import assert from 'node:assert/strict';
import { codingStateFromReviewState } from '../server/donna/codingState.js';

import {
  createClientEvidenceRequestInDb,
  createClientInDb,
  createCloseArchiveInDb,
  getClientEvidenceRequestsFromDb,
  getCloseArchivePreviewFromDb,
  getCloseExceptionsFromDb,
  getLedgerPeriodPreviewFromDb,
  lockClosePeriodInDb,
  postLedgerAdjustmentInDb,
  postLedgerPeriodInDb,
  postLedgerTransactionInDb,
  resolveClientEvidenceRequestInDb,
  updateTransactionInDb,
  withFirmDbClient
} from '../server/donna/firmDb.js';

const firmId = 'donna-demo-firm';
const runId = `ledger-sim-${Date.now()}`;
const clientId = runId;
const periodStart = '2026-01-01';
const periodEnd = '2026-01-31';
const adjustmentDate = '2026-02-15';

const log = (step, payload = {}) => {
  console.log(JSON.stringify({ step, ...payload }));
};

const assertRejectsCode = async (fn, code) => {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert(caught, `Expected ${code} to be thrown.`);
  assert.equal(caught.code, code);
  return caught;
};

const seed = async () => {
  await createClientInDb({
    firmId,
    profile: {
      id: clientId,
      companyName: 'Ledger Simulation Pte Ltd',
      uen: 'T26SIM0001A',
      entityType: 'Private Limited Company',
      stage: 'active'
    }
  });

  await withFirmDbClient(async (client) => {
    const connectionId = `${runId}-xero-connection`;
    await client.query(
      `insert into xero_connections (
         id, firm_id, client_id, tenant_id, tenant_name, status, scopes, access_token, refresh_token, expires_at
       )
       values ($1, $2, $3, $4, 'Simulation Xero', 'connected', $5::text[], 'sim-token', 'sim-refresh', now() + interval '1 hour')
       on conflict (id) do nothing`,
      [connectionId, firmId, clientId, `${runId}-tenant`, ['accounting.transactions', 'accounting.settings']]
    );
    const accounts = [
      { id: 'bank-eur', code: 'AWX779', name: 'Airwallex EUR', type: 'BANK', tax_type: 'NONE', payload: { CurrencyCode: 'EUR', AccountID: `${runId}-bank-eur` } },
      { id: 'subs', code: '485', name: 'Subscriptions', type: 'EXPENSE', tax_type: 'INPUTY24', payload: {} },
      { id: 'sales', code: '200', name: 'Sales', type: 'REVENUE', tax_type: 'OUTPUTY24', payload: {} }
    ];
    for (const account of accounts) {
      await client.query(
        `insert into xero_accounts (
           id, connection_id, firm_id, client_id, xero_account_id, code, name, type, status, tax_type, payload
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, $10::jsonb)
         on conflict (id) do nothing`,
        [
          `${runId}-${account.id}`,
          connectionId,
          firmId,
          clientId,
          account.payload.AccountID || `${runId}-${account.id}`,
          account.code,
          account.name,
          account.type,
          account.tax_type,
          JSON.stringify(account.payload)
        ]
      );
    }

    const documentId = `${runId}-statement`;
    await client.query(
      `insert into documents (id, firm_id, client_id, filename, document_type, status, document_date, currency, payload)
       values ($1, $2, $3, 'simulation-statement.pdf', 'bank_statement', 'received', $4, 'EUR', $5::jsonb)`,
      [
        documentId,
        firmId,
        clientId,
        periodStart,
        JSON.stringify({
          period_label: `${periodStart} to ${periodEnd}`,
          statement_currency: 'EUR',
          statement_summary: {
            starting_balance: 1000,
            deposits: 420,
            payouts: 260,
            ending_balance: 1160
          },
          candidate_transaction_count: 7,
          extracted_transaction_count: 7,
          extraction_status: 'validated',
          warnings: []
        })
      ]
    );
    const transactions = [
      {
        id: `${runId}-tx-boundary-start`,
        date: '2026-01-01',
        description: 'Simulation boundary start expense',
        money_out: 40,
        account_code: '485',
        review_state: 'accepted',
        payload: { review_state: 'accepted', account_code: '485', account_name: 'Subscriptions', xero_account_code: '485', xero_tax_type: 'INPUTY24' }
      },
      {
        id: `${runId}-tx-subscription`,
        date: '2026-01-10',
        description: 'Simulation SaaS subscription',
        money_out: 100,
        account_code: '485',
        review_state: 'accepted',
        payload: { review_state: 'accepted', account_code: '485', account_name: 'Subscriptions', xero_account_code: '485', xero_tax_type: 'INPUTY24' }
      },
      {
        id: `${runId}-tx-sale`,
        date: '2026-01-12',
        description: 'Simulation customer receipt',
        money_in: 250,
        account_code: '200',
        review_state: 'accepted',
        payload: { review_state: 'accepted', account_code: '200', account_name: 'Sales', xero_account_code: '200', xero_tax_type: 'OUTPUTY24' }
      },
      {
        id: `${runId}-tx-waiting`,
        date: '2026-01-15',
        description: 'Simulation waiting for client evidence',
        money_out: 55,
        account_code: '485',
        review_state: 'waiting',
        payload: { review_state: 'waiting', account_code: '485', account_name: 'Subscriptions', xero_account_code: '485', xero_tax_type: 'INPUTY24' }
      },
      {
        id: `${runId}-tx-held`,
        date: '2026-01-16',
        description: 'Simulation held by reviewer',
        money_in: 90,
        account_code: '200',
        review_state: 'held',
        payload: { review_state: 'held', account_code: '200', account_name: 'Sales', xero_account_code: '200', xero_tax_type: 'OUTPUTY24' }
      },
      {
        id: `${runId}-tx-atomic-bad`,
        date: '2026-01-20',
        description: 'Simulation invalid row to prove atomic rollback',
        money_out: 0,
        account_code: '485',
        review_state: 'accepted',
        payload: { review_state: 'accepted', account_code: '485', account_name: 'Subscriptions', xero_account_code: '485', xero_tax_type: 'INPUTY24' }
      },
      {
        id: `${runId}-tx-boundary-end`,
        date: '2026-01-31',
        description: 'Simulation boundary end receipt',
        money_in: 80,
        account_code: '200',
        review_state: 'accepted',
        payload: { review_state: 'accepted', account_code: '200', account_name: 'Sales', xero_account_code: '200', xero_tax_type: 'OUTPUTY24' }
      }
    ];
    for (const transaction of transactions) {
      await client.query(
        `insert into transactions (
           id, firm_id, client_id, document_id, transaction_date, description, money_in, money_out, currency,
           status, account_code, reconciliation_status, payload
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'EUR', 'approved', $9, 'explained', $10::jsonb)`,
        [
          transaction.id,
          firmId,
          clientId,
          documentId,
          transaction.date,
          transaction.description,
          transaction.money_in || 0,
          transaction.money_out || 0,
          transaction.account_code,
          JSON.stringify(transaction.payload)
        ]
      );
      // RT-16: the coding state is the transaction's own column.
      await client.query(
        `update transactions set coding_state = $3, coding_state_as_of = now() where firm_id = $1 and id = $2`,
        [firmId, transaction.id, codingStateFromReviewState(transaction.review_state)]
      );
      await client.query(
        `insert into transaction_review_queue (
           id, firm_id, client_id, item_type, item_id, reason, priority, status, payload
         )
         values ($1, $2, $3, 'transaction', $4, 'simulation ledger coding', 'normal', 'open', $5::jsonb)`,
        [
          `${transaction.id}-review`,
          firmId,
          clientId,
          transaction.id,
          JSON.stringify({
            transaction_id: transaction.id,
            account_code: transaction.account_code,
            xero_account_code: transaction.account_code
          })
        ]
      );
    }
  });
};

const cleanup = async () => {
  await withFirmDbClient((client) => client.query('delete from clients where firm_id = $1 and id = $2', [firmId, clientId])).catch(() => {});
};

const main = async () => {
  await cleanup();
  await seed();
  log('seeded', { client_id: clientId });

  const dryRun = await postLedgerTransactionInDb({
    firmId,
    clientId,
    transactionId: `${runId}-tx-subscription`,
    dryRun: true
  });
  assert.equal(dryRun.ledger_posting.source, 'ledger_posting_preview');
  assert.equal(dryRun.ledger_posting.ledger_journal.lines.length, 2);
  log('single_post_preview_ok');

  const postedOne = await postLedgerTransactionInDb({
    firmId,
    clientId,
    transactionId: `${runId}-tx-subscription`,
    dryRun: false
  });
  const originalJournalId = postedOne.ledger_posting.ledger_journal_id;
  assert(originalJournalId);
  log('single_post_execute_ok', { original_journal_id: originalJournalId });

  const periodDryRun = await postLedgerPeriodInDb({
    firmId,
    clientId,
    periodStart,
    periodEnd,
    dryRun: true,
    reviewStates: ['accepted']
  });
  assert.equal(periodDryRun.ledger_period_posting.requested_count, 7);
  assert.equal(periodDryRun.ledger_period_posting.ready_count, 3);
  assert.equal(periodDryRun.ledger_period_posting.skipped_count, 3);
  assert.equal(periodDryRun.ledger_period_posting.error_count, 1);
  assert(periodDryRun.ledger_period_posting.results.some((row) => row.transaction_id === `${runId}-tx-boundary-start` && row.status === 'ready'));
  assert(periodDryRun.ledger_period_posting.results.some((row) => row.transaction_id === `${runId}-tx-boundary-end` && row.status === 'ready'));
  assert(periodDryRun.ledger_period_posting.results.some((row) => row.transaction_id === `${runId}-tx-waiting` && row.status === 'skipped'));
  assert(periodDryRun.ledger_period_posting.results.some((row) => row.transaction_id === `${runId}-tx-held` && row.status === 'skipped'));
  log('period_dry_run_matrix_ok', {
    requested: periodDryRun.ledger_period_posting.requested_count,
    ready: periodDryRun.ledger_period_posting.ready_count,
    skipped: periodDryRun.ledger_period_posting.skipped_count,
    errors: periodDryRun.ledger_period_posting.error_count
  });

  const evidenceRequest = await createClientEvidenceRequestInDb({
    firmId,
    clientId,
    transactionId: `${runId}-tx-waiting`,
    reviewItemId: `${runId}-tx-waiting-review`,
    question: 'Please upload the subscription receipt.',
    evidenceType: 'supporting_document',
    actorId: 'ledger-simulation'
  });
  assert.equal(evidenceRequest.evidence_request.status, 'open');
  const openEvidenceRequests = await getClientEvidenceRequestsFromDb({ firmId, clientId, status: 'open' });
  assert.equal(openEvidenceRequests.counts.open, 1);
  const evidenceExceptions = await getCloseExceptionsFromDb({ firmId, clientId, periodStart, periodEnd });
  const waitingException = evidenceExceptions.exceptions.find((item) => item.transaction_id === `${runId}-tx-waiting`);
  assert.equal(waitingException.evidence_request_id, evidenceRequest.evidence_request.id);
  log('evidence_request_create_ok', { evidence_request_id: evidenceRequest.evidence_request.id });

  const resolvedEvidenceRequest = await resolveClientEvidenceRequestInDb({
    firmId,
    evidenceRequestId: evidenceRequest.evidence_request.id,
    reply: 'Receipt uploaded in client portal.',
    nextReviewState: 'accepted',
    resolutionNote: 'Simulation evidence accepted.',
    actorId: 'ledger-simulation'
  });
  assert.equal(resolvedEvidenceRequest.evidence_request.status, 'resolved');
  const resolvedEvidenceRequests = await getClientEvidenceRequestsFromDb({ firmId, clientId, status: 'resolved' });
  assert.equal(resolvedEvidenceRequests.counts.resolved, 1);
  log('evidence_request_resolve_ok', { evidence_request_id: resolvedEvidenceRequest.evidence_request.id });

  const atomicError = await assertRejectsCode(
    () => postLedgerPeriodInDb({
      firmId,
      clientId,
      periodStart,
      periodEnd,
      dryRun: false,
      reviewStates: ['accepted']
    }),
    'XERO_WRITEBACK_INVALID_PAYLOAD'
  );
  assert.equal(atomicError.details?.ledger_period_posting?.atomic, true);
  const rollbackCheck = await withFirmDbClient((client) =>
    client.query(
      `select source_id
       from ledger_journals
       where firm_id = $1
         and client_id = $2
         and source_type = 'transaction'
         and source_id = any($3::text[])`,
      [
        firmId,
        clientId,
        [
          `${runId}-tx-boundary-start`,
          `${runId}-tx-sale`,
          `${runId}-tx-atomic-bad`
        ]
      ]
    )
  );
  assert.equal(rollbackCheck.rows.length, 0);
  log('period_post_atomic_rollback_ok', {
    code: atomicError.code,
    rolled_back_sources: rollbackCheck.rows.length
  });

  await withFirmDbClient(async (client) => {
    await client.query(
      `update transactions
       set money_out = 65,
           coding_state = 'applied',
           coding_state_as_of = now(),
           updated_at = now()
       where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, `${runId}-tx-atomic-bad`]
    );
    await client.query(
      `update transactions
       set coding_state = 'applied',
           coding_state_as_of = now(),
           updated_at = now()
       where firm_id = $1
         and client_id = $2
         and id = any($3::text[])`,
      [
        firmId,
        clientId,
        [
          `${runId}-tx-waiting`,
          `${runId}-tx-held`,
          `${runId}-tx-atomic-bad`
        ]
      ]
    );
  });
  log('posting_blockers_resolved_for_close_ok');

  const periodPost = await postLedgerPeriodInDb({
    firmId,
    clientId,
    periodStart,
    periodEnd,
    dryRun: false,
    reviewStates: ['accepted']
  });
  assert.equal(periodPost.ledger_period_posting.posted_count, 6);
  assert.equal(periodPost.ledger_period_posting.skipped_count, 1);
  assert.equal(periodPost.ledger_period_posting.error_count, 0);
  log('period_post_ok', {
    posted: periodPost.ledger_period_posting.posted_count,
    skipped: periodPost.ledger_period_posting.skipped_count,
    atomic: periodPost.ledger_period_posting.atomic
  });

  const previewBeforeLock = await getLedgerPeriodPreviewFromDb({ firmId, clientId, periodStart, periodEnd });
  assert.equal(previewBeforeLock.close_preview.lockable, true);
  assert.equal(previewBeforeLock.trial_balance.balanced, true);
  log('period_preview_before_lock_ok', {
    lockable: previewBeforeLock.close_preview.lockable,
    debit: previewBeforeLock.trial_balance.total_debit,
    credit: previewBeforeLock.trial_balance.total_credit
  });

  const lock = await lockClosePeriodInDb({ firmId, clientId, periodStart, periodEnd, actorId: 'ledger-simulation' });
  assert.equal(lock.close_lock.status, 'locked');
  log('lock_ok', { close_period_id: lock.close_lock.close_period_id });

  const lockAgain = await lockClosePeriodInDb({ firmId, clientId, periodStart, periodEnd, actorId: 'ledger-simulation' });
  assert.equal(lockAgain.close_lock.status, 'locked');
  assert.equal(lockAgain.close_lock.close_period_id, lock.close_lock.close_period_id);
  assert.equal(lockAgain.close_lock.idempotent, true);
  assert.equal(lockAgain.close_lock.locked_at, lock.close_lock.locked_at);
  log('lock_idempotency_ok', { close_period_id: lockAgain.close_lock.close_period_id });

  const repostError = await assertRejectsCode(
    () => postLedgerTransactionInDb({
      firmId,
      clientId,
      transactionId: `${runId}-tx-subscription`,
      dryRun: false,
      force: true
    }),
    'LEDGER_LOCKED_PERIOD_IMMUTABLE'
  );
  log('locked_repost_blocked_ok', { code: repostError.code });

  const directEditError = await assertRejectsCode(
    () => updateTransactionInDb({
      firmId,
      transactionId: `${runId}-tx-subscription`,
      patch: { account_code: '200', account_name: 'Sales' }
    }),
    'LEDGER_LOCKED_TRANSACTION_IMMUTABLE'
  );
  log('locked_transaction_edit_blocked_ok', { code: directEditError.code });

  const lockedAdjustmentDateError = await assertRejectsCode(
    () => postLedgerAdjustmentInDb({
      firmId,
      clientId,
      originalJournalId,
      journalDate: '2026-01-20',
      reason: 'Simulation should reject same-period correction.',
      actorId: 'ledger-simulation'
    }),
    'LEDGER_ADJUSTMENT_DATE_LOCKED'
  );
  log('locked_adjustment_date_blocked_ok', { code: lockedAdjustmentDateError.code });

  const adjustment = await postLedgerAdjustmentInDb({
    firmId,
    clientId,
    originalJournalId,
    journalDate: adjustmentDate,
    reason: 'Simulation corrected subscription from 100 to 120 after lock.',
    actorId: 'ledger-simulation',
    lines: [
      { account_code: '485', account_name: 'Subscriptions', account_type: 'expense', normal_balance: 'debit', debit: 120, currency: 'EUR', tax_type: 'INPUTY24' },
      { account_code: 'AWX779', account_name: 'Airwallex EUR', account_type: 'bank', normal_balance: 'debit', credit: 120, currency: 'EUR', tax_type: 'NONE' }
    ]
  });
  assert.equal(adjustment.ledger_adjustment.journals.length, 2);
  assert.deepEqual(adjustment.ledger_adjustment.journals.map((journal) => journal.correction_type), ['reversal', 'replacement']);
  log('post_close_adjustment_ok', {
    journals: adjustment.ledger_adjustment.journals.map((journal) => journal.ledger_journal_id)
  });

  const febPreview = await getLedgerPeriodPreviewFromDb({
    firmId,
    clientId,
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28'
  });
  assert.equal(febPreview.trial_balance.balanced, true);
  assert.equal(febPreview.profit_and_loss.expenses, 20);
  log('adjustment_period_preview_ok', {
    feb_expenses: febPreview.profit_and_loss.expenses,
    balanced: febPreview.trial_balance.balanced
  });

  const exceptions = await getCloseExceptionsFromDb({ firmId, clientId, periodStart, periodEnd });
  assert.equal(exceptions.counts.blockers, 0);
  log('exceptions_ok', { total: exceptions.counts.total, blockers: exceptions.counts.blockers });

  const archivePreview = await getCloseArchivePreviewFromDb({ firmId, clientId, periodStart, periodEnd, actorId: 'ledger-simulation' });
  assert.equal(archivePreview.manifest.files.length, 8);
  assert.equal(archivePreview.sections.close.exceptions.counts.blockers, 0);
  log('archive_preview_ok', { archive_id: archivePreview.archive_id, files: archivePreview.manifest.files.length });

  const archive = await createCloseArchiveInDb({ firmId, clientId, periodStart, periodEnd, actorId: 'ledger-simulation' });
  assert.equal(archive.close_archive.status, 'generated');
  assert.equal(archive.close_archive.archive_id, archivePreview.archive_id);
  log('archive_create_ok', { archive_id: archive.close_archive.archive_id });

  await cleanup();
  log('cleanup_ok', { client_id: clientId });
  log('simulation_passed');
};

main().catch(async (error) => {
  console.error(JSON.stringify({
    step: 'simulation_failed',
    message: error.message,
    code: error.code || null,
    details: error.details || null,
    stack: error.stack
  }, null, 2));
  await cleanup();
  process.exit(1);
});
