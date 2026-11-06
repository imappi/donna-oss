import { correctionDeltaLines } from '../ledgerCorrectionLines.js';
import { codingStatutoryEvidenceGap, hasCodingStatutorySource } from '../codingStatutoryEvidence.js';
// Plane S: the exact matched evidence a coding considered, never posting authority.
import { createHash } from 'node:crypto';
import { hash } from '../jevEvidenceContract.js';
import { isDeepStrictEqual } from 'node:util';
import { readJevCase, readJevTransactionCases, evidenceSummary, codingCaseRevision, projectJevBankSource } from '../jevPreview.js';
import { verifyNativeChartObservation, verifyNativeRegistrationObservation } from '../nativeChartLineage.js';
import { nativeCodingContext } from '../codingAccountChoices.js';
import { resolveCodingPolicy, codingPolicyReceipt } from '../codingPolicy.js';
import { retainedProcessingScopeDecision, isNativeReviewRefusal } from '../runtimeReadinessAdmission.js';
import { loadMatchedDocumentsForTransactions } from './reconcile.js';
import { withFirmDbClient } from './pool.js';
import { rowToTransactionPayload } from './transactions.js';
import { applyCodingTransition } from '../codingState.js';
import { documentSourceComponents, allocationAccountClassConflict, sourceSideAccountClassConflict } from '../documentAllocationComponents.js';
import { ledgerAccountTypeFor } from '../ledger.js';
import { roleForSeedName, roleMeta } from '../accountRoles.js';
import { codingRevenueEvidenceGap } from '../codingRevenueEvidence.js';
import { codingChoiceFailure, nativeAccountChoices } from '../codingAccountChoices.js';
import { readClientCodingContextWithClient, isFenceContention, nativeSourceFenceBusy } from './codingPolicyContext.js';
import { toIsoDay } from '../dates.js';
import { codingSourceBusinessUseConflict, sourceBusinessUseQuestion, sourceBusinessUseFact } from '../sourceBusinessUse.js';
import { hasJevResolvedCoding } from '../jevDecisionReceipt.js';
import { CODING_EVIDENCE_RECONSIDERED_REFUSALS, CODING_CONFLICT_MAX_RECONSIDERATIONS, CODING_RECONSIDERATION_CONTRACT, codingReconsiderationAttempts, unsettledTreatmentOnClearSource, refusedCrossWindowGroup, REFUSED_CROSS_WINDOW_GROUP_SQL, CROSS_WINDOW_GROUP_REFUSAL, recordCodingPolicyFailure, recordCodingPolicyRecovery, CODING_POLICY_FAILED_ACTION } from '../codingPolicyRecovery.js';

// Derived routing metadata is not new source material. Keep the original
// content digest compatible while still carrying family into the coding menu.
export const codingEvidenceDigest = document => hash(document
  ? { ...document, source_family: undefined, matched_at: undefined, parse_summary: evidenceSummary(document.parse_summary) || null } : null);

export const currentCodingEvidence = async ({ client, firmId, clientId, transactionId }) =>
  (await loadMatchedDocumentsForTransactions({client,firmId,clientId,transactionIds:[transactionId]})).get(transactionId) || null;

// Reuse the case reader and its source revision at generation and every native
// apply boundary. Operational coding/ask receipts do not stale their own work.
export const nativeCodingSourceReceipt = (caseEvidence) => ({ version: 1,
  firm_id: caseEvidence.scope.firm_id, client_id: caseEvidence.scope.client_id,
  transaction_id: caseEvidence.focal.id,
  revision: codingCaseRevision(caseEvidence, { completeSources: true }) });

// One receipt byte shape for current acceptance and historical authentication.
// Writers attach the audit id only after the same transaction persists it.
const effectiveNativeReviewSource = transaction => transaction.native_source || transaction.ai_suggestion?.native_source;
const nativeReviewBody = ({ transaction, context, policyReceipt, actorId, authorityBasis }) => {
  if (!context) return null;
  if (!actorId || actorId === 'system' || !authorityBasis) codingChoiceFailure('review_acceptance_authority_required');
  const source = effectiveNativeReviewSource(transaction);
  if (!source) codingChoiceFailure('source_receipt_required');
  return { version: 1, scope: 'document_processing_review_only', review_outcome: 'saved',
    posting: 'unavailable', reason: 'processing_review_only', accounting_ready: false,
    firm_id: context.client_life.firm_id, client_id: context.client_life.client_id,
    transaction_id: transaction.id, client_life: context.client_life,
    birth_receipt: { store: 'audit_events', id: context.receipt_id, digest: context.receipt_digest },
    decision_digest: acceptedCodingDigest(transaction), account_code: transaction.account_code ?? null,
    category: transaction.category ?? null, source, policy: policyReceipt,
    accepted_by: actorId, authority_basis: authorityBasis };
};

export const nativeReviewScopeBody = ({ transaction, policy, actorId, authorityBasis }) =>
  policy?.nativeMenu?.context ? nativeReviewBody({ transaction, context: policy.nativeMenu.context,
    policyReceipt: codingPolicyReceipt(policy), actorId, authorityBasis }) : null;

// Authenticate history without pretending its saved policy is executable today.
// Current decision + retained birth + exact item-bound immutable audit own this
// baseline. Source equality and today's resolved policy are separate checks.
const authenticNativeReviewAcceptance = ({ row, context, audit }) => {
  const transaction = rowToTransactionPayload(row), stamp = transaction.review_scope;
  if (row.coding_state !== 'applied' || row.payload?.ledger_journal_id || !stamp
    || stamp.version !== 1 || typeof stamp.accepted_by !== 'string' || !stamp.accepted_by.trim() || stamp.accepted_by === 'system'
    || typeof stamp.authority_basis !== 'string' || !stamp.authority_basis.trim() || stamp.acceptance_audit?.store !== 'audit_events'
    || !audit?.metadata?.review_scope?.policy || !stamp.source
    || !/^[a-f0-9]{64}$/.test(stamp.source.revision || '')) return null;
  const historicalPolicy = audit.metadata.review_scope.policy;
  if (typeof historicalPolicy !== 'object' || Array.isArray(historicalPolicy)
    || typeof historicalPolicy.policyId !== 'string' || !historicalPolicy.policyId
    || !Number.isInteger(historicalPolicy.policyVersion) || historicalPolicy.policyVersion < 1
    || !['contract_id','client_life','receipt_id','receipt_digest','selection_digest','menu_contract_version','birth_registration_digest']
      .every(key => isDeepStrictEqual(historicalPolicy.native_chart?.[key], context[key]))) return null;
  const source = { version: 1, firm_id: context.client_life.firm_id,
    client_id: context.client_life.client_id, transaction_id: row.id, revision: stamp.source.revision };
  if (!isDeepStrictEqual(stamp.source, source)
    || !isDeepStrictEqual(effectiveNativeReviewSource(transaction), source)) return null;
  const body = nativeReviewBody({ transaction, context, policyReceipt: historicalPolicy,
    actorId: stamp.accepted_by, authorityBasis: stamp.authority_basis });
  const { acceptance_audit, ...storedBody } = stamp;
  if ((Object.hasOwn(transaction, 'accepted_coding_policy') && !isDeepStrictEqual(transaction.accepted_coding_policy, body.policy))
    || !audit || String(audit.id) !== String(acceptance_audit.id)
    || audit.firm_id !== context.client_life.firm_id || audit.client_id !== context.client_life.client_id
    || audit.resource_type !== 'transaction_review' || audit.acceptance_transaction_id !== row.id
    || audit.metadata?.transaction_id !== row.id || audit.metadata?.item_id !== audit.resource_id
    || !['review.accepted','review.overridden'].includes(audit.action) || audit.actor_id !== stamp.accepted_by
    || !isDeepStrictEqual(audit.metadata?.review_scope, body) || !isDeepStrictEqual(storedBody, body)) return null;
  return source;
};

// Validate current sources and retained birth in the SAME snapshot as the
// transaction and audit. Stored payload alone never establishes review scope.
// The client-level half of the native review projection, shared by the
// per-transaction reader below and the verdict-only reader: lineage,
// registration chain and coding context are facts about the CLIENT, read from
// one snapshot. Every typed refusal the verifiers raise throws from here.
const verifyNativeReviewSnapshot = (snapshot, { firmId, clientId }) => {
  const lineage = verifyNativeChartObservation({ firmId, clientId,
    client: snapshot.company, accounts: snapshot.accounts, receipts: snapshot.receipts });
  const scope = retainedProcessingScopeDecision(lineage, { boundary: 'review_projection' });
  if (!lineage) return { lineage, scope };
  const registration = verifyNativeRegistrationObservation({ lineage, profile: snapshot.company.profile,
    revisions: snapshot.registrationRevisions, sourceDocument: snapshot.registrationSource });
  return { lineage, scope, nativeChart: nativeCodingContext(lineage, snapshot.company.profile, registration) };
};

// Verdict-only scope for the PERSISTED convergence column (F-23). The column
// is derived from processingScope.enforced / reason_code alone — client-level
// facts — so one focal is enough to read the client's snapshot; no 65-row
// transaction/document window is read per target. Per-transaction review
// currency (review_current, pending) is a read-time concern of
// readNativeReviewContexts and is never persisted.
export const readNativeVerdictScope = async ({ client, firmId, clientId, transactionId }) => {
  const snapshot = await readJevTransactionCases({ client, firmId, clientId, transactionIds: [transactionId] });
  return verifyNativeReviewSnapshot(snapshot, { firmId, clientId }).scope;
};

export const readNativeReviewContexts = async ({ client, firmId, clientId, transactionIds }) => {
  const snapshot = await readJevTransactionCases({ client, firmId, clientId, transactionIds, includeConvergence: true });
  const { lineage, scope, nativeChart } = verifyNativeReviewSnapshot(snapshot, { firmId, clientId });
  const contexts = new Map(), acceptedSources = new Map();
  if (!lineage) return { scope, contexts, snapshot, acceptedSources };
  for (const window of snapshot.windows) {
    const transaction = rowToTransactionPayload(window.focal);
    const currentSource = nativeCodingSourceReceipt(snapshot.cases.get(transaction.id).caseEvidence);
    const profile = snapshot.company.profile || {};
    const policy = resolveCodingPolicy({ jurisdiction: snapshot.company.jurisdiction,
      profileJurisdiction: profile.jurisdiction, entityType: snapshot.company.entity_type,
      profileEntityType: profile.entityType || profile.entity_type, businessDate: transaction.date,
      accountingSystem: profile.accounting_system, taxProfile: profile.taxProfile || profile.tax_profile, nativeChart });
    const stamp = transaction.review_scope;
    const audit = snapshot.decisionAudits.find(row => String(row.id) === String(stamp?.acceptance_audit?.id));
    const acceptedSource = authenticNativeReviewAcceptance({ row: window.focal, context: nativeChart, audit });
    if (acceptedSource) acceptedSources.set(transaction.id, { source: acceptedSource, currentSource });
    const valid = Boolean(acceptedSource && isDeepStrictEqual(acceptedSource, currentSource)
      && isDeepStrictEqual(audit.metadata.review_scope, nativeReviewScopeBody({ transaction, policy,
        actorId: stamp.accepted_by, authorityBasis: stamp.authority_basis })));
    contexts.set(transaction.id, { ...scope, review_current: valid,
      review_reason: valid ? 'saved' : stamp ? 'stale_review_receipt' : 'review_receipt_missing',
      pending: snapshot.pendingFocals.includes(transaction.id) });
  }
  return { scope, contexts, snapshot, acceptedSources };
};

// The native source fence: this case's complete source revision stays stable
// until the caller commits. It is scoped to ONE client and takes no table lock,
// so other clients' writers and ANALYZE/VACUUM never meet it. Both steps are
// NOWAIT: contention is an explicit retryable 55P03, never a wait under a writer.
// 1. The client row FOR UPDATE fences INSERTS. Every source table the case
//    reads (transactions, documents, document_lines, reconciliation_matches,
//    client_evidence_requests, document_obligations, ledger_journals) has
//    client_id REFERENCES clients(id). An insert's foreign-key check takes FOR
//    KEY SHARE on that row, which conflicts only with FOR UPDATE: a new source
//    row for this client waits for this commit (one already in flight makes the
//    fence refuse). Other clients' inserts check other rows. The company
//    profile bound into the revision is fenced by the same row.
// 2. The case reader takes FOR SHARE NOWAIT on every row it reads (bank window,
//    documents, lines, matches, replies, obligations, postings). Those rows
//    cannot be updated or deleted before commit, and the same locking statements
//    are the reread that the caller compares with its receipt.
// Not fenced: an UPDATE that moves an unread row of this client into the case
// window without an insert (for example a distant bank line re-dated). The
// stamped receipt is the revision read here, and the evidence clock
// (recoverChangedCodingEvidenceInDb) compares every saved native review with
// its current source and reopens a changed one, so that residue converges.
const asFenceBusy = (error) => { throw isFenceContention(error) ? nativeSourceFenceBusy(error) : error; };
const fenceClientSourceInserts = ({ client, firmId, clientId }) =>
  client.query('select id from clients where firm_id=$1 and id=$2 for update nowait', [firmId, clientId]).catch(asFenceBusy);
export const lockNativeCodingSourceWithClient = async ({ client, firmId, clientId, transactionId }) => {
  await fenceClientSourceInserts({ client, firmId, clientId });
  return readJevCase({ client, firmId, clientId, transactionId, evidenceOnly: true, lockEvidence: 'nowait' }).catch(asFenceBusy);
};

export const assertNativeCodingSourceWithClient = async ({ client, firmId, clientId, transactionId, receipt, lock = true }) => {
  if (!receipt || receipt.version !== 1 || receipt.firm_id !== firmId
    || receipt.client_id !== clientId || receipt.transaction_id !== transactionId) codingChoiceFailure('source_receipt_required');
  // No model runs under the fence; the reread happens under it.
  const current = lock ? await lockNativeCodingSourceWithClient({ client, firmId, clientId, transactionId })
    : await readJevCase({ client, firmId, clientId, transactionId, evidenceOnly: true });
  if (!isDeepStrictEqual(receipt, nativeCodingSourceReceipt(current.caseEvidence))) codingChoiceFailure('source_changed');
  return current;
};

export const assertNativeSavedCodingActionWithClient = async ({ client, firmId, clientId, transactionId, authority, actorId, suggestion }) => {
  if (!actorId || actorId === 'system' || !Number.isInteger(authority?.actionIndex) || authority.actionIndex < 0
    || !authority.memberId || !authority.messageId || !['transaction_chat', 'feed_chat', 'firm_feed_chat'].includes(authority.surface)) {
    codingChoiceFailure('saved_action_authority_required');
  }
  // The authorizing member row stays active until commit; an in-flight
  // revocation refuses here instead of slipping past the read.
  const actor = (await client.query("select id,email,user_id from firm_members where firm_id=$1 and id=$2 and status='active' for share nowait", [firmId, authority.memberId])).rows[0];
  if (!actor || ![actor.id, actor.email, actor.user_id].filter(Boolean).includes(actorId)) codingChoiceFailure('saved_action_authority_required');
  const message = authority.surface === 'firm_feed_chat'
    ? (await client.query('select role,actor_type,model,payload from firm_chat_messages where firm_id=$1 and id=$2 for share', [firmId, authority.messageId])).rows[0]
    : (await client.query('select role,actor_type,model,payload,transaction_id from transaction_chat_messages where firm_id=$1 and client_id=$2 and id=$3 for share', [firmId, clientId, authority.messageId])).rows[0];
  const action = message?.payload?.actions?.[authority.actionIndex];
  if (message?.role !== 'assistant' || message?.actor_type !== 'llm'
    || !['apply_category', 'recode_decided'].includes(action?.type)
    || (authority.surface === 'transaction_chat' && message.transaction_id !== transactionId)
    || (authority.surface === 'firm_feed_chat' && action.client_id !== clientId)
    || (authority.surface !== 'transaction_chat' && !action.transaction_ids?.includes(transactionId))
    || !isDeepStrictEqual(action.native_choice, suggestion.native_choice)
    || !isDeepStrictEqual(action.native_source_by_transaction?.[transactionId], suggestion.native_source)
    || action.account_name !== suggestion.proposed_account || action.account_code !== suggestion.account_code
    || (action.tax_treatment || null) !== (suggestion.tax_treatment || null)
    || ['xero_tax_type', 'tax_type'].some(key => suggestion[key] && suggestion[key] !== action.tax_treatment)) codingChoiceFailure('saved_action_mismatch');
  return { model: message.model || null };
};

// Transaction chat captures this before reasoning. The persisted action owns the
// receipt; applying it never upgrades an old machine suggestion's evidence.
export const captureFiChatCodingEvidence = async ({ client, firmId, clientId, transactionId, lock = false }) => {
  const row = (await client.query('select jurisdiction from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
  const transactionRow = (await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3',
    [firmId,clientId,transactionId])).rows[0];
  if (String(row?.jurisdiction || '').toLowerCase() !== 'fi'
    && transactionRow?.payload?.coding_correction_required?.status !== 'pending') return null;
  if (!transactionRow) throw Object.assign(new Error('Transaction not found.'), { statusCode: 404 });
  const transaction = rowToTransactionPayload(transactionRow);
  if (lock) await lockChatCodingEvidence({ client, firmId, clientId, transactionId });
  const document = await currentCodingEvidence({ client, firmId, clientId, transactionId });
  return { document, transaction, receipt: { version: 1, firm_id: firmId, client_id: clientId,
    transaction_id: transactionId, bank_source_digest: chatBankSourceDigest(transaction), evidence_digest: codingEvidenceDigest(document) } };
};

// Match/document writers can change source rows without taking the bank-line
// lock first. Fence the bounded rows before rereading at the authoritative write.
// NOWAIT preserves the existing lock order without waiting into a lock cycle.
const lockChatCodingEvidence = async ({ client, firmId, clientId, transactionId }) => {
  const rows = (await client.query(`select d.id from reconciliation_matches m
    join documents d on d.firm_id=m.firm_id and d.client_id=m.client_id and d.id=m.matched_object_id
    where m.firm_id=$1 and m.client_id=$2 and m.bank_transaction_id=$3
      and m.status in ('confirmed','auto_matched','suggested')
    order by d.id,m.id for update of d,m nowait`, [firmId,clientId,transactionId])).rows;
  if (rows.length) await client.query(`select id from document_lines where firm_id=$1 and client_id=$2
    and document_id=any($3::text[]) order by document_id,id for update nowait`,
    [firmId,clientId,rows.map(row => row.id)]);
};

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Stable source fields only: accepting/re-coding intentionally changes coding
// state and account/tax labels, never the bank transaction the model reasoned on.
export const chatBankSourceDigest = transaction => digest([
  'id','client_id','document_id','date','description','raw_description','cleaned_description',
  'money_in','money_out','currency','account_currency','contact','counterparty_guess','structured_reference',
  'reference','payment_method','message','counterparty','external_transaction_id','bank_account_id','source_account_code','bank_account_code'
].map(key => transaction[key] ?? null));

export const acceptedCodingDigest = transaction => createHash('sha256').update(JSON.stringify({
  coding: ['category','account_code','proposed_account','account_name','account_label','xero_account_code',
    'tax_treatment','tax_type','xero_tax_type','tax_posting_facts','contact'].map(key => transaction[key] ?? null),
  original_suggestion: transaction.ai_suggestion || null
})).digest('hex');

// Compare the persisted consequence, after aliases and enrichment have run.
// Reuse the same source and decision projections as acceptance validation.
export const nativeReviewFocalChanged = (before, after) => before.coding_state !== after.coding_state
  || acceptedCodingDigest(rowToTransactionPayload(before)) !== acceptedCodingDigest(rowToTransactionPayload(after))
  || !isDeepStrictEqual(effectiveNativeReviewSource(rowToTransactionPayload(before)), effectiveNativeReviewSource(rowToTransactionPayload(after)))
  || !isDeepStrictEqual(projectJevBankSource(before), projectJevBankSource(after));

export const assertChatCodingEvidence = async ({ client, firmId, clientId, transactionId, authority, lock = false }) => {
  const current = await captureFiChatCodingEvidence({ client, firmId, clientId, transactionId, lock });
  if (!current) return null;
  const receipt = authority?.receipt;
  if (!receipt || receipt.version !== 1 || receipt.firm_id !== firmId || receipt.client_id !== clientId
    || receipt.transaction_id !== transactionId || receipt.message_id !== authority.messageId
    || receipt.action_index !== authority.actionIndex || !authority.actorId || authority.actorId === 'system') {
    throw Object.assign(new Error('This coding proposal has no current evidence receipt. Ask Donna to generate a fresh correction.'),
      { code: 'TRANSACTION_CHAT_CODING_EVIDENCE_REQUIRED', statusCode: 409 });
  }
  const message = (await client.query(`select role,actor_type,model,payload from transaction_chat_messages
    where firm_id=$1 and client_id=$2 and transaction_id=$3 and id=$4 for share`,
    [firmId,clientId,transactionId,authority.messageId])).rows[0];
  const persistedAction = message?.payload?.actions?.[authority.actionIndex];
  if (message?.role !== 'assistant' || message?.actor_type !== 'llm' || !['apply_category','recode_decided'].includes(persistedAction?.type)
    || !isDeepStrictEqual(persistedAction.coding_evidence, receipt)) {
    throw Object.assign(new Error('The coding receipt does not belong to this saved proposal. Generate a fresh correction.'),
      { code: 'TRANSACTION_CHAT_CODING_EVIDENCE_REQUIRED', statusCode: 409 });
  }
  if (receipt.evidence_digest !== current.receipt.evidence_digest
    || receipt.bank_source_digest !== current.receipt.bank_source_digest) {
    throw Object.assign(new Error('The matched evidence changed after this proposal. Ask Donna to generate a fresh correction.'),
      { code: 'TRANSACTION_CODING_EVIDENCE_STALE', statusCode: 409 });
  }
  if (['owner_fact','payroll_package','document_discrepancy'].includes(current.transaction.ai_suggestion?.posting_requirement)) {
    throw Object.assign(new Error('The coding requires an owner fact or payroll package before posting.'),
      { code: 'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED', statusCode: 409 });
  }
  return { ...receipt, authority_basis: 'human_transaction_chat_correction',
    actor_id: authority.actorId, model: message.model || null };
};

export const codingEvidenceChanged = (suggestion, document) => suggestion?.evidence_digest
  ? suggestion.evidence_digest !== codingEvidenceDigest(document)
  : Boolean(document?.matched_at && Number(suggestion?.suggested_at) > 0
    && new Date(document.matched_at).getTime() > Number(suggestion.suggested_at));

export const codingSourceIdentityConflicts = (evidence, transactionId = evidence?.focal?.id) =>
  (evidence?.matches || []).filter(m=>m.bank_transaction_id===transactionId
    && ['suggested','auto_matched','confirmed'].includes(m.status) && String(m.payload?.cross_entity?.own_side || '').trim())
    .map(m=>({match_id:m.id,document_id:m.matched_object_id,status:m.status,own_side:m.payload.cross_entity.own_side}));

const readCodingSourceIdentityConflicts = async ({client,firmId,clientId,transactionId,lock=false}) => {
  const matches=(await client.query(`select id,bank_transaction_id,matched_object_id,status,payload
    from reconciliation_matches where firm_id=$1 and client_id=$2 and bank_transaction_id=$3
      and status in ('suggested','auto_matched','confirmed') and payload ? 'cross_entity'
    order by id${lock?' for share':''}`,[firmId,clientId,transactionId])).rows;
  return codingSourceIdentityConflicts({matches},transactionId);
};

// A scoped answer explains this source relationship; it does not teach an
// accepted business alias or change any match. Recheck the exact actor, answer,
// question and current match identities at the authoritative write.
export const hasCurrentSourceIdentityReply = async ({client,firmId,clientId,transaction,conflicts}) => {
  const receipt=transaction.ai_suggestion?.source_identity_reply;
  if(!receipt?.evidence_request_id || receipt.authority_basis!=='attributable_source_relationship_reply'
    || !receipt.actor_id || receipt.actor_id==='system' || !conflicts.length
    || receipt.source_relationship_digest!==hash(conflicts))return false;
  const row=(await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2
    and transaction_id=$3 and id=$4 and audience='client' and status in ('replied','resolved') for share`,
    [firmId,clientId,transaction.id,receipt.evidence_request_id])).rows[0];
  const reply=String(row?.response_payload?.reply || '').trim();
  const actor=row?.response_payload?.reply_processing?.actor_id || row?.response_payload?.answer_recorded_by || (row?.responded_at && row?.resolved_by);
  return Boolean(reply && actor===receipt.actor_id && hash(reply)===receipt.reply_digest
    && hash(row.question || '')===receipt.question_digest
    && row.request_payload?.question_basis==='current_source_relationship'
    && row.request_payload?.coding_correction?.original_journal_id===transaction.ledger_journal_id
    && Array.isArray(row.request_payload?.source_relationships)
    && hash(row.request_payload?.source_relationships)===receipt.source_relationship_digest);
};

const hasCurrentSourceUseOverride = async ({client,firmId,clientId,transaction,document}) => {
  const receipt=transaction.ai_suggestion?.source_business_use_override;
  if (!receipt?.evidence_request_id || !receipt.reply_digest || receipt.authority_basis!=='attributable_owner_reply_corrects_source_annotation') return false;
  if (receipt.source_fact_digest!==hash({document_id:document?.document_id || document?.id,fact:sourceBusinessUseFact(document)})) return false;
  const row=(await client.query(`select response_payload,resolved_by,responded_at from client_evidence_requests
    where firm_id=$1 and client_id=$2 and transaction_id=$3 and id=$4 and audience='client'
      and status in ('replied','resolved') for share`,[firmId,clientId,transaction.id,receipt.evidence_request_id])).rows[0];
  const reply=String(row?.response_payload?.reply || '').trim();
  const actor=row?.response_payload?.reply_processing?.actor_id || row?.response_payload?.answer_recorded_by || (row?.responded_at && row?.resolved_by);
  return Boolean(actor && actor!=='system' && reply && hash(reply)===receipt.reply_digest && reply===receipt.source_quote);
};

// Factual confirmation of a cited held source is not a material grant. Only
// the existing reply consumer may mint this receipt; recheck source, question,
// current answer and its real actor under the final posting transaction.
const hasCurrentHeldSourceReply = async ({client,firmId,clientId,transaction,document}) => {
  const receipt=transaction.ai_suggestion?.source_reply_authority;
  if (receipt?.authority_basis!=='attributable_held_source_reply' || !receipt.actor_id || receipt.actor_id==='system'
    || !receipt.evidence_request_id || receipt.document_id!==document?.document_id
    || receipt.document_digest!==codingEvidenceDigest(document)) return false;
  const row=(await client.query(`select question,request_payload,response_payload,resolved_by,responded_at from client_evidence_requests
    where firm_id=$1 and client_id=$2 and transaction_id=$3 and id=$4 and audience='client'
      and status in ('replied','resolved') for share`,[firmId,clientId,transaction.id,receipt.evidence_request_id])).rows[0];
  const actor=row?.response_payload?.reply_processing?.actor_id || row?.response_payload?.answer_recorded_by || (row?.responded_at && row?.resolved_by);
  const reply=String(row?.response_payload?.reply || '').trim();
  return Boolean(actor===receipt.actor_id && reply && hash(reply)===receipt.reply_digest
    && hash(row.question || '')===receipt.question_digest
    && row.request_payload?.authority_basis==='persisted_match_requires_owner_confirmation'
    && row.request_payload?.citable_local_evidence?.some(item=>item.document_id===receipt.document_id));
};

// Matching that was attempted on an exact-amount parsed source and has not
// reached a verdict (a pending Jev execution or a provider failure). Until it
// does, that source is unread evidence for this movement, exactly like a file
// still parsing: an autonomous description-only posting must wait for it.
// Candidates are context only; nothing here links or authorizes anything.
const UNFINISHED_SOURCE_MATCHING_SQL = `select d.id from documents d
  where d.firm_id=$1 and d.client_id=$2 and d.parse_status='completed' and d.duplicate_of is null
    and d.document_type=any($5::text[]) and upper(coalesce(d.currency,''))=upper($4)
    and round(d.total_amount*100)=round($3::numeric*100)
    and not exists(select 1 from reconciliation_matches m where m.firm_id=d.firm_id and m.client_id=d.client_id
      and m.matched_object_id=d.id and m.status in ('confirmed','auto_matched'))
    and (coalesce(d.payload,'{}'::jsonb) ? 'reconciliation_provider_failure'
      or exists(select 1 from reconciliation_evaluations e where e.firm_id=d.firm_id and e.client_id=d.client_id
        and e.target_type='document' and e.target_id=d.id and e.verdict<>'superseded'
        and e.payload->>'decision_engine'='jev'
        and e.payload->>'next_action' in ('reconsider_current_evidence','retry_writer','reasoning')))
  order by d.id limit 5`;
const OUTGOING_SOURCE_TYPES = ['receipt','supplier_bill','payment_confirmation','payment_account_statement'];
const INCOMING_SOURCE_TYPES = ['sales_invoice','issued_receipt','payout_statement','deposit_slip'];
export const unfinishedSourceMatchingIds = async ({ client, firmId, clientId, transaction }) => {
  const incoming = Number(transaction?.money_in || 0), outgoing = Number(transaction?.money_out || 0);
  if ((incoming > 0) === (outgoing > 0) || !transaction?.currency) return [];
  return (await client.query(UNFINISHED_SOURCE_MATCHING_SQL, [firmId, clientId, incoming || outgoing, transaction.currency,
    incoming > 0 ? INCOMING_SOURCE_TYPES : OUTGOING_SOURCE_TYPES])).rows.map(row => row.id);
};

// The coded account's class: its canonical role, else the client's own chart.
const codingAccountClass = async ({client,firmId,clientId,account}) => {
  const roleClass = roleMeta(roleForSeedName(account))?.class;
  if (roleClass || !account) return roleClass || null;
  const row = (await client.query("select account_type from ledger_accounts where firm_id=$1 and client_id=$2 and (name=$3 or code=$3) order by (name=$3) desc limit 1",[firmId,clientId,account])).rows[0];
  return row ? ledgerAccountTypeFor({account_type:row.account_type}) : null;
};

export const assertCurrentCodingEvidence = async ({ client, firmId, clientId, transaction, lock = false }) => {
  // Human accepts keep their authority; a machine proposal is bound to its evidence.
  const accepted = transaction.accepted_coding_evidence;
  if (!accepted && transaction.ai_suggestion_status && transaction.ai_suggestion_status !== 'auto_applied') return currentCodingEvidence({client,firmId,clientId,transactionId:transaction.id});
  if (!accepted && autonomousCoding(transaction)) {
    const conflicts=await readCodingSourceIdentityConflicts({client,firmId,clientId,transactionId:transaction.id,lock});
    if(conflicts.length && !await hasCurrentSourceIdentityReply({client,firmId,clientId,transaction,conflicts}))throw Object.assign(new Error('The linked source names another business. Resolve the ownership relationship before autonomous posting.'),
      {code:'TRANSACTION_SOURCE_IDENTITY_UNRESOLVED',statusCode:409,details:{source_relationships:conflicts}});
  }
  const suggestion = transaction.ai_suggestion;
  if (lock) await lockChatCodingEvidence({client,firmId,clientId,transactionId:transaction.id});
  const document = await currentCodingEvidence({ client, firmId, clientId, transactionId: transaction.id });
  if (!accepted && autonomousCoding(transaction) && codingRevenueEvidenceGap({transaction,suggestion,matchedDocument:document})) throw Object.assign(new Error('An incoming operating-revenue posting requires the underlying sales evidence. The bank movement alone does not establish a sale or its tax.'),
    {code:'TRANSACTION_REVENUE_SOURCE_REQUIRED',statusCode:409});
  if (!accepted && autonomousCoding(transaction) && suggestion?.posting_requirement !== 'document_allocation'
    && ['confirmed','auto_matched'].includes(document?.match_status)) {
    const account = suggestion?.proposed_account || transaction.account_name || transaction.category;
    const accountClass = await codingAccountClass({client,firmId,clientId,account});
    if (sourceSideAccountClassConflict({documentType:document.document_type,accountClass})) throw Object.assign(new Error(
      `The ${account} ${accountClass} account contradicts the matched ${document.document_type}. A refund or reversal against this source reverses the source's own account and tax side; cash direction does not make a purchase refund revenue or a sales refund an expense.`),
      {code:'TRANSACTION_SOURCE_ACCOUNT_CLASS_CONFLICT',statusCode:409,details:{document_id:document.document_id,document_type:document.document_type,
        account,account_class:accountClass,recovery:'recode_current_evidence'}});
  }
  if (!accepted && autonomousCoding(transaction) && codingStatutoryEvidenceGap({transaction,suggestion,matchedDocument:document})
    && !await hasCurrentHeldSourceReply({client,firmId,clientId,transaction,document})) throw Object.assign(new Error('A statutory liability settlement requires the actual filing or contribution notice. The bank description alone does not establish that liability.'),
    {code:'TRANSACTION_STATUTORY_SOURCE_REQUIRED',statusCode:409});
  const useConflict=!accepted&&autonomousCoding(transaction)?codingSourceBusinessUseConflict({transaction,suggestion,matchedDocument:document}):null;
  if(useConflict && !await hasCurrentSourceUseOverride({client,firmId,clientId,transaction,document})) throw Object.assign(new Error('The selected business expense contradicts the source use annotation. Resolve the actual use and ownership before posting.'),
    {code:'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT',statusCode:409,details:{source_business_use:useConflict}});
  if (['owner_fact','payroll_package','document_discrepancy'].includes(suggestion?.posting_requirement)) throw Object.assign(new Error('The coding requires an owner fact or payroll package before posting.'), {code:'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED',statusCode:409});
  if (accepted && (accepted.coding_digest !== acceptedCodingDigest(transaction)
    || (accepted.accepted_bank_source_digest || accepted.bank_source_digest) !== chatBankSourceDigest(transaction)
    || accepted.version !== 1 || accepted.transaction_id !== transaction.id
    || accepted.firm_id !== firmId || accepted.client_id !== clientId)) {
    throw Object.assign(new Error('The accepted coding changed. Generate a fresh correction before posting.'),
      { code: 'TRANSACTION_CODING_EVIDENCE_STALE', statusCode: 409 });
  }
  if (accepted && (suggestion?.posting_requirement === 'document_allocation'
    || suggestion?.document_allocations?.length)) {
    throw Object.assign(new Error('A component allocation needs its own complete correction before posting.'),
      { code: 'TRANSACTION_CHAT_CODING_ALLOCATION_UNSUPPORTED', statusCode: 409 });
  }
  const evidenceDecision = accepted || suggestion;
  if (!evidenceDecision?.evidence_digest) return;


  if (!document && (await client.query(`select 1 from documents where firm_id=$1 and client_id=$2 and parse_status in ('pending','processing') limit 1`,[firmId,clientId])).rows.length) {
    throw Object.assign(new Error('Uploaded evidence is still being read. Posting waits for the current document batch.'), {code:'TRANSACTION_CODING_EVIDENCE_PENDING',statusCode:409});
  }
  if (!document && !accepted && autonomousCoding(transaction)) {
    const unfinished = await unfinishedSourceMatchingIds({ client, firmId, clientId, transaction });
    if (unfinished.length) throw Object.assign(new Error('A parsed document with this exact amount has not finished matching. Posting waits for its relationship to be decided.'),
      { code: 'TRANSACTION_CODING_EVIDENCE_PENDING', statusCode: 409, details: { reason: 'source_matching_unfinished', document_ids: unfinished } });
  }
  if (codingEvidenceChanged(evidenceDecision, document)) throw Object.assign(new Error('The matched evidence changed after coding. Recode from the current document.'), {
    code: 'TRANSACTION_CODING_EVIDENCE_STALE', statusCode: 409
  });
  return document;
};

export { CODING_CONFLICT_MAX_RECONSIDERATIONS };
const pendingCorrection = payload => payload?.coding_correction_required?.status === 'pending';
const autonomousCoding = payload => payload?.ai_suggestion_status === 'auto_applied'
  && !payload.accepted_coding_evidence
  && ['', 'coding_auto_post'].includes(payload.reviewed_by || '')
  && ['', 'coding_auto_post'].includes(payload.approved_by || '')
  && !['client_rule', 'merchant_lookup'].includes(payload.auto_categorize_source);

// Registration is evidence for the dated native decision, never retrospective
// posting authority. The existing correction case carries the changed input;
// its original suggestion and journal remain immutable.
const changedNativeRegistration = async ({ client, firmId, clientId, row }) => {
  const context = row.payload.ai_suggestion?.native_choice?.context;
  if (!context) return null;
  const businessDate = toIsoDay(row.transaction_date);
  const { codingPolicy } = await readClientCodingContextWithClient({ client, firmId, clientId, businessDate });
  if (!codingPolicy.nativeMenu) return null;
  const current = codingPolicy.nativeMenu.registrationEligibility;
  const previous = nativeAccountChoices(context, { businessDate }).registrationEligibility;
  const corrected = row.payload.coding_correction_required;
  const reference = corrected?.status === 'corrected' ? corrected.native_registration?.current || previous : previous;
  if (hash(reference) === hash(current)) return null;
  return { previous, current, digest: hash({ previous, current }) };
};

// Only an existing, current human correction followed by the named adjustment
// writer may close changed-source work. A journal's mere presence is not proof.
export async function completeCodingEvidenceCorrectionWithClient({client,firmId,clientId,transactionId,originalJournalId,correctionJournalIds,actorId}) {
  if (!transactionId || !actorId || actorId === 'system' || !correctionJournalIds?.length) return false;
  const row = (await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3 for update', [firmId,clientId,transactionId])).rows[0];
  const requirement = row?.payload?.coding_correction_required;
  const accepted = row?.payload?.accepted_coding_evidence;
  if (!pendingCorrection(row?.payload) || requirement.original_journal_id !== originalJournalId || !accepted
    || accepted.authority_basis !== 'human_transaction_chat_correction' || accepted.actor_id !== actorId) return false;
  await lockChatCodingEvidence({client,firmId,clientId,transactionId});
  const current = codingEvidenceDigest(await currentCodingEvidence({client,firmId,clientId,transactionId}));
  if (current !== requirement.current_evidence_digest || accepted.evidence_digest !== current) return false;
  const receipt = {...requirement,status:'corrected',actor_id:actorId,correction_journal_ids:correctionJournalIds};
  await client.query("update transactions set payload=jsonb_set(payload,'{coding_correction_required}',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and id=$3", [firmId,clientId,transactionId,JSON.stringify(receipt)]);
  await client.query("update transaction_review_queue set status='resolved',payload=payload || jsonb_build_object('coding_correction_required',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and item_id=$3 and reason='posted_evidence_changed'",[firmId,clientId,transactionId,JSON.stringify(receipt)]);
  return true;
}

// Activity and recovery must use the same source-row eligibility and retry cap.
const CODING_EVIDENCE_CANDIDATES_SQL = `select t.* from transactions t where t.firm_id=$1 and t.client_id=$2
        and ((t.coding_state in ('proposed','applied','asked','held')
          and coalesce(t.payload->>'ledger_journal_id','')=''
          and coalesce(t.status,'') not in ('posted','closed','synced')
          and not exists(select 1 from close_periods cp where cp.firm_id=t.firm_id and cp.client_id=t.client_id and cp.status='locked' and t.transaction_date between cp.period_start and cp.period_end)
          and not exists(select 1 from ledger_journals j where j.firm_id=t.firm_id and j.client_id=t.client_id and j.source_id=t.id))
          or (coalesce(t.payload->>'ledger_journal_id','')<>'' and t.payload->>'ai_suggestion_status'='auto_applied'))
        and coalesce(t.payload->>'reviewed_by','') in ('','coding_auto_post')
        and coalesce(t.payload->>'approved_by','') in ('','coding_auto_post')
        and coalesce(t.payload->'accepted_coding_evidence','null'::jsonb)='null'::jsonb
        and coalesce(t.payload->>'ai_suggestion_status','auto_applied')='auto_applied'
        and coalesce(t.payload->>'auto_categorize_source','') not in ('client_rule','merchant_lookup')
        and ($3::text is null or t.id=$3)
        order by t.id`;
const requiresCodingReconsideration = (row, document, refusal = row.payload.ledger_post_refusal, groupConflict = false) => {
  const useFact = sourceBusinessUseFact(document);
  const selected = row.payload.ai_suggestion?.jev_decision?.selected;
  const answeredQuestion = (selected === 'ask_business_use' && useFact.business_use_percent !== null)
    || (selected === 'ask_business_purpose' && useFact.classification === 'personal')
    || (selected === 'ask_statutory_source' && hasCodingStatutorySource(document));
  return answeredQuestion || groupConflict || CODING_EVIDENCE_RECONSIDERED_REFUSALS.includes(refusal?.code)
    // A statement-only line the ledger refused for an unresolved treatment has
    // no source to re-read; the coder owns it again. With a settled source the
    // source-recheck recovery (codingRefusalRecovery.js) owns the re-read. Once
    // that re-read has verified the source and the treatment is still refused,
    // the coder owns it once more with the verified source in hand, and its
    // contract decides the fork (H-5a): unclear printed tax becomes the
    // document_discrepancy ask; clear printed tax keeps the coding with its
    // named cause. A coding that already carries that cause is never
    // re-admitted (codingPolicyRecovery.js); a legacy coding without it is
    // re-admitted once, within the attempts bound, to receive it.
    || (refusal?.code === 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' && (!['confirmed','auto_matched'].includes(document?.match_status)
      || (verifiedSourceRecheck(row) && !unsettledTreatmentOnClearSource({ ...row, payload: { ...row.payload, ledger_post_refusal: refusal } }))));
};
// The source-recheck lane's settled receipt: the original file was re-read and
// its printed tax verified. The clock's recode carries it forward, so the
// coder's contract sees the source it verified (hasVerifiedSourceForDiscrepancy).
const verifiedSourceRecheck = (row) => row.payload.posting_recovery?.state === 'reconsidered'
  && row.payload.posting_recovery?.review?.source_verified === true ? row.payload.posting_recovery : null;
const reconsiderationFor = (row, current, refusal = row.payload.ledger_post_refusal, groupConflict = false) => {
  const recodeRefusal = requiresCodingReconsideration(row,current.matchedDocument,refusal,groupConflict);
  const revision = codingCaseRevision(current.caseEvidence);
  const prior = row.payload.coding_evidence_reconsideration;
  // Attempts count per case revision under the current coding contract; a
  // receipt from an earlier contract re-enters once (codingPolicyRecovery.js).
  const attempts = prior?.digest === revision ? codingReconsiderationAttempts(prior) : 0;
  return { recodeRefusal, revision, attempts, exhausted: recodeRefusal && attempts >= CODING_CONFLICT_MAX_RECONSIDERATIONS };
};

const requiresMatchedCodingReconsideration = (row, document, acceptedSourceChanged = null) => {
  // H-7b: a resting cross-window group is the clock's to wake, not pending work.
  if (refusedCrossWindowGroup(row)) return false;
  const changed = acceptedSourceChanged ?? codingEvidenceChanged(row.payload.ai_suggestion, document);
  if (row.payload.ledger_journal_id) return changed
    && row.payload.coding_correction_required?.current_evidence_digest !== codingEvidenceDigest(document);
  return changed || (requiresCodingReconsideration(row, document)
    && codingReconsiderationAttempts(row.payload.coding_evidence_reconsideration) < CODING_CONFLICT_MAX_RECONSIDERATIONS);
};

// Presence selects bounded authentication work, never authority. Every unique
// eligible focal is read; no first-200 truncation or full-client read per line.
const possibleNativeReview = row => row.coding_state === 'applied'
  && !row.payload?.ledger_journal_id && row.payload?.review_scope;
const readAcceptedNativeSources = async ({ client, firmId, clientId, rows }) => {
  const ids = [...new Set(rows.filter(possibleNativeReview).map(row => row.id))];
  const accepted = new Map();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const verified = await readNativeReviewContexts({ client, firmId, clientId, transactionIds: ids.slice(offset, offset + 200) });
    if (verified.scope.enforced === true) for (const [id, receipt] of verified.acceptedSources) accepted.set(id, receipt);
  }
  return accepted;
};
const acceptedNativeSourceChanged = (receipt, currentSource = receipt?.currentSource) =>
  receipt ? !isDeepStrictEqual(receipt.source, currentSource) : null;

// Same eligibility, match selection, source digest and retry cap as the scalar
// reader. The snapshot already has the client/transaction set; read its evidence
// together instead of borrowing a network roundtrip for each displayed line.
export async function pendingMatchedCodingReconsiderationIdsWithClient(client, firmId, clientId, transactionIds) {
  const ids = new Set(transactionIds);
  if (!ids.size) return new Set();
  const rows = (await client.query(CODING_EVIDENCE_CANDIDATES_SQL, [firmId, clientId, null])).rows
    .filter(row => ids.has(row.id));
  const accepted = await readAcceptedNativeSources({ client, firmId, clientId, rows });
  const documents = await loadMatchedDocumentsForTransactions({ client, firmId, clientId, transactionIds: rows.map(row => row.id) });
  return new Set(rows.filter(row => requiresMatchedCodingReconsideration(row, documents.get(row.id) || null,
    acceptedNativeSourceChanged(accepted.get(row.id)))).map(row => row.id));
}

export async function hasPendingCodingReconsiderationWithClient(client, firmId, clientId, transactionId, { matchedOnly = false } = {}) {
  const row = (await client.query(CODING_EVIDENCE_CANDIDATES_SQL, [firmId, clientId, transactionId])).rows[0];
  if (!row) return false;
  const resting = refusedCrossWindowGroup(row);
  if (resting) return !matchedOnly && codingCaseRevision((await readJevCase({client, firmId, clientId, transactionId, evidenceOnly: true})).caseEvidence) !== resting.case_evidence_digest;
  // Display reads actual match evidence only. Candidate discovery belongs to
  // recovery and must never reopen a settled pill by amount resemblance.
  const accepted = (await readAcceptedNativeSources({ client, firmId, clientId, rows: [row] })).get(row.id);
  if (matchedOnly) {
    const document = await currentCodingEvidence({client,firmId,clientId,transactionId});
    return requiresMatchedCodingReconsideration(row, document, acceptedNativeSourceChanged(accepted));
  }
  const current = await readJevCase({client, firmId, clientId, transactionId, evidenceOnly: true});
  if (row.payload.ledger_journal_id) {
    const digest = codingEvidenceDigest(current.matchedDocument);
    const registration = await changedNativeRegistration({ client, firmId, clientId, row });
    return (codingEvidenceChanged(row.payload.ai_suggestion, current.matchedDocument)
      && row.payload.coding_correction_required?.current_evidence_digest !== digest)
      || Boolean(registration && row.payload.coding_correction_required?.native_registration?.digest !== registration.digest);
  }
  const plan = reconsiderationFor(row, current);
  const priorDigest = row.payload.ai_suggestion?.case_evidence_digest || row.payload.coding_evidence_reconsideration?.digest;
  const changed = acceptedNativeSourceChanged(accepted, nativeCodingSourceReceipt(current.caseEvidence))
    ?? (priorDigest ? priorDigest !== plan.revision
      : row.payload.ai_suggestion ? codingEvidenceChanged(row.payload.ai_suggestion, current.matchedDocument) : Boolean(current.matchedDocument));
  return changed || (plan.recodeRefusal && !plan.exhausted);
}

// F-26 / F-34 — a client the recovery worker cannot process this tick is never
// a log line. Contention (the client-row fence starved by an ordinary insert
// stream) and a typed native refusal (a corrupt lineage, an unverifiable
// registration chain) both rest on Donna with nobody told, so each is receipted
// through the EXISTING runtime-policy incident writer (recordCodingPolicyFailure:
// one incident per case, three-attempt bound, escalation to the maintainers'
// repair list) on one representative undecided transaction of the client,
// coalesced to one receipt per client per window. The next clean tick of that
// client closes it through the writer's own recovery receipt.
export const RECOVERY_STALL_WINDOW_MINUTES = 30;
const STALL_STARVED = 'evidence_recovery_starved';
const STALL_REFUSED = 'NATIVE_REVIEW_REFUSED';
const recordRecoveryStall = async ({ firmId, clientId, kind, cause }) => {
  const refused = kind === 'refused';
  const error = Object.assign(new Error(refused
    ? `Native review refused for this client (${cause?.code || 'unverifiable'}); recovery is skipped until it is repaired.`
    : 'Evidence recovery could not take this client\'s fence; ordinary writes are starving it.'),
  refused ? { reasonCode: STALL_REFUSED, details: { reason: cause?.details?.reason || cause?.code || null } }
    : { code: 'coding_policy_unavailable', details: { reason: STALL_STARVED } });
  try {
    return await withFirmDbClient(async client => {
      await client.query('begin');
      try {
        // The audit insert takes FOR KEY SHARE on the very client row that is contended.
        await client.query("set local lock_timeout='2s'");
        const rep = (await client.query(`select id from transactions where firm_id=$1 and client_id=$2
          and coalesce(coding_state,'') <> all($3::text[]) order by id limit 1`, [firmId, clientId, ['posted', 'synced', 'closed']])).rows[0];
        let recorded = false;
        if (rep) {
          const recent = (await client.query(`select 1 from audit_events where firm_id=$1 and client_id=$2 and resource_type='transaction'
            and resource_id=$3 and action=$4 and (metadata->>'reason_detail' = $5 or metadata->>'reason_code' = $5)
            and created_at > now() - ($6::int * interval '1 minute') limit 1`,
          [firmId, clientId, rep.id, CODING_POLICY_FAILED_ACTION, refused ? STALL_REFUSED : STALL_STARVED, RECOVERY_STALL_WINDOW_MINUTES])).rowCount;
          if (!recent) {
            recorded = (await recordCodingPolicyFailure({ client, firmId, clientId, transactionIds: [rep.id], error, operation: 'coding', includeDecided: true })).length > 0;
          }
        }
        await client.query('commit');
        return { receipted: recorded || Boolean(rep) };
      } catch (failure) { await client.query('rollback'); throw failure; }
    });
  } catch (failure) {
    console.warn('[coding_convergence] could not receipt a skipped recovery client', { firmId, clientId, kind, code: failure?.code || null, message: failure?.message });
    return { receipted: false, receipt_error: failure?.code || failure?.message || 'unknown' };
  }
};
const resolveRecoveryStall = async ({ firmId, clientId }) => {
  try {
    await withFirmDbClient(async client => {
      const open = (await client.query(`select distinct a.resource_id from audit_events a
        where a.firm_id=$1 and a.client_id=$2 and a.action=$3 and a.resource_type='transaction'
          and (a.metadata->>'reason_detail' = $4 or a.metadata->>'reason_code' = $5)
          and not exists (select 1 from audit_events r where r.firm_id=a.firm_id and r.client_id=a.client_id
            and r.resource_type='transaction' and r.resource_id=a.resource_id and r.action='transaction.coding.policy_recovered'
            and r.id > a.id) limit 20`, [firmId, clientId, CODING_POLICY_FAILED_ACTION, STALL_STARVED, STALL_REFUSED])).rows;
      if (!open.length) return;
      await client.query('begin');
      try {
        await recordCodingPolicyRecovery({ client, firmId, clientId, transactionIds: open.map(row => row.resource_id) });
        await client.query('commit');
      } catch (failure) { await client.query('rollback'); throw failure; }
    });
  } catch (failure) {
    console.warn('[coding_convergence] could not close a recovery stall receipt', { firmId, clientId, code: failure?.code || null, message: failure?.message });
  }
};

// Re-open only unposted autonomous codings. The clock then uses its existing
// uncoded pool, strong coder, ask writer and posting writer. No second loop.
export const recoverChangedCodingEvidenceInDb = async ({ firmId, limit = 50, runWorkerAdmissionFn = async ({ work }) => work() }) => {
  const candidates = await withFirmDbClient(async client => (await client.query(`
    select distinct t.client_id from transactions t
    where t.firm_id=$1 and (t.coding_state in ('proposed','applied','asked','held') or t.payload ? 'ledger_journal_id'
      or ${REFUSED_CROSS_WINDOW_GROUP_SQL})
    order by t.client_id`, [firmId])).rows);
  const recovered = [];
  const correctionCases = [];
  const skipped = [];
  let changedClients = 0;
  for (const { client_id: clientId } of candidates) {
    if (changedClients >= limit) break;
    const beforeCount = recovered.length, beforeCases = correctionCases.length;
    // One client's contention or failure is that client's, for this tick only:
    // its transaction rolls back whole, it is recorded, and the next tick
    // retries it. The remaining clients still converge; no retry loop here.
    try {
    await runWorkerAdmissionFn({ firmId, clientId, work: () => withFirmDbClient(async client => {
    await client.query('begin');
    try {
      const rows = (await client.query(`${CODING_EVIDENCE_CANDIDATES_SQL} for update of t skip locked`, [firmId, clientId, null])).rows;
      // Authenticate saved native reviews and compare their sources without a
      // fence; an unchanged review is a read-only no-op. Only a row that may
      // be rewritten takes the per-case native fence below and rereads there.
      const accepted = await readAcceptedNativeSources({ client, firmId, clientId, rows });
      // A client with saved native reviews never waits under another writer:
      // before its first write this tick takes the client-row fence (NOWAIT)
      // once, so a contended client is skipped instead of joining a lock cycle.
      const nativeClient = rows.some(possibleNativeReview);
      let clientFenced = false;
      const beforeWrite = async () => {
        if (!nativeClient || clientFenced) return;
        await fenceClientSourceInserts({ client, firmId, clientId }); clientFenced = true;
      };
      const pendingEvidence = (await client.query(`select 1 from documents where firm_id=$1 and client_id=$2 and parse_status in ('pending','processing') limit 1`,[firmId,clientId])).rows.length > 0;
      const groupConflicts = new Map();
      for (const row of rows) {
        if (!['REFUND_GROUP_CODING_CONFLICT','REFUND_GROUP_CODING_PENDING'].includes(row.payload?.ledger_post_refusal?.code)) continue;
        const groupIds=row.payload.jev_refund_group?.transaction_ids || [];
        // Initial in-flight coding is not a failed group decision. Reconsider
        // only when every member already has a decision and they cannot post.
        if(row.payload.ledger_post_refusal.code==='REFUND_GROUP_CODING_PENDING'
          && !groupIds.every(id=>rows.some(member=>member.id===id && member.payload.ai_suggestion)))continue;
        for (const id of row.payload.ledger_post_refusal.details?.transaction_ids || []) {
          if (row.payload.jev_refund_group?.transaction_ids?.includes(id)) groupConflicts.set(id,row.payload.ledger_post_refusal);
        }
      }
      for (const row of rows) {
        if (recovered.length - beforeCount >= 200) break;
        // H-7b: a resting cross-window group is woken only by the step below.
        if (refusedCrossWindowGroup(row)) continue;
        let current = await readJevCase({client,firmId,clientId,transactionId:row.id,evidenceOnly:true});
        let acceptedSource = accepted.get(row.id);
        const priorDigest = row.payload.ai_suggestion?.case_evidence_digest || row.payload.coding_evidence_reconsideration?.digest;
        const evidenceChanged = () => acceptedNativeSourceChanged(acceptedSource, nativeCodingSourceReceipt(current.caseEvidence))
          ?? (priorDigest ? priorDigest !== codingCaseRevision(current.caseEvidence)
            : row.payload.ai_suggestion ? codingEvidenceChanged(row.payload.ai_suggestion, current.matchedDocument) : Boolean(current.matchedDocument));
        if (possibleNativeReview(row)) {
          // Without a refusal, group conflict, answered question or changed
          // source, the decision below is a no-op; nothing is fenced for it.
          if (!evidenceChanged() && !groupConflicts.has(row.id) && !row.payload.ledger_post_refusal
            && !requiresCodingReconsideration(row, current.matchedDocument)) continue;
          // Fence this case, then authenticate and compare again under it: the
          // unfenced read selected the work, it does not validate the write.
          current = await lockNativeCodingSourceWithClient({ client, firmId, clientId, transactionId: row.id }); clientFenced = true;
          acceptedSource = (await readAcceptedNativeSources({ client, firmId, clientId, rows: [row] })).get(row.id);
        }
        const document = current.matchedDocument;
        if (row.payload.ledger_journal_id) {
          if (!autonomousCoding(row.payload) || pendingEvidence) continue;
          const original = (await client.query("select j.id, (select jsonb_agg(jsonb_build_object('account_code',l.account_code,'account_name',l.account_name,'account_type',a.account_type,'currency',l.currency,'tax_type',l.tax_type,'role',l.payload->>'role','debit',l.debit,'credit',l.credit) order by l.line_no,l.id) from ledger_lines l join ledger_accounts a on a.id=l.account_id and a.firm_id=l.firm_id and a.client_id=l.client_id where (l.journal_id=j.id or l.journal_id in (select cj.id from ledger_journals cj where cj.firm_id=j.firm_id and cj.client_id=j.client_id and cj.correction_of_journal_id=j.id and cj.status in ('posted','closed'))) and l.firm_id=j.firm_id and l.client_id=j.client_id) as lines from ledger_journals j where j.firm_id=$1 and j.client_id=$2 and j.source_id=$3 and j.id=$4 and j.status in ('posted','closed')",[firmId,clientId,row.id,row.payload.ledger_journal_id])).rows[0];
          if (!original) continue;
          original.lines = correctionDeltaLines([], (original.lines || []).map(line=>({...line,
            account_name:line.account_name || line.account,account_type:line.account_type || line.account_class})))
            .map(line=>({...line,account:line.account_name,account_class:line.account_type}));
          const previous = row.payload.coding_correction_required;
          const currentDigest = codingEvidenceDigest(document);
          const currentConflicts=codingSourceIdentityConflicts(current.caseEvidence,row.id);
          const conflicts=await hasCurrentSourceIdentityReply({client,firmId,clientId,transaction:{...row.payload,id:row.id},conflicts:currentConflicts})?[]:currentConflicts;
          const allocated = row.payload.ai_suggestion?.posting_requirement === 'document_allocation';
          const allocationConflicts = allocated
            && documentSourceComponents(document).complete ? (original.lines || []).filter(line =>
              allocationAccountClassConflict({documentType:document.document_type,incoming:Number(row.money_in || 0),outgoing:Number(row.money_out || 0),
                accountClass:roleMeta(roleForSeedName(line.account))?.class || line.account_class})
              && (Number(row.money_in || 0)>0 ? Number(line.credit)>0 : Number(line.debit)>0))
            // A single-account journal follows its settled source's side in either cash direction.
            : !allocated && ['confirmed','auto_matched'].includes(document?.match_status) ? (original.lines || []).filter(line =>
              sourceSideAccountClassConflict({documentType:document.document_type,accountClass:roleMeta(roleForSeedName(line.account))?.class || line.account_class})) : [];
          const sourceUseConflicts=[];
          if (!await hasCurrentSourceUseOverride({client,firmId,clientId,transaction:{...row.payload,id:row.id},document}))
            for (const line of original.lines || []) {
              const conflict=codingSourceBusinessUseConflict({transaction:row,suggestion:{proposed_account:line.account,tax_type:line.tax_type,coding_policy:row.payload.ai_suggestion?.coding_policy},matchedDocument:document,accountClass:line.account_class,taxRole:line.role});
              if (conflict && Number(line.debit)>0) sourceUseConflicts.push({...conflict,account:line.account,amount:Number(line.debit)});
            }
          const sourceUseDigest=hash(sourceUseConflicts);
          const revenueSourceGap=(original.lines || []).some(line=>Number(line.credit)>0 && codingRevenueEvidenceGap({transaction:row,suggestion:{proposed_account:line.account},matchedDocument:document}));
          const statutorySourceGap=!await hasCurrentHeldSourceReply({client,firmId,clientId,transaction:{...row.payload,id:row.id},document}) && (original.lines || []).some(line=>!['alv_input_deductible','alv_output'].includes(line.role) && Number(line.debit)>0 && codingStatutoryEvidenceGap({transaction:row,suggestion:{proposed_account:line.account,coding_policy:row.payload.ai_suggestion?.coding_policy},matchedDocument:document}));
          const relationshipDigest=hash(conflicts);
          const allocationDigest=hash(allocationConflicts);
          const registration = await changedNativeRegistration({ client, firmId, clientId, row });
          const changed = Boolean(registration) || codingEvidenceChanged(row.payload.ai_suggestion,document) || conflicts.length>0 || allocationConflicts.length>0 || sourceUseConflicts.length>0 || revenueSourceGap || statutorySourceGap;
          if (previous?.status === 'corrected' && !changed && previous.current_evidence_digest === currentDigest) {
            correctionCases.push({client_id:clientId,transaction_id:row.id,correction_required:false,requirement:previous});
            continue;
          }
          // A crash after the durable requirement but before its derived case
          // must heal the same visible case without minting another decision.
          if (previous && !(previous.status==='corrected' && changed) && previous.current_evidence_digest === currentDigest
            && (previous.source_relationship_digest || hash([])) === relationshipDigest
            && (previous.allocation_account_digest || hash([])) === allocationDigest
            && (previous.source_business_use_digest || hash([])) === sourceUseDigest
            && (previous.native_registration?.digest || null) === (registration?.digest || null)
            && Boolean(previous.revenue_source_required) === revenueSourceGap
            && Boolean(previous.statutory_source_required) === statutorySourceGap) {
            correctionCases.push({client_id:clientId,transaction_id:row.id,correction_required:previous.status==='pending',requirement:previous});
            continue;
          }
          if (!changed && !pendingCorrection(row.payload)) continue;
          const requirement = {
            version:1,status:changed?'pending':'no_correction_required',
            reason:statutorySourceGap?'posted_statutory_source_required':revenueSourceGap?'posted_revenue_source_required':sourceUseConflicts.length?'posted_source_business_use_conflict':conflicts.length?'posted_source_identity_unresolved':allocationConflicts.length?'posted_allocation_account_conflict':changed?'posted_source_evidence_changed':'original_source_restored',
            message:statutorySourceGap?'The autonomous statutory-liability journal has no current supporting filing or contribution notice. Establish the liability and period in transaction chat; apply a ledger adjustment if accounting changes. The original journal remains unchanged.':revenueSourceGap?'The autonomous operating-revenue journal has no current underlying sales source. Establish what the receipt settled in transaction chat and apply a ledger adjustment if needed. The original journal remains unchanged.':sourceUseConflicts.length?'The posted business expense contradicts an explicit personal or mixed-use source annotation. Review the actual use and ownership in transaction chat; apply a ledger adjustment if accounting changes. The original journal remains unchanged.':allocationConflicts.length?(allocated?'A posted invoice component uses an account class inconsistent with its issuer and payment direction. Reconsider the component account in transaction chat and apply a ledger adjustment. The original journal remains unchanged.':'The posted account contradicts its matched source: a refund or reversal against that source reverses the source\'s own account and tax side. Reconsider the account in transaction chat and apply a ledger adjustment. The original journal remains unchanged.'):conflicts.length?'The posted source names another business and its relationship is unresolved. Review ownership and coding in transaction chat; apply a ledger adjustment if accounting changes. The original journal remains unchanged.':changed?'Evidence changed after autonomous posting. Reconsider the current source in transaction chat; if the accounting changes, apply a ledger adjustment. The original journal remains unchanged.':'The exact original source receipt is restored; no correction is required.',
            original_journal_id:original.id,correction_journal_ids:previous?.correction_journal_ids || [],previous_evidence_digest:row.payload.ai_suggestion?.evidence_digest || null,
            current_evidence_digest:currentDigest,document_id:document?.document_id || null,
            source_relationship_digest:relationshipDigest,source_relationships:conflicts,
            allocation_account_digest:allocationDigest,allocation_account_conflicts:allocationConflicts,
            source_business_use_digest:sourceUseDigest,source_business_use_conflicts:sourceUseConflicts,revenue_source_required:revenueSourceGap,statutory_source_required:statutorySourceGap,
            next_action:changed?'recode_decided':null,actor_id:'coding_convergence',
            authority_basis:statutorySourceGap?'autonomous_posting_statutory_source_required':revenueSourceGap?'autonomous_posting_revenue_source_required':sourceUseConflicts.length?'autonomous_posting_source_business_use_conflict':allocationConflicts.length?'autonomous_posting_source_account_class_conflict':conflicts.length?'autonomous_posting_source_identity_conflict':'autonomous_posting_source_receipt_changed',model:row.payload.ai_suggestion?.model || null
          };
          if (registration) Object.assign(requirement, {
            native_registration: registration, reason: 'posted_registration_evidence_changed',
            message: 'The dated registration evidence changed after posting. The original journal and decision remain unchanged. Registration-driven tax correction is not yet qualified; this case requires the existing review workflow.',
            authority_basis: 'autonomous_posting_registration_evidence_changed'
          });
          await beforeWrite();
          await client.query("update transactions set payload=jsonb_set(payload,'{coding_correction_required}',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and id=$3",[firmId,clientId,row.id,JSON.stringify(requirement)]);
          await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
            values($1,$2,'system','coding_convergence','coding.posted_evidence_reconsideration','transaction',$3,$4::jsonb)`,
            [firmId,clientId,row.id,JSON.stringify({reason:requirement.message,transaction_id:row.id,original_journal_id:original.id,ledger_adjustment_required:changed,requirement})]);
          recovered.push({client_id:clientId,transaction_id:row.id,correction_required:changed,requirement});
          continue;
        }
        const changed = evidenceChanged();
        const refusal = groupConflicts.get(row.id) || row.payload.ledger_post_refusal;
        if(row.coding_state==='applied' && refusal?.code==='TRANSACTION_SOURCE_IDENTITY_UNRESOLVED'
          && codingSourceIdentityConflicts(current.caseEvidence,row.id).length) {
          // Keep the completed coding judgment; the existing proposed-coding
          // sweep owns the precise ownership question. No repeat model solve.
          await beforeWrite();
          await client.query(`update transactions set status='needs_review',payload=payload - 'ai_suggestion_status' - 'ledger_post_refusal',updated_at=now()
            where firm_id=$1 and client_id=$2 and id=$3`,[firmId,clientId,row.id]);
          await applyCodingTransition(client,{firmId,clientId,transactionId:row.id,to:'proposed'});
          await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
            values($1,$2,'system','coding_convergence','coding.source_identity_question_required','transaction',$3,$4::jsonb)`,
            [firmId,clientId,row.id,JSON.stringify({source_relationships:codingSourceIdentityConflicts(current.caseEvidence,row.id),model:row.payload.ai_suggestion?.model||null,authority_basis:'unresolved_source_identity_posting_refusal'})]);
          recovered.push({client_id:clientId,transaction_id:row.id,ownership_question_required:true});
          continue;
        }
        if (row.coding_state==='applied' && ((refusal?.code==='TRANSACTION_REVENUE_SOURCE_REQUIRED'
          && codingRevenueEvidenceGap({transaction:row,suggestion:row.payload.ai_suggestion,matchedDocument:document}))
          || (refusal?.code==='TRANSACTION_STATUTORY_SOURCE_REQUIRED' && codingStatutoryEvidenceGap({transaction:row,suggestion:row.payload.ai_suggestion,matchedDocument:document}) && !await hasCurrentHeldSourceReply({client,firmId,clientId,transaction:{...row.payload,id:row.id},document})))) {
          await beforeWrite();
          await client.query("update transactions set status='needs_review',payload=payload-'ai_suggestion_status'-'ledger_post_refusal',updated_at=now() where firm_id=$1 and client_id=$2 and id=$3",[firmId,clientId,row.id]);
          await applyCodingTransition(client,{firmId,clientId,transactionId:row.id,to:'proposed'});
          recovered.push({client_id:clientId,transaction_id:row.id,source_question_required:refusal.code});
          continue;
        }
        if (row.coding_state==='applied' && refusal?.code==='TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT'
          && !hasJevResolvedCoding(row.payload.ai_suggestion)) {
          const conflict=codingSourceBusinessUseConflict({transaction:row,suggestion:row.payload.ai_suggestion,matchedDocument:document});
          if (conflict) {
            const next={...row.payload.ai_suggestion,posting_requirement:'owner_fact',evidence_required:true,
              ask_client_question:sourceBusinessUseQuestion(conflict),source_business_use_guard:conflict};
            await beforeWrite();
            await client.query("update transactions set status='needs_review',payload=(payload-'ai_suggestion_status'-'ledger_post_refusal') || jsonb_build_object('ai_suggestion',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and id=$3",[firmId,clientId,row.id,JSON.stringify(next)]);
            await applyCodingTransition(client,{firmId,clientId,transactionId:row.id,to:'proposed'});
            recovered.push({client_id:clientId,transaction_id:row.id,source_use_question_required:true});
            continue;
          }
        }
        const { recodeRefusal, revision, attempts, exhausted } = reconsiderationFor(row, current, refusal, groupConflicts.has(row.id));
        if (exhausted) continue;
        // Evidence-pending waits for the source, not for another coding: recode
        // only once nothing is still parsing or still being matched.
        if (!changed && !recodeRefusal
          && !(row.payload.ledger_post_refusal?.code === 'TRANSACTION_CODING_EVIDENCE_PENDING' && !pendingEvidence
            && !(await unfinishedSourceMatchingIds({ client, firmId, clientId, transaction: row })).length)) continue;
        await beforeWrite();
        await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
          values($1,$2,'system','coding_convergence','coding.evidence_changed','transaction',$3,$4::jsonb)`,
          [firmId, clientId, row.id, JSON.stringify({ previous_suggestion: row.payload.ai_suggestion, current_evidence_digest: codingEvidenceDigest(document) })]);
        const recheck = recodeRefusal && refusal?.code === 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' ? verifiedSourceRecheck(row) : null;
        await client.query(`update transactions set status='needs_review',
          payload=(payload - 'ai_suggestion' - 'ai_suggestion_status' - 'ledger_post_refusal' - 'accepted_coding_policy' - 'posting_recovery') || $4::jsonb, updated_at=now()
          where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, row.id, JSON.stringify({coding_evidence_reconsideration:{digest:revision, contract:CODING_RECONSIDERATION_CONTRACT, attempts:recodeRefusal?attempts+1:0, reason:recodeRefusal?'coding_source_conflict':'source_evidence_changed'}, ...(recodeRefusal ? {posting_recovery:{...(recheck||{}),review:{...(recheck?.review||{}),source_validation:refusal?.details?.source_validation || null,previous_refusal:refusal,recovery:'recode_current_evidence'}}}: {})})]);
        await applyCodingTransition(client, { firmId, clientId, transactionId: row.id, to: 'proposed' });
        recovered.push({ client_id: clientId, transaction_id: row.id });
      }
      // H-7b (codingPolicyRecovery.js): a group refused for spanning policy
      // windows rests until any member's case revision moves off the one it
      // was refused under. Then every member's refusal is cleared together, so
      // the coder admits the whole group once more; an unchanged group is left
      // alone and no coding is attempted.
      const resting = (await client.query(`select t.* from transactions t where t.firm_id=$1 and t.client_id=$2
        and ${REFUSED_CROSS_WINDOW_GROUP_SQL} order by t.id for update of t skip locked`, [firmId, clientId])).rows;
      const woken = new Set();
      for (const row of resting) {
        if (woken.has(row.id)) continue;
        const refusal = refusedCrossWindowGroup(row);
        const current = await readJevCase({client,firmId,clientId,transactionId:row.id,evidenceOnly:true});
        if (codingCaseRevision(current.caseEvidence) === refusal.case_evidence_digest) continue;
        await beforeWrite();
        const members = (await client.query(`update transactions set payload=payload-'ledger_post_refusal',updated_at=now()
          where firm_id=$1 and client_id=$2 and id=any($3::text[]) and payload->'ledger_post_refusal'->>'code'=$4 returning id`,
        [firmId, clientId, refusal.transaction_ids, CROSS_WINDOW_GROUP_REFUSAL])).rows.map(member => member.id).sort();
        await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
          values($1,$2,'system','coding_convergence','coding.evidence_changed','transaction',$3,$4::jsonb)`,
          [firmId, clientId, row.id, JSON.stringify({ reason: 'cross_window_group_evidence_changed', previous_refusal: row.payload.ledger_post_refusal,
            previous_case_evidence_digest: refusal.case_evidence_digest, transaction_ids: members })]);
        for (const id of members) { woken.add(id); recovered.push({ client_id: clientId, transaction_id: id, cross_window_group_readmitted: true }); }
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
  }) });
    } catch (error) {
      recovered.length = beforeCount; correctionCases.length = beforeCases;
      const contended = isFenceContention(error);
      const refused = !contended && isNativeReviewRefusal(error);
      const state = contended ? 'contended' : refused ? 'refused' : 'failed';
      const entry = { client_id: clientId, skipped: true, state, code: error?.code || null, message: error?.message || String(error) };
      if (state !== 'failed') Object.assign(entry, await recordRecoveryStall({ firmId, clientId, kind: refused ? 'refused' : 'contended', cause: error }));
      skipped.push(entry);
      console.warn('[coding_convergence] evidence recovery skipped client for this tick', { firmId, clientId, state,
        code: error?.code || null, message: error?.message || String(error) });
      continue;
    }
    await resolveRecoveryStall({ firmId, clientId });
    if (recovered.length > beforeCount) changedClients += 1;
  }
  // The existing review-case writer makes correction work discoverable in the
  // same artifact/chat surface as an operator's recode_decided action.
  const corrections = [...new Map([...correctionCases,...recovered.filter(item => item.requirement)].map(item=>[item.transaction_id,item])).values()];
  if (corrections.length) {
    const {ensureTransactionReviewItemInDb} = await import('./coding.js');
    for (const item of corrections) {
      const reviewItemId = await ensureTransactionReviewItemInDb({firmId,clientId:item.client_id,transactionId:item.transaction_id,
        source:'coding_evidence_reconsideration',caseReason:'posted_evidence_changed',caseIdSuffix:'posted-evidence'});
      await withFirmDbClient(client => client.query("update transaction_review_queue set status=$3,payload=payload || $4::jsonb,updated_at=now() where firm_id=$1 and id=$2",[firmId,reviewItemId,item.correction_required?'open':'resolved',JSON.stringify({reviewer_note:item.requirement.message,coding_correction_required:item.requirement})]));
    }
  }
  return [...recovered, ...skipped];
};
