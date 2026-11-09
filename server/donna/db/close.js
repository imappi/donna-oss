import { lockClientCloseBoundaryWithClient } from './closeSerialization.js';
// server/donna/db/close.js — plane S — close: diagnostics, exceptions, the period preview, financial reports, the close archive, fiscal years and periods, close checks and the period lock.
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move.
// Public symbols retain their import paths through firmDb.js. Wave 6 moves
// country operations behind named registries; shared writers retain persistence.

import { readClosePolicyWithClient, resolveClosePolicy, retainedArchivePolicies, hasActingRetentionPolicy } from '../closePolicyRegistry.js';

import { lifecycleJurisdiction } from '../countryLifecycleContext.js';

import { toIsoDay } from '../dates.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { FISCAL_PERIOD_INTAKE_FLAG_KEY, planFiscalPeriodRegistration, statutoryBoundProvenanceFor } from '../fiscalPeriodIntake.js';
// G-13 (FI-15) — the statement-coverage close gate flag (D-P2-6); the option it
// arms lives in sourceImportCompleteness.js and is threaded via the read model.
import { FINLAND_STATEMENT_COVERAGE_GATE_FLAG_KEY } from '../sourceImportCompleteness.js';
import { listCloseBlockersForClient } from '../caseManager.js';
import { ledgerDateOnly } from '../ledger.js';
import { buildFinancialReport, buildLedgerPeriodReadModel, normalizeLedgerPeriod } from '../ledgerReadModel.js';
import { buildProcountorExportPackage } from '../procountorExportPackage.js';
import { buildCloseDiagnostics, buildCloseExceptions } from '../ledgerDiagnostics.js';
import { buildCloseArchiveExportBundle, buildCloseArchivePackage, CLOSE_ARCHIVE_SCHEMA_VERSION } from '../closeArchive.js';

import { queryFirmDb, queryOptionalFirmDb, withFirmDbClient } from './pool.js';
import { evaluateRetainedProcessingScopeWithClient, recordEntityReadinessBlockedWithClient, EntityReadinessAdmissionError } from '../runtimeReadinessAdmission.js';
import { DEFAULT_FIRM_ID, requireClientInFirm } from './clients.js';
import { rowToDocumentPayload } from './documents.js';
import { rowToTransactionPayload } from './transactions.js';
import { REVIEW_QUEUE_WITH_CODING_STATE_SQL, rowToTransactionReviewPayload } from './coding.js';
import { rowToClientEvidenceRequestPayload } from './asks.js';
import { ledgerRecordId, rowToLedgerAccountPayload, rowToLedgerJournalPayload, rowToLedgerLinePayload } from './ledger.js';
import { getFirmSnapshotFromDb } from './snapshot.js';
import { readRecognitionGapWithClient, recognitionDraftReason } from '../salesRecognitionGap.js';

// Snapshot shape for a close_periods row: the row as stored, with the two
// `date` columns normalized to calendar-day strings (see
// rowToTransactionPayload's date note — the raw pg Date serializes shifted
// on a non-UTC host, which is how a January period rendered under December
// on the 2026-08-26 stage-C canary).
export const rowToClosePeriodPayload = (row = {}) => ({
  ...row,
  period_start: row.period_start ? toIsoDay(row.period_start) : null,
  period_end: row.period_end ? toIsoDay(row.period_end) : null
});

export const rowToCloseArchivePayload = (row = {}) => ({
  id: row.id,
  firm_id: row.firm_id,
  client_id: row.client_id,
  // toIsoDay — date columns; see rowToTransactionPayload's date note.
  period_start: row.period_start ? toIsoDay(row.period_start) : null,
  period_end: row.period_end ? toIsoDay(row.period_end) : null,
  status: row.status,
  schema_version: row.schema_version,
  manifest_checksum: row.manifest_checksum,
  manifest: row.manifest || {},
  generated_by: row.generated_by,
  generated_at: row.generated_at ? new Date(row.generated_at).toISOString() : null,
  storage_status: row.storage_status,
  storage_destination: row.storage_destination,
  export_handoff: row.payload?.export_handoff || null,
  payload: row.payload || {},
  created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
});

// G-9 (D-G9-3) — the KPL 2:10 retention guard shared by the two hard-delete
// writers. Returns null when FINLAND_TILIKAUSI does not act for the client
// (zero behavior change off-Finland), when the fiscal_years table predates
// migration 063, or when nothing is held; otherwise the held fiscal-year rows
// with their retain-until dates for the given retention class. `onDate`
// narrows to the fiscal year containing that date (the document guard);
// without it every non-open fiscal year is considered (the client guard).

export const __heldFiscalYearsForRetention = async (client, args = {}) => {
  if (!args.clientId) return null;
  const { policy } = await readClosePolicyWithClient({ client, ...args });
  if (policy?.heldFiscalYearsForRetention) return policy.heldFiscalYearsForRetention(client, args);
  const snapshot = await readClientConfigSnapshot(client, args);
  if (!hasActingRetentionPolicy(snapshot)) return null;
  const archives = await client.query(
    `select payload->'sections'->'period'->'retention' as retention from close_archives
      where firm_id = $1 and client_id = $2 and payload->'sections'->'period'->'retention' is not null`,
    [args.firmId, args.clientId]
  );
  const held = [];
  for (const { policy: retainedPolicy, starts } of retainedArchivePolicies(archives.rows.map(row => row.retention))) {
    held.push(...(await retainedPolicy.heldFiscalYearsForRetention(client, { ...args, retainedFiscalStarts: starts }) || []));
  }
  if (held.length) return held;
  // A cleared/conflicting identity cannot turn an active retained-book guard
  // into permission to destroy a closed book whose policy cannot be recovered.
  if (!policy) {
    const closed = await client.query("select 1 from fiscal_years where firm_id=$1 and client_id=$2 and status <> 'open' limit 1", [args.firmId, args.clientId]);
    if (closed.rows.length) throw Object.assign(new Error('Restore the retained book country context before deleting statutory evidence.'), { statusCode: 409, code: 'RETENTION_POLICY_CONTEXT_REQUIRED' });
  }
  return null;
};

export const getCloseDiagnosticsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for close diagnostics.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const documentsResult = await client.query(
      `select *
       from documents
       where firm_id = $1
         and client_id = $2
       order by uploaded_at nulls last, created_at`,
      [firmId, clientId]
    );
    const transactionsResult = await client.query(
      `select *
       from transactions
       where firm_id = $1
         and client_id = $2
         and transaction_date >= $3
         and transaction_date <= $4
       order by transaction_date, created_at`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    return buildCloseDiagnostics({
      clientId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      documents: documentsResult.rows.map(rowToDocumentPayload),
      transactions: transactionsResult.rows.map(rowToTransactionPayload)
    });
  });
};

export const getCloseExceptionsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for close exceptions.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const documentsResult = await client.query(
      `select *
       from documents
       where firm_id = $1
         and client_id = $2
       order by uploaded_at nulls last, created_at`,
      [firmId, clientId]
    );
    const transactionsResult = await client.query(
      `select *
       from transactions
       where firm_id = $1
         and client_id = $2
         and transaction_date >= $3
         and transaction_date <= $4
       order by transaction_date, created_at`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    const reviewResult = await client.query(
      `select q.*, t.coding_state as transaction_coding_state
       from ${REVIEW_QUEUE_WITH_CODING_STATE_SQL}
       where q.firm_id = $1
         and q.client_id = $2
       order by q.updated_at desc`,
      [firmId, clientId]
    );
    const evidenceRequestResult = await queryOptionalFirmDb(
      `select *
       from client_evidence_requests
       where firm_id = $1
         and client_id = $2
       order by updated_at desc`,
      [firmId, clientId]
    );
    return buildCloseExceptions({
      clientId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      documents: documentsResult.rows.map(rowToDocumentPayload),
      transactions: transactionsResult.rows.map(rowToTransactionPayload),
      transactionReviewQueue: reviewResult.rows.map(rowToTransactionReviewPayload),
      clientEvidenceRequests: evidenceRequestResult.rows.map(rowToClientEvidenceRequestPayload)
    });
  });
};

export const getLedgerPeriodPreviewFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  basis = 'accrual'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a ledger period preview.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });

  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });

    // FI-6 Half B (year-2 carryforward): resolve the tilikausi this period sits in
    // so the read model can split cumulative equity into edellisten tilikausien vs
    // tilikauden voitto/tappio. A NO-OP unless FINLAND_OPENING_BALANCES acts (and
    // its dependency FINLAND_TILIKAUSI, enforced at flag-read) — flag-off ⇒
    // fiscalYear stays null ⇒ the single cumulative-earnings line is byte-identical.
    let fiscalYear = null;
    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const { policy: closePolicy } = await readClosePolicyWithClient({ client, firmId, clientId });
    // G-13 (D-P2-6): the statement-coverage close gate — config-plane, dark by
    // default; flag-off ⇒ the close preview is byte-identical.
    const statementCoverageActs = clientFlagActs({ flagKey: FINLAND_STATEMENT_COVERAGE_GATE_FLAG_KEY, snapshot, envFallback: () => false });
    if (closePolicy?.carryforwardActs?.({ snapshot })) {
      const clientRow = await client.query(
        `select incorporation_date, entity_type from clients where firm_id = $1 and id = $2 limit 1`,
        [firmId, clientId]
      );
      const incorporationDate = clientRow.rows[0]?.incorporation_date || null;
      const entityType = clientRow.rows[0]?.entity_type || null;
      fiscalYear = await resolveClientFiscalYearTx({ client, firmId, clientId, date: period.period_start, incorporationDate, entityType });
    }

    const accountsResult = await client.query(
      `select *
       from ledger_accounts
       where firm_id = $1 and client_id = $2
       order by code nulls last, name`,
      [firmId, clientId]
    );
    const journalsResult = await client.query(
      `select *
       from ledger_journals
       where firm_id = $1
         and client_id = $2
         and journal_date <= $3
         and status <> 'voided'
       order by journal_date, created_at`,
      [firmId, clientId, period.period_end]
    );
    const linesResult = await client.query(
      `select
         ll.*,
         lj.journal_date,
         lj.status as journal_status,
         lj.source_type as journal_source_type,
         lj.source_id as journal_source_id
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       where ll.firm_id = $1
         and ll.client_id = $2
         and lj.journal_date <= $3
         and lj.status <> 'voided'
       order by lj.journal_date, lj.created_at, ll.line_no`,
      [firmId, clientId, period.period_end]
    );
    const transactionsResult = await client.query(
      `select *
       from transactions
       where firm_id = $1
         and client_id = $2
         and transaction_date >= $3
         and transaction_date <= $4
       order by transaction_date, created_at`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    const documentIds = Array.from(new Set(transactionsResult.rows.map((row) => row.document_id).filter(Boolean)));
    const documentsResult = documentIds.length
      ? await client.query(
          `select *
           from documents
           where firm_id = $1
             and client_id = $2
             and (
               id = any($3)
               or document_type in ('bank_statement', 'statement')
               or payload->>'document_type' in ('bank_statement', 'statement')
             )
           order by uploaded_at nulls last, created_at`,
          [firmId, clientId, documentIds]
        )
      : await client.query(
          `select *
           from documents
           where firm_id = $1
             and client_id = $2
             and (
               document_type in ('bank_statement', 'statement')
               or payload->>'document_type' in ('bank_statement', 'statement')
             )
           order by uploaded_at nulls last, created_at`,
          [firmId, clientId]
        );
    const reviewResult = await client.query(
      `select q.*, t.coding_state as transaction_coding_state
       from ${REVIEW_QUEUE_WITH_CODING_STATE_SQL}
       where q.firm_id = $1
         and q.client_id = $2
       order by q.updated_at desc`,
      [firmId, clientId]
    );
    const closePeriodResult = await client.query(
      `select *
       from close_periods
       where firm_id = $1
         and client_id = $2
         and period_start = $3
         and period_end = $4
       limit 1`,
      [firmId, clientId, period.period_start, period.period_end]
    );

    const closePeriod = closePeriodResult.rows[0] || null;
    const closeChecksResult = closePeriod
      ? await client.query(
          `select *
           from close_checks
           where firm_id = $1
             and client_id = $2
             and close_period_id = $3
           order by check_type`,
          [firmId, clientId, closePeriod.id]
        )
      : { rows: [] };

    return buildLedgerPeriodReadModel({
      clientId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      ledgerAccounts: accountsResult.rows.map(rowToLedgerAccountPayload),
      ledgerJournals: journalsResult.rows.map(rowToLedgerJournalPayload),
      ledgerLines: linesResult.rows.map((row) => ({
        ...rowToLedgerLinePayload(row),
        journal_date: row.journal_date,
        journal_status: row.journal_status,
        journal_source_type: row.journal_source_type,
        journal_source_id: row.journal_source_id
      })),
      documents: documentsResult.rows.map(rowToDocumentPayload),
      transactions: transactionsResult.rows.map(rowToTransactionPayload),
      transactionReviewQueue: reviewResult.rows.map(rowToTransactionReviewPayload),
      closePeriod,
      closeChecks: closeChecksResult.rows,
      sourceImportRequired: true,
      basis,
      fiscalYear,
      requireStatementCoverage: statementCoverageActs
    });
  });
};


export const getProcountorExportPackageFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a Procountor export package.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const [accountsResult, journalsResult, linesResult, transactionsResult, evidenceRequestsResult] = await Promise.all([
      client.query(
        `select *
           from ledger_accounts
          where firm_id = $1 and client_id = $2
          order by code nulls last, name`,
        [firmId, clientId]
      ),
      client.query(
        `select *
           from ledger_journals
          where firm_id = $1
            and client_id = $2
            and journal_date >= $3
            and journal_date <= $4
            and status = 'posted'
          order by journal_date, created_at`,
        [firmId, clientId, period.period_start, period.period_end]
      ),
      client.query(
        `select ll.*
           from ledger_lines ll
           join ledger_journals lj on lj.id = ll.journal_id
          where ll.firm_id = $1
            and ll.client_id = $2
            and lj.journal_date >= $3
            and lj.journal_date <= $4
            and lj.status = 'posted'
          order by lj.journal_date, lj.created_at, ll.line_no`,
        [firmId, clientId, period.period_start, period.period_end]
      ),
      client.query(
        `select *
           from transactions
          where firm_id = $1
            and client_id = $2
            and transaction_date >= $3
            and transaction_date <= $4
          order by transaction_date, created_at`,
        [firmId, clientId, period.period_start, period.period_end]
      ),
      client.query(
        `select *
           from client_evidence_requests
          where firm_id = $1
            and client_id = $2
            and status in ('draft', 'open', 'replied')
          order by updated_at desc`,
        [firmId, clientId]
      )
    ]);

    const documentIds = new Set();
    for (const tx of transactionsResult.rows) if (tx.document_id) documentIds.add(tx.document_id);
    for (const journal of journalsResult.rows) {
      if (journal.payload?.document_id) documentIds.add(journal.payload.document_id);
      const tx = transactionsResult.rows.find((row) => row.id === journal.source_id);
      if (tx?.document_id) documentIds.add(tx.document_id);
    }
    const documentsResult = documentIds.size
      ? await client.query(
          `select *
             from documents
            where firm_id = $1
              and client_id = $2
              and id = any($3::text[])
            order by uploaded_at nulls last, created_at`,
          [firmId, clientId, Array.from(documentIds)]
        )
      : { rows: [] };
    const closeBlockers = await listCloseBlockersForClient({ client, firmId, clientId });

    return buildProcountorExportPackage({
      clientId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      journals: journalsResult.rows,
      ledgerLines: linesResult.rows,
      transactions: transactionsResult.rows,
      documents: documentsResult.rows,
      evidenceRequests: evidenceRequestsResult.rows,
      closeBlockers,
      accounts: accountsResult.rows
    });
  });
};

// Read-only financial report (Profit & Loss + Balance Sheet + Trial Balance + cash) for a
// (firm, client, period), sourced entirely from Donna's posted ledger. Shared by
// the client portal and the firm console. No new numbers are computed here — it
// projects the deterministic GL aggregation from getLedgerPeriodPreviewFromDb into
// a stable report shape with an honest draft verdict.
export const getFinancialReportFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  basis = 'accrual'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for a financial report.');
    error.statusCode = 400;
    throw error;
  }
  const readModel = await getLedgerPeriodPreviewFromDb({ firmId, clientId, periodStart, periodEnd, basis });
  // FI-09: an accrual statement names the uploaded sales documents and the
  // uploaded supplier documents its posted ledger does not recognise in the
  // period, each under its own reason (a cash view recognises at settlement by
  // definition, so it has none to name).
  const gap = readModel.basis === 'cash' ? null : await withFirmDbClient((client) =>
    readRecognitionGapWithClient({ client, firmId, clientId, period: { starts_on: readModel.period_start, ends_on: readModel.period_end } }));
  return buildFinancialReport({ firmId, clientId, readModel,
    salesRecognition: recognitionDraftReason(gap?.sales), purchaseRecognition: recognitionDraftReason(gap?.purchase) });
};

// `open_financials` latest-month resolution reads the ledger's own terminal
// activity, never the bounded chat feed or an unposted transaction date. SQL
// formats the DATE before it crosses the JS timezone boundary (the same class
// of off-by-one failure recorded in the stage-C close canary).
export const getLatestPostedLedgerPeriodFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  query = queryFirmDb
} = {}) => {
  if (!clientId) return null;
  const result = await query(
    `select to_char(max(journal_date), 'YYYY-MM') as period
       from ledger_journals
      where firm_id = $1 and client_id = $2 and status = 'posted'`,
    [firmId, clientId]
  );
  const period = String(result.rows?.[0]?.period || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : null;
};

// Newly generated evidence requires current identity. Retained archive export
// deliberately does not pass through this guard: its original bytes are evidence.
const requireArchiveJurisdiction = (row) => {
  const jurisdiction = lifecycleJurisdiction(row);
  if (!jurisdiction) throw Object.assign(new Error('Confirm the client country in the business profile before generating a close archive.'), {
    statusCode: 409, code: 'CLOSE_ARCHIVE_JURISDICTION_REQUIRED',
    details: { recovery_route: 'client_profile' }
  });
  return jurisdiction.toUpperCase();
};

const getCloseArchiveInputsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd
} = {}) => {
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  return withFirmDbClient(async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const clientResult = await client.query(
      `select *
       from clients
       where firm_id = $1
         and id = $2
       limit 1`,
      [firmId, clientId]
    );
    const clientRow = clientResult.rows[0] || {};
    const jurisdiction = requireArchiveJurisdiction(clientRow);
    const retention = await resolveClosePolicy(clientRow)?.archiveRetentionForPeriod?.({
      client, firmId, clientId, periodStart: period.period_start, periodEnd: period.period_end
    }) ?? null;
    const transactionsResult = await client.query(
      `select *
       from transactions
       where firm_id = $1
         and client_id = $2
         and transaction_date >= $3
         and transaction_date <= $4
       order by transaction_date, created_at`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    const documentIds = Array.from(new Set(transactionsResult.rows.map((row) => row.document_id).filter(Boolean)));
    const documentsResult = documentIds.length
      ? await client.query(
          `select *
           from documents
           where firm_id = $1
             and client_id = $2
             and (
               id = any($3)
               or document_type in ('bank_statement', 'statement')
               or payload->>'document_type' in ('bank_statement', 'statement')
             )
           order by uploaded_at nulls last, created_at`,
          [firmId, clientId, documentIds]
        )
      : await client.query(
          `select *
           from documents
           where firm_id = $1
             and client_id = $2
             and (
               document_type in ('bank_statement', 'statement')
               or payload->>'document_type' in ('bank_statement', 'statement')
             )
           order by uploaded_at nulls last, created_at`,
          [firmId, clientId]
        );
    const reviewResult = await client.query(
      `select q.*, t.coding_state as transaction_coding_state
       from ${REVIEW_QUEUE_WITH_CODING_STATE_SQL}
       where q.firm_id = $1
         and q.client_id = $2
       order by q.updated_at desc`,
      [firmId, clientId]
    );
    const accountsResult = await client.query(
      `select *
       from ledger_accounts
       where firm_id = $1
         and client_id = $2
       order by code nulls last, name`,
      [firmId, clientId]
    );
    const journalsResult = await client.query(
      `select *
       from ledger_journals
       where firm_id = $1
         and client_id = $2
         and journal_date >= $3
         and journal_date <= $4
         and status <> 'voided'
       order by journal_date, created_at`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    const linesResult = await client.query(
      `select
         ll.*,
         lj.journal_date,
         lj.status as journal_status,
         lj.source_type as journal_source_type,
         lj.source_id as journal_source_id
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       where ll.firm_id = $1
         and ll.client_id = $2
         and lj.journal_date >= $3
         and lj.journal_date <= $4
         and lj.status <> 'voided'
       order by lj.journal_date, lj.created_at, ll.line_no`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    const closePeriodResult = await client.query(
      `select *
       from close_periods
       where firm_id = $1
         and client_id = $2
         and period_start = $3
         and period_end = $4
       limit 1`,
      [firmId, clientId, period.period_start, period.period_end]
    );
    const closePeriod = closePeriodResult.rows[0] || null;
    const closeChecksResult = closePeriod
      ? await client.query(
          `select *
           from close_checks
           where firm_id = $1
             and client_id = $2
             and close_period_id = $3
           order by check_type`,
          [firmId, clientId, closePeriod.id]
        )
      : { rows: [] };
    const auditResult = await client.query(
      `select *
       from audit_events
       where firm_id = $1
         and client_id = $2
         and action <> 'close.archive_generated'
       order by created_at desc
       limit 500`,
      [firmId, clientId]
    );

    return {
      retention,
      client: {
        ...(clientRow.profile || {}),
        jurisdiction,
        id: clientRow.id,
        company_name: clientRow.company_name,
        uen: clientRow.uen,
        entity_type: clientRow.entity_type,
        default_currency: clientRow.profile?.defaultCurrency || clientRow.profile?.default_currency || null
      },
      documents: documentsResult.rows.map(rowToDocumentPayload),
      transactions: transactionsResult.rows.map(rowToTransactionPayload),
      transactionReviewQueue: reviewResult.rows.map(rowToTransactionReviewPayload),
      ledgerAccounts: accountsResult.rows.map(rowToLedgerAccountPayload),
      ledgerJournals: journalsResult.rows.map(rowToLedgerJournalPayload),
      ledgerLines: linesResult.rows.map((row) => ({
        ...rowToLedgerLinePayload(row),
        journal_date: row.journal_date,
        journal_status: row.journal_status,
        journal_source_type: row.journal_source_type,
        journal_source_id: row.journal_source_id
      })),
      closePeriod,
      closeChecks: closeChecksResult.rows,
      auditEvents: auditResult.rows.map((row) => ({
        id: row.id,
        firm_id: row.firm_id,
        client_id: row.client_id,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        metadata: row.metadata || {},
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null
      }))
    };
  });
};

export const getCloseArchivePreviewFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for close archive preview.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const [ledgerPreview, closeDiagnostics, closeExceptions, inputs] = await Promise.all([
    getLedgerPeriodPreviewFromDb({ firmId, clientId, periodStart: period.period_start, periodEnd: period.period_end }),
    getCloseDiagnosticsFromDb({ firmId, clientId, periodStart: period.period_start, periodEnd: period.period_end }),
    getCloseExceptionsFromDb({ firmId, clientId, periodStart: period.period_start, periodEnd: period.period_end }),
    getCloseArchiveInputsFromDb({ firmId, clientId, periodStart: period.period_start, periodEnd: period.period_end })
  ]);
  return {
    ...buildCloseArchivePackage({
      firmId,
      clientId,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      generatedBy: actorId,
      ledgerPreview,
      closeDiagnostics,
      closeExceptions,
      ...inputs
    }),
    dry_run: true
  };
};

export const createCloseArchiveInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  actorId = 'system'
} = {}) => {
  const archive = await getCloseArchivePreviewFromDb({ firmId, clientId, periodStart, periodEnd, actorId });
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      // The preview can outlive an identity repair. Hold the current row through
      // persistence so a new archive cannot certify the old country after it.
      const current = await client.query(
        'select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 for share',
        [firmId, clientId]
      );
      if (requireArchiveJurisdiction(current.rows[0]) !== archive.sections.entity.jurisdiction) {
        throw Object.assign(new Error('The client country changed while preparing the close archive. Generate it again.'), {
          statusCode: 409, code: 'CLOSE_ARCHIVE_CONTEXT_CHANGED'
        });
      }
      await client.query(
        `insert into close_archives (
           id, firm_id, client_id, period_start, period_end, status, schema_version,
           manifest_checksum, manifest, generated_by, generated_at, storage_status, payload
         )
         values ($1, $2, $3, $4, $5, 'generated', $6, $7, $8::jsonb, $9, $10::timestamptz, 'not_configured', $11::jsonb)
         on conflict (id) do update set
           status = 'generated',
           schema_version = excluded.schema_version,
           manifest_checksum = excluded.manifest_checksum,
           manifest = excluded.manifest,
           generated_by = excluded.generated_by,
           generated_at = excluded.generated_at,
           storage_status = excluded.storage_status,
           payload = excluded.payload,
           updated_at = now()`,
        [
          archive.archive_id,
          firmId,
          clientId,
          archive.period_start,
          archive.period_end,
          CLOSE_ARCHIVE_SCHEMA_VERSION,
          archive.manifest_checksum_sha256,
          JSON.stringify(archive.manifest),
          actorId,
          archive.generated_at,
          JSON.stringify({
            sections: archive.sections,
            custody_statement: archive.manifest.custody_statement
          })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'close.archive_generated', 'close_archive', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          actorId,
          archive.archive_id,
          JSON.stringify({
            period_start: archive.period_start,
            period_end: archive.period_end,
            manifest_checksum_sha256: archive.manifest_checksum_sha256,
            schema_version: CLOSE_ARCHIVE_SCHEMA_VERSION,
            storage_status: 'not_configured'
          })
        ]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  return {
    close_archive: {
      ...archive,
      source: 'close_archive',
      dry_run: false,
      status: 'generated',
      storage_status: 'not_configured',
      storage_destination: null
    }
  };
};

export const getCloseArchiveExportFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  archiveId,
  periodStart,
  periodEnd,
  actorId = 'system'
} = {}) => {
  const cleanArchiveId = String(archiveId || '').trim();
  if (!clientId && !cleanArchiveId) {
    const error = new Error('Client id or archive id is required for close archive export.');
    error.statusCode = 400;
    throw error;
  }

  if (cleanArchiveId) {
    return withFirmDbClient(async (client) => {
      const archiveResult = await client.query(
        `select *
         from close_archives
         where firm_id = $1
           and id = $2
           ${clientId ? 'and client_id = $3' : ''}
         order by generated_at desc
         limit 1`,
        clientId ? [firmId, cleanArchiveId, clientId] : [firmId, cleanArchiveId]
      );
      const row = archiveResult.rows[0] || null;
      if (!row) {
        const error = new Error('Close archive was not found.');
        error.statusCode = 404;
        error.code = 'CLOSE_ARCHIVE_NOT_FOUND';
        throw error;
      }
      const archive = rowToCloseArchivePayload(row);
      const sections = archive.payload?.sections || {};
      if (!Object.keys(sections).length) {
        const error = new Error('Close archive payload is missing export sections. Re-generate the archive package.');
        error.statusCode = 409;
        error.code = 'CLOSE_ARCHIVE_PAYLOAD_MISSING';
        throw error;
      }
      const exportedAt = new Date().toISOString();
      const handoff = {
        method: 'manual_download',
        destination: 'client_download_folder',
        status: 'delivered',
        exported_at: exportedAt,
        exported_by: actorId,
        archive_id: archive.id,
        manifest_checksum_sha256: archive.manifest_checksum,
        note: 'User-initiated download. The client controls custody after the file leaves Donna.'
      };
      const bundle = buildCloseArchiveExportBundle({
        archive: {
          ...archive,
          archive_id: archive.id,
          manifest_checksum_sha256: archive.manifest_checksum
        },
        sections,
        manifest: archive.manifest,
        storageStatus: 'delivered',
        storageDestination: 'manual_download',
        handoff
      });
      const completedHandoff = {
        ...handoff,
        filename: bundle.filename,
        bundle_checksum_sha256: bundle.bundle_checksum_sha256,
        integrity_check: {
          status: 'passed',
          checked_at: exportedAt,
          method: 'bundle_checksum_sha256'
        }
      };
      bundle.handoff = completedHandoff;
      bundle.storage = {
        status: 'delivered',
        destination: 'manual_download',
        note: 'Archive bundle was handed off through a user-initiated manual download.'
      };
      await client.query('begin');
      try {
        await client.query(
          `update close_archives
           set storage_status = 'delivered',
               storage_destination = 'manual_download',
               payload = payload || $3::jsonb,
               updated_at = now()
           where firm_id = $1 and id = $2`,
          [
            firmId,
            archive.id,
            JSON.stringify({
              export_handoff: completedHandoff
            })
          ]
        );
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, 'close.archive_exported', 'close_archive', $4, $5::jsonb)`,
          [
            firmId,
            archive.client_id,
            actorId,
            archive.id,
            JSON.stringify(completedHandoff)
          ]
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      return bundle;
    });
  }

  const preview = await getCloseArchivePreviewFromDb({ firmId, clientId, periodStart, periodEnd, actorId });
  const exportedAt = new Date().toISOString();
  const handoff = {
    method: 'manual_download',
    destination: 'client_download_folder',
    status: 'preview_exported',
    exported_at: exportedAt,
    exported_by: actorId,
    archive_id: preview.archive_id,
    manifest_checksum_sha256: preview.manifest_checksum_sha256,
    note: 'Preview download only. Generate the archive to persist the handoff record.'
  };
  const bundle = buildCloseArchiveExportBundle({
    archive: preview,
    sections: preview.sections,
    manifest: preview.manifest,
    storageStatus: 'preview_exported',
    storageDestination: 'manual_download',
    handoff
  });
  const completedHandoff = {
    ...handoff,
    filename: bundle.filename,
    bundle_checksum_sha256: bundle.bundle_checksum_sha256,
    integrity_check: {
      status: 'passed',
      checked_at: exportedAt,
      method: 'bundle_checksum_sha256'
    }
  };
  bundle.handoff = completedHandoff;
  return bundle;
};

const closePeriodSummaryPayload = (preview = {}) => ({
  source: 'donna_close_preview',
  generated_at: preview.generated_at || new Date().toISOString(),
  close_status: preview.close_preview?.status || 'blocked',
  lockable: Boolean(preview.close_preview?.lockable),
  posted_journal_count: preview.ledger_period?.posted_journal_count || 0,
  ledger_line_count: preview.ledger_period?.ledger_line_count || 0,
  trial_balance: {
    total_debit: preview.trial_balance?.total_debit || 0,
    total_credit: preview.trial_balance?.total_credit || 0,
    imbalance: preview.trial_balance?.imbalance || 0,
    balanced: Boolean(preview.trial_balance?.balanced)
  },
  profit_and_loss: {
    revenue: preview.profit_and_loss?.revenue || 0,
    expenses: preview.profit_and_loss?.expenses || 0,
    net_income: preview.profit_and_loss?.net_income || 0
  },
  cash: {
    total: preview.cash?.total || 0
  },
  review_counts: preview.review_counts || {},
  xero_mirror: preview.xero_mirror || {}
});

// FI-13 slice 13.1a (GB-aware since 2026-07-31) — entity-aware fiscal-year
// resolution for a client, inside the caller's transaction. This is the ONE
// place the C6 assertion lives, so every load-bearing consumer path (close
// nesting, tosite gap-free, tosite allocation, opening-balance seed, year-2
// carryforward) resolves through the same guard instead of each re-deriving it.
// Country fiscal policy resolves from current persisted identity and source dates;
// optional historical caller hints never override a corrected client row.
export const resolveClientFiscalYearTx = async ({
  client, firmId, clientId, date, incorporationDate, entityType
}) => {
  const { row, policy } = await readClosePolicyWithClient({ client, firmId, clientId });
  if (!policy) throw Object.assign(new Error('Fiscal-year resolution requires an available country policy.'), { statusCode: 409, code: 'FISCAL_YEAR_POLICY_UNAVAILABLE' });
  const incDate = row?.incorporation_date ? ledgerDateOnly(row.incorporation_date) : null;
  const etype = row?.entity_type || null;

  let persistedPeriod = null;
  if (policy.readsPersistedPeriod?.({ entityType: etype })) {
    // The persisted fiscal_years rows covering the date. Exactly one is the
    // healthy case; zero → the pure resolver's refusal/derivation; more than
    // one → an overlapping registry, a data fault we refuse rather than
    // silently pick.
    const covering = await client.query(
      `select label, starts_on, ends_on from fiscal_years
        where firm_id = $1 and client_id = $2
          and starts_on <= $3::date and ends_on >= $3::date`,
      [firmId, clientId, date]
    );
    if (covering.rows.length > 1) {
      const error = new Error(
        `fiscal-year registry is ambiguous: ${covering.rows.length} persisted fiscal years cover ${date} for this client`
      );
      error.statusCode = 409;
      error.code = 'FISCAL_YEAR_REGISTRY_AMBIGUOUS';
      throw error;
    }
    const fy = covering.rows[0];
    if (fy) {
      persistedPeriod = {
        label: fy.label,
        starts_on: ledgerDateOnly(fy.starts_on),
        ends_on: ledgerDateOnly(fy.ends_on)
      };
    }
  }

  return policy.resolveFiscalYear({ date, incorporationDate: incDate, entityType: etype, persistedPeriod });
};

// FI-4 — ensure the tilikausi (fiscal_years) row for a resolved fiscal year
// exists, idempotently, inside the caller's transaction. Emits fiscal_year.ensured
// on a first-time insert (nothing silent). Additive: writes only to the new table.
export const ensureFiscalYearRowTx = async ({ client, firmId, clientId, fiscalYear, actorId = 'system' }) => {
  const id = ledgerRecordId('fiscalyear', firmId, clientId, fiscalYear.starts_on);
  const inserted = await client.query(
    `insert into fiscal_years (id, firm_id, client_id, label, starts_on, ends_on, status)
     values ($1, $2, $3, $4, $5, $6, 'open')
     on conflict (firm_id, client_id, starts_on) do nothing
     returning id`,
    [id, firmId, clientId, fiscalYear.label, fiscalYear.starts_on, fiscalYear.ends_on]
  );
  if (inserted.rows.length) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'fiscal_year.ensured', 'fiscal_year', $3, $4::jsonb)`,
      [
        firmId,
        clientId,
        id,
        JSON.stringify({ actor_id: actorId, label: fiscalYear.label, starts_on: fiscalYear.starts_on, ends_on: fiscalYear.ends_on })
      ]
    );
  }
  const row = await client.query(
    `select * from fiscal_years where firm_id = $1 and client_id = $2 and starts_on = $3 limit 1`,
    [firmId, clientId, fiscalYear.starts_on]
  );
  return row.rows[0] || null;
};

// registerFiscalPeriodWithClient — the EXPLICIT, jurisdiction-neutral fiscal-period
// intake. See `fiscalPeriodIntake.js` for why this is not a GB feature: today
// `ensureFiscalYearRowTx` is the only writer and it DERIVES its bounds, which leaves
// both a GB switcher and a Finnish Oy unable to persist a first period at all.
//
// Deliberately additive: same table, same deterministic id as the derive path, so an
// explicitly registered FI period IS the row `ensureFiscalYearRowTx` would upsert
// (it is `on conflict do nothing`, so the two can never fight).
//
// The bounds come from the owner as a FACT — Donna does not guess them. The only
// jurisdictional judgement applied is a statutory maximum length, and only where the
// tree can actually source one: FI delegates to `assertValidTilikausi`; GB does not
// pretend to know its rule (gov.uk 403s through the egress proxy) and the receipt
// records `statutory_bound_enforced: false` so silence is never mistaken for a check.
export const registerFiscalPeriodWithClient = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  label = null,
  startsOn = null,
  endsOn = null,
  authorityBasis = null,
  actorId = 'system'
} = {}) => {
  if (!clientId) {
    throw Object.assign(new Error('Client id is required to register a fiscal period.'), { statusCode: 400, code: 'FISCAL_PERIOD_CLIENT_REQUIRED' });
  }
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: FISCAL_PERIOD_INTAKE_FLAG_KEY, snapshot, envFallback: () => false })) {
    throw Object.assign(new Error('Explicit fiscal-period intake is disabled for this client.'), { statusCode: 409, code: 'FISCAL_PERIOD_INTAKE_DISABLED' });
  }

  // FOR UPDATE on the client row serializes intake per client, which is what makes
  // the overlap check below sound: the two unique constraints on fiscal_years catch
  // a duplicate start or label, but nothing in the schema catches a merely
  // OVERLAPPING period, so the check has to hold a lock to mean anything.
  const clientRow = await client.query(
    `select jurisdiction, entity_type, profile from clients where firm_id = $1 and id = $2 limit 1 for update`,
    [firmId, clientId]
  );
  if (!clientRow.rows.length) {
    throw Object.assign(new Error('Client not found in this firm.'), { statusCode: 404, code: 'FISCAL_PERIOD_CLIENT_REQUIRED' });
  }
  const jurisdiction = String(clientRow.rows[0]?.jurisdiction || '').trim().toUpperCase();
  if (!jurisdiction) {
    throw Object.assign(new Error('A fiscal period requires a persisted client jurisdiction.'), { statusCode: 409, code: 'FISCAL_PERIOD_JURISDICTION_REQUIRED' });
  }
  const entityType = clientRow.rows[0]?.entity_type || null;
  const policy = resolveClosePolicy(clientRow.rows[0]);
  if (!policy) throw Object.assign(new Error('Fiscal-period intake requires an available country policy.'), { statusCode: 409, code: 'FISCAL_YEAR_POLICY_UNAVAILABLE' });

  const existing = await client.query(
    `select id, label, starts_on, ends_on, status from fiscal_years where firm_id = $1 and client_id = $2`,
    [firmId, clientId]
  );
  const existingPeriods = existing.rows.map((row) => ({
    id: row.id,
    label: row.label,
    starts_on: ledgerDateOnly(row.starts_on),
    ends_on: ledgerDateOnly(row.ends_on),
    status: row.status
  }));

  // FI is the one jurisdiction whose statutory maximum is already sourced in this
  // tree; anywhere else the assertion is omitted rather than invented.
  const statutoryAssert = policy.statutoryAssert?.(entityType) ?? null;

  const plan = planFiscalPeriodRegistration({
    label,
    startsOn: ledgerDateOnly(startsOn),
    endsOn: ledgerDateOnly(endsOn),
    existingPeriods,
    jurisdiction,
    statutoryAssert
  });

  if (plan.decision === 'noop') {
    const row = await client.query(
      `select * from fiscal_years where firm_id = $1 and client_id = $2 and starts_on = $3 limit 1`,
      [firmId, clientId, plan.period.starts_on]
    );
    return { fiscal_period: row.rows[0] || null, created: false, audit_event_id: null, statutory: plan.statutory };
  }

  const id = ledgerRecordId('fiscalyear', firmId, clientId, plan.period.starts_on);
  await client.query(
    `insert into fiscal_years (id, firm_id, client_id, label, starts_on, ends_on, status)
     values ($1, $2, $3, $4, $5, $6, 'open')
     on conflict (firm_id, client_id, starts_on) do nothing`,
    [id, firmId, clientId, plan.period.label, plan.period.starts_on, plan.period.ends_on]
  );

  // Audit-as-precondition: no receipt, no period. The bounds of a fiscal year gate
  // every opening balance and period lock downstream, so an unattributed one is not
  // a row worth having.
  const auditResult = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, 'fiscal_period.registered', 'fiscal_year', $4, $5::jsonb)
     returning id`,
    [firmId, clientId, actorId, id, JSON.stringify({
      label: plan.period.label,
      starts_on: plan.period.starts_on,
      ends_on: plan.period.ends_on,
      jurisdiction,
      entity_type: entityType,
      statutory_bound_enforced: plan.statutory.bound_enforced,
      statutory_authority: plan.statutory.authority,
      statutory_bound_provenance: statutoryBoundProvenanceFor(jurisdiction)?.note ?? null,
      authority_basis: authorityBasis || null,
      source: 'explicit_intake'
    })]
  );

  const row = await client.query(
    `select * from fiscal_years where firm_id = $1 and client_id = $2 and starts_on = $3 limit 1`,
    [firmId, clientId, plan.period.starts_on]
  );
  return {
    fiscal_period: row.rows[0] || null,
    created: true,
    audit_event_id: auditResult.rows[0]?.id != null ? String(auditResult.rows[0].id) : null,
    statutory: plan.statutory
  };
};

// Standalone entry — owns its transaction so an onboarding/intake surface can
// register a period without holding a connection. Mirrors the opening-balance
// writer's txn discipline.
export const registerFiscalPeriodFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  label = null,
  startsOn = null,
  endsOn = null,
  authorityBasis = null,
  actorId = 'system'
} = {}) => withFirmDbClient(async (client) => {
  await requireClientInFirm({ client, firmId, clientId });
  await client.query('begin');
  try {
    const result = await registerFiscalPeriodWithClient({ client, firmId, clientId, label, startsOn, endsOn, authorityBasis, actorId });
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
});

// The owner fiscal-period read (row 17's fiscal-period step). Returns the
// persisted fiscal_years rows plus whether the explicit intake ACTS for this
// client, so the portal card renders persisted state and stays hidden while
// FISCAL_PERIOD_INTAKE is dark — the WhatsApp binding-state pattern: the FE
// asks the server for the flag verdict, it never guesses one.
export const listFiscalPeriodsFromDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId
} = {}) => withFirmDbClient(async (client) => {
  await requireClientInFirm({ client, firmId, clientId });
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const intakeActs = clientFlagActs({ flagKey: FISCAL_PERIOD_INTAKE_FLAG_KEY, snapshot, envFallback: () => false });
  const rows = await client.query(
    `select id, label, starts_on, ends_on, status from fiscal_years where firm_id = $1 and client_id = $2 order by starts_on`,
    [firmId, clientId]
  );
  return {
    intake_acts: intakeActs,
    periods: rows.rows.map((row) => ({
      id: row.id,
      label: row.label,
      starts_on: ledgerDateOnly(row.starts_on),
      ends_on: ledgerDateOnly(row.ends_on),
      status: row.status
    }))
  };
});

// Bind close checks to the exact journal generation they observed. This
// detects an opening committed while the preview loaded or before final lock.
const readCloseBookVersion = async ({client=null,firmId,clientId}) => {
  if (!client) return withFirmDbClient(connection=>readCloseBookVersion({client:connection,firmId,clientId}));
  const result=await client.query(`select md5(coalesce(string_agg(id || ':' || updated_at::text || ':' || status, '|' order by id), '')) as version
    from ledger_journals where firm_id=$1 and client_id=$2`,[firmId,clientId]);
  return result.rows[0].version;
};
const assertCloseBookVersion = async ({client,firmId,clientId,version}) => {
  if (await readCloseBookVersion({client,firmId,clientId}) !== version) {
    throw Object.assign(new Error('The book changed while close checks were being prepared. Run the close again against the current balances.'),
      {statusCode:409,code:'CLOSE_BOOK_CHANGED_RETRY'});
  }
};

export const runCloseChecksInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  actorId = 'system',
  force = false
} = {}) => {
  const bookVersion=await readCloseBookVersion({firmId,clientId});
  const preview = await getLedgerPeriodPreviewFromDb({ firmId, clientId, periodStart, periodEnd });
  const period = normalizeLedgerPeriod({ periodStart: preview.period_start, periodEnd: preview.period_end });
  const generatedChecks = (preview.close_preview?.checks || []).filter((item) => item.source !== 'persisted');
  const closePeriodId = preview.ledger_period?.id || ledgerRecordId('close-period', firmId, clientId, period.period_start, period.period_end);
  const nextStatus = preview.close_preview?.lockable ? 'reviewing' : 'open';
  const payload = {...closePeriodSummaryPayload(preview),book_version:bookVersion};

  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await lockClientCloseBoundaryWithClient({client,firmId,clientId});
      await assertCloseBookVersion({client,firmId,clientId,version:bookVersion});
      await requireClientInFirm({ client, firmId, clientId });
      // FI-4 — nesting guard (no-op unless FINLAND_TILIKAUSI acts for this client):
      // refuse a close period that straddles / falls outside its tilikausi, and
      // ensure the tilikausi row exists. Inside the same transaction as the upsert.
      const { policy: closePolicy } = await readClosePolicyWithClient({ client, firmId, clientId });
      await closePolicy?.enforcePeriodNesting?.({ client, firmId, clientId, period, actorId, resolveClientFiscalYearTx, ensureFiscalYearRowTx });
      // FI-5 — refuse to close over a tilikausi whose voucher sequence has a hole
      // (no-op unless FINLAND_TOSITENUMERO acts). Same transaction as the upsert.
      await closePolicy?.enforceVoucherSequence?.({ client, firmId, clientId, period, resolveClientFiscalYearTx, ledgerRecordId });
      const existing = await client.query(
        `select status
         from close_periods
         where firm_id = $1
           and client_id = $2
           and period_start = $3
           and period_end = $4
         limit 1`,
        [firmId, clientId, period.period_start, period.period_end]
      );
      if (existing.rows[0]?.status === 'locked' && !force) {
        const error = new Error('Close period is locked. Pass force to refresh checks.');
        error.statusCode = 409;
        error.code = 'CLOSE_PERIOD_LOCKED';
        throw error;
      }
      await client.query(
        `insert into close_periods (
           id, firm_id, client_id, period_start, period_end, status, payload
         )
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         on conflict (firm_id, client_id, period_start, period_end) do update set
           status = case when close_periods.status = 'locked' and $8 = false then close_periods.status else excluded.status end,
           payload = close_periods.payload || excluded.payload,
           updated_at = now()`,
        [
          closePeriodId,
          firmId,
          clientId,
          period.period_start,
          period.period_end,
          nextStatus,
          JSON.stringify(payload),
          force
        ]
      );
      for (const item of generatedChecks) {
        const checkId = ledgerRecordId('close-check', closePeriodId, item.check_type);
        await client.query(
          `insert into close_checks (
             id, close_period_id, firm_id, client_id, check_type, status, summary, payload
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
           on conflict (close_period_id, check_type) do update set
             status = excluded.status,
             summary = excluded.summary,
             payload = excluded.payload,
             updated_at = now()`,
          [
            checkId,
            closePeriodId,
            firmId,
            clientId,
            item.check_type,
            item.status,
            item.summary || null,
            JSON.stringify({
              count: item.count == null ? null : item.count,
              ...(item.payload || {})
            })
          ]
        );
      }
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'close.checks_run', 'close_period', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          closePeriodId,
          JSON.stringify({
            actor_id: actorId,
            period_start: period.period_start,
            period_end: period.period_end,
            status: preview.close_preview?.status || 'blocked',
            lockable: Boolean(preview.close_preview?.lockable)
          })
        ]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return {
    snapshot,
    close_checks_run: {
      source: 'close_checks_run',
      book_version: bookVersion,
      close_period_id: closePeriodId,
      client_id: clientId,
      period_start: period.period_start,
      period_end: period.period_end,
      status: preview.close_preview?.status || 'blocked',
      lockable: Boolean(preview.close_preview?.lockable),
      checks: generatedChecks
    }
  };
};

export const lockClosePeriodInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  periodStart,
  periodEnd,
  actorId = 'system',
  force = false
} = {}) => {
  if (!clientId) {
    const error = new Error('Client id is required for close lock.');
    error.statusCode = 400;
    throw error;
  }
  const period = normalizeLedgerPeriod({ periodStart, periodEnd });
  const assertScope = async (client, lock) => {
    const decision = await evaluateRetainedProcessingScopeWithClient({ client, firmId, clientId, boundary: 'close_lock', lock });
    if (!decision.allowed) {
      await recordEntityReadinessBlockedWithClient({ client: { query: queryFirmDb }, firmId, clientId,
        boundary: 'close_lock', decision, actorId, resourceType: 'close_period',
        resourceId: `${clientId}:${period.period_start}:${period.period_end}` });
      throw new EntityReadinessAdmissionError(decision);
    }
  };
  // Before either idempotent success or persisted checks. Preview remains a read.
  await withFirmDbClient(async client => {
    await requireClientInFirm({ client, firmId, clientId });
    await assertScope(client, false);
  });
  if (!force) {
    const existingLock = await withFirmDbClient(async (client) => {
      await requireClientInFirm({ client, firmId, clientId });
      const result = await client.query(
        `select cp.*,
                coalesce(
                  jsonb_agg(
                    jsonb_build_object(
                      'check_type', cc.check_type,
                      'status', cc.status,
                      'summary', cc.summary,
                      'payload', cc.payload
                    )
                    order by cc.check_type
                  ) filter (where cc.id is not null),
                  '[]'::jsonb
                ) as checks
         from close_periods cp
         left join close_checks cc
           on cc.close_period_id = cp.id
          and cc.firm_id = cp.firm_id
          and cc.client_id = cp.client_id
         where cp.firm_id = $1
           and cp.client_id = $2
           and cp.period_start = $3
           and cp.period_end = $4
         group by cp.id
         limit 1`,
        [firmId, clientId, period.period_start, period.period_end]
      );
      return result.rows[0] || null;
    });
    if (existingLock?.status === 'locked') {
      const snapshot = await getFirmSnapshotFromDb({ firmId });
      return {
        snapshot,
        close_lock: {
          source: 'close_lock',
          close_period_id: existingLock.id,
          client_id: clientId,
          period_start: period.period_start,
          period_end: period.period_end,
          status: 'locked',
          locked_at: existingLock.locked_at ? new Date(existingLock.locked_at).toISOString() : null,
          forced: false,
          idempotent: true,
          checks: existingLock.checks || []
        }
      };
    }
  }
  const checkResult = await runCloseChecksInDb({ firmId, clientId, periodStart, periodEnd, actorId, force });
  const closeRun = checkResult.close_checks_run;
  if (!closeRun.lockable && !force) {
    const error = new Error('Close period is not lockable yet.');
    error.statusCode = 409;
    error.code = 'CLOSE_PERIOD_NOT_LOCKABLE';
    error.details = {
      status: closeRun.status,
      checks: closeRun.checks
    };
    throw error;
  }

  const lockedAt = new Date().toISOString();
  let persistedLockedAt = lockedAt;
  await withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      await lockClientCloseBoundaryWithClient({client,firmId,clientId});
      await assertCloseBookVersion({client,firmId,clientId,version:closeRun.book_version});
      await requireClientInFirm({ client, firmId, clientId });
      await assertScope(client, true);
      const lockUpdateResult = await client.query(
        `update close_periods
         set status = 'locked',
             closed_by = $6,
             closed_at = coalesce(closed_at, now()),
             locked_at = coalesce(locked_at, now()),
             payload = payload || $7::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and period_start = $3
           and period_end = $4
           and id = $5
         returning locked_at`,
        [
          firmId,
          clientId,
          closeRun.period_start,
          closeRun.period_end,
          closeRun.close_period_id,
          actorId,
          JSON.stringify({
            locked_at: lockedAt,
            locked_by: actorId,
            lock_forced: Boolean(force)
          })
        ]
      );
      persistedLockedAt = lockUpdateResult.rows[0]?.locked_at
        ? new Date(lockUpdateResult.rows[0].locked_at).toISOString()
        : lockedAt;
      await client.query(
        `update ledger_journals
         set status = 'closed',
             closed_at = coalesce(closed_at, now()),
             payload = payload || $5::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and journal_date >= $3
           and journal_date <= $4
           and status = 'posted'`,
        [
          firmId,
          clientId,
          closeRun.period_start,
          closeRun.period_end,
          JSON.stringify({
            close_period_id: closeRun.close_period_id,
            closed_by: actorId
          })
        ]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'close.period_locked', 'close_period', $3, $4::jsonb)`,
        [
          firmId,
          clientId,
          closeRun.close_period_id,
          JSON.stringify({
            actor_id: actorId,
            period_start: closeRun.period_start,
            period_end: closeRun.period_end,
            forced: Boolean(force)
          })
        ]
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return {
    snapshot,
    close_lock: {
      source: 'close_lock',
      close_period_id: closeRun.close_period_id,
      client_id: clientId,
      period_start: closeRun.period_start,
      period_end: closeRun.period_end,
      status: 'locked',
      locked_at: persistedLockedAt,
      forced: Boolean(force),
      checks: closeRun.checks
    }
  };
};
