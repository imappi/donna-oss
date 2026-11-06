import assert from 'node:assert/strict';
import { applyCodingTransition, codingStateFromReviewState } from '../server/donna/codingState.js';
import crypto from 'node:crypto';

import {
  DEFAULT_FIRM_ID,
  acceptClientEvidenceRequestInDb,
  createClientEvidenceRequestInDb,
  createClientInDb,
  createCloseArchiveInDb,
  getClientEvidenceRequestsFromDb,
  getCloseArchiveExportFromDb,
  getCloseDiagnosticsFromDb,
  getCloseExceptionsFromDb,
  getLedgerPeriodPreviewFromDb,
  isFirmDatabaseConfigured,
  lockClosePeriodInDb,
  postLedgerPeriodInDb,
  rejectClientEvidenceRequestInDb,
  resolveClientEvidenceRequestInDb,
  syncDocumentsAndTransactionsInDb,
  withFirmDbClient
} from '../server/donna/firmDb.js';
import { buildXeroMirrorVerificationResult } from '../server/donna/xeroMirrorVerification.js';

const firmId = process.env.DONNA_E2E_FIRM_ID || DEFAULT_FIRM_ID;
const runId = `close-e2e-${Date.now()}`;
const clientId = runId;
const periodStart = '2026-03-01';
const periodEnd = '2026-03-31';
const actorId = 'synthetic-close-e2e';

const log = (step, payload = {}) => {
  console.log(JSON.stringify({ step, ...payload }));
};

const ensureFirm = async () => {
  await withFirmDbClient((client) =>
    client.query(
      `insert into firms (id, name, slug, jurisdiction, default_currency, metadata)
       values ($1, 'Synthetic Close E2E Firm', 'synthetic-close-e2e', 'SG', 'EUR', $2::jsonb)
       on conflict (id) do update set
         name = excluded.name,
         metadata = firms.metadata || excluded.metadata,
         updated_at = now()`,
      [firmId, JSON.stringify({ synthetic_e2e: true })]
    )
  );
};

const cleanup = async () => {
  await withFirmDbClient((client) =>
    client.query('delete from clients where firm_id = $1 and id = $2', [firmId, clientId])
  ).catch(() => {});
};

const seedXeroMirrorScaffold = async () => {
  await withFirmDbClient(async (client) => {
    const connectionId = `${runId}-xero-connection`;
    await client.query(
      `insert into xero_connections (
         id, firm_id, client_id, tenant_id, tenant_name, status, scopes, access_token, refresh_token, expires_at
       )
       values ($1, $2, $3, $4, 'Synthetic Xero Mirror', 'connected', $5::text[], 'synthetic-token', 'synthetic-refresh', now() + interval '1 hour')
       on conflict (id) do update set
         status = excluded.status,
         scopes = excluded.scopes,
         expires_at = excluded.expires_at,
         updated_at = now()`,
      [
        connectionId,
        firmId,
        clientId,
        `${runId}-tenant`,
        ['accounting.transactions', 'accounting.banktransactions', 'accounting.settings']
      ]
    );

    const accounts = [
      { id: 'bank', code: 'AWX779', name: 'Airwallex EUR', type: 'BANK', tax_type: 'NONE', account_id: `${runId}-bank` },
      { id: 'software', code: '485', name: 'Software subscriptions', type: 'EXPENSE', tax_type: 'INPUTY24' },
      { id: 'travel', code: '493', name: 'Travel and meals', type: 'EXPENSE', tax_type: 'INPUTY24' },
      { id: 'sales', code: '200', name: 'Consulting revenue', type: 'REVENUE', tax_type: 'OUTPUTY24' }
    ];
    for (const account of accounts) {
      await client.query(
        `insert into xero_accounts (
           id, connection_id, firm_id, client_id, xero_account_id, code, name, type, status, tax_type, payload
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, $10::jsonb)
         on conflict (id) do update set
           code = excluded.code,
           name = excluded.name,
           type = excluded.type,
           status = excluded.status,
           tax_type = excluded.tax_type,
           payload = excluded.payload,
           updated_at = now()`,
        [
          `${runId}-${account.id}`,
          connectionId,
          firmId,
          clientId,
          account.account_id || `${runId}-${account.id}`,
          account.code,
          account.name,
          account.type,
          account.tax_type,
          JSON.stringify({
            AccountID: account.account_id || `${runId}-${account.id}`,
            Code: account.code,
            Name: account.name,
            Type: account.type,
            TaxType: account.tax_type
          })
        ]
      );
    }
  });
};

const statementDocumentId = `${runId}-statement-mar`;
const evidenceDocumentId = `${runId}-receipt`;

const sourceDocument = {
  id: statementDocumentId,
  client_id: clientId,
  filename: 'synthetic-airwallex-eur-mar-2026.pdf',
  document_type: 'bank_statement',
  status: 'received',
  source: 'client_portal',
  document_date: periodStart,
  statement_currency: 'EUR',
  currency: 'EUR',
  period_label: `${periodStart} to ${periodEnd}`,
  statement_summary: {
    starting_balance: 1000,
    deposits: 500,
    payouts: 275,
    ending_balance: 1225
  },
  candidate_transaction_count: 5,
  extracted_transaction_count: 5,
  extraction_status: 'validated',
  warnings: []
};

const sourceTransactions = [
  {
    id: `${runId}-tx-clean-software`,
    client_id: clientId,
    document_id: statementDocumentId,
    date: '2026-03-03',
    description: 'Notion subscription',
    money_out: 100,
    account_currency: 'EUR',
    status: 'ready',
    account_code: '485',
    category: 'Software subscriptions',
    reconciliation_status: 'explained',
    review_state: 'accepted',
    xero_account_code: '485',
    xero_tax_type: 'INPUTY24'
  },
  {
    id: `${runId}-tx-client-ask`,
    client_id: clientId,
    document_id: statementDocumentId,
    date: '2026-03-08',
    description: 'Founder card charge at airport',
    money_out: 55,
    account_currency: 'EUR',
    status: 'needs_review',
    account_code: '493',
    category: 'Travel and meals',
    reconciliation_status: 'needs_evidence',
    review_state: 'waiting',
    xero_account_code: '493',
    xero_tax_type: 'INPUTY24'
  },
  {
    id: `${runId}-tx-clean-revenue`,
    client_id: clientId,
    document_id: statementDocumentId,
    date: '2026-03-12',
    description: 'Client retainer receipt',
    money_in: 500,
    account_currency: 'EUR',
    status: 'ready',
    account_code: '200',
    category: 'Consulting revenue',
    reconciliation_status: 'explained',
    review_state: 'accepted',
    xero_account_code: '200',
    xero_tax_type: 'OUTPUTY24'
  },
  {
    id: `${runId}-tx-review-hold`,
    client_id: clientId,
    document_id: statementDocumentId,
    date: '2026-03-19',
    description: 'Reviewer held team lunch',
    money_out: 80,
    account_currency: 'EUR',
    status: 'needs_review',
    account_code: '493',
    category: 'Travel and meals',
    reconciliation_status: 'held',
    review_state: 'held',
    xero_account_code: '493',
    xero_tax_type: 'INPUTY24'
  },
  {
    id: `${runId}-tx-boundary-close`,
    client_id: clientId,
    document_id: statementDocumentId,
    date: '2026-03-31',
    description: 'Month-end software charge',
    money_out: 40,
    account_currency: 'EUR',
    status: 'ready',
    account_code: '485',
    category: 'Software subscriptions',
    reconciliation_status: 'explained',
    review_state: 'accepted',
    xero_account_code: '485',
    xero_tax_type: 'INPUTY24'
  }
];

const seedIntake = async () => {
  await createClientInDb({
    firmId,
    profile: {
      id: clientId,
      companyName: 'Synthetic Close Journey Pte Ltd',
      uen: '202600001E',
      entityType: 'Private Limited Company',
      incorporationDate: '2026-01-15',
      stage: 'active'
    }
  });
  await seedXeroMirrorScaffold();
  await syncDocumentsAndTransactionsInDb({
    firmId,
    documents: [sourceDocument],
    transactions: sourceTransactions.map((transaction) => ({
      ...transaction,
      payload: {
        ...transaction,
        review_state: transaction.review_state,
        account_name: transaction.category,
        account_label: `${transaction.account_code} · ${transaction.category}`,
        proposed_account: transaction.account_code,
        xero_account_code: transaction.xero_account_code,
        xero_tax_type: transaction.xero_tax_type,
        support_status: transaction.review_state === 'waiting' ? 'client_required' : 'sufficient'
      }
    }))
  });
  await withFirmDbClient(async (client) => {
    for (const transaction of sourceTransactions) {
      // RT-16: the coding state is the transaction's own column.
      await client.query(
        `update transactions set coding_state = $3, coding_state_as_of = now() where firm_id = $1 and id = $2`,
        [firmId, transaction.id, codingStateFromReviewState(transaction.review_state)]
      );
      await client.query(
        `insert into transaction_review_queue (
           id, firm_id, client_id, item_type, item_id, reason, priority, status, payload
         )
         values ($1, $2, $3, 'transaction', $4, 'synthetic close journey', 'normal', 'open', $5::jsonb)
         on conflict (firm_id, client_id, item_type, item_id, reason) do update set
           status = 'open',
           payload = excluded.payload,
           updated_at = now()`,
        [
          `${transaction.id}-review`,
          firmId,
          clientId,
          transaction.id,
          JSON.stringify({
            transaction_id: transaction.id,
            account_code: transaction.account_code,
            account_name: transaction.category,
            account_label: `${transaction.account_code} · ${transaction.category}`,
            xero_account_code: transaction.xero_account_code,
            xero_tax_type: transaction.xero_tax_type
          })
        ]
      );
    }
  });
};

const seedEvidenceDocument = async ({ evidenceRequestId }) => {
  await withFirmDbClient((client) =>
    client.query(
      `insert into documents (
         id, firm_id, client_id, filename, document_type, status, uploaded_at,
         source, file_url, total_amount, currency, reference_number, payload
       )
       values ($1, $2, $3, 'airport-meal-receipt.pdf', 'receipt', 'received', now(),
         'client_portal', null, 55, 'EUR', 'SYN-RECEIPT-001', $4::jsonb)
       on conflict (id) do update set
         status = excluded.status,
         payload = excluded.payload,
         updated_at = now()`,
      [
        evidenceDocumentId,
        firmId,
        clientId,
        JSON.stringify({
          evidence_request_id: evidenceRequestId,
          evidence_context: { request_id: evidenceRequestId, transaction_id: `${runId}-tx-client-ask` },
          storage_bucket: 'donna-evidence',
          storage_key: `${firmId}/${clientId}/evidence/${evidenceRequestId}/airport-meal-receipt.pdf`,
          file_storage: {
            provider: 'supabase_storage',
            bucket: 'donna-evidence',
            key: `${firmId}/${clientId}/evidence/${evidenceRequestId}/airport-meal-receipt.pdf`,
            checksum_sha256: crypto.createHash('sha256').update(`${runId}:receipt`).digest('hex')
          }
        })
      ]
    )
  );
};

const acceptReviewerHold = async () => {
  await withFirmDbClient(async (client) => {
    await applyCodingTransition(client, { firmId, clientId, transactionId: `${runId}-tx-review-hold`, to: 'applied' });
    await client.query(
      `update transaction_review_queue
       set payload = payload || $4::jsonb,
           updated_at = now()
       where firm_id = $1 and client_id = $2 and item_id = $3`,
      [
        firmId,
        clientId,
        `${runId}-tx-review-hold`,
        JSON.stringify({
          reviewer_note: 'Synthetic reviewer cleared lunch as business travel support.'
        })
      ]
    );
  });
};

const markMirrorExported = async () => {
  await withFirmDbClient(async (client) => {
    const result = await client.query(
      `select *
       from transactions
       where firm_id = $1 and client_id = $2
       order by transaction_date, created_at`,
      [firmId, clientId]
    );
    for (const row of result.rows) {
      const payload = row.payload || {};
      const xeroId = `${runId}-xero-${row.id.split('-').at(-1)}`;
      await client.query(
        `update transactions
         set payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1 and client_id = $2 and id = $3`,
        [
          firmId,
          clientId,
          row.id,
          JSON.stringify({
            xero_bank_transaction_id: xeroId,
            xero_writeback_status: 'exported',
            xero_synced_at: new Date().toISOString(),
            xero_account_code: payload.xero_account_code || payload.account_code || row.account_code || null,
            xero_amount: Number(row.money_in || row.money_out || 0)
          })
        ]
      );
    }
  });
};

const fakeXeroBankTransaction = ({ transaction, accountCode, total }) => ({
  BankTransactionID: transaction.xero_bank_transaction_id,
  DateString: transaction.date,
  Status: 'AUTHORISED',
  Total: total,
  BankAccount: { Code: 'AWX779', Name: 'Airwallex EUR' },
  LineItems: [
    {
      AccountCode: accountCode,
      TaxType: transaction.xero_tax_type || transaction.payload?.xero_tax_type || 'NONE',
      LineAmount: total
    }
  ]
});

const runMockMirrorVerification = async () => {
  const rows = await withFirmDbClient(async (client) => {
    const result = await client.query(
      `select *
       from transactions
       where firm_id = $1 and client_id = $2
       order by transaction_date, created_at`,
      [firmId, clientId]
    );
    return result.rows.map((row) => ({ ...(row.payload || {}), id: row.id, date: row.transaction_date, money_in: Number(row.money_in || 0), money_out: Number(row.money_out || 0), account_code: row.account_code }));
  });
  const okTransaction = rows.find((row) => row.id.endsWith('tx-clean-software'));
  const driftTransaction = rows.find((row) => row.id.endsWith('tx-client-ask'));
  const missingTransaction = rows.find((row) => row.id.endsWith('tx-boundary-close'));
  const ok = buildXeroMirrorVerificationResult({
    transaction: okTransaction,
    expectedBankTransaction: fakeXeroBankTransaction({
      transaction: okTransaction,
      accountCode: okTransaction.xero_account_code || okTransaction.account_code,
      total: 100
    }),
    xeroResponse: {
      BankTransactions: [
        fakeXeroBankTransaction({
          transaction: okTransaction,
          accountCode: okTransaction.xero_account_code || okTransaction.account_code,
          total: 100
        })
      ]
    }
  });
  const drift = buildXeroMirrorVerificationResult({
    transaction: driftTransaction,
    expectedBankTransaction: fakeXeroBankTransaction({
      transaction: driftTransaction,
      accountCode: driftTransaction.xero_account_code || driftTransaction.account_code,
      total: 55
    }),
    xeroResponse: {
      BankTransactions: [
        fakeXeroBankTransaction({
          transaction: driftTransaction,
          accountCode: '485',
          total: 65
        })
      ]
    }
  });
  const missing = buildXeroMirrorVerificationResult({
    transaction: missingTransaction,
    expectedBankTransaction: fakeXeroBankTransaction({
      transaction: missingTransaction,
      accountCode: missingTransaction.xero_account_code || missingTransaction.account_code,
      total: 40
    }),
    xeroResponse: { BankTransactions: [] }
  });
  return {
    source: 'synthetic_xero_mirror_verification',
    source_of_truth: false,
    note: 'Synthetic Xero verification uses fake mirror responses. Donna ledger remains the accounting source of truth.',
    results: [ok, drift, missing],
    counts: {
      mirror_ok: [ok, drift, missing].filter((item) => item.status === 'mirror_ok').length,
      mirror_missing: [ok, drift, missing].filter((item) => item.status === 'mirror_missing').length,
      mirror_drift: [ok, drift, missing].filter((item) => item.status === 'mirror_drift').length,
      mirror_error: [ok, drift, missing].filter((item) => item.status === 'mirror_error').length
    }
  };
};

const main = async () => {
  if (!isFirmDatabaseConfigured()) {
    throw new Error('Firm database is not configured. Set DATABASE_URL or provide .env before running synthetic close E2E.');
  }

  await cleanup();
  await ensureFirm();
  await seedIntake();
  log('client_intake_seeded', { client_id: clientId, period_start: periodStart, period_end: periodEnd });

  const diagnostics = await getCloseDiagnosticsFromDb({ firmId, clientId, periodStart, periodEnd });
  assert.equal(diagnostics.source_import.status, 'passed');
  assert.equal(diagnostics.source_import.statement_proof.status, 'passed');
  assert.equal(diagnostics.source_import.transaction_count, 5);
  log('source_import_proof_ok', {
    statement_status: diagnostics.source_import.statement_proof.status,
    transactions: diagnostics.source_import.transaction_count
  });

  const initialDryRun = await postLedgerPeriodInDb({ firmId, clientId, periodStart, periodEnd, dryRun: true });
  assert.equal(initialDryRun.ledger_period_posting.ready_count, 3);
  assert.equal(initialDryRun.ledger_period_posting.skipped_count, 2);
  log('admin_reconcile_dry_run_ok', {
    ready: initialDryRun.ledger_period_posting.ready_count,
    skipped: initialDryRun.ledger_period_posting.skipped_count
  });

  const requestResult = await createClientEvidenceRequestInDb({
    firmId,
    clientId,
    transactionId: `${runId}-tx-client-ask`,
    reviewItemId: `${runId}-tx-client-ask-review`,
    question: 'Please confirm the business purpose and upload the receipt for the airport charge.',
    evidenceType: 'receipt',
    dueAt: '2026-04-05T00:00:00.000Z',
    actorId
  });
  const evidenceRequestId = requestResult.evidence_request.id;
  assert.equal(requestResult.evidence_request.status, 'open');
  log('firm_ask_created_ok', { evidence_request_id: evidenceRequestId });

  const firstReply = await resolveClientEvidenceRequestInDb({
    firmId,
    evidenceRequestId,
    reply: 'It was during the client trip, but I forgot to attach the receipt.',
    actorId: 'client-synthetic'
  });
  assert.equal(firstReply.evidence_request.status, 'replied');
  const repliedExceptions = await getCloseExceptionsFromDb({ firmId, clientId, periodStart, periodEnd });
  const repliedException = repliedExceptions.exceptions.find((item) => item.transaction_id === `${runId}-tx-client-ask`);
  assert.equal(repliedException?.type, 'waiting_for_client');
  assert.equal(repliedException?.evidence_request_status, 'replied');
  log('client_reply_waits_for_firm_review_ok');

  const reask = await rejectClientEvidenceRequestInDb({
    firmId,
    evidenceRequestId,
    rejectionReason: 'Need the receipt image or PDF before accepting this evidence.',
    followUpQuestion: 'Please upload the airport receipt and add one sentence on business purpose.',
    dueAt: '2026-04-07T00:00:00.000Z',
    actorId
  });
  assert.equal(reask.evidence_request.status, 'open');
  log('firm_reask_ok', { evidence_request_id: evidenceRequestId });

  await seedEvidenceDocument({ evidenceRequestId });
  const secondReply = await resolveClientEvidenceRequestInDb({
    firmId,
    evidenceRequestId,
    reply: 'Attached receipt. Meal was during the Singapore investor meeting trip.',
    documentIds: [evidenceDocumentId],
    actorId: 'client-synthetic'
  });
  assert.equal(secondReply.evidence_request.status, 'replied');
  assert.deepEqual(secondReply.evidence_request.response_payload.document_ids, [evidenceDocumentId]);
  log('client_reply_with_evidence_ok', { document_id: evidenceDocumentId });

  const accepted = await acceptClientEvidenceRequestInDb({
    firmId,
    evidenceRequestId,
    resolutionNote: 'Firm accepted receipt and business-purpose explanation.',
    actorId
  });
  assert.equal(accepted.evidence_request.status, 'resolved');
  const evidenceRequests = await getClientEvidenceRequestsFromDb({ firmId, clientId });
  assert.equal(evidenceRequests.counts.resolved, 1);
  log('firm_accepts_evidence_ok');

  await acceptReviewerHold();
  const post = await postLedgerPeriodInDb({ firmId, clientId, periodStart, periodEnd, dryRun: false });
  assert.equal(post.ledger_period_posting.posted_count, 5);
  assert.equal(post.ledger_period_posting.error_count, 0);
  assert.equal(post.ledger_period_posting.atomic, true);
  log('native_ledger_posting_ok', { posted: post.ledger_period_posting.posted_count });

  const beforeMirrorExceptions = await getCloseExceptionsFromDb({ firmId, clientId, periodStart, periodEnd });
  assert.equal(beforeMirrorExceptions.counts.blockers, 0);
  assert.equal(beforeMirrorExceptions.counts.by_type.xero_mirror_missing, 5);
  log('mirror_missing_is_warning_only_ok', {
    blockers: beforeMirrorExceptions.counts.blockers,
    missing_mirror: beforeMirrorExceptions.counts.by_type.xero_mirror_missing
  });

  await markMirrorExported();
  const afterMirrorDiagnostics = await getCloseDiagnosticsFromDb({ firmId, clientId, periodStart, periodEnd });
  assert.equal(afterMirrorDiagnostics.xero_mirror_diff.counts.exported, 5);
  assert.equal(afterMirrorDiagnostics.xero_mirror_diff.status, 'passed');
  const mockMirrorVerification = await runMockMirrorVerification();
  assert.deepEqual(mockMirrorVerification.counts, {
    mirror_ok: 1,
    mirror_missing: 1,
    mirror_drift: 1,
    mirror_error: 0
  });
  log('xero_mirror_mock_verification_ok', mockMirrorVerification.counts);

  const preview = await getLedgerPeriodPreviewFromDb({ firmId, clientId, periodStart, periodEnd });
  assert.equal(preview.close_preview.lockable, true);
  assert.equal(preview.close_preview.checks.find((check) => check.check_type === 'source_import')?.status, 'passed');
  assert.equal(preview.close_preview.checks.find((check) => check.check_type === 'posting_completeness')?.status, 'passed');
  log('close_preview_lockable_ok');

  const lock = await lockClosePeriodInDb({ firmId, clientId, periodStart, periodEnd, actorId });
  assert.equal(lock.close_lock.status, 'locked');
  log('close_lock_ok', { close_period_id: lock.close_lock.close_period_id });

  const archive = await createCloseArchiveInDb({ firmId, clientId, periodStart, periodEnd, actorId });
  assert.equal(archive.close_archive.status, 'generated');
  assert.equal(archive.close_archive.sections.source.import_diagnostics.status, 'passed');
  assert.equal(archive.close_archive.sections.close.exceptions.counts.blockers, 0);
  log('close_archive_generated_ok', {
    archive_id: archive.close_archive.archive_id,
    files: archive.close_archive.manifest.files.length
  });

  const exportBundle = await getCloseArchiveExportFromDb({
    firmId,
    clientId,
    archiveId: archive.close_archive.archive_id,
    actorId
  });
  assert.equal(exportBundle.handoff.status, 'delivered');
  assert.equal(exportBundle.handoff.integrity_check.status, 'passed');
  assert(exportBundle.bundle_checksum_sha256);
  assert(exportBundle.files['manifest.json']);
  assert(exportBundle.files['ledger.json']);
  assert(exportBundle.files['source.json']);
  assert(exportBundle.files['xero_mirror.json']);
  log('close_archive_export_handoff_ok', {
    filename: exportBundle.filename,
    checksum: exportBundle.bundle_checksum_sha256.slice(0, 12)
  });

  await cleanup();
  log('cleanup_ok', { client_id: clientId });
  log('synthetic_close_e2e_passed');
};

main().catch(async (error) => {
  console.error(JSON.stringify({
    step: 'synthetic_close_e2e_failed',
    message: error.message,
    code: error.code || null,
    details: error.details || null,
    stack: error.stack
  }, null, 2));
  await cleanup();
  process.exit(1);
});
