// Jurisdiction-policy incidents use the existing audit spine and coding clock.
// Failure is recorded only after the caller's failed transaction is rolled back;
// recovery co-commits with a successful coding decision. No accounting state is
// changed here, and an audit receipt alone never claims an owner was asked.
// Ledger refusals with an automatic owner, named in one place so the workers
// and the case-health projection agree on who moves a refused row:
//   - the coding evidence clock (recoverChangedCodingEvidenceInDb) re-runs the
//     coder against the current source, at most CODING_CONFLICT_MAX_RECONSIDERATIONS
//     times per case revision; an unresolved treatment joins it only on a
//     statement-only line (the clock decides that from the live match);
//   - the source re-read lane (codingRefusalRecovery.js) rechecks a settled
//     source's printed tax for the two codes below.
// A bank line refused because the business is not recorded as VAT/ALV
// registered on its date, one per country posting policy that raises it (each
// declares it on its taxRegistration). The clock re-runs the coder with the
// refusal on posting_recovery; the coder's contract (transactionLlm.js) turns
// it into the owner's registration question while the record still does not
// say registered. Nothing here lets the line post: the policy still decides.
export const TAX_REGISTRATION_REFUSALS = Object.freeze([
  'TRANSACTION_ALV_REGISTRATION_REQUIRED',
  'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED'
]);
export const CODING_EVIDENCE_RECONSIDERED_REFUSALS = Object.freeze([
  ...TAX_REGISTRATION_REFUSALS,
  'TRANSACTION_ALV_CODING_SOURCE_CONFLICT',
  'TRANSACTION_ALV_EVIDENCE_REQUIRED',
  'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED',
  'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT',
  'TRANSACTION_DOCUMENT_ALLOCATION_ACCOUNT_CONFLICT',
  'TRANSACTION_SOURCE_ACCOUNT_CLASS_CONFLICT',
  'REFUND_GROUP_CODING_CONFLICT'
]);
// The unresolved-treatment refusal, one per country posting policy that
// raises it (finland/postingPolicy.js, gb/postingPolicy.js). The clock and the
// source re-read lane treat each the same way.
export const UNRESOLVED_TREATMENT_REFUSALS = Object.freeze([
  'TRANSACTION_ALV_TREATMENT_UNRESOLVED',
  'TRANSACTION_GB_VAT_TREATMENT_UNRESOLVED'
]);
export const POSTING_SOURCE_RECHECK_REFUSALS = Object.freeze([
  'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH',
  ...UNRESOLVED_TREATMENT_REFUSALS
]);
export const CODING_CONFLICT_MAX_RECONSIDERATIONS = 3;

// H-5a (Kari, 2026-09-24, option 2). A matched Finnish line whose coder still
// answers the unsure marker after its one source re-read splits on what the
// verified source PRINTS, decided once by the coder's contract
// (transactionLlm.js) and persisted on the coding's tax_unresolved_guard.
// Incomplete or inconsistent printed tax is a genuine source discrepancy: the
// line becomes the document_discrepancy ask. Clear printed tax is Donna's
// failure, not the owner's: no ask; the coding keeps its answer with this
// NAMED cause, the posting policy refuses it, and it rests. The clock never
// re-admits a row carrying that receipt, and the display (caseHealth.js,
// reconcileActivity.js) renders it stuck with its cause — never retrying,
// reconciled, an owner question or an anonymous stall. It is a deliberate,
// visible violation waiting on the baseline diagnosis.
export const UNSETTLED_TREATMENT_CLEAR_SOURCE = 'coder_left_printed_treatment_unsettled';
// Payload keys read either nested (a transactions row) or flattened (a DTO).
export const unsettledTreatmentOnClearSource = (row = {}) => {
  const read = key => row?.payload?.[key] ?? row?.[key] ?? null;
  const refusal = read('ledger_post_refusal'), recovery = read('posting_recovery');
  const guard = read('ai_suggestion')?.tax_unresolved_guard;
  if (refusal?.code !== 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' || recovery?.state !== 'reconsidered'
    || recovery?.review?.source_verified !== true || guard?.cause !== UNSETTLED_TREATMENT_CLEAR_SOURCE) return null;
  return { cause: guard.cause, refusal_code: refusal.code, source_tax: guard.source_tax || null };
};

// H-7b (Kari, 2026-09-24, option 1). A duplicate/refund group whose members
// fall in different policy windows is refused as a group
// (assertRefundGroupPolicyWindow) before any decision is persisted. No worker
// can settle it: it is not an owner fact, and deciding it under one window is
// an accounting-policy call that has not been made. The batch coder records
// on each member's refusal the case revision (codingCaseRevision) it was
// refused under; while that stays current, coder admission (discovery, the
// coder's pools) excludes the member, and the display names this refusal —
// stuck with its cause, never "in progress", the anonymous cycle expiry, a
// reconciled row or an owner question. When any member's case revision
// changes (a new document, match or attributable reply), the evidence clock
// clears the refusal on every member and the group is admitted normally.
export const CROSS_WINDOW_GROUP_REFUSAL = 'REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED';
// Payload keys read either nested (a transactions row) or flattened (a DTO).
export const refusedCrossWindowGroup = (row = {}) => {
  const refusal = row?.payload?.ledger_post_refusal ?? row?.ledger_post_refusal ?? null;
  const members = refusal?.details?.transaction_ids;
  if (refusal?.code !== CROSS_WINDOW_GROUP_REFUSAL || !refusal.case_evidence_digest
    || !Array.isArray(members) || !members.includes(row?.id)) return null;
  return { code: refusal.code, message: refusal.error || null, transaction_ids: members, case_evidence_digest: refusal.case_evidence_digest };
};
// The same rule over a transaction alias `t`, for the admission queries.
export const REFUSED_CROSS_WINDOW_GROUP_SQL = `(t.payload->'ledger_post_refusal'->>'code' = '${CROSS_WINDOW_GROUP_REFUSAL}'
       and coalesce(t.payload->'ledger_post_refusal'->>'case_evidence_digest', '') <> ''
       and coalesce(t.payload->'ledger_post_refusal'->'details'->'transaction_ids', '[]'::jsonb) ? t.id)`;

// The evidence clock counts its reconsiderations per case revision AND per
// coding contract. A receipt written under an earlier contract counts no
// attempts: when the coder's contract is repaired (2026-09-21: the unsure tax
// marker became a source-document ask for EVERY engine, not only Jev's own
// resolved terminal), rows that spent the bound under the old shape re-enter
// the same clock once, without a rebuild or re-upload, and the bound then
// holds again under the contract that repaired them. The projection
// (caseHealth.js) reads the same helper so "clock-owned" and "exhausted"
// cannot drift between the worker and the display.
export const CODING_RECONSIDERATION_CONTRACT = 'coding-reconsideration-v2-shared-unsure-treatment';
export const codingReconsiderationAttempts = (receipt) =>
  receipt && typeof receipt === 'object' && receipt.contract === CODING_RECONSIDERATION_CONTRACT
    ? Number(receipt.attempts || 0) : 0;

export const CODING_POLICY_FAILED_ACTION = 'transaction.coding.policy_failed';
export const CODING_POLICY_RECOVERED_ACTION = 'transaction.coding.policy_recovered';

// Both existing coder discovery and its direct transaction pool use this same
// predicate (transaction alias `t`). A failure can arrive after a concurrent
// successful proposal, so presence of that proposal cannot hide owed recovery.
// Append order, not transaction-start timestamps, identifies the current receipt.
export const ACTIVE_CODING_POLICY_FAILURE_SQL = `(
  select policy_event.action
    from audit_events policy_event
   where policy_event.firm_id = t.firm_id
     and policy_event.client_id = t.client_id
     and policy_event.resource_type = 'transaction'
     and policy_event.resource_id = t.id
     and policy_event.metadata->>'operation' = 'coding'
     and policy_event.action in ('${CODING_POLICY_FAILED_ACTION}', '${CODING_POLICY_RECOVERED_ACTION}')
   order by policy_event.id desc
   limit 1
) = '${CODING_POLICY_FAILED_ACTION}'`;

// Administrative consumers and named accounting writers serialize the same
// incident identity. SAVEPOINT detects a caller-owned transaction without relying
// on pg internals; an autocommit failure opens its own short transaction. No source
// row is locked here, preserving the existing readiness/source writer lock order.
export const withCodingPolicyIncidentLock = async ({ client, firmId, clientId, transactionId, operation = 'coding' }, callback) => {
  if (typeof client?.totalCount === 'number') throw new TypeError('Policy incident writes require a checked-out database client, not a pool.');
  let ownsTransaction = false;
  try { await client.query('savepoint runtime_policy_incident'); }
  catch (error) {
    if (error?.code !== '25P01') throw error;
    await client.query('begin');
    ownsTransaction = true;
  }
  try {
    const key = JSON.stringify(['runtime_policy_incident', firmId, clientId, transactionId, operation]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const result = await callback();
    await client.query(ownsTransaction ? 'commit' : 'release savepoint runtime_policy_incident');
    return result;
  } catch (error) {
    if (ownsTransaction) await client.query('rollback');
    else {
      await client.query('rollback to savepoint runtime_policy_incident');
      await client.query('release savepoint runtime_policy_incident');
    }
    throw error;
  }
};

const DECIDED = ['applied', 'held', 'posted', 'synced', 'closed'];
const actions = [CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION];

// These are posting safety refusals, not evidence of a missing owner fact.
// Keep them on the existing accountable runtime repair path: retrying unchanged
// coding cannot resolve an unknown treatment or add a missing native tax split.
const AE_POSTING_REPAIR_CONDITIONS = Object.freeze({
  TRANSACTION_AE_VAT_CONNECTOR_UNSUPPORTED:
    'Provide an authoritative supported UAE connector tax mapping, then retry the unchanged source treatment. Do not infer UAE semantics from foreign connector codes or relabel the transaction to bypass the refusal.',
  TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED:
    'Resolve the authoritative UAE VAT coding from held evidence, then retry posting. If an actual business fact is missing, use the existing grounded owner-ask workflow; do not ask the owner to choose a tax treatment.',
  TRANSACTION_AE_VAT_POSTING_UNSUPPORTED:
    'Implement supported native UAE VAT posting for this treatment, then retry the unchanged authoritative coding. Do not relabel the treatment to bypass the missing tax split.',
  TRANSACTION_AE_VAT_CODING_CONFLICT:
    'Resolve the conflicting authoritative UAE VAT coding from held evidence, then retry posting. If an actual business fact is missing, use the existing grounded owner-ask workflow; do not ask the owner to choose a tax treatment.',
  TRANSACTION_AE_VAT_DIRECTION_MISMATCH:
    'Resolve the authoritative UAE VAT coding against the persisted transaction direction and held evidence, then retry posting. If an actual business fact is missing, use the existing grounded owner-ask workflow; do not ask the owner to choose a tax treatment.'
});

export const codingPolicyFailureDisposition = (error) => {
  const reason = String(error?.reasonCode || error?.code || 'coding_policy_unavailable');
  const detail = typeof error?.details?.reason === 'string' ? error.details.reason : null;
  if (reason === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE') {
    return { reason, detail: error.details?.reason_code || detail, ownerFact: false, recode: false, retrySafe: false,
      ownerQuestion: null, unlockCondition: 'Accounting support requires separate qualification and release. Configuration changes or recoding cannot enable posting in this review workspace.' };
  }
  if (reason === 'NATIVE_REVIEW_REFUSED') {
    return { reason, detail, ownerFact: false, recode: false, retrySafe: false, ownerQuestion: null,
      unlockCondition: 'Repair this client\'s native chart lineage or registration record (the refusal names which). Evidence recovery skips the client, and its lines stay hanging, until it verifies.' };
  }
  if (Object.hasOwn(AE_POSTING_REPAIR_CONDITIONS, reason)) {
    return {
      reason, detail, ownerFact: false, recode: false, retrySafe: false,
      ownerQuestion: null, unlockCondition: AE_POSTING_REPAIR_CONDITIONS[reason]
    };
  }
  const ownerFact = reason === 'jurisdiction_unresolved'
    || (reason === 'jurisdiction_context_conflict'
      && ['profile_jurisdiction_conflict', 'entity_jurisdiction_conflict', 'profile_entity_conflict'].includes(detail));
  const recode = (reason === 'jurisdiction_context_conflict'
      && ['coding_policy_receipt_conflict', 'stamped_policy_context_conflict', 'posting_policy_receipt_conflict', 'posting_source_changed'].includes(detail))
    || (reason === 'coding_policy_invalid' && detail === 'tax_code_not_in_policy')
    || ['posting_tax_code_foreign', 'posting_tax_code_invalid'].includes(reason);
  return {
    reason, detail, ownerFact, recode,
    retrySafe: reason === 'coding_policy_unavailable' || reason === 'posting_policy_unavailable' || recode,
    ownerQuestion: detail === 'profile_entity_conflict'
      ? 'The business profile contains conflicting legal forms. What is the business legal form?'
      : detail === 'entity_jurisdiction_conflict'
      ? 'The recorded country and legal form disagree. Which country is this business registered in?'
      : detail === 'profile_jurisdiction_conflict'
        ? 'The business profile contains conflicting countries. Which country is this business registered in?'
        : 'Which country is this business registered in?',
    unlockCondition: detail === 'profile_entity_conflict'
      ? 'Confirm the legal form in About your business.'
      : detail === 'entity_jurisdiction_conflict'
      ? 'Confirm the business country and legal form in business setup.'
      : ownerFact ? 'Confirm jurisdiction in business setup.'
      : recode ? 'Run coding again using the current business profile.'
        : detail === 'evidence_recovery_starved'
          ? 'Ordinary writes are keeping evidence recovery from taking this client\'s fence. It retries every tick and this clears when it gets through; if it persists, pause bulk writes to the client.'
          : 'Repair the runtime policy configuration, then retry this transaction.'
  };
};

const targets = async ({ client, firmId, clientId, transactionIds, recovery = false, operation = 'coding', includeDecided = false }) => {
  if (!client || !firmId || !clientId) throw new TypeError('Coding policy receipt requires client, firmId and clientId.');
  const ids = Array.isArray(transactionIds) ? [...new Set(transactionIds.filter(Boolean))] : null;
  if (ids && !ids.length) return [];
  const result = await client.query(
    `select id from transactions
      where firm_id = $1 and client_id = $2
        and ($3::text[] is null or id = any($3::text[]))
        and ($4::boolean or coalesce(coding_state, '') <> all($5::text[]))
      order by id`,
    [firmId, clientId, ids, recovery, operation === 'posting' || includeDecided ? ['posted', 'synced', 'closed'] : DECIDED]
  );
  return result.rows.map((row) => row.id);
};

const latest = async (client, firmId, clientId, transactionId, operation) => {
  const result = await client.query(
    `select id, action, metadata from audit_events
      where firm_id = $1 and client_id = $2
        and resource_type = 'transaction' and resource_id = $3
        and action = any($4::text[]) and metadata->>'operation' = $5
      order by id desc limit 1`,
    [firmId, clientId, transactionId, actions, operation]
  );
  return result.rows[0] || null;
};

const insert = async ({ client, firmId, clientId, transactionId, action, metadata }) => {
  const result = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata, actor_id)
     values ($1, $2, 'system', $3, 'transaction', $4, $5::jsonb, $6)
     returning id, action, resource_id, metadata, created_at`,
    [firmId, clientId, action, transactionId, JSON.stringify(metadata), metadata.attempted_by || null]
  );
  return result.rows[0];
};

// includeDecided: a client-level stall (the recovery worker could not process the
// client) also covers its APPLIED-but-unposted lines, which the per-line coding
// path never fails; only posted/synced/closed lines are out of scope.
export const recordCodingPolicyFailure = async ({ client, firmId, clientId, transactionIds, error, operation = 'coding', includeDecided = false }) => {
  const { reason, detail, ownerFact, recode, retrySafe, unlockCondition, ownerQuestion } = codingPolicyFailureDisposition(error);
  const automaticRoute = operation === 'posting' ? 'ledger_auto_post' : 'coding_convergence';
  const rows = [];
  for (const transactionId of await targets({ client, firmId, clientId, transactionIds, operation, includeDecided })) {
    await withCodingPolicyIncidentLock({ client, firmId, clientId, transactionId, operation }, async () => {
      if (!(await targets({ client, firmId, clientId, transactionIds: [transactionId], operation, includeDecided })).length) return;
      const previous = await latest(client, firmId, clientId, transactionId, operation);
      const sameFailure = previous?.action === CODING_POLICY_FAILED_ACTION && previous.metadata?.reason_code === reason
        && (previous.metadata?.reason_detail || null) === detail
        && (previous.metadata?.jurisdiction || null) === (error?.jurisdiction || null);
      const attempts = sameFailure ? Math.min(3, Number(previous.metadata?.attempts || 1) + 1) : 1;
      // Three unsuccessful policy reads escalate visibly. Further ticks can still
      // detect repaired configuration, without filling the audit window forever.
      if (sameFailure && (Number(previous.metadata?.attempts) >= 3 || reason === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE')) {
        rows.push(previous);
        return;
      }
      rows.push(await insert({ client, firmId, clientId, transactionId, action: CODING_POLICY_FAILED_ACTION, metadata: {
        operation, reason_code: reason, reason_detail: detail, jurisdiction: error?.jurisdiction || null,
        ...(reason === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE' ? { scope_receipt: error.details, attempted_by: error.actorId || null } : {}),
        error: String(error?.message || reason).slice(0, 300),
        retry_safe: retrySafe,
        attempts,
        escalation_required: !ownerFact && (!retrySafe || attempts >= 3),
        recovery_route: ownerFact ? 'client_profile' : recode ? 'transaction_coding_retry' : retrySafe && attempts < 3 ? automaticRoute : 'runtime_policy_incident',
        recovery_path: ownerFact ? 'client_profile' : recode ? 'transaction_coding_retry' : retrySafe && attempts < 3 ? automaticRoute : 'runtime_policy_incident',
        unlock_condition: unlockCondition,
        ...(ownerFact ? {
          owner_question: ownerQuestion
        } : {}),
        failure_kind: ownerFact ? 'missing_owner_fact' : 'system_failure',
        authority_basis: reason === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE' ? 'retained_processing_scope' : 'coding_policy_resolution'
      } }));
    });
  }
  return rows;
};

export const recordCodingPolicyRecovery = async ({ client, firmId, clientId, transactionIds, policy, operation = 'coding' }) => {
  // Only the exact successful decision set can recover an incident. An omitted
  // set must not turn a successful menu/profile read into whole-client recovery.
  if (!Array.isArray(transactionIds)) throw new TypeError('Coding policy recovery requires transactionIds.');
  const rows = [];
  for (const transactionId of await targets({ client, firmId, clientId, transactionIds, recovery: true })) {
    await withCodingPolicyIncidentLock({ client, firmId, clientId, transactionId, operation }, async () => {
      const previous = await latest(client, firmId, clientId, transactionId, operation);
      if (previous?.action !== CODING_POLICY_FAILED_ACTION) return;
      rows.push(await insert({ client, firmId, clientId, transactionId, action: CODING_POLICY_RECOVERED_ACTION, metadata: {
        operation, recovered_failure_id: String(previous.id),
        jurisdiction: policy?.jurisdiction || null,
        policy_id: policy?.policyId || policy?.id || policy?.policy_id || null,
        policy_version: policy?.policyVersion || policy?.version || policy?.policy_version || null,
        authority_basis: 'coding_policy_resolution'
      } }));
    });
  }
  return rows;
};

const compareId = (a, b) => {
  if (/^\d+$/.test(String(a?.id)) && /^\d+$/.test(String(b?.id))) {
    return BigInt(a.id) > BigInt(b.id) ? 1 : BigInt(a.id) < BigInt(b.id) ? -1 : 0;
  }
  return String(a?.created_at || '').localeCompare(String(b?.created_at || ''));
};

// Pure projection: unrelated lines and operations cannot clear an incident, and
// numeric audit ids retain ordering above Number.MAX_SAFE_INTEGER.
export const codingPolicyFailuresForTransaction = ({ transaction, auditEvents = [] }) => {
  if (!transaction?.id || ['posted', 'synced', 'closed'].includes(transaction.coding_state)) return [];
  const byOperation = new Map();
  for (const row of auditEvents) {
    if (!actions.includes(row?.action) || row.resource_type !== 'transaction' || row.resource_id !== transaction.id) continue;
    if (transaction.client_id && row.client_id && transaction.client_id !== row.client_id) continue;
    if (transaction.firm_id && row.firm_id && transaction.firm_id !== row.firm_id) continue;
    const operation = row.metadata?.operation || 'coding';
    if (operation !== 'posting' && DECIDED.includes(transaction.coding_state)) continue;
    if (!byOperation.has(operation) || compareId(row, byOperation.get(operation)) > 0) byOperation.set(operation, row);
  }
  return [...byOperation.values()].filter((row) => row.action === CODING_POLICY_FAILED_ACTION).map((row) => ({
    system: 'coding_policy', operation: row.metadata?.operation || 'coding',
    failure: row.metadata?.reason_code || 'coding_policy_unavailable',
    reason_detail: row.metadata?.reason_detail || null,
    error: row.metadata?.error || null,
    failure_kind: row.metadata?.failure_kind || 'system_failure',
    retry_safe: row.metadata?.retry_safe === true,
    recovery_path: row.metadata?.recovery_path || 'runtime_policy_incident',
    recovery_route: row.metadata?.recovery_route || row.metadata?.recovery_path || 'runtime_policy_incident',
    attempts: row.metadata?.attempts || 1,
    escalation_required: row.metadata?.escalation_required === true,
    owner_question: row.metadata?.owner_question || null,
    unlock_condition: row.metadata?.unlock_condition || null,
    transaction_id: transaction.id,
    receipt_ref: { table: 'audit_events', id: row.id, path: 'metadata' }
  }));
};
