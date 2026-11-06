// Donna — the reconciliation provider-failure receipt + its re-drive
// (2026-09-13, FI provider-failure pass;
// docs/finding-2026-09-13-fi-provider-failure-recovery.md).
//
// THE GAP THIS CLOSES. Every family wrapper (receipt / sales invoice /
// supplier bill / payment confirmation / payment account statement) answered
// a THROWN LLM matcher — a 401 from a revoked key, a 5xx outage, a reset
// socket — by running the weighted matcher instead, and answered a MISSING
// Anthropic key the same way. The reproduction (finding §2): a 401 on a
// Finnish supplier bill produced a weighted `suggested` row at 0.95 with no
// evaluation and no trace that the strong model never ran — a heuristic
// replacement decision the two-terminal doctrine forbids. A provider
// failure is a TRANSPORT fact (AGENTS.md lesson AY), never a matching
// judgment: it must not become a weighted match, a no_match verdict, or
// (through the doc-first drain) a request for evidence the book already
// holds.
//
// THE SHAPE. On a typed provider failure (providerTransport.js) the wrapper
//   1. writes the CAUSE on the document — `documents.payload
//      .reconciliation_provider_failure` (code / status / reason / owner /
//      matcher_family, attempts and first/last timestamps accumulate),
//   2. audits `document.reconciliation_provider_failed` once per distinct
//      failure (code + status) per document,
//   3. returns a ZERO stats shape carrying `provider_failure` — no weighted
//      body, no throw (the parse that produced the document continues),
// and the existing coding-convergence clock re-drives every receipted
// document through the SAME family orchestrator on its bounded cadence until
// the strong model answers; a completed LLM run clears the receipt (audited
// `document.reconciliation_provider_recovered`). The doc-first drain skips a
// receipted document (documentDispositionLlm.js) so it is never dispositioned
// — and never asked about — before its matcher has actually run.
//
// A credential failure (PROVIDER_KEY_MISSING / PROVIDER_UNAUTHORIZED) carries
// `owner: 'operator'`: the clock keeps re-driving it (one bounded attempt per
// tick per client, then it stops for the tick), the receipt names the key,
// and nothing about it ever reaches the business owner.
//
// This module decides no match and calls no model: it receipts, discovers,
// and re-drives the existing named orchestrators.

import { withFirmDbClient } from './firmDb.js';
import { JEV_PREPARATION_CONTRACT } from './documentDispositionShape.js';
import { runReceiptReconciliationForDocument } from './receiptReconciliation.js';
import { autoExplainReceiptForDocument } from './receiptAutoExplain.js';
import { runSalesInvoiceReconciliationForDocument } from './salesInvoiceReconciliation.js';
import { autoExplainSalesInvoiceForDocument } from './salesInvoiceAutoExplain.js';
import { runBillReconciliationForDocument } from './billReconciliation.js';
import { autoExplainBillForDocument } from './billAutoExplain.js';
import { runPaymentAccountStatementReconciliationForDocument } from './paymentAccountStatementReconciliation.js';
import { runPaymentConfirmationReconciliationForDocument } from './paymentConfirmationReconciliation.js';
import { runPayoutReconciliationForDocument } from './payoutReconciliation.js';
import { onReconciliationRunCompleted } from './loopsShadowProducers.js';
import { isProviderFailure, providerFailureReceipt, providerKeyMissing } from './providerTransport.js';

export const RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY = 'reconciliation_provider_failure';
export const RECONCILIATION_PROVIDER_FAILED_AUDIT_ACTION = 'document.reconciliation_provider_failed';
export const RECONCILIATION_PROVIDER_RECOVERED_AUDIT_ACTION = 'document.reconciliation_provider_recovered';
// Per convergence tick: enough to drain a small backlog in a few ticks,
// bounded so an outage over a large book converges instead of blowing the
// tick's budget.
export const RECONCILIATION_PROVIDER_RECOVERY_MAX_DOCUMENTS = 10;

// The LLM matcher self-disables with this reason when the Anthropic key is
// absent (every family, `DISABLED_STATS('no_anthropic_api_key')`). It is a
// provisioning gap that rests on the operator — typed here so the wrappers
// treat it exactly like a rejected key, never as a reason to run the
// weighted body.
export const LLM_MATCHER_NO_KEY_REASON = 'no_anthropic_api_key';
export const providerFailureFromDisabledStats = (stats) =>
  (stats?.disabled && stats.disabled_reason === LLM_MATCHER_NO_KEY_REASON
    ? providerKeyMissing('anthropic', { keyName: 'ANTHROPIC_API_KEY' })
    : null);

// Write the receipt on the document (payload key + audit), inside whatever
// transaction the caller holds. Returns the persisted receipt.
export const recordReconciliationProviderFailureWithClient = async ({
  client,
  firmId,
  clientId,
  documentId,
  family,
  failure,
  logTag = 'reconciliation'
} = {}) => {
  if (!client || !firmId || !clientId || !documentId) return null;
  const cause = providerFailureReceipt(failure);
  if (!cause) throw new Error('recordReconciliationProviderFailureWithClient needs a typed provider failure');
  const now = new Date().toISOString();
  const priorResult = await client.query(
    `select payload->$3::text as receipt from documents where firm_id = $1 and id = $2`,
    [firmId, documentId, RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY]
  );
  const prior = priorResult.rows[0]?.receipt && typeof priorResult.rows[0].receipt === 'object' ? priorResult.rows[0].receipt : null;
  const sameFailure = Boolean(prior && prior.code === cause.code && (prior.status ?? null) === (cause.status ?? null));
  // Two counters, deliberately distinct: `request_attempts` is how many
  // requests the ONE failed operation made (the transport's retries);
  // `attempts` is how many operations have failed the same way on this
  // document (the clock's re-drives) — the same meaning the coding receipt
  // gives it (db/coding.js).
  const { attempts: requestAttempts, ...causeRest } = cause;
  const receipt = {
    ...causeRest,
    request_attempts: Number(requestAttempts) || 1,
    matcher_family: family || prior?.matcher_family || null,
    attempts: (sameFailure ? Number(prior.attempts) || 0 : 0) + 1,
    first_failed_at: sameFailure && prior.first_failed_at ? prior.first_failed_at : now,
    last_failed_at: now
  };
  await client.query(
    `update documents
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb),
            updated_at = now()
      where firm_id = $1 and id = $2`,
    [firmId, documentId, RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY, JSON.stringify(receipt)]
  );
  if (!sameFailure) {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, $4, 'document', $5, $6::jsonb)`,
      [firmId, clientId, logTag, RECONCILIATION_PROVIDER_FAILED_AUDIT_ACTION, documentId, JSON.stringify(receipt)]
    );
  }
  console.error(`[${logTag}] provider failure receipted on the document — no verdict written, no weighted fallback`, {
    documentId, code: receipt.code, status: receipt.status, reason: receipt.reason, owner: receipt.owner, attempts: receipt.attempts
  });
  return receipt;
};

// The wrapper-side helper: receipt the failure and return the family's
// ZERO stats shape carrying it (`accumulate(stats)` in the statement-side
// loop reads nothing from it; the recovery clock reads `provider_failure`).
export const providerFailureStats = async ({ zeroStats, ...args } = {}) => {
  const receipt = await recordReconciliationProviderFailureWithClient(args);
  return { ...(typeof zeroStats === 'function' ? zeroStats() : {}), provider_failure: receipt };
};

// Clear the receipt once the strong model has actually run for the document
// (any verdict). Audited only when something was cleared.
export const clearReconciliationProviderFailureWithClient = async ({ client, firmId, clientId, documentId, logTag = 'reconciliation' } = {}) => {
  if (!client || !firmId || !documentId) return false;
  const result = await client.query(
    `update documents
        set payload = payload - $3::text,
            updated_at = now()
      where firm_id = $1 and id = $2 and payload ? $3::text
      returning payload`,
    [firmId, documentId, RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY]
  );
  if (!result.rowCount) return false;
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'system', $3, $4, 'document', $5, $6::jsonb)`,
    [firmId, clientId, logTag, RECONCILIATION_PROVIDER_RECOVERED_AUDIT_ACTION, documentId, JSON.stringify({ recovered_at: new Date().toISOString() })]
  );
  return true;
};

// The same document population the statement-side loop re-matches
// (parseDocumentsDb.js runReconciliationForBankStatementInDb), restricted to
// documents still carrying a provider-failure receipt. Oldest failure first.
export const RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES = Object.freeze([
  'receipt', 'supplier_bill', 'sales_invoice', 'issued_receipt',
  'payment_account_statement', 'payment_confirmation', 'payout_statement', 'deposit_slip'
]);
// A pre-fix signed credit was incorrectly receipted as having a negative
// available balance. Re-drive that exact obsolete verdict through the same
// family worker. A current verdict (including a genuine no-match) leaves this
// pool, so this is a bounded repair, not a recurring request to reconsider a
// model's accounting judgment.
export const STALE_SIGNED_CREDIT_EVALUATION_SQL = `(
  d.document_type in ('sales_invoice', 'issued_receipt') and d.payment_status = 'credit_note'
  and d.total_amount < 0
  and exists (
    select 1 from reconciliation_evaluations e
     where e.firm_id = d.firm_id and e.client_id = d.client_id
       and e.target_type = 'document' and e.target_id = d.id
       and e.matcher_family = 'sales_invoice'
       and e.unmatchable_reason = 'credit_note_no_bank_line'
       and case when jsonb_typeof(e.payload->'remaining_available') = 'number'
         then (e.payload->>'remaining_available')::numeric < 0 else false end
  )
)`;
// A document closed by the retired document-side "immaterial" Jev terminal
// carries no settlement channel: nothing established how it was paid, and the
// relationship to its bank line was never made. Re-drive it once through its
// family matcher; the fresh family evaluation leaves this pool.
export const STALE_UNSETTLED_DOCUMENT_DISPOSITION_SQL = `(
  d.payload->'no_line_disposition'->>'disposition' = 'auto_explain'
  and d.payload->'no_line_disposition'->>'decision_engine' = 'jev'
  and coalesce(d.payload->'no_line_disposition'->>'settlement_channel', 'unknown') not in ('cash', 'personal_card', 'uncovered_account')
  and not exists (
    select 1 from reconciliation_evaluations e
     where e.firm_id = d.firm_id and e.client_id = d.client_id
       and e.target_type = 'document' and e.target_id = d.id
       and e.payload->>'decision_engine' = 'jev'
       and e.matcher_family not in ('document_no_line_disposition', 'jev_first_decision')
       and e.evaluated_at > coalesce((d.payload->'no_line_disposition'->>'evaluated_at')::timestamptz, '-infinity'::timestamptz)
  )
)`;
// FI-02 (INV-11): a material correction superseded the document's verdicts
// and reopened its settled matches (documentCorrections.js). The document is
// owed ONE fresh family evaluation: it stays in this pool until a live verdict
// newer than the correction lands, which is what takes it out again. The pool
// is the receipts' — a correction-superseded verdict, or a match still carrying
// the correction's live marker or reopen receipt — never a timer.
// The `superseded_by` value a verdict carries when a material document
// correction moved the basis it was judged on (written by
// loopsShadowProducers.invalidateReconciliationForCorrectedDocument).
export const DOCUMENT_CORRECTION_SUPERSEDED_BY = 'document_correction';
export const CORRECTION_REEVALUATION_PENDING_CODE = 'DOCUMENT_CORRECTED_REEVALUATION_PENDING';
export const CORRECTION_REEVALUATION_PENDING_SQL = `exists (
  select 1 from (
    select ce.evaluated_at as reopened_at from reconciliation_evaluations ce
     where ce.firm_id = d.firm_id and ce.client_id = d.client_id
       and ce.target_type = 'document' and ce.target_id = d.id
       and ce.verdict = 'superseded' and ce.payload->>'superseded_by' = '${DOCUMENT_CORRECTION_SUPERSEDED_BY}'
    union all
    select coalesce((cm.payload->'invalidated_by_correction'->>'invalidated_at')::timestamptz,
                    (cm.payload->'reopened_by_correction'->>'reopened_at')::timestamptz) as reopened_at
      from reconciliation_matches cm
     where cm.firm_id = d.firm_id and cm.client_id = d.client_id and cm.matched_object_id = d.id
       and cm.status in ('confirmed', 'auto_matched', 'suggested')
       and (cm.payload ? 'invalidated_by_correction' or cm.payload ? 'reopened_by_correction')
  ) reopened
  where not exists (
    select 1 from reconciliation_evaluations fe
     where fe.firm_id = d.firm_id and fe.client_id = d.client_id
       and fe.target_type = 'document' and fe.target_id = d.id
       and fe.verdict <> 'superseded'
       and fe.payload->>'matcher_mode' is distinct from 'shadow'
       and fe.evaluated_at > reopened.reopened_at)
)`;
// A reopened pair whose fresh evaluation already ran (whichever path ran it)
// without re-proposing it: it is owed its retirement, not another evaluation.
export const CORRECTION_RETIREMENT_PENDING_SQL = `exists (
  select 1 from reconciliation_matches rm
   where rm.firm_id = d.firm_id and rm.client_id = d.client_id and rm.matched_object_id = d.id
     and rm.status = 'suggested'
     and rm.payload ? 'reopened_by_correction'
     and rm.updated_at <= (rm.payload->'reopened_by_correction'->>'reopened_at')::timestamptz
     and exists (
       select 1 from reconciliation_evaluations re
        where re.firm_id = d.firm_id and re.client_id = d.client_id
          and re.target_type = 'document' and re.target_id = d.id
          and re.verdict <> 'superseded'
          and re.payload->>'matcher_mode' is distinct from 'shadow'
          and re.evaluated_at > (rm.payload->'reopened_by_correction'->>'reopened_at')::timestamptz)
)`;
// A handed-off decision is still owed work until its consumer leaves a final
// family receipt. A database write failure is not a provider outage or no-match.
const PENDING_EXECUTION_PREDICATE_SQL = `e.firm_id=d.firm_id and e.client_id=d.client_id and e.target_id=d.id
    and ((e.payload->>'decision_engine'='jev'
      and e.payload->>'next_action' in ('reconsider_current_evidence','retry_writer','reasoning'))
      or (e.unmatchable_reason='credit_note_write_failed' and e.payload->>'next_action'='retry_writer'))`;
export const DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL = `
  select d.id as document_id, d.client_id, d.document_type,
         coalesce(d.payload->'${RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY}',
           jsonb_build_object('code', case when ${STALE_SIGNED_CREDIT_EVALUATION_SQL}
             then 'SIGNED_CREDIT_REMAINING_STALE' when ${STALE_UNSETTLED_DOCUMENT_DISPOSITION_SQL}
             then 'DOCUMENT_DISPOSITION_UNSETTLED' when ${CORRECTION_REEVALUATION_PENDING_SQL} or ${CORRECTION_RETIREMENT_PENDING_SQL}
             then '${CORRECTION_REEVALUATION_PENDING_CODE}' else 'RECONCILIATION_EXECUTION_PENDING' end)) as receipt
    from documents d
   where d.firm_id = $1
     and (d.payload ? '${RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY}'
       or ${STALE_SIGNED_CREDIT_EVALUATION_SQL}
       or ${STALE_UNSETTLED_DOCUMENT_DISPOSITION_SQL}
       or ${CORRECTION_REEVALUATION_PENDING_SQL}
       or ${CORRECTION_RETIREMENT_PENDING_SQL}
       or exists(select 1 from reconciliation_evaluations e where ${PENDING_EXECUTION_PREDICATE_SQL}
         and (coalesce((e.payload->>'attempt_count')::int,1)<3
           or (e.payload->>'decision_engine'='jev' and coalesce(e.payload->>'preparation_contract','') <> '${JEV_PREPARATION_CONTRACT}'))
         and e.evaluated_at < now()-interval '5 minutes'))
     and d.parse_status = 'completed'
     and d.total_amount is not null
     and d.duplicate_of is null
     and d.document_type = any($3::text[])
   order by (d.payload->'${RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY}'->>'last_failed_at') asc nulls first, d.id asc
   limit $2
`;

// One document through its family orchestrator — the SAME entry points the
// parse and statement paths call, followed by the same auto-explain leg
// (per-firm gated inside; soft-degrades like the statement loop).
export const runFamilyReconciliationForDocument = async ({ client, firmId, clientId, document } = {}) => {
  const documentId = document?.id;
  const type = document?.document_type;
  const args = { client, firmId, clientId, documentId };
  const explain = async (fn) => {
    try { await fn({ ...args, parseRunId: null }); } catch (error) {
      console.error('[reconciliationProviderRecovery] auto-explain threw — recovery continues', { documentId, error: error?.message || String(error) });
    }
  };
  if (type === 'receipt') {
    const stats = await runReceiptReconciliationForDocument(args);
    if (!stats?.provider_failure) await explain(autoExplainReceiptForDocument);
    return stats;
  }
  if (type === 'sales_invoice' || type === 'issued_receipt') {
    const stats = await runSalesInvoiceReconciliationForDocument(args);
    if (!stats?.provider_failure) await explain(autoExplainSalesInvoiceForDocument);
    return stats;
  }
  if (type === 'supplier_bill') {
    const stats = await runBillReconciliationForDocument(args);
    if (!stats?.provider_failure) await explain(autoExplainBillForDocument);
    return stats;
  }
  if (type === 'payment_account_statement') return runPaymentAccountStatementReconciliationForDocument(args);
  if (type === 'payment_confirmation') return runPaymentConfirmationReconciliationForDocument(args);
  if (type === 'payout_statement' || type === 'deposit_slip') return runPayoutReconciliationForDocument(args);
  return null;
};

// The re-drive step (called by the coding-convergence tick). Discovers the
// receipted documents, groups them by client, and runs each through its
// family orchestrator under the client's readiness admission. The FIRST
// document that fails on the provider again stops that client's loop for
// the tick — a dead provider costs one bounded call per client per tick,
// never one per document. A completed run clears the receipt (in the
// wrapper) and the run-completed hook reconciles the gap cases.
export const recoverReconciliationProviderFailures = async ({
  client,
  firmId,
  limit = RECONCILIATION_PROVIDER_RECOVERY_MAX_DOCUMENTS,
  runWorkerAdmissionFn = async ({ work }) => work(),
  withClient = withFirmDbClient,
  runFamilyFn = runFamilyReconciliationForDocument,
  onRunCompletedFn = onReconciliationRunCompleted,
  // FI-02: a corrected document's reopen (before its fresh evaluation) and the
  // retirement of a reopened pair the evaluation did not re-propose (after).
  // Both take their own checkout, so they run outside the work client.
  reopenCorrectedFn = null,
  retireUnrefreshedFn = null
} = {}) => {
  if (!firmId) return [];
  const bound = Math.min(Math.max(Number(limit) || RECONCILIATION_PROVIDER_RECOVERY_MAX_DOCUMENTS, 1), 50);
  const discover = (c) => c.query(DISCOVER_RECONCILIATION_PROVIDER_FAILURES_SQL, [firmId, bound, [...RECONCILIATION_PROVIDER_RECOVERY_DOC_TYPES]]);
  const discovered = client ? await discover(client) : await withClient(discover);
  const byClient = new Map();
  for (const row of discovered.rows || []) {
    if (!row?.client_id || !row.document_id) continue;
    if (!byClient.has(row.client_id)) byClient.set(row.client_id, []);
    byClient.get(row.client_id).push(row);
  }
  const results = [];
  const isCorrection = (row) => row.receipt?.code === CORRECTION_REEVALUATION_PENDING_CODE;
  for (const [clientId, docs] of byClient) {
    const retireFor = async (documentId) => {
      if (!retireUnrefreshedFn) return [];
      try { return await retireUnrefreshedFn({ firmId, clientId, documentId }); } catch (error) {
        console.error('[reconciliationProviderRecovery] reopened-pair retirement threw', { documentId, error: error?.message || String(error) });
        return [];
      }
    };
    const retiredBefore = new Map();
    for (const row of docs.filter(isCorrection)) {
      // A fresh evaluation another path already ran: retire first, so the
      // pool never spends a second evaluation on it.
      const retired = await retireFor(row.document_id);
      if (retired.length) retiredBefore.set(row.document_id, retired);
      if (reopenCorrectedFn) {
        try { await reopenCorrectedFn({ firmId, clientId, documentId: row.document_id }); } catch (error) {
          console.error('[reconciliationProviderRecovery] correction reopen threw — the evaluation still runs on the live state', { documentId: row.document_id, error: error?.message || String(error) });
        }
      }
    }
    const recoveredCorrections = [];
    try {
      await runWorkerAdmissionFn({ firmId, clientId, work: () => withClient(async (workClient) => {
        const completed = [];
        for (const row of docs) {
          const entry = { client_id: clientId, document_id: row.document_id, family: row.document_type, prior: row.receipt?.code || null };
          try {
            if (isCorrection(row)) {
              const owed = await workClient.query(
                `select ${CORRECTION_REEVALUATION_PENDING_SQL} as pending from documents d where d.firm_id = $1 and d.id = $2`,
                [firmId, row.document_id]
              );
              if (!owed.rows[0]?.pending) {
                entry.outcome = 'recovered';
                entry.retired_match_ids = retiredBefore.get(row.document_id) || [];
                results.push(entry);
                continue;
              }
            }
            const stats = await runFamilyFn({ client: workClient, firmId, clientId, document: { id: row.document_id, document_type: row.document_type } });
            if (stats?.provider_failure) {
              entry.outcome = 'provider_failure';
              entry.failure = { code: stats.provider_failure.code, status: stats.provider_failure.status, owner: stats.provider_failure.owner, attempts: stats.provider_failure.attempts };
              results.push(entry);
              // The provider is still down for this client: stop spending
              // on it this tick; the receipts keep the documents in the pool.
              break;
            }
            const still = await workClient.query(
              `select (d.payload ? $3::text or ${STALE_SIGNED_CREDIT_EVALUATION_SQL}
                 or ${CORRECTION_REEVALUATION_PENDING_SQL}
                 or exists(select 1 from reconciliation_evaluations e where ${PENDING_EXECUTION_PREDICATE_SQL})) as receipted
                 from documents d where d.firm_id = $1 and d.id = $2`,
              [firmId, row.document_id, RECONCILIATION_PROVIDER_FAILURE_PAYLOAD_KEY]
            );
            entry.outcome = still.rows[0]?.receipted ? 'unchanged' : 'recovered';
            entry.stats = stats && typeof stats === 'object'
              ? {
                  disabled: Boolean(stats.disabled),
                  suggested_inserted: Number(stats.suggested_inserted || 0),
                  auto_match_inserted: Number(stats.auto_match_inserted || 0),
                  auto_match_upgraded: Number(stats.auto_match_upgraded || 0)
                }
              : null;
            if (entry.outcome === 'recovered') completed.push({ targetType: 'document', targetId: row.document_id });
            if (entry.outcome === 'recovered' && isCorrection(row)) recoveredCorrections.push(row.document_id);
            results.push(entry);
          } catch (error) {
            entry.outcome = 'error';
            entry.error = error?.message || String(error);
            results.push(entry);
          }
        }
        if (completed.length && typeof onRunCompletedFn === 'function') {
          try { await onRunCompletedFn({ client: workClient, firmId, clientId, targets: completed }); } catch (error) {
            console.error('[reconciliationProviderRecovery] run-completed hook threw', { clientId, error: error?.message || String(error) });
          }
        }
      }) });
    } catch (error) {
      results.push({ client_id: clientId, outcome: 'error', error: error?.message || String(error) });
    }
    for (const documentId of recoveredCorrections) {
      const retired = await retireFor(documentId);
      const entry = results.find((item) => item.document_id === documentId);
      if (entry && retired.length) entry.retired_match_ids = retired;
    }
  }
  return results;
};

export const recoverReconciliationProviderFailuresInDb = async (args = {}) => {
  // Imported at run time: documentCorrections sits under the parse worker's
  // import graph, which this module's family matchers also reach.
  const { reopenMatchesInvalidatedByCorrection, retireUnrefreshedReopenedMatches } = await import('./documentCorrections.js');
  return recoverReconciliationProviderFailures({
    reopenCorrectedFn: reopenMatchesInvalidatedByCorrection,
    retireUnrefreshedFn: retireUnrefreshedReopenedMatches,
    ...args,
    withClient: withFirmDbClient
  });
};

// A wrapper's failure branch, shared by every family: a typed provider
// failure (thrown, or the no-key self-disable) becomes the receipt + the
// stats shape; anything else returns null so the wrapper keeps its own
// (infrastructure) fallback. `isProviderFailure` is re-exported so the
// wrappers import one module.
export { isProviderFailure };
