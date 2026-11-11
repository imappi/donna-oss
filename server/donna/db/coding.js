import { TAX_REGISTRATION_LANE } from '../taxRegistrationReply.js';
import { isDeepStrictEqual } from 'node:util';
import { assertFirmAccess } from './authority.js';
import { codingStatutoryEvidenceGap } from '../codingStatutoryEvidence.js';
import { codingRevenueEvidenceGap } from '../codingRevenueEvidence.js';
import { makeJevTrialProvider } from '../jevTrialProvider.js';
import { firstLineLaneDecidesWithClient } from '../firstLineLane.js';
import { readClientCodingContextWithClient } from './codingPolicyContext.js';
import { assertNativeCodingChoice, resolveNativeAccountChoice, codingChoiceFailure } from '../codingAccountChoices.js';
import { readJevCase, jevCasePrompt, codingCaseRevision, matchedAllocationHandles } from '../jevPreview.js';
// server/donna/db/coding.js — plane S — coding: the review case file DTO, account options and resolved policy, the single/batch strong-coder writers, the review-item writers (every transition through codingState.js).
//
// RT-17 (2026-09-02): extracted from server/donna/firmDb.js as a pure move. Every public
// symbol keeps its old import path through firmDb.js, which re-exports it; helpers another
// plane needs are exported here and NOT re-exported by firmDb.js. Zero behaviour change.

import { ownerReplyIdentity, assertCurrentOwnerReply } from '../ownerReplyIdentity.js';
import { recordOwnerReplyProcessingReceipt } from '../ownerReplyProcessingReceipt.js';
import { codingEvidenceDigest, assertChatCodingEvidence, acceptedCodingDigest, nativeReviewFocalChanged, chatBankSourceDigest, codingSourceIdentityConflicts, nativeCodingSourceReceipt, nativeReviewScopeBody, assertNativeCodingSourceWithClient, assertNativeSavedCodingActionWithClient } from './codingEvidence.js';
import { assertExecutionBudgetActive } from '../executionBudget.js';
import { bindTaxPostingFactsWithClient, taxFactsDigest, loadTaxPostingContext, loadClientTaxFactAutomation } from './taxPostingFacts.js';
import { buildDonnaLedgerWriteback } from '../donnaLedgerWriteback.js';
import { lockClientCloseBoundaryWithClient } from './closeSerialization.js';
import { __createClientEvidenceRequestWithClient, consumeNativeUnresolvedCodingWithClient } from './asks.js';
import { canonicalMerchantPattern, normalizeIntelText } from '../transactionIntel.js';
import { accountOptionsForClient, CODING_DEFAULT_MODEL, knownPrincipalsForClientProfile, suggestTransactionCoding, suggestTransactionCodingBatch } from '../transactionLlm.js';
// Q9 (the sole-model lab, 2026-08-16): the coding lane's model-policy
// resolution — same pattern as the disposition sweep owner (Q6c).
import { readLaneDecidingPolicy } from '../modelLanePolicy.js';
import { resolveOpenAiCompatibleEndpoint } from '../providerEndpoints.js';
// `dismissFirmFact` (G2 PR-14): the reverse executor's memory leg routes a minted
// fact to the SAME governed tombstone writer the forget_fact verb uses (INV-1).
import { CODING_FACT_ADMISSION_FLAG, codingFactSubjects, distillAndStageFirmFactCandidates, getCodingFactsForTransactions, getFirmFactsForSubjects } from '../firmFacts.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { hasJevResolvedCoding } from '../jevDecisionReceipt.js';
import { checkEntityReadinessAdmissionWithClient, EntityReadinessAdmissionError } from '../runtimeReadinessAdmission.js';
// RT-16 — the ONE coding state (transactions.coding_state, migration 138):
// the machine, the legacy-input mapping, the DTO projection, the writer.
import { applyCodingTransition, codingStateClosesReviewCase, isDecidedCodingState, legacyReviewStateFor, nextCodingStateForPatch, normalizeCodingState, normalizeTransactionReviewState, reviewCaseClosesForLegacyState } from '../codingState.js';
import { classifyTaxCodeForPolicy } from '../taxCodeJurisdiction.js';
import { withoutTaxTreatmentsFor } from '../postingPolicy.js';
import { requireCodingPolicyForClient, CodingPolicyError, isCodingPolicyError, assertCodingPolicyReceipt, codingPolicyReceipt } from '../codingPolicy.js';
import { recordCodingPolicyFailure, recordCodingPolicyRecovery, ACTIVE_CODING_POLICY_FAILURE_SQL, REFUSED_CROSS_WINDOW_GROUP_SQL } from '../codingPolicyRecovery.js';
import { enrichCodingWithXeroAccount } from '../xeroAccountMatcher.js';
import { recordHumanOutcome } from '../llmDecisions.js';
import { emitReviewAudit, normalizeReviewItemStatus, rowToReviewItemPayload, assertNoReviewScopePatch } from '../reviewItem.js';
import { reversePatchFromBeforeAfter } from '../reversePatch.js';

import { queryFirmDb, withFirmDbClient } from './pool.js';
import { DEFAULT_FIRM_ID, loadClientOwnBankAccounts } from './clients.js';
import { __buildReviewRecodeDistillation, __ruleConfirmationBumpPatch, __shouldBumpRuleConfirmation, __shouldDistillReviewRecode, demotedRuleAsSuggestion, loadActiveClientRulesForAuthority, saveMerchantRuleForPayload } from './memory.js';
import { amountForPayload, assertTransactionAccountingMutable, refreshTransactionIntelForClient, rowToTransactionPayload } from './transactions.js';
import { linkReplyEvidenceMatchesInDb } from './reconcile.js';
import { __shouldApplyReplyRecode, loadReplyDocumentsWithContent, resolveOpenEvidenceRequestsForTransaction } from './asks.js';
import { __resolveMissingAccountSuggestion, __donnaChartMenuAccounts, ensureLedgerAccountFromVerdict, getDonnaLedgerAccountsForClient, postLedgerTransactionInDb } from './ledger.js';
import { getXeroAccountsForClient } from './xero.js';
import { getFirmSnapshotFromDb } from './snapshot.js';

// Reopen only legacy autonomous account labels, before the existing strong
// coder discovers work. The displaced source remains in the audit receipt.
export const recoverAeVatLegacyCodingInDb = async ({ firmId, limit = 50 }) => withFirmDbClient(async client => {
  await client.query('begin');
  try {
    const candidates = (await client.query(`select distinct t.client_id from transactions t
      join clients c on c.firm_id=t.firm_id and c.id=t.client_id
      where t.firm_id=$1 and lower(c.jurisdiction)='ae' and t.coding_state='applied'
        and coalesce(t.status,'') not in ('posted','closed','synced')
        and t.payload->>'auto_categorize_source' in ('word_overlap','matched_document_verdict','minted_verdict_account')
        and not exists(select 1 from jsonb_each(t.payload) authority where authority.key=any(array['ledger_journal_id','tax_posting_facts','accepted_coding_policy','tax_treatment','tax_type','xero_tax_type','tax_code','matched_client_rule_id','reviewed_by','approved_by','ai_suggestion_applied_by','coding_actor_id']) and authority.value not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb))
        and not exists(select 1 from ledger_journals j where j.firm_id=t.firm_id and j.client_id=t.client_id and j.source_id=t.id)
        and not exists(select 1 from audit_events a where a.firm_id=t.firm_id and a.client_id=t.client_id and a.action='transaction_review.update' and (a.resource_id=t.id or a.metadata->>'transaction_id'=t.id or exists(select 1 from transaction_review_queue h where h.firm_id=t.firm_id and h.client_id=t.client_id and h.id=a.resource_id and (h.item_id=t.id or h.payload->>'transaction_id'=t.id))))
        and not exists(select 1 from client_evidence_requests r where r.firm_id=t.firm_id and r.client_id=t.client_id and r.transaction_id=t.id and r.status in ('draft','open','replied'))
        and exists(select 1 from reconciliation_matches m join documents d on d.firm_id=m.firm_id and d.client_id=m.client_id and d.id=m.matched_object_id
          where m.firm_id=t.firm_id and m.client_id=t.client_id and m.bank_transaction_id=t.id and m.status in ('confirmed','auto_matched')
            and d.document_type in ('supplier_bill','sales_invoice'))
      order by t.client_id`, [firmId])).rows;
    const recovered = [];
    for (const candidate of candidates) {
      if (recovered.length >= limit * 200) break;
      const clientId = candidate.client_id;
      const automation = await loadClientTaxFactAutomation({ client, firmId, clientId });
      if (!automation) continue;
      const before = (await client.query('select * from clients where firm_id=$1 and id=$2', [firmId, clientId])).rows[0];
      if (!automation.clientEnabled(before, await readClientConfigSnapshot(client, { firmId, clientId, strict: true }))) continue;
      await lockClientCloseBoundaryWithClient({ client, firmId, clientId });
      const admission = await checkEntityReadinessAdmissionWithClient({ client, firmId, clientId, boundary: 'worker_discovery' });
      if (!admission.allowed) continue;
      const row = (await client.query('select * from clients where firm_id=$1 and id=$2 for no key update nowait', [firmId, clientId])).rows[0];
      await client.query('select id from client_capability_config where firm_id=$1 and (client_id=$2 or client_id is null) and valid_to is null for share', [firmId, clientId]);
      const snapshot = await readClientConfigSnapshot(client, { firmId, clientId, strict: true });
      if (!automation.clientEnabled(row, snapshot)) continue;
      const rows = (await client.query(`select t.* from transactions t where t.firm_id=$1 and t.client_id=$2 and t.coding_state='applied'
        and coalesce(t.status,'') not in ('posted','closed','synced')
        and t.payload->>'auto_categorize_source' in ('word_overlap','matched_document_verdict','minted_verdict_account')
        and not exists(select 1 from jsonb_each(t.payload) authority where authority.key=any(array['ledger_journal_id','tax_posting_facts','accepted_coding_policy','tax_treatment','tax_type','xero_tax_type','tax_code','matched_client_rule_id','reviewed_by','approved_by','ai_suggestion_applied_by','coding_actor_id']) and authority.value not in ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb))
        and not exists(select 1 from ledger_journals j where j.firm_id=t.firm_id and j.client_id=t.client_id and j.source_id=t.id)
        and not exists(select 1 from audit_events a where a.firm_id=t.firm_id and a.client_id=t.client_id and a.action='transaction_review.update' and (a.resource_id=t.id or a.metadata->>'transaction_id'=t.id or exists(select 1 from transaction_review_queue h where h.firm_id=t.firm_id and h.client_id=t.client_id and h.id=a.resource_id and (h.item_id=t.id or h.payload->>'transaction_id'=t.id))))
        and not exists(select 1 from client_evidence_requests r where r.firm_id=t.firm_id and r.client_id=t.client_id and r.transaction_id=t.id and r.status in ('draft','open','replied'))
        and exists(select 1 from reconciliation_matches m join documents d on d.firm_id=m.firm_id and d.client_id=m.client_id and d.id=m.matched_object_id
          where m.firm_id=t.firm_id and m.client_id=t.client_id and m.bank_transaction_id=t.id and m.status in ('confirmed','auto_matched')
            and d.document_type in ('supplier_bill','sales_invoice'))
        order by t.id limit 200 for update of t`, [firmId, clientId])).rows;
      let clientRecovered = 0;
      for (const tx of rows) {
        if (clientRecovered >= 200) break;
        if (!automation.legacyNeedsRecovery(tx)) continue;
        await assertTransactionAccountingMutable({ client, firmId, transactionId: tx.id, patch: { account_code: tx.account_code } });
        await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
          values($1,$2,'system',$3,'transaction.ae_vat_legacy_coding_reopened','transaction',$4,$5::jsonb)`,
        [firmId, clientId, automation.actorId, tx.id, JSON.stringify({ authority_basis: automation.authorityBasis, previous_payload: tx.payload, previous_coding_state: tx.coding_state })]);
        await client.query(`update transactions set payload=payload - 'ai_suggestion' - 'ledger_post_refusal',updated_at=now() where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, tx.id]);
        await applyCodingTransition(client, { firmId, clientId, transactionId: tx.id, to: 'proposed' });
        recovered.push({ client_id: clientId, transaction_id: tx.id });
        clientRecovered += 1;
      }
    }
    await client.query('commit'); return recovered;
  } catch (error) { await client.query('rollback'); throw error; }
});

export const recordAeVatBusinessUseWithClient = async ({ client, firmId, request, expectedReplyKey, actorId, answer }) => {
  const { assertCurrentOwnerReply } = await import('../ownerReplyIdentity.js');
  const automation = await loadClientTaxFactAutomation({ client, firmId, clientId: request.client_id });
  if (!automation) throw Object.assign(new Error('No registered tax-fact answer handler for this client.'), { code: 'TAX_POSTING_FACTS_AUTHORITY_REQUIRED', statusCode: 403 });
  const { taxFactsSource } = await import('./taxPostingFacts.js');
  const { enqueueLocalJob } = await import('../desktop/localJobQueue.js');
  if (!automation.validateAnswer(answer)) throw automation.error('AE_VAT_BUSINESS_USE_INVALID', 'The answer must establish the factual purpose and actual use.');
  await client.query('savepoint ae_vat_business_use_reply');
  const principal = await automation.assertActor({ client, firmId, clientId: request.client_id, actorId });
  const saved = (await client.query('select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3 for update', [firmId, request.client_id, request.id])).rows[0];
  assertCurrentOwnerReply(saved, expectedReplyKey);
  const ids = saved.request_payload?.anchor_transaction_ids;
  if (saved.evidence_type !== automation.evidenceType || saved.audience !== 'client' || !Array.isArray(ids) || ids.length !== 1) throw automation.error('AE_VAT_REPLY_SOURCE_INVALID', 'The question must name exactly one current bank transaction.');
  const transactionId = ids[0], clientId = saved.client_id;
  const current = await automation.readContext({ client, firmId, clientId, transactionId, lock: true });
  const stale = !current || current.pendingMatch || current.evidence.id !== saved.request_payload.vat_document_id
    || taxFactsDigest(current.evidence) !== saved.request_payload.vat_evidence_digest
    || taxFactsDigest(taxFactsSource(current.transaction)) !== taxFactsDigest(saved.request_payload.vat_source)
    || current.transaction.ledger_journal_id || ['posted','closed','synced'].includes(current.transaction.coding_state);
  if (!stale) {
    const fact = { ...answer, actor_id: principal.actorId, authority_basis: 'persisted_owner_answer', evidence_request_id: saved.id,
      document_id: current.evidence.id, evidence_digest: taxFactsDigest(current.evidence), source: taxFactsSource(current.transaction) };
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,$3,$4,'ae_vat.business_use_recorded','transaction',$5,$6::jsonb)`, [firmId, clientId, principal.actorType, principal.actorId,
      transactionId, JSON.stringify({ fact_digest: taxFactsDigest(fact), evidence_request_id: saved.id, reply_key: expectedReplyKey,
        authority_basis: 'persisted_owner_answer', statement: answer })]);
    await client.query(`update transactions set payload=(payload - 'ledger_post_refusal') || jsonb_build_object('ae_vat_business_use',$4::jsonb),updated_at=now()
      where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, transactionId, JSON.stringify(fact)]);
  }
  await client.query(`update client_evidence_requests set status=$4,resolved_at=now(),resolved_by=$5,
    response_payload=response_payload || $6::jsonb,updated_at=now() where firm_id=$1 and client_id=$2 and id=$3`,
  [firmId, clientId, saved.id, stale ? 'cancelled' : 'resolved', principal.actorId,
    JSON.stringify({ vat_business_use_recorded: !stale, superseded_by_source_change: stale, continuation: 'coding_convergence' })]);
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,$3,$4,'ae_vat.business_use_reply_completed','client_evidence_request',$5,$6::jsonb)`,
  [firmId, clientId, principal.actorType, principal.actorId, saved.id, JSON.stringify({ transaction_id: transactionId, superseded: stale, continuation: 'coding_convergence', reply_key: expectedReplyKey })]);
  await enqueueLocalJob({ client, functionId: 'parse-cron:coding_convergence', handlerVersion: '2',
    payload: { firm_id: firmId, client_id: clientId, evidence_request_id: saved.id, reply_key: expectedReplyKey },
    dedupeKey: `ae-vat-business-use:${expectedReplyKey}`, maxAttempts: 1 });
  if (stale) await client.query(`update transactions set payload=payload - 'ledger_post_refusal',updated_at=now()
    where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, transactionId]);
  await client.query('release savepoint ae_vat_business_use_reply');
  return { recorded: !stale, superseded: stale, continuation: 'coding_convergence' };
};

// U08-S3: one continuation at the existing post boundary. The model supplies
// evidence-backed facts; this named coding writer owns their atomic receipt.
export const ensureAeVatPostingFactsInDb = async ({ firmId, clientId, transactionId, reasonFn = null } = {}) => {
  const automation = await withFirmDbClient(client => loadClientTaxFactAutomation({ client, firmId, clientId }));
  if (!automation) return null;
  const context = await withFirmDbClient(client => automation.readContext({ client, firmId, clientId, transactionId }));
  if (!context || context.pendingMatch
    || context.transaction.ledger_journal_id || ['posted','closed','synced'].includes(context.transaction.coding_state)) return null;
  const priorFacts = context.transaction.tax_posting_facts;
  if (priorFacts && (priorFacts.authority_basis !== automation.authorityBasis || priorFacts.context_digest === context.digest)) return null;
  const pending = await withFirmDbClient(async client => (await client.query(`select * from client_evidence_requests
    where firm_id=$1 and client_id=$2 and evidence_type=$3 and status in ('draft','open','sent','replied')
      and request_payload->'anchor_transaction_ids' ? $4 order by id limit 1`, [firmId, clientId, automation.evidenceType, transactionId])).rows[0]);
  if (pending && (pending.status === 'replied' || (pending.request_payload?.vat_reassessed_context_digest || pending.request_payload?.vat_context_digest) === context.digest)) return { waiting_on_owner: true, evidence_request_id: pending.id };
  const decision = await (reasonFn || automation.reason)({ context });
  return withFirmDbClient(async client => {
    await client.query('begin');
    try {
      await lockClientCloseBoundaryWithClient({ client, firmId, clientId });
      const admission = await checkEntityReadinessAdmissionWithClient({ client, firmId, clientId, boundary: 'worker_discovery', resourceType: 'transaction', resourceId: transactionId });
      if (!admission.allowed) throw new EntityReadinessAdmissionError(admission);
      // Follow the existing readiness → client order. Yield rather than wait
      // against a profile writer already blocked on the readiness fence.
      await client.query('select id from clients where firm_id=$1 and id=$2 for no key update nowait', [firmId, clientId]);
      await client.query('select id from client_capability_config where firm_id=$1 and (client_id=$2 or client_id is null) and valid_to is null for share', [firmId, clientId]);
      await client.query('select id from cohort_capability_config where firm_id=$1 and valid_to is null for share', [firmId]);
      await client.query('select cohort_key from client_cohort_members where firm_id=$1 and client_id=$2 and valid_to is null for share', [firmId, clientId]);
      const livePending = (await client.query(`select * from client_evidence_requests
        where firm_id=$1 and client_id=$2 and evidence_type=$3 and status in ('draft','open','sent','replied')
          and request_payload->'anchor_transaction_ids' ? $4 order by id limit 1 for update`, [firmId, clientId, automation.evidenceType, transactionId])).rows[0];
      if (taxFactsDigest(livePending || null) !== taxFactsDigest(pending || null)) throw automation.error('AE_VAT_SOURCE_CHANGED', 'The owner question or reply changed during reasoning.');
      const current = await automation.readContext({ client, firmId, clientId, transactionId, lock: true });
      if (!current || current.pendingMatch || current.digest !== context.digest) throw automation.error('AE_VAT_SOURCE_CHANGED', 'The VAT evidence or authority changed during reasoning; retry from the current source.');
      if (taxFactsDigest(current.transaction.tax_posting_facts || null) !== taxFactsDigest(priorFacts || null) || current.transaction.ledger_journal_id
        || ['posted','closed','synced'].includes(current.transaction.coding_state)) throw automation.error('AE_VAT_SOURCE_CHANGED', 'A factual correction or posting arrived during reasoning.');
      await assertTransactionAccountingMutable({ client, firmId, transactionId, patch: { tax_treatment: current.transaction.tax_treatment } });
      const sameQuestionSource = pending && current.evidence.id === pending.request_payload.vat_document_id
        && taxFactsDigest(current.evidence) === pending.request_payload.vat_evidence_digest
        && taxFactsDigest((await import('./taxPostingFacts.js')).taxFactsSource(current.transaction)) === taxFactsDigest(pending.request_payload.vat_source);
      if (pending && decision.outcome === 'owner_business_use' && sameQuestionSource) {
        await client.query(`update client_evidence_requests set request_payload=request_payload || $4::jsonb,updated_at=now()
          where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, pending.id, JSON.stringify({ vat_reassessed_context_digest: current.digest })]);
        await client.query('commit'); return { waiting_on_owner: true, evidence_request_id: pending.id };
      }
      if (pending && decision.outcome !== 'unsupported') {
        await client.query(`update client_evidence_requests set status=$4,resolved_at=now(),resolved_by=$6,updated_at=now(),response_payload=response_payload || $5::jsonb
          where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, pending.id, decision.outcome === 'supported' ? 'resolved' : 'cancelled',
          JSON.stringify({ vat_source_reassessment: { context_digest: current.digest, model: decision.model, explanation: decision.explanation, authority_basis: automation.authorityBasis } }), automation.actorId]);
        await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
          values($1,$2,'system',$3,'ae_vat.question_reassessed','client_evidence_request',$4,$5::jsonb)`, [firmId, clientId, automation.actorId, pending.id,
          JSON.stringify({ transaction_id: transactionId, context_digest: current.digest, model: decision.model, authority_basis: automation.authorityBasis, outcome: decision.outcome })]);
      }
      if (decision.outcome === 'owner_business_use') {
        if (current.ownerFact || Number(current.transaction.money_out || 0) <= 0) throw automation.error('AE_VAT_OWNER_QUESTION_INVALID', 'Business-use questions apply only to missing purchase facts, not known answers or sales.');
        const ask = await __createClientEvidenceRequestWithClient({ client, firmId, clientId, documentId: current.evidence.id,
          evidenceType: automation.evidenceType, question: decision.question, actorId: automation.actorId, markTransactionNeedsClient: false,
          requestContext: { anchor_transaction_ids: [transactionId], vat_context_digest: context.digest, vat_document_id: current.evidence.id,
            vat_evidence_digest: taxFactsDigest(current.evidence), vat_source: (await import('./taxPostingFacts.js')).taxFactsSource(current.transaction),
            authority_basis: automation.authorityBasis, model: decision.model, source_explanation: decision.explanation } });
        await client.query(`update transactions set payload=payload - 'ledger_post_refusal',updated_at=now() where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, transactionId]);
        await client.query('commit');
        return { waiting_on_owner: true, evidence_request_id: ask.id };
      }
      if (decision.outcome !== 'supported') throw automation.error('AE_VAT_FACTS_UNSUPPORTED', decision.explanation);
      if (current.ownerFact && (!current.ownerFact.exclusively_taxable_business_use || current.ownerFact.personal_use)) throw automation.error('AE_VAT_RECOVERY_UNSUPPORTED', 'The owner declaration does not establish full business use.');
      const facts = await bindTaxPostingFactsWithClient({ client, firmId, clientId, transaction: current.transaction,
        facts: { ...decision.facts, document_id: current.evidence.id, explanation: decision.explanation }, actorId: automation.actorId,
        runtime: { model: decision.model, authority_basis: automation.authorityBasis, context_digest: context.digest } });
      await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,'system',$3,'transaction.tax_facts_generated','transaction',$4,$5::jsonb)`, [firmId, clientId, automation.actorId, transactionId,
        JSON.stringify({ transaction_id: transactionId, tax_posting_facts_digest: taxFactsDigest(facts), authority_basis: automation.authorityBasis,
          context_digest: context.digest, model: decision.model, explanation: decision.explanation,
          document_id: facts.document_id, evidence_digest: facts.evidence_digest, date_of_supply: facts.date_of_supply, reporting_date: facts.reporting_date,
          superseded_facts: priorFacts || null })]);
      const transaction = { ...current.transaction, tax_posting_facts: facts };
      const ledgerAccounts = await getDonnaLedgerAccountsForClient({ client, firmId, clientId });
      const taxPostingContext = await loadTaxPostingContext({ client, firmId, clientId, transaction,
        postingContext: { row: current.row }, ledgerAccounts, lock: true });
      const preview = buildDonnaLedgerWriteback({ transaction, ledgerAccounts, jurisdiction: 'ae' });
      // Reuse S2's full scope, source-reuse and money gate before accepting
      // anything. Posting independently repeats it under its own locks.
      automation.validatePostingFacts({ entry: { direction: Number(transaction.money_out || 0) > 0 ? 'in' : 'out' },
        coding: preview.coding, transaction, taxCodingEnabled: true, taxPostingContext });
      await client.query(`update transactions set payload=payload || jsonb_build_object('tax_posting_facts',$4::jsonb),updated_at=now()
        where firm_id=$1 and client_id=$2 and id=$3`, [firmId, clientId, transactionId, JSON.stringify(facts)]);
      await client.query('commit');
      return { generated: true };
    } catch (error) { await client.query('rollback'); throw error; }
  });
};

// The close path's decided set, in the legacy label vocabulary api.js still
// speaks. RT-16: its image under codingState.js's mapping is
// DECIDED_CODING_STATES — pinned byte-identical by codingState.test.js.
export const DECIDED_TRANSACTION_REVIEW_STATES = Object.freeze([
  'accepted',
  'resolved',
  'synced',
  'posted',
  'closed',
  'held'
]);

// The review CASE closes on a legacy input label that means "done here"
// (resolved / synced / posted / closed / held). RT-16: the label is the
// INPUT contract; the coding state itself rides transactions.coding_state.
export const shouldCloseReviewForState = (reviewState) => reviewCaseClosesForLegacyState(reviewState);

// The legacy label a review CASE renders for a line: the coding state's
// projection, else the SPA's defaults (an open case reads "Suggested", a
// closed one "Reviewed"). One helper for the DTO builder, the pod-safety
// before/after capture and the reverse target read, so they cannot
// disagree.
const REVIEW_CASE_CLOSED_STATUSES = new Set(['resolved', 'cancelled', 'closed', 'dismissed']);
export const reviewCaseLegacyLabel = (codingState, caseStatus) =>
  legacyReviewStateFor(codingState)
  || (REVIEW_CASE_CLOSED_STATUSES.has(String(caseStatus || '').trim().toLowerCase()) ? 'resolved' : 'suggested');

const transactionReviewCodingPatch = (patch = {}) => {
  const allowed = [
    'category',
    'proposed_account',
    'account_code',
    'account_name',
    'account_label',
    'xero_account_id',
    'xero_account_code',
    'xero_account_name',
    'xero_tax_type',
    'tax_type',
    'tax_treatment',
    'tax_posting_facts',
    'coding_policy',
    'account_id',
    'native_choice',
    'native_source',
    'support_status',
    'support_note',
    // An unattended coding accept is still an APPLIED coding decision. Keep
    // its lifecycle receipt on the transaction alongside the account fields;
    // otherwise downstream ask/match gathers continue to read the old
    // `suggested` marker even though the named review writer accepted it.
    'ai_suggestion_status',
    'ai_suggestion_applied_via'
  ];
  const out = Object.fromEntries(
    allowed
      .filter((key) => patch[key] !== undefined && patch[key] !== null && patch[key] !== '')
      .map((key) => [key, patch[key]])
  );
  // RT-16: ai_suggestion_status is the APPLIED receipt only; 'suggested'
  // was the retired state value (the column carries 'proposed').
  if (String(out.ai_suggestion_status || '') === 'suggested') delete out.ai_suggestion_status;
  return out;
};

export const isIntercompanyAccount = (accountCode = '') =>
  /intercompany|internal transfer|related party|treasury/.test(normalizeIntelText(accountCode));

export const fallbackSupportNoteForSuggestion = (suggestion = {}, accountCode = '') => {
  const account = suggestion.account_label || suggestion.account_name || suggestion.xero_account_name || accountCode || suggestion.proposed_account || 'the suggested account';
  if (isIntercompanyAccount(account)) {
    return suggestion.support_note || suggestion.reasoning || `Reviewer confirmed ${account}; bank statement line is sufficient support for this intercompany movement.`;
  }
  if (suggestion.evidence_required !== false) return '';
  return suggestion.support_note || suggestion.reasoning || `AI suggestion applied to ${account}; bank statement line is sufficient support.`;
};

// RT-16 — the review-queue reads that feed rowToTransactionReviewPayload join
// the transaction's coding_state (the case file carries no coding state any
// more; migration 138 dropped its column). `q.*` keeps every query's column
// shape; the join key is the case file's transaction (payload.transaction_id,
// else item_id).
export const REVIEW_QUEUE_WITH_CODING_STATE_SQL = `transaction_review_queue q
       left join transactions t
         on t.firm_id = q.firm_id
        and t.id = coalesce(q.payload->>'transaction_id', q.item_id)`;

// PR 3: keep the transaction-shaped payload but route through the shared
// DTO so item_type='document_line' rows go through the same envelope.
// RT-16: the `review_state` the bank-tx review surfaces render is a
// PROJECTION of the transaction's coding_state (joined as
// transaction_coding_state by the queries above) — never a state of the
// case file itself. The shared DTO only normalises status + envelope keys.
export const rowToTransactionReviewPayload = (row = {}) => {
  const payload = row.payload || {};
  const codingState = normalizeCodingState(row.transaction_coding_state ?? row.coding_state);
  const reviewState = reviewCaseLegacyLabel(codingState, row.status);
  const { transaction_coding_state: _joinedCodingState, ...rowWithoutJoin } = row;
  const base = rowToReviewItemPayload({ ...rowWithoutJoin, item_type: row.item_type || 'transaction' });
  return {
    ...rowWithoutJoin,
    ...base,
    item_type: row.item_type || 'transaction',
    coding_state: codingState,
    review_state: reviewState,
    payload: {
      ...payload,
      review_state: reviewState
    }
  };
};

// The client's account menu for LLM surfaces (transaction chat):
// the external mirror chart when one is synced, otherwise the
// Donna-chart union — the same menu the batch coder codes against,
// so every surface proposes from one vocabulary.
export const getClientAccountOptionsFromDb = async ({ firmId = DEFAULT_FIRM_ID, clientId } = {}) =>
  withFirmDbClient(async (client) => {
    try {
      const menuProfile = withClientCodingPolicy({}, await resolveClientCodingPolicyWithClient({ client, firmId, clientId }));
      const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
      if (xeroAccounts.length) return accountOptionsForClient(xeroAccounts, menuProfile);
      const ledgerAccounts = await getDonnaLedgerAccountsForClient({ client, firmId, clientId });
      return accountOptionsForClient(__donnaChartMenuAccounts(ledgerAccounts, menuProfile), menuProfile);
    } catch (error) {
      if (isCodingPolicyError(error)) await recordCodingPolicyFailure({ client, firmId, clientId, error });
      throw error;
    }
  });

export const captureNativeChatCodingContextWithClient = async ({ client, firmId, clientId, transactionIds }) => {
  const policy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId });
  if (!policy.nativeMenu) return null;
  const sources = {}, cases = [];
  for (const transactionId of [...new Set(transactionIds)]) {
    const current = await readJevCase({ client, firmId, clientId, transactionId, evidenceOnly: true });
    sources[transactionId] = nativeCodingSourceReceipt(current.caseEvidence);
    cases.push(jevCasePrompt(current.caseEvidence));
  }
  return { native_coding_sources: sources, native_coding_cases: cases };
};

export const revalidateNativeChatCodingContextWithClient = async ({ client, firmId, clientId, context, actions }) => {
  if (!context?.coding_policy?.native_chart) return;
  for (const action of actions || []) {
    if (!['apply_category', 'recode_decided', 'mark_personal'].includes(action.type)) continue;
    if (!action.native_choice || !Object.keys(action.native_source_by_transaction || {}).length) codingChoiceFailure('chat_source_receipt_missing');
    for (const [transactionId, receipt] of Object.entries(action.native_source_by_transaction || {})) {
      const current = await assertNativeCodingSourceWithClient({ client, firmId, clientId, transactionId, receipt, lock: false });
      const policy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId,
        businessDate: current.caseEvidence.transactions.find(row => row.id === transactionId)?.transaction_date });
      assertCodingPolicyReceipt(policy, action.coding_policy_by_transaction?.[transactionId] || action.coding_policy);
      assertNativeCodingChoice(policy.nativeMenu, { ...action, proposed_account: action.account_name }, { applying: true });
    }
  }
};

const enrichCodingForClient = async ({ client, firmId, clientId, coding = {}, transaction = {} }) => {
  const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
  if (!xeroAccounts.length) return coding;
  const policy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate: transaction.date });
  return enrichCodingWithXeroAccount({ coding, transaction, xeroAccounts, jurisdiction: policy.jurisdiction });
};

// Resolve persisted identity before any coding provider or accounting effect.
// The caller owns recovery receipts: a failure inside a transaction must first
// roll back, then record its recovery obligation on the live connection.
export const resolveClientCodingPolicyWithClient = async args =>
  (await readClientCodingContextWithClient(args)).codingPolicy;

// Bind one resolved policy to the runtime model context.
export const withClientCodingPolicy = (profile, policy) => {
  profile.codingPolicy = policy;
  if (policy.nativeMenu) profile.chartAutoMints = false;
  profile.jurisdiction = policy.jurisdiction;
  profile.entityType = policy.entityType;
  profile.entity_type = policy.entityType;
  profile.taxProfile = policy.taxProfile;
  profile.tax_profile = policy.taxProfile;
  profile.accountingSystem = policy.accountingSystem;
  profile.accounting_system = policy.accountingSystem;
  return profile;
};

export const __resolveClientCodingPolicyWithClientForTests = (args) => resolveClientCodingPolicyWithClient(args);
export const resolveClientCodingPolicy = ({ firmId = DEFAULT_FIRM_ID, clientId, businessDate = null } = {}) =>
  withFirmDbClient(async (client) => {
    try {
      return await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate });
    } catch (error) {
      if (isCodingPolicyError(error)) await recordCodingPolicyFailure({ client, firmId, clientId, error });
      throw error;
    }
  });

// FIK-0a: a coding fact read that failed is still degraded to [] (no decision
// changes in this slice), but its receipt names the failure so it can never
// be mistaken for a genuinely empty memory. Only the error code is kept: the
// message can carry query values and the receipt is not a private store.
const firmFactReadFailure = (error) => ({ status: 'read_failed',
  error: { code: String(error?.code || error?.name || 'unknown').slice(0, 64) } });
// FIK-0b: under CODING_FACT_ADMISSION a failed read no longer codes the line
// as if its memory were empty. Nothing is decided; the line is held on the
// existing coding-failure receipt, so the convergence clock re-drives it — a
// retry owned by the queue, never an owner ask.
const firmFactReadHold = (read) => ({ provider: 'firm_facts', status: 0, reason: 'firm_fact_read_failed',
  message: `Coding memory could not be read (${read?.error?.code || 'unknown'}); nothing was coded and the line will be retried.`,
  retryable: true, code: 'CODING_CONTEXT_READ_FAILED', owner: 'queue' });

export const assertCodingSuggestionForPolicy = (policy, suggestion = {}, { requireReceipt = true } = {}) => {
  if (requireReceipt) assertCodingPolicyReceipt(policy, suggestion.coding_policy);
  assertNativeCodingChoice(policy.nativeMenu, suggestion);
  const taxCode = suggestion.tax_treatment;
  if (taxCode == null || String(taxCode).trim() === '') return;
  // The country's no-VAT treatment is its own label, offered only on a line
  // the record says not registered; the posting policy decides the date.
  if (classifyTaxCodeForPolicy(policy, taxCode) !== 'valid' && !withoutTaxTreatmentsFor(policy.jurisdiction).includes(String(taxCode).trim())) {
    throw new CodingPolicyError('coding_policy_invalid', { jurisdiction: policy.jurisdiction, details: { reason: 'tax_code_not_in_policy' } });
  }
};

// AI chat actions carry the policy receipt from their persisted generation.
// Validate before minting even a review case; the named review writer repeats
// this check under its transaction lock. Legacy AI actions must be regenerated.
export const validateCodingPolicyForChatActionInDb = async ({ firmId = DEFAULT_FIRM_ID, clientId, transactionId, action } = {}) =>
  withFirmDbClient(async (client) => {
    try {
      const row = (await client.query(
        'select transaction_date, payload from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1',
        [firmId, clientId, transactionId]
      )).rows[0] || {};
      const policy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate: rowToTransactionPayload(row).date });
      const receipt = action?.coding_policy_by_transaction?.[transactionId] || action?.coding_policy;
      if (!receipt) throw new CodingPolicyError('jurisdiction_context_conflict', { jurisdiction: policy.jurisdiction, details: { reason: 'coding_policy_receipt_missing' } });
      assertCodingSuggestionForPolicy(policy, { ...action, proposed_account: action.account_name, coding_policy: receipt, tax_treatment: action.tax_treatment });
      if (policy.nativeMenu) {
        assertNativeCodingChoice(policy.nativeMenu, { ...action, proposed_account: action.account_name }, { applying: true });
        await assertNativeCodingSourceWithClient({ client, firmId, clientId, transactionId,
          receipt: action.native_source_by_transaction?.[transactionId], lock: false });
      }
      const profile = withClientCodingPolicy({}, policy);
      const externalAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
      const chart = externalAccounts.length ? externalAccounts
        : __donnaChartMenuAccounts(await getDonnaLedgerAccountsForClient({ client, firmId, clientId }), profile);
      const menu = accountOptionsForClient(chart, profile);
      if (!action.account_name || !menu.some((name) => normalizeIntelText(name) === normalizeIntelText(action.account_name))) {
        throw new CodingPolicyError('coding_policy_invalid', { jurisdiction: policy.jurisdiction, details: { reason: action.account_name ? 'coding_account_not_in_menu' : 'coding_account_missing' } });
      }
      return receipt;
    } catch (error) {
      if (isCodingPolicyError(error)) await recordCodingPolicyFailure({ client, firmId, clientId, transactionIds: [transactionId], error });
      throw error;
    }
  });

// Terminal coding states the single-line re-suggest must never
// overwrite (a pilot-client receipt, June 2026): the row's AI button ran a
// fresh per-click verdict — a THINNER call than the batch path (no
// known_facts, no chat context) — and flattened a human-accepted line
// back to 'suggested' 86 minutes after the firm accepted it. A human
// word (or a settled auto-apply) is terminal: re-suggest is for
// undecided lines only. Pure; exported for tests.
// RT-16: reads the ONE column (a DTO or a row carrying `coding_state`).
export const __isTerminalCodingState = (row = {}) => isDecidedCodingState(row?.coding_state);

const CONFIDENT_AUTO_CODING_SOURCES = new Set(['client_rule', 'merchant_lookup']);

// Reserve bounded batch capacity for work the coder can actually perform.
// Replied requests remain eligible for the reply-context helper below; a draft
// or open client question owns its line unless current source evidence invalidated
// its coding. Reconsider without closing the ask; only a new applied verdict
// invokes the existing supersession writer.
const PENDING_EVIDENCE_RECONSIDERATION_SQL = `(t.payload ? 'coding_evidence_reconsideration' and (t.payload->'ai_suggestion') is null)`;
const BATCH_OWNER_WAIT_SQL = `exists (
  select 1 from client_evidence_requests owner_wait
   where owner_wait.firm_id = t.firm_id
     and owner_wait.client_id = t.client_id
     and owner_wait.transaction_id = t.id
     and owner_wait.audience = 'client'
     and owner_wait.status in ('draft', 'open')
) and not (${PENDING_EVIDENCE_RECONSIDERATION_SQL})`;

// Third batch-coder pool: ordinary imported bank lines are source-of-truth
// work even when transaction intel did not mint a review-queue sidecar and no
// document matcher settled them. Honeybee happened to exercise the first two
// pools; Cactus exposed that using those side effects as an admission ticket
// stranded most of a new entity's book. Keep this query in lockstep with
// codingConvergence.DISCOVER_CODER_CLIENTS_SQL so the five-minute clock only
// discovers rows this loader will actually return. An unresolved policy failure
// also re-admits an existing nonterminal proposal until its replacement commits.
export const DIRECT_UNCODED_NEEDS_REVIEW_SQL = `
  select t.*
    from transactions t
   where t.firm_id = $1
     and t.client_id = $2
     and (
       (t.status = 'needs_review' and (t.payload->'ai_suggestion') is null)
       or (${ACTIVE_CODING_POLICY_FAILURE_SQL})
     )
     and coalesce(t.payload->>'auto_categorize_source', '') not in ('client_rule', 'merchant_lookup')
     and (t.coding_state is null or t.coding_state not in ('applied', 'held', 'posted', 'synced', 'closed'))
     and not ${REFUSED_CROSS_WINDOW_GROUP_SQL}
     and not (t.id = any($4::text[]))
     and not exists (
       select 1
         from client_evidence_requests r
        where r.firm_id = t.firm_id
          and r.client_id = t.client_id
          and r.transaction_id = t.id
          and lower(r.status) in ('draft', 'open', 'replied')
          and (lower(r.status) = 'replied' or not (${PENDING_EVIDENCE_RECONSIDERATION_SQL}))
     )
   order by t.transaction_date nulls last, t.created_at, t.id
   limit $3
`;

// Provider-failure receipt for the batch coder (2026-09-12, FI reliability
// pass). A transport failure — no key, a rejected key, a rate limit, an
// outage — used to be persisted as a `rules_fallback` verdict on every line
// in the chunk, which took the line out of the coder's pool for good (the
// clock only re-drives lines without an ai_suggestion) and, worse, could
// mint a "please upload support" question for a line whose bill was already
// matched. Now the lines stay bare, the cause rides the line as
// `payload.coding_provider_failure` (attempts and timestamps accumulate), one
// audit row per distinct failure per client names the transactions, and the
// existing convergence clock re-drives the coder on its bounded cadence until
// the provider answers. Any persisted verdict clears the receipt.
export const CODING_PROVIDER_FAILURE_PAYLOAD_KEY = 'coding_provider_failure';
export const recordCodingProviderFailureWithClient = async ({ client, firmId = DEFAULT_FIRM_ID, clientId, transactionIds = [], failure = {} } = {}) => {
  const ids = [...new Set((transactionIds || []).filter(Boolean))];
  if (!client || !clientId || !ids.length) return null;
  const now = new Date().toISOString();
  const cause = {
    provider: failure.provider || 'openai',
    status: Number(failure.status) || 0,
    reason: String(failure.reason || 'provider_failure').slice(0, 80),
    message: String(failure.message || '').slice(0, 300),
    retryable: failure.retryable !== false,
    // 2026-09-13 — the typed class and its human owner (providerTransport.js):
    // a credential failure rests on the OPERATOR, a transient one on the queue.
    code: typeof failure.code === 'string' && failure.code ? failure.code : null,
    owner: failure.owner === 'operator' || failure.owner === 'queue'
      ? failure.owner
      : (failure.retryable === false ? 'operator' : 'queue'),
    // How many requests the failed operation itself made (the transport's
    // retries) — distinct from `attempts` below, the number of failed runs.
    request_attempts: Math.max(1, Number(failure.attempts) || 1)
  };
  let prior = [];
  await client.query('begin');
  try {
    prior = (await client.query(
      `select id, payload->$3::text as receipt from transactions where firm_id = $1 and client_id = $2 and id = any($4::text[])`,
      [firmId, clientId, CODING_PROVIDER_FAILURE_PAYLOAD_KEY, ids]
    )).rows;
    const priorReceipt = prior.find((row) => row.receipt)?.receipt || null;
    const sameFailure = priorReceipt && priorReceipt.status === cause.status && priorReceipt.reason === cause.reason;
    for (const row of prior) {
      const previous = row.receipt || null;
      const receipt = {
        ...cause,
        attempts: (previous && previous.status === cause.status && previous.reason === cause.reason ? Number(previous.attempts) || 0 : 0) + 1,
        first_failed_at: previous?.first_failed_at || now,
        last_failed_at: now
      };
      await client.query(
        `update transactions set payload = payload || jsonb_build_object($4::text, $5::jsonb) where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, row.id, CODING_PROVIDER_FAILURE_PAYLOAD_KEY, JSON.stringify(receipt)]
      );
    }
    if (!sameFailure) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'transaction_ai_batch', 'transaction.coding_provider_failed', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ ...cause, transaction_ids: prior.map((row) => row.id), failed_at: now })]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return { ...cause, transaction_ids: prior.map((row) => row.id), receipted_at: now };
};

export const __loadDirectUncodedNeedsReviewPool = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  limit = 80,
  excludedTransactionIds = []
} = {}) => {
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (!client || !clientId || safeLimit === 0) return [];
  const result = await client.query(DIRECT_UNCODED_NEEDS_REVIEW_SQL, [
    firmId,
    clientId,
    safeLimit,
    [...new Set((excludedTransactionIds || []).filter(Boolean))]
  ]);
  return (result.rows || [])
    .map((row) => rowToTransactionPayload(row))
    .filter((tx) => {
      const source = tx.auto_categorize_source || tx.payload?.auto_categorize_source;
      return !CONFIDENT_AUTO_CODING_SOURCES.has(source) && !__isTerminalCodingState(tx);
    })
    .map((tx) => ({
      ...tx,
      review_id: null,
      review_reason: null,
      review_priority: null,
      review_payload: {}
    }));
};

// Q9 (Kari's dated sole-model lab call, 2026-08-16): resolve the coding
// lane's active model policy for (firm, client) into the transport the
// transactionLlm compatible path consumes. No active policy — or a policy
// naming the lane's strong default — keeps the openai path byte-identical.
// A policy naming any other qualified rung routes the deciding call over
// the openai_compatible endpoint; an UNCONFIGURED endpoint under an active
// policy fails LOUD here (OPENAI_COMPATIBLE_NOT_CONFIGURED propagates,
// nothing stamped) — never silently back to the strong model, the same
// posture as the disposition sweep (Q6c).
export const resolveCodingTransport = async (client, { firmId, clientId }) => {
  const policy = await readLaneDecidingPolicy({ client, firmId, clientId, laneId: 'transaction_coding' });
  if (!policy?.deciding_model || policy.deciding_model === CODING_DEFAULT_MODEL) return null;
  const endpoint = resolveOpenAiCompatibleEndpoint({});
  return {
    provider: 'openai_compatible',
    endpoint,
    model: policy.deciding_model,
    policy_basis: policy.basis || null
  };
};

export const suggestTransactionCodingInDb = async ({ firmId = DEFAULT_FIRM_ID, transactionId } = {}) => {
  if (!transactionId) {
    const error = new Error('Transaction id is required.');
    error.statusCode = 400;
    throw error;
  }

  return withFirmDbClient(async (client) => {
    let inTransaction = false;
    let policyClientId = null;
    try {
      const transactionResult = await client.query('select * from transactions where firm_id = $1 and id = $2', [firmId, transactionId]);
      if (!transactionResult.rows.length) {
        const error = new Error('Transaction not found.');
        error.statusCode = 404;
        throw error;
      }

      const transaction = rowToTransactionPayload(transactionResult.rows[0]);
      policyClientId = transaction.client_id;
      // Terminal-state guard: skip the model call entirely and return
      // the current snapshot unchanged. The refusal is audited so the
      // click still leaves a receipt.
      if (__isTerminalCodingState(transactionResult.rows[0])) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', 'transaction.ai_suggest.skipped', 'transaction', $3, $4::jsonb)`,
          [
            firmId,
            transaction.client_id,
            transactionId,
            JSON.stringify({
              reason: 'terminal_coding_state',
              coding_state: transactionResult.rows[0].coding_state || null
            })
          ]
        );
        return getFirmSnapshotFromDb({ firmId });
      }
      const clientResult = await client.query('select * from clients where firm_id = $1 and id = $2', [firmId, transaction.client_id]);
      // W1 (S09/L2): the ONE read boundary — a demoted legacy AI rule reaches
      // the coder as a labelled hint, never as authority.
      const ruleAuthority = await loadActiveClientRulesForAuthority({ client, firmId, clientId: transaction.client_id, limit: 50 });
      const rulesResult = { rows: [...ruleAuthority.authoritative, ...ruleAuthority.demoted.map(demotedRuleAsSuggestion)] };
      const clientProfile = clientResult.rows[0]
        ? {
            ...(clientResult.rows[0].profile || {}),
            id: clientResult.rows[0].id,
            companyName: clientResult.rows[0].profile?.companyName || clientResult.rows[0].company_name,
            uen: clientResult.rows[0].profile?.uen || clientResult.rows[0].uen,
            jurisdiction: clientResult.rows[0].jurisdiction || ''
          }
        : {};
      const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId: transaction.client_id });
      // Union-menu marker — same predicate as the batch path's
      // donnaChartClient: no external mirror ⇒ the menu is the palette
      // union and a listed account mints on first posting; the coder's
      // instructions say so instead of hedging (transactionLlm
      // instructionsForChartMode).
      if (!xeroAccounts.length) clientProfile.chartAutoMints = true;
      // Own-account roster → the coder's internal-transfer anchor (the
      // tx-12/tx-13 miscode class: a transfer to the client's own checking
      // coded as an expense because the model was never told which accounts
      // are the client's).
      clientProfile.knownBankAccounts = await loadClientOwnBankAccounts(client, {
        firmId,
        clientId: transaction.client_id
      });
      // Resolve the persisted policy before constructing the model vocabulary.
      withClientCodingPolicy(clientProfile, await resolveClientCodingPolicyWithClient({
        client,
        firmId,
        clientId: transaction.client_id,
        businessDate: transaction.date
      }));
      const codingCase = await readJevCase({client,firmId,clientId:transaction.client_id,transactionId,evidenceOnly:true});
      const matchedDocuments = new Map([[transactionId,codingCase.matchedDocument]]);
      const jevEnabled = await firstLineLaneDecidesWithClient(client, { firmId, clientId: transaction.client_id, decidedBy: 'transaction_coding',
        snapshot: await readClientConfigSnapshot(client, { firmId, clientId: transaction.client_id, strict: true }) });
      let firmFactRead = null;
      const codingAdmission = clientFlagActs({ flagKey: CODING_FACT_ADMISSION_FLAG,
        snapshot: await readClientConfigSnapshot(client, { firmId, clientId: transaction.client_id, strict: true }), envFallback: () => false });
      // Under the admission the strong coder reads the same memory Jev does, as
      // it already does in a batch round (plan §1.5); flag off, only Jev reads it.
      const firmFacts = jevEnabled || codingAdmission ? await getFirmFactsForSubjects({ client, firmId, clientId: transaction.client_id, codingAdmission,
        subjects: codingFactSubjects({ transaction, clientProfile, firmId }) })
        .catch((error) => { firmFactRead = firmFactReadFailure(error); return []; }) : [];
      if (codingAdmission && firmFactRead) {
        const hold = firmFactReadHold(firmFactRead);
        const receipt = await recordCodingProviderFailureWithClient({
          client, firmId, clientId: transaction.client_id, transactionIds: [transactionId], failure: hold
        });
        throw Object.assign(new Error(hold.message), { statusCode: 503, code: hold.code, details: { provider_failure: receipt || hold } });
      }
      const suggestion = await suggestTransactionCoding({
        clientProfile,
        transaction: {
          ...transaction,
          ...(jevEnabled ? {_jevProvider: await makeJevTrialProvider({client,firmId,clientId:transaction.client_id,resourceType:'transaction',resourceId:transactionId,decisionKind:'coding'})} : {}),
          case_evidence: jevCasePrompt(codingCase.caseEvidence),
          matched_document: matchedDocuments.get(transactionId) || null
        },
        clientRules: rulesResult.rows,
        xeroAccounts,
        jevEnabled,
        firmFacts,
        firmFactRead,
        transport: await resolveCodingTransport(client, { firmId, clientId: transaction.client_id })
      });
      if (suggestion?.provider_failure) {
        // The provider did not answer (no key, bad key, rate limit, outage,
        // hung or unreadable reply). Nothing is persisted as a verdict — the
        // template is a shape, not a coding; the cause is receipted on the
        // line (the convergence clock re-drives it) and the click surfaces
        // the typed failure instead of a fabricated suggestion.
        const receipt = await recordCodingProviderFailureWithClient({
          client, firmId, clientId: transaction.client_id, transactionIds: [transactionId], failure: suggestion.provider_failure
        });
        const error = new Error(suggestion.provider_failure.message || 'The model provider did not answer; nothing was suggested.');
        error.statusCode = 503;
        error.code = suggestion.provider_failure.code || 'PROVIDER_UNAVAILABLE';
        error.details = { provider_failure: receipt || suggestion.provider_failure };
        throw error;
      }
      const coding = {
        ...suggestion,
        ...(suggestion.document_allocations ? { document_allocations: matchedAllocationHandles(codingCase.caseEvidence,
          matchedDocuments.get(transactionId), suggestion.document_allocations) } : {}),
        evidence_digest: codingEvidenceDigest(matchedDocuments.get(transactionId) || null),
        case_evidence_digest: codingCaseRevision(codingCase.caseEvidence),
        ...(clientProfile.codingPolicy.nativeMenu ? { native_source: nativeCodingSourceReceipt(codingCase.caseEvidence) } : {}),
        suggested_at: Date.now(),
        transaction_id: transactionId
      };
      const suggestionPayload = xeroAccounts.length
        ? enrichCodingWithXeroAccount({ coding, transaction, xeroAccounts, jurisdiction: clientProfile.jurisdiction || null })
        : coding;

      await client.query('begin');
      inTransaction = true;
      const currentTransaction = (await client.query(
        'select coding_state, transaction_date, payload from transactions where firm_id = $1 and id = $2 for update',
        [firmId, transactionId]
      )).rows[0];
      if (!currentTransaction || __isTerminalCodingState(currentTransaction)) {
        await client.query('commit');
        inTransaction = false;
        return getFirmSnapshotFromDb({ firmId });
      }
      const freshCase = await readJevCase({client,firmId,clientId:transaction.client_id,transactionId,evidenceOnly:true});
      if (codingCaseRevision(freshCase.caseEvidence) !== codingCaseRevision(codingCase.caseEvidence)) {
        await client.query('commit');
        inTransaction = false;
        return getFirmSnapshotFromDb({ firmId });
      }
      const currentPolicy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId: transaction.client_id, businessDate: rowToTransactionPayload(currentTransaction).date, lockContext: true });
      assertCodingSuggestionForPolicy(currentPolicy, suggestionPayload);
      if (currentPolicy.nativeMenu) await assertNativeCodingSourceWithClient({ client, firmId, clientId: transaction.client_id,
        transactionId, receipt: suggestionPayload.native_source });
      // A healthy provider answer can still wait on a row or authority lock
      // until its owning invocation expires. Refuse before writing its verdict.
      assertExecutionBudgetActive({ client });
      await client.query(
        `update transactions
         set payload = payload || $3::jsonb,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [
          firmId,
          transactionId,
          JSON.stringify({
            ai_suggestion: suggestionPayload,
            ...(currentPolicy.nativeMenu ? { review_scope: null } : {})
          })
        ]
      );

      // RT-16: a fresh proposal on a proposed / asked / never-coded line
      // (the terminal guard above keeps decided lines out).
      await applyCodingTransition(client, { firmId, clientId: transaction.client_id, transactionId, to: 'proposed' });

      await client.query(
        `update transaction_review_queue
         set payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1
           and client_id = $2
           and status = 'open'
           and (
             item_id = $3
             or payload->>'transaction_id' = $3
           )`,
        [
          firmId,
          transaction.client_id,
          transactionId,
          JSON.stringify({
            ai_suggestion: suggestionPayload
          })
        ]
      );

      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'transaction.ai_suggest', 'transaction', $3, $4::jsonb)`,
        [
          firmId,
          transaction.client_id,
          transactionId,
          JSON.stringify({
            source: suggestionPayload.source,
            model: suggestionPayload.model,
            proposed_account: suggestionPayload.proposed_account,
            confidence: suggestionPayload.confidence
          })
        ]
      );

      await recordCodingPolicyRecovery({ client, firmId, clientId: transaction.client_id, transactionIds: [transactionId], policy: currentPolicy });
      await consumeNativeUnresolvedCodingWithClient({ client, firmId, clientId: transaction.client_id,
        transactionId, policy: currentPolicy, suggestion: suggestionPayload });
      assertExecutionBudgetActive({ client });
      await client.query('commit');
      return getFirmSnapshotFromDb({ firmId });
    } catch (error) {
      if (inTransaction) await client.query('rollback');
      if (isCodingPolicyError(error)) await recordCodingPolicyFailure({ client, firmId, clientId: policyClientId, transactionIds: [transactionId], error });
      throw error;
    }
  });
};

// ── The big-ticket invariant (June 2026, the EXPLAINED-green receipts) ──
// Firm policy, enforced in code: a MATERIAL line never reaches the books
// on description-only auto-apply. It gets there with a settled matched
// document (the uncapped path above), the client's word (reply-recode),
// or the firm's click (human apply) — never on the verdict's
// self-assessment alone. The rule, after the 06-12 receipts tightened
// it twice: auto-explain only MICRO-SPEND (line ≤ the line ceiling) at
// counterparties the BOOK hasn't spent materially with overall (≤ the
// relationship ceiling). Two numbers, both env-tunable; both
// currency-blind (acceptable slack at EUR/USD parity scale); the
// model's own cap and evidence_required always bind first.
const DESCRIPTION_ONLY_AUTO_APPLY_CEILING_DEFAULT = 50;
const RELATIONSHIP_AUTO_APPLY_CEILING_DEFAULT = 500;
export const __descriptionOnlyAutoApplyCeiling = () => {
  const fromEnv = Number(process.env.DONNA_AUTO_APPLY_CEILING || 0);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DESCRIPTION_ONLY_AUTO_APPLY_CEILING_DEFAULT;
};
export const __relationshipAutoApplyCeiling = () => {
  const fromEnv = Number(process.env.DONNA_AUTO_APPLY_RELATIONSHIP_CEILING || 0);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : RELATIONSHIP_AUTO_APPLY_CEILING_DEFAULT;
};

// Own-money family: transfers between the client's own accounts,
// conversions, and named owner/director movements ("payout to the
// director"). Their only possible evidence IS the bank line — capping
// them floods review with asks no auditor wants. External-counterparty
// P&L and loan claims all bind to the ceiling.
export const __isOwnMoneyMovementAccount = (accountCode = '') =>
  isIntercompanyAccount(accountCode) || /owner draw|director loan/.test(normalizeIntelText(accountCode));

// ── Counterparty-cluster materiality (June 2026, the koodaa receipts) ──
// Materiality is per-RELATIONSHIP: a €250 contractor leg belongs to a
// tens-of-thousands engagement, and a per-line ceiling alone is
// salami-sliceable. v1 clustered per coding ROUND and the limitation
// bit the same day: rounds pool a bounded slice (batchLimit + straggler
// leftovers), so a late round saw ONE koodaa leg and waved it through.
// Totals are therefore computed over the client's WHOLE BOOK — no
// round composition can dilute them.
//
// Key: for "pay … to NAME" transfer lines the counterparty is the
// payee tail (canonicalMerchantPattern alone keeps 'payout'/'to'
// tokens and would split the same vendor across phrasing variants);
// everything else canonicalizes the whole description. Under-
// clustering only weakens the extra protection — it can never block
// a line the per-line ceiling would have allowed on its own merits.
// The payee tail of a "pay … to NAME" line — the LINE's own naming of
// who the money went to. Shared by the cluster key and the own-money
// principal check; the line text is the only identity source the gate
// trusts (the suggestion's contact field is the model's claim, and a
// claim must not license itself).
export const __namedPayeeForTransaction = (transaction = {}) => {
  const text = `${transaction.description || ''} ${transaction.raw_description || ''}`.trim();
  const payee = text.match(/\bto\s+([a-z][^|]*)$/i);
  return payee ? payee[1].trim() : '';
};

// Does the line's named payee match one of the client's registry
// people? Token-subset match in both directions absorbs name-order and
// middle-name differences between registry print ("VIRTA, ANNA
// MARIA") and bank phrasing ("Anna Virta"); a single-token payee
// never matches — a bare surname is exactly the confusion this guards
// against. Pure; exported for tests.
export const __payeeMatchesKnownPrincipal = (payeeText = '', principals = []) => {
  const payeeTokens = normalizeIntelText(payeeText).split(' ').filter((token) => token.length > 1);
  if (payeeTokens.length < 2) return false;
  const payeeSet = new Set(payeeTokens);
  return (Array.isArray(principals) ? principals : []).some((principal) => {
    const name = typeof principal === 'string' ? principal : principal?.name || '';
    const tokens = normalizeIntelText(name).split(' ').filter((token) => token.length > 1);
    if (tokens.length < 2) return false;
    return tokens.every((token) => payeeSet.has(token)) || payeeTokens.every((token) => tokens.includes(token));
  });
};

export const __roundCounterpartyKey = (transaction = {}) => {
  const payee = __namedPayeeForTransaction(transaction);
  if (payee) return canonicalMerchantPattern(payee);
  return canonicalMerchantPattern(
    `${transaction.contact || ''} ${transaction.description || ''} ${transaction.raw_description || ''}`.trim()
  );
};

export const __counterpartyClusterTotals = (rows = []) => {
  const totals = new Map();
  for (const transaction of rows) {
    const key = __roundCounterpartyKey(transaction);
    if (!key) continue;
    const amount = Math.abs(amountForPayload(transaction));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    totals.set(key, (totals.get(key) || 0) + amount);
  }
  return totals;
};

export const __shouldAutoApplyBatchSuggestion = (transaction = {}, suggestion = {}) => {
  if (codingSourceIdentityConflicts(transaction.case_evidence).length) return false;
  if (codingRevenueEvidenceGap({transaction,suggestion,matchedDocument:transaction.matched_document})) return false;
  if (codingStatutoryEvidenceGap({transaction,suggestion,matchedDocument:transaction.matched_document})) return false;
  if (!suggestion || suggestion.evidence_required || ['owner_fact','payroll_package','document_discrepancy'].includes(suggestion.posting_requirement)) return false;
  // A verdict that names a missing CoA account is, by its own
  // admission, parked in the wrong account — never auto-apply it,
  // whatever account/confidence rides alongside. A RESOLVED one (the
  // account was just created from the verdict) stays a suggestion
  // too: the first posting into a brand-new account gets one human
  // glance before anything applies.
  if (suggestion.missing_account || suggestion.missing_account_resolved) return false;
  if (!suggestion.proposed_account || normalizeIntelText(suggestion.proposed_account) === 'suspense') return false;
  const confidence = String(suggestion.confidence || '');
  const jevResolved = hasJevResolvedCoding(suggestion);
  // A SETTLED matched document is the strongest evidence a bookkeeper
  // ever gets for a bank line — the firm already paired the invoice/
  // receipt to this exact transaction. High confidence on top of that
  // applies without an amount cap: the cap below exists for
  // description-only coding, and keeping it here parked an $854 land
  // lease bill (matched, settled, named vendor) as review noise
  // forever. A wrong code stays one cheap correction.
  const matchStatus = String(transaction.matched_document?.match_status || '');
  if ((confidence === 'high' || jevResolved) && (matchStatus === 'confirmed' || matchStatus === 'auto_matched')) {
    return true;
  }
  if (!jevResolved && !['medium', 'high'].includes(confidence)) return false;
  const amount = amountForPayload(transaction);

  // Intercompany transfers stay cap-exempt: a movement between the
  // firm's own books is deterministic — there is no owner FACT to ask
  // for, and no external document will ever exist.
  //
  // The broader own-money exemption that used to sit beside it — owner
  // draws/distributions naming no payee (e.g. "OWNER DISTRIBUTION
  // 905026") auto-applying past the model cap — is REVERSED (Kari's
  // dated call, 2026-08-04). The June rationale was honest on its day:
  // the ask lane didn't run anywhere, so a cap-blocked equity line
  // rotted at SUGGESTED (firm limbo). The ask lane now runs, which
  // flips the correct terminal: an unmatched owner-equity line binds to
  // the cap here, rests 'suggested', and the coding auto-post sweep
  // routes it to an OWNER ask ('owner_fact_required',
  // codingAutoPost.js) — was it a draw, a repayment, personal? Only the
  // owner knows; auto-explaining it off the account name alone was the
  // model self-licensing.
  //
  // A line that names a PERSON binds to the model cap below and then to
  // the identity-checked principal exemption (the family-payment-receipt guard
  // — a "Director loan" to a NAMED non-principal must not self-license
  // off the account name).
  if (isIntercompanyAccount(suggestion.proposed_account)) return true;

  // Model cap. Description-only / external-counterparty applies AND
  // own-money lines that DO name a payee bind to the model's own
  // auto_explain_limit first.
  const limit = Number(suggestion.auto_explain_limit || 0);
  if (!Number.isFinite(amount) || (!jevResolved && !(Number.isFinite(limit) && limit > 0 && amount <= limit))) return false;

  // Own-money with a registry-VERIFIED named principal is exempt from
  // the firm ceilings (but not the cap above) — the verified payee IS
  // the evidence. An unverified named payee falls through to the
  // ceilings. (the family-payment receipt, June 2026.)
  if (
    __isOwnMoneyMovementAccount(suggestion.proposed_account) &&
    __payeeMatchesKnownPrincipal(__namedPayeeForTransaction(transaction), transaction.known_principals)
  ) {
    return true;
  }

  // Big-ticket invariant: description-only applies are micro-spend only,
  // bound by the line ceiling AND the counterparty's BOOK-wide cluster
  // total (attached by the batch loop; absent for single-line callers,
  // where the line ceiling stands alone).
  if (amount > __descriptionOnlyAutoApplyCeiling()) return false;
  return Number(transaction.counterparty_cluster_total || 0) <= __relationshipAutoApplyCeiling();
};

const shouldAutoApplyBatchSuggestion = __shouldAutoApplyBatchSuggestion;

// Make the batch coding pool reply-aware. For each pooled line with a
// live evidence request:
//   open    → SKIP. The line is waiting on the client; there is nothing
//             new to code from, and re-coding writes 'suggested' over
//             the waiting state (the ASKED→SUGGESTED churn).
//   replied → attach client_reply_context (question + reply + reply
//             docs + the prior verdict labeled as the model's own
//             unconfirmed suggestion) so the coding click drains
//             pending replies through the same strong call — including
//             replies stranded by an earlier LLM outage.
export const __attachReplyContextToBatchPool = async ({
  client,
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactions = [],
  requireAttributableReply = false
} = {}) => {
  if (!transactions.length) return { pool: [], skippedWaiting: 0 };
  const requestsResult = await client.query(
    `select distinct on (transaction_id) id, transaction_id, status, audience, question, responded_at, resolved_by, response_payload,
            request_payload->>'lane' as lane, evidence_type
     from client_evidence_requests
     where firm_id = $1 and client_id = $2
       and transaction_id = any($3::text[])
       and status in ('open', 'replied')
       and audience = 'client'
     order by transaction_id, updated_at desc`,
    [firmId, clientId, transactions.map((tx) => tx.id)]
  );
  const requestByTx = new Map(requestsResult.rows.map((row) => [row.transaction_id, row]));

  const replyDocumentIds = [
    ...new Set(
      requestsResult.rows
        .filter((row) => row.status === 'replied')
        .flatMap((row) => (row.response_payload?.document_ids || []).filter(Boolean))
    )
  ];
  let documentsById = new Map();
  if (replyDocumentIds.length) {
    // Reply documents WITH content (see loadReplyDocumentsWithContent) — the
    // batch coder needs the report's numbers, not just its filename.
    const docs = await loadReplyDocumentsWithContent({
      client, firmId, clientId, documentIds: replyDocumentIds
    });
    documentsById = new Map(docs.map((doc) => [doc.id, doc]));
  }

  const pool = [];
  let skippedWaiting = 0;
  for (const transaction of transactions) {
    const request = requestByTx.get(transaction.id);
    if (!request) {
      pool.push(transaction);
      continue;
    }
    // W1 (INV-14): a drafted question is on the owner as much as a sent one —
    // the line waits for the answer, it is not re-coded around the question.
    if ((request.status === 'open' || request.status === 'draft') && !transaction.coding_evidence_reconsideration) {
      skippedWaiting += 1;
      continue;
    }
    // A line-anchored lane question about the business (the registration
    // question, taxRegistrationReply.js) is answered by its lane reader, not
    // by re-coding this line around the reply: the line waits until the
    // reader records the answer and re-admits it.
    if (request.status === 'replied' && request.lane === TAX_REGISTRATION_LANE) {
      skippedWaiting += 1;
      continue;
    }
    const replyActor = request.response_payload?.reply_processing?.actor_id || request.response_payload?.answer_recorded_by || (request.responded_at && request.resolved_by);
    if (requireAttributableReply && (!replyActor || replyActor === 'system')) {
      skippedWaiting += 1;
      continue;
    }
    const reply = String(request.response_payload?.reply || '').trim();
    const replyDocuments = (request.response_payload?.document_ids || [])
      .map((id) => documentsById.get(id))
      .filter(Boolean);
    if (!reply && !replyDocuments.length) {
      // 'replied' with nothing usable — code it as a normal line.
      pool.push(transaction);
      continue;
    }
    const prior = transaction.ai_suggestion && typeof transaction.ai_suggestion === 'object'
      ? transaction.ai_suggestion
      : null;
    pool.push({
      ...transaction,
      client_reply_context: {
        question_asked: request.question || '',
        client_reply: reply,
        reply_documents: replyDocuments,
        prior_verdict: prior
          ? {
              proposed_account: prior.proposed_account || '',
              confidence: prior.confidence || '',
              reasoning: prior.reasoning || '',
              provenance: 'machine_suggestion_unconfirmed'
            }
          : null
      },
      reply_evidence_request_id: request.id,
      ...(requireAttributableReply ? { owner_reply: { key: ownerReplyIdentity(request), actorId: replyActor,
        actorType: request.response_payload?.reply_processing?.actor_type || 'user' } } : {})
    });
  }
  return { pool, skippedWaiting };
};

export const batchSuggestTransactionCodingInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientIds = [],
  limit = 80,
  autoApply = true
} = {}) => {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) {
    const error = new Error('At least one client id is required for batch AI review.');
    error.statusCode = 400;
    throw error;
  }

  // Intake and explicit rule writers own transaction-intel refresh. A coding
  // round reads that persisted context and the direct uncoded pool; replaying
  // the broad legacy refresh here rewrote already-posted peer transactions.
  const batchLimit = Math.min(Math.max(Number(limit) || 80, 1), 160);
  const batchSummaries = [];
  // Every auto-applied line on Donna's internal ledger must terminate with a
  // journal, not merely review_state='accepted'. Collect the exact committed
  // lines and post them after the pooled coding connection is released. The
  // ledger sweep below is the durable retry for any refused inline post.
  const internalLedgerApplied = [];

  await withFirmDbClient(async (client) => {
    for (const clientId of ids) {
      let policyFailureTransactionIds;
      try {
      const clientResult = await client.query('select * from clients where firm_id = $1 and id = $2', [firmId, clientId]);
      const clientProfile = clientResult.rows[0]
        ? {
            ...(clientResult.rows[0].profile || {}),
            id: clientResult.rows[0].id,
            companyName: clientResult.rows[0].profile?.companyName || clientResult.rows[0].company_name,
            uen: clientResult.rows[0].profile?.uen || clientResult.rows[0].uen,
            jurisdiction: clientResult.rows[0].jurisdiction || ''
          }
        : { id: clientId };
      // W1 (S09/L2): the ONE read boundary (see the single-suggest path above).
      const ruleAuthority = await loadActiveClientRulesForAuthority({ client, firmId, clientId, limit: 80 });
      const rulesResult = { rows: [...ruleAuthority.authoritative, ...ruleAuthority.demoted.map(demotedRuleAsSuggestion)] };
      const xeroAccounts = await getXeroAccountsForClient({ client, firmId, clientId });
      // Own-account roster → the batch coder's internal-transfer anchor
      // (same attach as the single-suggest path — the tx-12/tx-13 class).
      clientProfile.knownBankAccounts = await loadClientOwnBankAccounts(client, { firmId, clientId });
      // Resolve the persisted policy before constructing the batch vocabulary.
      withClientCodingPolicy(clientProfile, await resolveClientCodingPolicyWithClient({
        client, firmId, clientId
      }));
      // Whose chart governs: a synced external mirror when one exists
      // (xero/qbo — propose account creation there, don't write it),
      // otherwise the client's Donna-ledger chart, which WE own and
      // can grow from verdicts directly.
      const accountingSystem = String(clientProfile.accounting_system || 'none').trim().toLowerCase();
      const donnaChartClient = accountingSystem === 'none';
      // Union-menu marker: transactionLlm appends the honest account-list
      // note (menu = chart ∪ palette; a listed account mints on first
      // posting) so the model stops hedging about "missing from the chart"
      // accounts that are usable menu names. External-mirror clients keep
      // byte-identical instructions.
      if (donnaChartClient && !clientProfile.codingPolicy.nativeMenu) clientProfile.chartAutoMints = true;

      // Resolve previously parked missing-account lines BEFORE building
      // the menu: their persisted verdicts already name the account —
      // create it in the Donna chart and re-point the suggestion, no
      // model call. Runs first so this round's menu (and any re-coding
      // of pooled lines) sees the new accounts.
      // RT-16 (RT-09 §4 a): every write this round makes — the verdicts and
      // the chart accounts a verdict mints — is an ADMITTED write, made on
      // THIS connection inside THIS transaction, so the 127/133 fence scopes
      // it through the transaction-local donna.admitted_generation GUC the
      // admission helper sets, instead of reading a minted account as a
      // foreign invalidation of the entity's ready generation. A client that
      // is not enrolled passes (enforced: false); an enrolled client that is
      // not ready refuses the round loudly, receipted by the helper.
      const admitCodingRound = async () => {
        const admission = await checkEntityReadinessAdmissionWithClient({
          client,
          firmId,
          clientId,
          boundary: 'worker_discovery',
          resourceType: 'client_worker_pool',
          resourceId: clientId
        });
        if (!admission.allowed) {
          await client.query('commit');
          const error = new EntityReadinessAdmissionError(admission);
          error.transactionCommitted = true;
          throw error;
        }
      };

      let parkedResolved = 0;
      if (donnaChartClient) {
        const parkedResult = await client.query(
          `select id, transaction_date, coding_state, payload from transactions
            where firm_id = $1 and client_id = $2
              and payload->'ai_suggestion'->'missing_account'->>'name' is not null
            limit 200`,
          [firmId, clientId]
        );
        if (parkedResult.rows.length) {
          await client.query('begin');
          try {
            await admitCodingRound();
            for (const row of parkedResult.rows) {
              if (__isTerminalCodingState(row)) continue;
              const parkedSuggestion = row.payload?.ai_suggestion;
              const parkedPolicy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate: rowToTransactionPayload(row).date, lockContext: true });
              assertCodingSuggestionForPolicy(parkedPolicy, parkedSuggestion, { requireReceipt: Boolean(parkedSuggestion?.coding_policy) });
              const ensured = await ensureLedgerAccountFromVerdict({
                client,
                firmId,
                clientId,
                missingAccount: parkedSuggestion?.missing_account || {},
                sourceTransactionId: row.id
              });
              if (!ensured) continue;
              const resolvedSuggestion = __resolveMissingAccountSuggestion(parkedSuggestion, { accountId: ensured.accountId });
              await client.query(
                `update transactions
                    set payload = payload || $3::jsonb, updated_at = now()
                  where firm_id = $1 and id = $2`,
                [firmId, row.id, JSON.stringify({ ai_suggestion: resolvedSuggestion })]
              );
              await client.query(
                `update transaction_review_queue
                    set payload = payload || $4::jsonb, updated_at = now()
                  where firm_id = $1 and client_id = $2 and status = 'open'
                    and (item_id = $3 or payload->>'transaction_id' = $3)`,
                [firmId, clientId, row.id, JSON.stringify({ ai_suggestion: resolvedSuggestion })]
              );
              parkedResolved += 1;
            }
            await client.query('commit');
          } catch (error) {
            await client.query('rollback');
            throw error;
          }
        }
      }

      const ledgerChartAccounts = donnaChartClient
        ? await getDonnaLedgerAccountsForClient({ client, firmId, clientId })
        : [];
      const menuAccounts = donnaChartClient
        ? __donnaChartMenuAccounts(ledgerChartAccounts, clientProfile)
        : xeroAccounts;
      const reviewResult = await client.query(
        `select q.id as review_id, q.item_id, q.reason, q.priority, q.payload as review_payload, t.*
         from transaction_review_queue q
         join transactions t on t.firm_id = q.firm_id
          and t.client_id = q.client_id
          and (t.id = q.item_id or t.id = q.payload->>'transaction_id')
         where q.firm_id = $1
           and q.client_id = $2
           and q.status = 'open'
           and (t.coding_state is null or t.coding_state not in ('applied', 'held', 'posted', 'synced', 'closed'))
           and not (${BATCH_OWNER_WAIT_SQL})
           and not ${REFUSED_CROSS_WINDOW_GROUP_SQL}
         order by q.priority desc, q.created_at asc, q.id asc
         limit $3`,
        [firmId, clientId, batchLimit]
      );
      const transactions = reviewResult.rows
        .map((row) => ({
          ...rowToTransactionPayload(row),
          review_id: row.review_id,
          review_reason: row.reason,
          review_priority: row.priority,
          review_payload: row.review_payload || {}
        }))
        .filter((tx) => {
          const src = tx.review_payload?.auto_categorize_source
            || tx.payload?.auto_categorize_source;
          return !CONFIDENT_AUTO_CODING_SOURCES.has(src);
        })
        // A terminal LINE never re-pools, whatever queue row dragged it
        // in (a pilot-client receipt: an accepted line re-pooled via a
        // stale open queue row, and the round's write flattened the
        // firm's accept back to 'suggested'). The queue-side review_state
        // exclusion above is necessary but not sufficient — the
        // transaction's OWN state is the truth this filter reads.
        .filter((tx) => !__isTerminalCodingState(tx));

      // Attach the reconciled-document evidence before the coding call —
      // the matchers already paired the invoice/receipt to each line.
      // Widen the pool beyond the review queue: most doc-matched lines
      // never get a queue row (or the match cascade closed it), so they
      // were unreachable by this pass and sat matched-but-uncoded forever
      // ("Needs category" on the Reconciled tab) — the exact settled
      // cohort the uncapped auto-apply path below was built for. Code any
      // reconciled/explained line the strong model hasn't seen yet.
      // 'auto_reconciled' belongs in this settled set (it IS settled-by-match —
      // mirrors codingAutoPost.SETTLED_RECON_STATUSES); its omission left
      // auto-matched-but-uncoded lines (the Aug-Honeybee Dadant/Chevron rows)
      // permanently unreachable by this pass, resting at Suspense. 'posted' is
      // deliberately still excluded: a posted journal already carries its
      // account, so an uncoded 'posted' line is a contradiction, not a pool.
      const matchedPoolLimit = Math.max(batchLimit - transactions.length, 0);
      if (matchedPoolLimit > 0) {
        const matchedUncodedResult = await client.query(
          `select t.*
           from transactions t
           where t.firm_id = $1
             and t.client_id = $2
             and t.reconciliation_status in ('reconciled', 'explained', 'auto_reconciled')
             and (t.payload->'ai_suggestion') is null
             and not (${BATCH_OWNER_WAIT_SQL})
             and not ${REFUSED_CROSS_WINDOW_GROUP_SQL}
           order by t.transaction_date nulls last, t.created_at
           limit $3`,
          [firmId, clientId, matchedPoolLimit]
        );
        const pooledIds = new Set(transactions.map((tx) => tx.id));
        for (const row of matchedUncodedResult.rows) {
          const tx = rowToTransactionPayload(row);
          if (pooledIds.has(tx.id)) continue;
          const src = tx.auto_categorize_source || tx.payload?.auto_categorize_source;
          if (CONFIDENT_AUTO_CODING_SOURCES.has(src)) continue;
          if (__isTerminalCodingState(tx)) continue;
          transactions.push({
            ...tx,
            review_id: null,
            review_reason: null,
            review_priority: null,
            review_payload: {}
          });
        }
      }

      // The source-of-truth pool: uncoded, non-terminal needs-review bank
      // lines do not need a match or queue sidecar to deserve a verdict. Fill
      // the remaining round capacity after the richer queue/match contexts,
      // deduping those already admitted above. The reply helper below remains
      // the final owner-wait guard for every pool shape.
      const directPoolLimit = Math.max(batchLimit - transactions.length, 0);
      if (directPoolLimit > 0) {
        const directTransactions = await __loadDirectUncodedNeedsReviewPool({
          client,
          firmId,
          clientId,
          limit: directPoolLimit,
          excludedTransactionIds: transactions.map((tx) => tx.id)
        });
        transactions.push(...directTransactions);
      }

      let { pool: codablePool, skippedWaiting } = await __attachReplyContextToBatchPool({
        client,
        firmId,
        clientId,
        transactions,
        requireAttributableReply: Boolean(clientProfile.codingPolicy.nativeMenu)
      });

      if (!clientProfile.codingPolicy.nativeMenu) for (const tx of codablePool) {
        const currentCase = await readJevCase({client,firmId,clientId,transactionId:tx.id,evidenceOnly:true});
        tx.matched_document = currentCase.matchedDocument;
        tx.case_evidence = jevCasePrompt(currentCase.caseEvidence);
        tx.case_evidence_digest = codingCaseRevision(currentCase.caseEvidence);
        if (clientProfile.codingPolicy.nativeMenu) tx.native_source = nativeCodingSourceReceipt(currentCase.caseEvidence);
      }

      // Layer-2 facts for this run: the firm's accumulated local
      // knowledge about the pooled merchants / this client / its
      // jurisdiction (firmFacts.js). Soft-fails to none. clientId is the
      // entity key (G−1(c)) — the coding run is the highest-value
      // merchant-fact consumer, so the cross-venture leak mattered most
      // here: venture A's merchant judgment no longer feeds venture B's
      // coding; legacy rows ride with legacy_firm_scope: true.
      // A failed read still degrades to none here (FIK-0a changes no
      // decision), but it is receipted as a failure, not as empty memory.
      let firmFactRead = null;
      const codingAdmission = clientFlagActs({ flagKey: CODING_FACT_ADMISSION_FLAG,
        snapshot: await readClientConfigSnapshot(client, { firmId, clientId, strict: true }), envFallback: () => false });
      // Under the admission each line reads its own memory through the
      // single-line recipe (plan §1.5): the pool read below shares one capped,
      // merchant-first set across the pool, so other lines' merchant facts can
      // crowd out a line's client and firm facts, and it keys merchants on
      // source_line as well. Flag off, the pool read is unchanged.
      const firmFactsByTransaction = codingAdmission
        ? await getCodingFactsForTransactions({ client, firmId, clientId, clientProfile, transactions: codablePool, codingAdmission })
          .catch((error) => { firmFactRead = firmFactReadFailure(error); return new Map(); })
        : null;
      const firmFacts = codingAdmission ? [] : await getFirmFactsForSubjects({
        client,
        firmId,
        clientId,
        codingAdmission,
        subjects: [
          ...codablePool.map((tx) => ({
            scope: 'merchant',
            value: `${tx.description || ''} ${tx.raw_description || ''} ${tx.source_line || ''}`
          })),
          { scope: 'client', value: clientProfile.uen || clientProfile.companyName || '' },
          { scope: 'jurisdiction', value: clientProfile.jurisdiction || '' },
          { scope: 'firm', value: firmId }
        ]
      }).catch((error) => { firmFactRead = firmFactReadFailure(error); return []; });

      const codingUnits = [];
      const chunked = new Set();
      // One batch request shares one policy, so a chunk never mixes the
      // reviewed guidance selected for different business dates (FIK-4
      // prerequisite, plan §8.5). With one selection for the whole pool — the
      // flag off, or no dated reviewed entry — this is today's chunking exactly.
      // A resolve failure keeps the default key: the batch call reports it as before.
      const guidanceKeyOf = (transaction) => {
        try {
          return requireCodingPolicyForClient(clientProfile, { businessDate: transaction.date ?? transaction.transaction_date ?? null }).guidanceDigest ?? '';
        } catch (error) {
          if (isCodingPolicyError(error)) return '';
          throw error;
        }
      };
      const chunksByGuidance = new Map();
      for (const transaction of codablePool) {
        if(chunked.has(transaction.id))continue;
        const ids=transaction.jev_refund_group?.status==='selected'?transaction.jev_refund_group.transaction_ids:[];
        const group=ids?.length===3?ids.map(id=>codablePool.find(tx=>tx.id===id)):[];
        const unit=group.length===3 && group.every(tx=>tx && !chunked.has(tx.id))?group:[transaction];
        codingUnits.push(unit);
        // A refund group stays whole even across selections; its own window
        // guard (assertRefundGroupPolicyWindow) then asks for a group decision.
        const key=guidanceKeyOf(unit[0]);
        if(!chunksByGuidance.has(key))chunksByGuidance.set(key,[]);
        const keyed=chunksByGuidance.get(key);
        if(!keyed.length || keyed.at(-1).length+unit.length>25)keyed.push([]);
        keyed.at(-1).push(...unit);
        for(const tx of unit)chunked.add(tx.id);
      }
      const chunks = [...chunksByGuidance.values()].flat();

      // Counterparty-cluster totals for the big-ticket gate — computed
      // over the client's WHOLE BOOK, not the round pool: rounds pool a
      // bounded slice, so a straggler round would see one koodaa leg
      // and wave it through (the 06-12 receipt). Looked up at gate
      // time, never attached to the pool objects (they feed the LLM
      // input).
      const counterpartySourceSql = `select description, raw_description, money_in, money_out, payload->>'contact' as contact
        from transactions where firm_id=$1 and client_id=$2`;
      const bookLinesResult = await client.query(counterpartySourceSql,[firmId,clientId]);
      const counterpartyTotals = __counterpartyClusterTotals(bookLinesResult.rows);

      // Registry people for the own-money apply gate — the People tab
      // is the gate for person-family claims (Director loan / draws):
      // a named payee must match it or the ceiling binds.
      const knownPrincipals = knownPrincipalsForClientProfile(clientProfile);

      let suggested = 0;
      let autoApplied = 0;
      let skippedTerminal = 0;
      let skippedStaleEvidence = 0;
      let remembered = 0;
      let providerFailure = null;
      const providerFailures = [];
      const groupSummary = [];
      // Aggregated missing-account verdicts — the firm-facing CoA
      // provisioning signal this run surfaced (one entry per proposed
      // account name, with how many lines are blocked on it).
      const missingAccountsByName = new Map();

      // Q9 — resolved ONCE per round: the whole round's chunks decide under
      // the same policy row (a mid-round policy flip must not split a round
      // across two models).
      const codingTransport = await resolveCodingTransport(client, { firmId, clientId });
      const jevEnabled = await firstLineLaneDecidesWithClient(client, { firmId, clientId, decidedBy: 'transaction_coding',
        snapshot: await readClientConfigSnapshot(client, { firmId, clientId, strict: true }) });

      if (jevEnabled) for (const transaction of codablePool) transaction._jevProvider = await makeJevTrialProvider({client,firmId,clientId,resourceType:'transaction',resourceId:transaction.id,decisionKind:'coding'});
      // Jev already solves independent cases separately. Persist those same units
      // separately, retaining atomicity for a complete duplicate/refund group.
      const persistenceChunks = jevEnabled ? codingUnits : chunks.flatMap(chunk => {
        if (!clientProfile.codingPolicy.nativeMenu || !chunk.some(tx => tx.client_reply_context)) return [chunk];
        const units = codingUnits.filter(unit => chunk.includes(unit[0]));
        const result = []; let ordinary = [];
        for (const unit of units) {
          if (unit.some(tx => tx.client_reply_context)) {
            if (ordinary.length) { result.push(ordinary); ordinary = []; }
            result.push(unit); // Refund groups remain indivisible.
          } else ordinary.push(...unit);
        }
        if (ordinary.length) result.push(ordinary);
        return result;
      });
      const policyFailures = [];
      const unitSummaries = [];
      const groupRefusals = [];
      // FIK-0b: a failed memory read under the admission holds the whole round
      // (every line would be coded against the same missing memory).
      if (codingAdmission && firmFactRead && codablePool.length) {
        providerFailure = await recordCodingProviderFailureWithClient({
          client, firmId, clientId, transactionIds: codablePool.map((transaction) => transaction.id), failure: firmFactReadHold(firmFactRead)
        });
        unitSummaries.push({ transaction_ids: codablePool.map((transaction) => transaction.id), scanned: codablePool.length,
          suggested: 0, auto_applied: 0, status: 'context_read_failed' });
      }
      for (let chunk of (codingAdmission && firmFactRead ? [] : persistenceChunks)) {
        const counters = { suggested, autoApplied, remembered, skippedTerminal, skippedStaleEvidence };
        const previousMissingAccounts = new Map([...missingAccountsByName].map(([key,value]) => [key,{...value}]));
        try {
        policyFailureTransactionIds = chunk.map((transaction) => transaction.id);
        const chunkInternalApplied = [];
        let generationProfile = clientProfile, generationFacts = firmFacts, generationFactsByTransaction = firmFactsByTransaction;
        let generationCounterpartyTotals = counterpartyTotals;
        if (clientProfile.codingPolicy.nativeMenu) {
          // Prior units commit before this generation. Rehydrate the model's
          // actual source inputs together; apply still checks this original
          // receipt after reasoning, without a lock during the provider call.
          await client.query('begin isolation level repeatable read');
          try {
            const company = (await client.query('select * from clients where firm_id=$1 and id=$2',[firmId,clientId])).rows[0];
            generationProfile = { ...company.profile, id: company.id,
              companyName: company.profile?.companyName || company.company_name,
              uen: company.profile?.uen || company.uen, jurisdiction: company.jurisdiction || '',
              knownBankAccounts: await loadClientOwnBankAccounts(client,{firmId,clientId}) };
            withClientCodingPolicy(generationProfile,await resolveClientCodingPolicyWithClient({client,firmId,clientId}));
            generationCounterpartyTotals = __counterpartyClusterTotals((await client.query(counterpartySourceSql,[firmId,clientId])).rows);
            const rows = (await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=any($3::text[])',
              [firmId,clientId,chunk.map(tx=>tx.id)])).rows;
            const current = new Map(rows.map(row=>[row.id,row]));
            const candidates = chunk.filter(tx=>current.has(tx.id) && !__isTerminalCodingState(current.get(tx.id)))
              .map(tx=>({ ...rowToTransactionPayload(current.get(tx.id)), review_id:tx.review_id,
                review_reason:tx.review_reason, review_priority:tx.review_priority, review_payload:tx.review_payload,
                ...(tx._jevProvider ? {_jevProvider:tx._jevProvider} : {}) }));
            const hydrated = await __attachReplyContextToBatchPool({client,firmId,clientId,transactions:candidates,requireAttributableReply:true});
            skippedWaiting += hydrated.skippedWaiting;
            skippedTerminal += chunk.length-candidates.length;
            if (chunk.some(tx=>tx.jev_refund_group?.status==='selected') && hydrated.pool.length !== chunk.length) {
              skippedStaleEvidence += hydrated.pool.length;
              hydrated.pool = []; // Never generate against a partial indivisible group.
            }
            chunk = hydrated.pool;
            for (const tx of chunk) {
              const currentCase = await readJevCase({client,firmId,clientId,transactionId:tx.id,evidenceOnly:true});
              tx.matched_document = currentCase.matchedDocument;
              tx.case_evidence = jevCasePrompt(currentCase.caseEvidence);
              tx.case_evidence_digest = codingCaseRevision(currentCase.caseEvidence);
              tx.native_source = nativeCodingSourceReceipt(currentCase.caseEvidence);
            }
            await client.query('commit');
          } catch (error) { await client.query('rollback'); throw error; }
          if (!chunk.length) continue;
          if (codingAdmission) generationFactsByTransaction = await getCodingFactsForTransactions({client,firmId,clientId,
            clientProfile:generationProfile,transactions:chunk,codingAdmission});
          else generationFacts = await getFirmFactsForSubjects({client,firmId,clientId,codingAdmission,subjects:[
            ...chunk.map(tx=>({scope:'merchant',value:`${tx.description || ''} ${tx.raw_description || ''} ${tx.source_line || ''}`})),
            {scope:'client',value:generationProfile.uen || generationProfile.companyName || ''},
            {scope:'jurisdiction',value:generationProfile.jurisdiction || ''},{scope:'firm',value:firmId}]});
        }
        const batch = await suggestTransactionCodingBatch({
          clientProfile: generationProfile,
          transactions: chunk,
          clientRules: rulesResult.rows,
          // The menu the model codes against. For Donna-chart clients
          // this is the ledger chart ∪ base vocabulary, NOT the (empty)
          // Xero mirror — the mirror rows below still drive the
          // Xero-identity enrichment, which correctly no-ops here.
          xeroAccounts: menuAccounts,
          firmFacts: generationFacts,
          firmFactsByTransaction: generationFactsByTransaction,
          firmFactRead,
          jevEnabled,
          transport: codingTransport
        });
        if (batch?.provider_failure) {
          // The provider did not answer this chunk (no key, bad key, rate
          // limit, outage). Nothing is persisted as a verdict; the cause is
          // receipted on the lines and the round stops here — the remaining
          // chunks would hit the same provider. The clock re-drives them.
          providerFailure = await recordCodingProviderFailureWithClient({
            client, firmId, clientId, transactionIds: chunk.map((transaction) => transaction.id), failure: batch.provider_failure
          });
          unitSummaries.push({ transaction_ids: chunk.map(transaction => transaction.id), scanned: chunk.length,
            suggested: 0, auto_applied: 0, status: 'provider_failed' });
          break;
        }
        const byId = new Map(chunk.map((transaction) => [transaction.id, transaction]));
        const failedIds = new Set();
        for (const failed of batch?.provider_failures || []) {
          if (!byId.has(failed.transaction_id) || failedIds.has(failed.transaction_id)) continue;
          failedIds.add(failed.transaction_id);
          const receipt = await recordCodingProviderFailureWithClient({
            client, firmId, clientId, transactionIds: [failed.transaction_id], failure: failed.failure
          });
          providerFailures.push({ transaction_id: failed.transaction_id, failure: receipt });
        }
        const writtenSuggestions = [];
        groupSummary.push(...(batch.group_summary || []));

        await client.query('begin');
        try {
          await admitCodingRound();
          for (const suggestion of batch.suggestions || []) {
            const transaction = byId.get(suggestion.transaction_id);
            if (!transaction || failedIds.has(transaction.id)) continue;

            // Race half of the terminal invariant: the pool was
            // selected before the model call, and a human accept can
            // land mid-round. Re-read the line's CURRENT state inside
            // the write transaction — a verdict never overwrites a
            // decision that arrived while it was being computed.
            const currentStateResult = await client.query(
              `select coding_state, transaction_date, payload
                 from transactions
                where firm_id = $1 and id = $2
                for update`,
              [firmId, transaction.id]
            );
            if (currentStateResult.rows.length && __isTerminalCodingState(currentStateResult.rows[0])) {
              skippedTerminal += 1;
              continue;
            }

            // The matcher may finish while the strong coding model is
            // thinking. Rehydrate the current evidence at the write boundary
            // and refuse the stale suggestion if the best match changed. A
            // later convergence tick will recode from the new document; we do
            // not persist a verdict that claims authority from an older view.
            const currentCase = await readJevCase({client,firmId,clientId,transactionId:transaction.id,evidenceOnly:true,lockEvidence:!clientProfile.codingPolicy.nativeMenu});
            if (codingCaseRevision(currentCase.caseEvidence) !== transaction.case_evidence_digest) {
              skippedStaleEvidence += 1;
              continue;
            }

            const currentPolicy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate: rowToTransactionPayload(currentStateResult.rows[0] || {}).date, lockContext: true });
            assertCodingSuggestionForPolicy(currentPolicy, suggestion);
            if (currentPolicy.nativeMenu) await assertNativeCodingSourceWithClient({ client, firmId, clientId,
              transactionId: transaction.id, receipt: transaction.native_source });
            if (currentPolicy.nativeMenu && transaction.client_reply_context) {
              const reply = (await client.query(`select * from client_evidence_requests
                where firm_id=$1 and client_id=$2 and id=$3 for update`,
                [firmId,clientId,transaction.reply_evidence_request_id])).rows[0];
              assertCurrentOwnerReply(reply,transaction.owner_reply?.key);
              const actor = reply.response_payload?.reply_processing?.actor_id || reply.response_payload?.answer_recorded_by || (reply.responded_at && reply.resolved_by);
              if (reply.transaction_id !== transaction.id || reply.audience !== 'client' || !actor || actor === 'system'
                || actor !== transaction.owner_reply?.actorId) codingChoiceFailure('owner_reply_authority_required');
            }
            assertExecutionBudgetActive({ client });

            let suggestionPayload = enrichCodingWithXeroAccount({
              coding: {
                ...suggestion,
                ...(suggestion.document_allocations ? { document_allocations: matchedAllocationHandles(currentCase.caseEvidence,
                  transaction.matched_document, suggestion.document_allocations) } : {}),
                evidence_digest: codingEvidenceDigest(transaction.matched_document),
                case_evidence_digest: transaction.case_evidence_digest || null,
                ...(currentPolicy.nativeMenu ? { native_source: transaction.native_source } : {}),
                suggested_at: Date.now(),
                transaction_id: transaction.id,
                source: suggestion.source || 'openai_batch',
                ...(transaction.client_reply_context
                  ? {
                      recoded_from_reply: true,
                      evidence_request_id: transaction.reply_evidence_request_id || null
                    }
                  : {})
              },
              transaction,
              xeroAccounts,
              jurisdiction: clientProfile.jurisdiction || null
            });
            if (suggestionPayload.missing_account?.name) {
              const missing = suggestionPayload.missing_account;
              const missingKey = normalizeIntelText(missing.name);
              const entry = missingAccountsByName.get(missingKey)
                || { ...missing, transaction_count: 0 };
              entry.transaction_count += 1;
              // Donna-chart clients: the chart is ours — create the
              // verdict-named account NOW and re-point the suggestion
              // at it (still a suggestion, never auto-applied; see the
              // missing_account_resolved veto in the apply gate).
              if (donnaChartClient) {
                const ensured = await ensureLedgerAccountFromVerdict({
                  client,
                  firmId,
                  clientId,
                  missingAccount: missing,
                  sourceTransactionId: transaction.id
                });
                if (ensured) {
                  suggestionPayload = __resolveMissingAccountSuggestion(suggestionPayload, { accountId: ensured.accountId });
                  entry.created = true;
                  entry.account_id = ensured.accountId;
                }
              }
              missingAccountsByName.set(missingKey, entry);
            }
            const supportNote = String(suggestionPayload.support_note || '').trim();
            // Reply-confirmed lines apply on the reply gate (the reply
            // IS the evidence — no auto_explain_limit amount cap, which
            // would park a client-confirmed $3.8k owner draw behind a
            // $25 limit forever). Everything else keeps the batch gate.
            const applies = autoApply && (transaction.client_reply_context
              ? __shouldApplyReplyRecode(suggestionPayload)
              : shouldAutoApplyBatchSuggestion(
                  {
                    ...transaction,
                    counterparty_cluster_total: generationCounterpartyTotals.get(__roundCounterpartyKey(transaction)) || 0,
                    known_principals: currentPolicy.nativeMenu ? knownPrincipalsForClientProfile(generationProfile) : knownPrincipals
                  },
                  suggestionPayload
                ));
            const nextCodingState = applies ? 'applied' : 'proposed';
            const txPatch = applies
              ? {
                  ...(currentPolicy.nativeMenu ? { account_id: suggestionPayload.account_id,
                    native_choice: suggestionPayload.native_choice, native_source: suggestionPayload.native_source } : {}),
                  proposed_account: suggestionPayload.proposed_account,
                  account_code: suggestionPayload.account_code || suggestionPayload.proposed_account,
                  account_name: suggestionPayload.account_name || '',
                  account_label: suggestionPayload.account_label || '',
                  xero_account_id: suggestionPayload.xero_account_id || null,
                  xero_account_code: suggestionPayload.xero_account_code || null,
                  xero_account_name: suggestionPayload.xero_account_name || null,
                  xero_account_type: suggestionPayload.xero_account_type || null,
                  xero_tax_type: suggestionPayload.xero_tax_type || null,
                  tax_type: suggestionPayload.tax_type || null,
                  tax_code: suggestionPayload.tax_code || null,
                  xero_account_match_status: suggestionPayload.xero_account_match_status || null,
                  contact: suggestionPayload.contact || transaction.contact || '',
                  tax_treatment: suggestionPayload.tax_treatment,
                  confidence: suggestionPayload.confidence || transaction.confidence || 'medium',
                  support_note: supportNote,
                  support_status: 'explained',
                  support_explained_at: transaction.support_explained_at || Date.now(),
                  reconciliation_status: transaction.reconciliation_status === 'reconciled' ? 'reconciled' : 'explained',
                  status: transaction.status === 'approved' ? 'approved' : 'ready',
                  ai_suggestion: suggestionPayload,
                  ai_suggestion_status: 'auto_applied',
                  ai_suggestion_applied_at: Date.now(),
                  // W1 (INV-01): the batch never persists a human-shaped "remember"
                  // intent on the line — its rule proposal is minted below with
                  // source 'ai_batch' (status proposed). A persisted true here was
                  // re-read by updateTransactionInDb as a human teaching.
                  remember_merchant_rule: false,
                  merchant_pattern: suggestionPayload.merchant_pattern || '',
                  merchant_rule_account: suggestionPayload.account_code || suggestionPayload.proposed_account,
                  merchant_rule_auto_explain_limit: suggestionPayload.auto_explain_limit || null
                }
              : {
                  ai_suggestion: suggestionPayload
                };
            assertExecutionBudgetActive({ client });
            if (currentPolicy.nativeMenu) txPatch.review_scope = null;
            const codingUpdateResult = await client.query(
              `update transactions
               set account_code = case when $4 then $5 else account_code end,
                   reconciliation_status = case when $4 then $6 else reconciliation_status end,
                   status = case when $4 and status = 'needs_review' then 'ready' else status end,
                   payload = (payload - 'coding_provider_failure') || $3::jsonb,
                   updated_at = now()
               where firm_id = $1 and id = $2
                 and coalesce((
                   select rm.matched_object_id || ':' || rm.status
                     from reconciliation_matches rm
                    where rm.firm_id = transactions.firm_id
                      and rm.client_id = $7
                      and rm.bank_transaction_id = transactions.id
                      and rm.status in ('confirmed', 'auto_matched', 'suggested')
                    order by case rm.status
                      when 'confirmed' then 0
                      when 'auto_matched' then 1
                      else 2
                    end, rm.id
                    limit 1
                 ), '') = $8
               returning id`,
              [
                firmId,
                transaction.id,
                JSON.stringify(txPatch),
                applies,
                txPatch.account_code || suggestionPayload.account_code || suggestionPayload.proposed_account,
                txPatch.reconciliation_status || transaction.reconciliation_status || null,
                clientId,
                transaction.matched_document
                  ? `${transaction.matched_document.document_id}:${transaction.matched_document.match_status}`
                  : ''
              ]
            );
            if (codingUpdateResult.rowCount === 0) {
              skippedStaleEvidence += 1;
              continue;
            }
            // RT-16: the ONE coding state — applied (auto) or proposed.
            await applyCodingTransition(client, { firmId, clientId, transactionId: transaction.id, to: nextCodingState });
            // Native review acceptance closes this review case; accounting stays incomplete.
            await client.query(
              `update transaction_review_queue
               set status = case when $5 then 'resolved' else status end,
                   payload = payload || $4::jsonb,
                   updated_at = now()
               where firm_id = $1
                 and client_id = $2
                 and status = 'open'
                 and (
                   item_id = $3
                   or payload->>'transaction_id' = $3
                 )`,
              [
                firmId,
                clientId,
                transaction.id,
                JSON.stringify({
                  ai_suggestion: suggestionPayload,
                  ...(applies ? { ai_suggestion_status: 'auto_applied' } : {}),
                  reviewer_note: applies ? 'Batch AI review auto-applied low-risk suggestion.' : undefined
                }),
                Boolean(applies && currentPolicy.nativeMenu)
              ]
            );

            writtenSuggestions.push(suggestion);
            await consumeNativeUnresolvedCodingWithClient({ client, firmId, clientId, transactionId: transaction.id,
              policy: currentPolicy, suggestion: suggestionPayload, answeredRequestId: transaction.reply_evidence_request_id || null });
            suggested += 1;
            if (applies) {
              autoApplied += 1;
              if (donnaChartClient && !currentPolicy.nativeMenu) {
                chunkInternalApplied.push({ clientId, transactionId: transaction.id });
              }
              if (transaction.client_reply_context) {
                // #ask-reply-match — link the bank line → the client's
                // uploaded evidence document(s) so the artifact renders the
                // rich match branch. Inside the chunk txn; idempotent with
                // the sync reply path (ON CONFLICT DO NOTHING).
                await linkReplyEvidenceMatchesInDb({
                  client,
                  firmId,
                  clientId,
                  transactionId: transaction.id,
                  replyDocuments: transaction.client_reply_context.reply_documents || [],
                  evidenceRequestId: transaction.reply_evidence_request_id || null,
                  // Magnitude of the bank line — money_in for receipts,
                  // money_out for payments. Math.abs(Number(...)) per field so
                  // the string "0.00" doesn't short-circuit `||` as truthy and
                  // zero the amount.
                  fallbackAmount: Math.abs(Number(transaction.money_in)) || Math.abs(Number(transaction.money_out)) || 0
                });
              }
              await resolveOpenEvidenceRequestsForTransaction({
                client,
                firmId,
                clientId,
                transactionId: transaction.id,
                ...(currentPolicy.nativeMenu ? { actorId: transaction.owner_reply?.actorId || 'coding_batch_review' } : {}),
                note: transaction.client_reply_context
                  ? `Resolved by client reply — applied ${txPatch.account_code || suggestionPayload.proposed_account}.`
                  : `Superseded by auto-applied coding (${txPatch.account_code || suggestionPayload.proposed_account}).`
              });
              if (currentPolicy.nativeMenu) {
                const actorId = transaction.owner_reply?.actorId || 'coding_batch_review';
                if (transaction.owner_reply) await recordOwnerReplyProcessingReceipt({ client, firmId, clientId, actorId,
                  actorType: transaction.owner_reply.actorType, evidenceRequestId: transaction.reply_evidence_request_id, transactionId: transaction.id,
                  processing: { reply_key: transaction.owner_reply.key, state: 'completed', applied: true, actor_id: actorId,
                    actor_type: transaction.owner_reply.actorType }, metadata: { model: suggestionPayload.model || null } });
                // Bind this unit's authorized consequence under the existing source fence.
                // Keep the original model source and focal digest in ai_suggestion.
                const acceptedCase = await readJevCase({ client,firmId,clientId,transactionId:transaction.id,evidenceOnly:true });
                await client.query("update transactions set payload=jsonb_set(payload,'{native_source}',$4::jsonb) where firm_id=$1 and client_id=$2 and id=$3",
                  [firmId,clientId,transaction.id,JSON.stringify(nativeCodingSourceReceipt(acceptedCase.caseEvidence))]);
                const acceptedRow = (await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3',
                  [firmId,clientId,transaction.id])).rows[0];
                const reviewScope = nativeReviewScopeBody({ transaction: rowToTransactionPayload(acceptedRow), policy: currentPolicy, actorId,
                  authorityBasis: transaction.owner_reply ? 'attributable_owner_reply_coding' : 'existing_low_risk_coding_acceptance' });
                const auditId = await emitReviewAudit(client, { firmId, clientId, itemType: 'transaction', itemId: transaction.id,
                  action: 'review.accepted', actorId, actorType: transaction.owner_reply?.actorType || 'system',
                  metadata: { transaction_id: transaction.id, coding_state: 'applied', review_scope: reviewScope,
                    model: suggestionPayload.model || null, ...(transaction.owner_reply ? { evidence_request_id: transaction.reply_evidence_request_id,
                      reply_key: transaction.owner_reply.key } : {}) } });
                if (!auditId) throw new Error('Native review acceptance audit was not persisted.');
                await client.query("update transactions set payload=payload || jsonb_build_object('review_scope',$4::jsonb) where firm_id=$1 and client_id=$2 and id=$3",
                  [firmId,clientId,transaction.id,JSON.stringify({ ...reviewScope, acceptance_audit: { store: 'audit_events', id: auditId } })]);
              }
              if (suggestionPayload.remember_candidate && suggestionPayload.merchant_pattern) {
                const savedRule = await saveMerchantRuleForPayload({
                  client,
                  firmId,
                  clientId,
                  transactionId: transaction.id,
                  payload: {
                    ...transaction,
                    ...txPatch,
                    support_note: supportNote,
                    ai_suggestion: suggestionPayload
                  },
                  supportNote,
                  source: 'ai_batch'
                });
                if (savedRule) remembered += 1;
              }
            }
          }

          for (const suggestion of writtenSuggestions) {
            await recordCodingPolicyRecovery({ client, firmId, clientId, transactionIds: [suggestion.transaction_id], policy: suggestion.coding_policy });
          }
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
             values ($1, $2, 'system', 'transaction.ai_batch_review', 'client', $2, $3::jsonb)`,
            [
              firmId,
              clientId,
              JSON.stringify({
                chunk_count: persistenceChunks.length,
                suggested,
                auto_applied: autoApplied,
                remembered,
                skipped_terminal: skippedTerminal,
                skipped_stale_evidence: skippedStaleEvidence,
                skipped_waiting_on_client: skippedWaiting,
                group_summary: groupSummary.slice(0, 20),
                missing_accounts: [...missingAccountsByName.values()],
                parked_missing_account_lines_resolved: parkedResolved
              })
            ]
          );
          // The transaction includes the verdict, case, audit and any chart
          // changes. Expiry during any awaited write rolls all of them back.
          assertExecutionBudgetActive({ client });
          await client.query('commit');
          internalLedgerApplied.push(...chunkInternalApplied);
          unitSummaries.push({ transaction_ids: chunk.map(transaction => transaction.id), scanned: chunk.length,
            suggested: suggested - counters.suggested, auto_applied: autoApplied - counters.autoApplied, status: 'completed' });
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
        } catch (error) {
          if (!isCodingPolicyError(error) && error.code !== 'REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED') throw error;
          ({ suggested, autoApplied, remembered, skippedTerminal, skippedStaleEvidence } = counters);
          missingAccountsByName.clear();
          for (const [key,value] of previousMissingAccounts) missingAccountsByName.set(key,value);
          unitSummaries.push({ transaction_ids: chunk.map(transaction => transaction.id), scanned: chunk.length,
            suggested: 0, auto_applied: 0, status: 'refused', code: error.code });
          if (error.code === 'REFUND_GROUP_POLICY_WINDOW_UNSUPPORTED') {
            const { receiptPostingFailure } = await import('./ledger.js');
            await receiptPostingFailure({ client, firmId, clientId, transactionIds: chunk.map(transaction => transaction.id), error });
            // H-7b: each group member's refusal carries the case revision it
            // was refused under, so admission rests the group until that
            // evidence changes (codingPolicyRecovery.js names the rule).
            const members = new Set(error.details?.transaction_ids || []);
            const refused = chunk.filter(transaction => members.has(transaction.id) && transaction.case_evidence_digest);
            if (refused.length) await client.query(`update transactions
                set payload = jsonb_set(payload, '{ledger_post_refusal,case_evidence_digest}', $4::jsonb -> id)
              where firm_id = $1 and client_id = $2 and id = any($3::text[])
                and payload->'ledger_post_refusal'->>'code' = $5`,
            [firmId, clientId, refused.map(transaction => transaction.id),
              JSON.stringify(Object.fromEntries(refused.map(transaction => [transaction.id, transaction.case_evidence_digest]))), error.code]);
            groupRefusals.push({ transaction_ids: chunk.map(transaction => transaction.id), code: error.code, details: error.details });
            continue;
          }
          const failures = await recordCodingPolicyFailure({ client, firmId, clientId,
            transactionIds: chunk.map(transaction => transaction.id), error });
          policyFailures.push({ transaction_ids: chunk.map(transaction => transaction.id), code: error.code,
            receipt_ids: (failures || []).map(receipt => String(receipt.id)) });
        }
      }

      batchSummaries.push({
        client_id: clientId,
        scanned: unitSummaries.reduce((sum, unit) => sum + unit.scanned, 0),
        units: unitSummaries,
        ...(groupRefusals.length ? { group_refusals: groupRefusals } : {}),
        skipped_waiting_on_client: skippedWaiting,
        skipped_terminal: skippedTerminal,
        skipped_stale_evidence: skippedStaleEvidence,
        suggested,
        auto_applied: autoApplied,
        remembered,
        group_summary: groupSummary.slice(0, 20),
        missing_accounts: [...missingAccountsByName.values()],
        parked_missing_account_lines_resolved: parkedResolved,
        ...(providerFailure ? { provider_failure: providerFailure } : {}),
        ...(providerFailures.length ? { provider_failures: providerFailures } : {}),
        ...(policyFailures.length ? { policy_failures: policyFailures, policy_failure: true } : {})
      });

      } catch (error) {
        if (!isCodingPolicyError(error)) throw error;
        const failure = await recordCodingPolicyFailure({ client, firmId, clientId, transactionIds: policyFailureTransactionIds, error });
        batchSummaries.push({ client_id: clientId, scanned: 0, suggested: 0, auto_applied: 0, error: error.code, policy_failure: true, policy_error: { code: error.code, message: error.message, jurisdiction: error.jurisdiction, receipt_ids: (failure || []).map((receipt) => String(receipt.id)) } });
      }
    }

  });

  // Terminal posting runs after the coding transactions commit and outside
  // their pooled connection. Refusals are visible and recoverable: the
  // LEDGER_AUTO_POST convergence sweep discovers the accepted transaction
  // directly even when it has no review-queue sidecar.
  const uniqueInternalApplied = [...new Map(internalLedgerApplied
    .map((item) => [`${item.clientId}:${item.transactionId}`, item])).values()];
  for (const { clientId, transactionId } of uniqueInternalApplied) {
    try {
      await postLedgerTransactionInDb({
        firmId,
        clientId,
        transactionId,
        dryRun: false,
        actorId: 'coding_batch_auto_post',
        skipSnapshot: true
      });
    } catch (postError) {
      if (postError?.code === 'LEDGER_ALREADY_POSTED') continue;
      const { recordRefusalViaDb } = await import('../ledgerAutoPost.js');
      await recordRefusalViaDb({ firmId, clientId, transactionId, error: postError,
        actorId: 'coding_batch_auto_post', source: 'coding_batch_inline_post' });
    }
  }

  const snapshot = await getFirmSnapshotFromDb({ firmId });
  return {
    ...snapshot,
    transaction_ai_batch: {
      source: 'transaction_ai_batch',
      reviewed_at: Date.now(),
      summaries: batchSummaries
    }
  };
};

// A human accept of a real account IS the explanation (the "No match"
// chip receipt, June 2026: firm-accepted APA lines rendered "No match"
// on the Reconciled tab because the accept writer stamped only the
// review layer — review_state — while the chip and the tab partition
// read the reconciliation layer the batch auto-apply stamps). Mirror
// the auto-apply: an accepted/resolved coding to a non-Suspense
// account stamps support_status 'explained' and flips
// reconciliation_status (preserve-stronger in the SQL). A Suspense
// accept is a park, not a decision — it explains nothing. Pure;
// exported for tests.
export const __acceptExplainsSupport = ({ reviewState = '', codingPatch = {}, itemPayload = {} } = {}) => {
  if (!['accepted', 'resolved'].includes(String(reviewState || ''))) return false;
  const account = codingPatch.account_name || codingPatch.category || codingPatch.account_label
    || codingPatch.account_code || codingPatch.proposed_account
    || itemPayload.account_name || itemPayload.account_code || itemPayload.proposed_account || '';
  if (!account) return false;
  return normalizeIntelText(account) !== 'suspense';
};

// Reverse = feed `before_state` back through the same writer as a patch.
// Pure; exported for tests.
export const __reviewItemBeforeAfter = ({
  item = {},
  txBefore = null,
  codingPatch = {},
  finalStatus = null,
  reviewState = null,
  acceptExplains = false,
  // G2 PR-14 — the rule confirmation bump this write drove (null when it didn't, or
  // when PR-13's review-item key skipped it). AFTER-side only, by design: the reverse
  // reports it and never patches it back down.
  ruleConfirmationBump = null
} = {}) => {
  const payload = item.payload || {};
  const before = {
    status: item.status ?? null,
    review_state: item.review_state ?? payload.review_state ?? null
  };
  const after = { status: finalStatus, review_state: reviewState };
  for (const key of Object.keys(codingPatch)) {
    before[key] = payload[key] ?? null;
    after[key] = codingPatch[key] ?? null;
  }
  if (txBefore) {
    const priorReconciliation = txBefore.reconciliation_status ?? null;
    before.transaction = {
      account_code: txBefore.account_code ?? null,
      category: txBefore.category ?? null,
      reconciliation_status: priorReconciliation
    };
    after.transaction = {
      account_code: codingPatch.account_code || codingPatch.xero_account_code || txBefore.account_code || null,
      category: codingPatch.category || codingPatch.account_label || codingPatch.account_name || txBefore.category || null,
      reconciliation_status:
        acceptExplains && !['reconciled', 'posted', 'auto_reconciled'].includes(String(priorReconciliation || ''))
          ? 'explained'
          : priorReconciliation
    };
  }
  if (ruleConfirmationBump) after.rule_confirmation_bump = ruleConfirmationBump;
  return { before_state: before, after_state: after };
};

// Pod-safety #2 (reverse half, pure core): now lives in the firmDb-free leaf
// reversePatch.js so the reverse EXECUTOR (reverseExecutor.js) can build restoring
// patches without importing the heavy firmDb chain. Re-exported here under the
// historical `__reversePatchFromBeforeAfter` name so existing callers and
// firmDb.test.js are untouched.
export const __reversePatchFromBeforeAfter = reversePatchFromBeforeAfter;

// Bare-line case-file mint (the tx-1/tx-22 `no_review_item` gap, diagnosed
// 2026-07-03 from persisted apply errors). Transaction-intel only queues
// FLAGGED lines; the batch coder writes its confident verdicts straight onto
// the transaction — so a confidently-coded line has NO transaction_review_queue
// row ("bare"). Any existing door that applies through the named review writer
// may mint the missing case file first: verify the transaction really belongs
// to (firm, client) — never fabricate one for a foreign/unknown id — then mint
// idempotently and hand back its id. The caller's normal writer
// (updateTransactionReviewItemInDb) proceeds unchanged: this adds a row for the
// EXISTING door, never a second accounting write path.
export const ensureTransactionReviewItemInDb = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  transactionId,
  source = 'chat_apply',
  preserveTransactionReviewState = false,
  caseReason = 'chat_recode_bare_line',
  caseIdSuffix = 'chat-bare'
} = {}) => {
  if (!clientId || !transactionId) return null;
  const txLookup = await queryFirmDb(
    `select id, description, payload, coding_state from transactions
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, transactionId]
  );
  const tx = txLookup.rows[0];
  if (!tx) return null;
  // RT-16: the case file carries no coding state — the line's is its own
  // column. A decided bare line has no queue row by construction, but
  // recode_decided must still re-verify its terminal state from persisted
  // data: with preserveTransactionReviewState the minted case opens already
  // resolved for a decided line; ordinary apply_category / mark_personal
  // callers mint an open case.
  const persistedCodingState = preserveTransactionReviewState ? normalizeCodingState(tx.coding_state) : null;
  const reviewStatus = isDecidedCodingState(persistedCodingState) ? 'resolved' : 'open';
  const inserted = await queryFirmDb(
    `insert into transaction_review_queue (
       id, firm_id, client_id, item_type, item_id, reason, priority, status, payload
     ) values ($1, $2, $3, 'transaction', $4, $7, 'normal', $5, $6::jsonb)
     on conflict (firm_id, client_id, item_type, item_id, reason) do update set updated_at = now()
     returning id`,
    [
      `rvq-${transactionId}-${String(caseIdSuffix || 'chat-bare').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48)}`,
      firmId,
      clientId,
      transactionId,
      reviewStatus,
      JSON.stringify({
        source,
        transaction_id: transactionId,
        transaction_description: tx.description || ''
      }),
      String(caseReason || 'chat_recode_bare_line').slice(0, 80)
    ]
  );
  return inserted.rows[0]?.id || null;
};

// Everything else about the write (stamps, audits, distillation) is
// identical; only the return value changes.
// `captureBeforeState: true` (the chat-apply callers) changes the return shape
// to `{ snapshot, before_state, after_state }` — the pod-safety #2 capture.
// Legacy callers are untouched.
export const updateTransactionReviewItemInDb = async ({ firmId = DEFAULT_FIRM_ID, reviewItemId, patch = {}, distillFactsFn = distillAndStageFirmFactCandidates, returnSnapshot = true, actorId = 'system', captureBeforeState = false, codingEvidenceAuthority = null, nativeCodingAuthority = null, reviewAcceptanceBasis = null, reviewAuthority = null } = {}) => {
  assertNoReviewScopePatch(patch);
  if (!reviewItemId) {
    const error = new Error('Review item id is required.');
    error.statusCode = 400;
    throw error;
  }

  const requestedStatus = String(patch.status || '').trim();
  const requestedReviewState = normalizeTransactionReviewState(patch.review_state || patch.reviewState);
  // RT-16: the machine vocabulary is accepted directly (`coding_state`);
  // the legacy label stays the SPA's / chat's input contract.
  const requestedCodingState = normalizeCodingState(patch.coding_state || patch.codingState);
  // Accept both canonical (open/resolved/cancelled) and the legacy
  // aliases (closed/dismissed) on input — normaliseReviewItemStatus
  // returns the canonical form or null.
  const nextStatus = normalizeReviewItemStatus(requestedStatus);
  if (!nextStatus && !requestedReviewState && !requestedCodingState) {
    const error = new Error('Valid review item status is required.');
    error.statusCode = 400;
    throw error;
  }

  const result = await withFirmDbClient(async (client) => {
    let policyFailureContext = null;
    await client.query('begin');
    try {
      // Match the existing transaction/ask/batch writers: transaction first,
      // then case. The initial lookup selects identity only; the locked reread
      // below supplies the authoritative payload and refuses relocation.
      const transactionIdForCase = row => (row.item_type === 'transaction' || row.payload?.transaction_id)
        ? (row.payload?.transaction_id || row.item_id) : null;
      const candidate = (await client.query('select * from transaction_review_queue where firm_id = $1 and id = $2',
        [firmId,reviewItemId])).rows[0];
      if (!candidate) throw Object.assign(new Error('Review item not found.'), {statusCode:404});
      if (reviewAuthority && reviewAuthority.clientId !== candidate.client_id) {
        throw Object.assign(new Error('The review target changed. Refresh before reviewing it.'), {statusCode:403,code:'FIRM_ACCESS_DENIED'});
      }
      const caseTransactionId = transactionIdForCase(candidate);
      const caseTransaction = caseTransactionId
        ? (await client.query('select * from transactions where firm_id = $1 and id = $2 for update',
          [firmId,caseTransactionId])).rows[0] : {};
      if (!caseTransaction) throw Object.assign(new Error('Review transaction not found.'), {statusCode:404});
      const item = (await client.query('select * from transaction_review_queue where firm_id = $1 and id = $2 for update',
        [firmId,reviewItemId])).rows[0];
      if (!item) throw Object.assign(new Error('Review item not found.'), {statusCode:404});
      if (item.client_id !== candidate.client_id || (reviewAuthority && reviewAuthority.clientId !== item.client_id)
        || (caseTransactionId && caseTransaction.client_id !== item.client_id)) {
        throw Object.assign(new Error('The review target changed. Refresh before reviewing it.'), {statusCode:403,code:'FIRM_ACCESS_DENIED'});
      }
      if (item.item_type !== candidate.item_type || item.item_id !== candidate.item_id
        || transactionIdForCase(item) !== caseTransactionId) {
        throw Object.assign(new Error('The review target changed. Refresh before reviewing it.'), {statusCode:409,code:'REVIEW_TARGET_CHANGED'});
      }
      // W1 (S04/L3): the committed learning effects of this apply, reported to
      // the caller so a receipt states what committed, never what was intended.
      const learning = { rules_minted: [], facts_minted: [], candidates_staged: 0, candidate_ids: [], candidates_posture: null };
      const codingPatch = transactionReviewCodingPatch(patch);
      const payload = {
        ...(item.payload || {}),
        reviewer_note: patch.reviewer_note || patch.note || null,
        ...codingPatch,
        ...('client_message' in patch ? { client_message: patch.client_message } : {}),
        ...('sync_metadata' in patch ? { sync_metadata: patch.sync_metadata } : {})
      };
      if (codingEvidenceAuthority && caseTransactionId) {
        const accepted = await assertChatCodingEvidence({ client, firmId, clientId: item.client_id,
          transactionId: caseTransactionId, authority: { ...codingEvidenceAuthority, actorId }, lock: true });
        if (accepted) {
          const suggestion = caseTransaction.payload?.ai_suggestion;
          if (suggestion?.posting_requirement === 'document_allocation' || suggestion?.document_allocations?.length) {
            throw Object.assign(new Error('A component allocation needs its own complete correction. This category-only proposal cannot replace it.'),
              { code: 'TRANSACTION_CHAT_CODING_ALLOCATION_UNSUPPORTED', statusCode: 409 });
          }
          // Contact is an explicit field of the saved correction. Preserve the
          // original reasoning source receipt and bind its authorized result too.
          accepted.accepted_bank_source_digest = chatBankSourceDigest({ ...rowToTransactionPayload(caseTransaction),
            ...(codingPatch.contact ? { contact: codingPatch.contact } : {}) });
          accepted.coding_digest = acceptedCodingDigest({ ...rowToTransactionPayload(caseTransaction), ...codingPatch,
            account_code: codingPatch.account_code || codingPatch.xero_account_code || caseTransaction.account_code,
            category: codingPatch.category || codingPatch.account_label || codingPatch.account_name || caseTransaction.category });
          codingPatch.accepted_coding_evidence = accepted;
          payload.accepted_coding_evidence = accepted;
        }
      }
      if (codingPatch.tax_posting_facts) {
        codingPatch.tax_posting_facts = await bindTaxPostingFactsWithClient({ client, firmId,
          clientId: item.client_id, transaction: rowToTransactionPayload(caseTransaction),
          facts: codingPatch.tax_posting_facts, actorId });
        payload.tax_posting_facts = codingPatch.tax_posting_facts;
      }
      const priorCodingState = caseTransaction.coding_state ?? null;
      const nextCodingState = requestedCodingState
        || nextCodingStateForPatch({ currentState: priorCodingState, patch, itemStatus: nextStatus || item.status });
      // The legacy label every downstream reader of this writer still speaks
      // (the audits, the distiller, the llm_decisions outcome, the pod-safety
      // capture) — a PROJECTION of the state, never persisted as one.
      const reviewState = reviewCaseLegacyLabel(nextCodingState, nextStatus || item.status);
      delete payload.review_state;
      delete payload.reviewState;
      delete payload.coding_state;
      delete payload.codingState;
      const finalStatus = nextStatus
        || ((reviewCaseClosesForLegacyState(requestedReviewState) || codingStateClosesReviewCase(nextCodingState)) ? 'resolved' : 'open');
      const acceptExplains = __acceptExplainsSupport({ reviewState, codingPatch, itemPayload: payload });
      const appliesCoding = caseTransactionId && (
        (['applied', 'posted', 'synced'].includes(nextCodingState) && nextCodingState !== priorCodingState)
        || Object.keys(codingPatch).some((key) => /account|tax_type|tax_treatment|tax_posting_facts|native_choice|native_source/.test(key))
      );
      let nativeAcceptancePolicy = null;
      let nativeAcceptanceModel = null;
      if (appliesCoding) {
        policyFailureContext = { clientId: item.client_id, transactionIds: [caseTransactionId] };
        const currentPolicy = await resolveClientCodingPolicyWithClient({ client, firmId, clientId: item.client_id, businessDate: rowToTransactionPayload(caseTransaction).date, lockContext: true });
        const suggestion = caseTransaction.payload?.ai_suggestion || item.payload?.ai_suggestion || {};
        const proposed = { ...(nativeCodingAuthority ? {} : suggestion), ...codingPatch };
        const appliesExistingSuggestion = suggestion.coding_policy
          && (!codingPatch.tax_treatment || codingPatch.tax_treatment === suggestion.tax_treatment)
          && (!codingPatch.proposed_account || codingPatch.proposed_account === suggestion.proposed_account);
        assertCodingSuggestionForPolicy(currentPolicy, proposed, { requireReceipt: patch.require_coding_policy === true || Boolean(codingPatch.coding_policy) || Boolean(appliesExistingSuggestion) });
        if (currentPolicy.nativeMenu) {
          nativeAcceptancePolicy = currentPolicy;
          nativeAcceptanceModel = proposed.model || suggestion.model || null;
          if (!nativeCodingAuthority && (!isDeepStrictEqual(proposed.native_choice, suggestion.native_choice)
            || !isDeepStrictEqual(proposed.native_source, suggestion.native_source))) codingChoiceFailure('saved_suggestion_required');
          assertNativeCodingChoice(currentPolicy.nativeMenu, proposed, { applying: true });
          await assertNativeCodingSourceWithClient({ client, firmId, clientId: item.client_id,
            transactionId: caseTransactionId, receipt: proposed.native_source });
          if (nextCodingState === 'applied' && !nativeCodingAuthority && !reviewAcceptanceBasis) {
            if (!reviewAuthority?.principal || actorId !== reviewAuthority.principal.principalId) {
              throw Object.assign(new Error('Authenticated review authority is required.'), {statusCode:403,code:'FIRM_ACCESS_DENIED'});
            }
            await assertFirmAccess({firmId,dbClient:client,resolvedPrincipal:reviewAuthority.principal,clientIds:[item.client_id]});
          }
          // The existing source fence includes firm_members and lasts through
          // commit. Read live membership only after acquiring it, so revocation
          // cannot commit between authorization and this named write.
          if (nativeCodingAuthority) nativeAcceptanceModel = (await assertNativeSavedCodingActionWithClient({ client, firmId, clientId: item.client_id,
            transactionId: caseTransactionId, authority: nativeCodingAuthority, actorId, suggestion: proposed })).model;
          const choice = resolveNativeAccountChoice(currentPolicy.nativeMenu, proposed, { allowAlias: true });
          // Alternate homes also feed the existing posting builder. Verify any
          // retained homes against their prior receipt before replacing that
          // coherent identity as part of an explicit native correction.
          const prior = caseTransaction.payload || {};
          const alternateHomes = Object.fromEntries(['xero_account_id', 'xero_account_code', 'xero_account_name', 'account_label']
            .filter(key => prior[key] != null && prior[key] !== '').map(key => [key, prior[key]]));
          if (Object.keys(alternateHomes).length) {
            const priorReceipt = prior.native_choice || prior.ai_suggestion?.native_choice;
            if (!priorReceipt) codingChoiceFailure('prior_account_identity_required');
            resolveNativeAccountChoice(currentPolicy.nativeMenu, { ...priorReceipt, ...alternateHomes });
          }
          Object.assign(codingPatch, { account_id: choice.id, account_code: choice.code, account_name: choice.name,
            account_label: choice.name, category: choice.name, proposed_account: choice.name,
            native_choice: proposed.native_choice, native_source: proposed.native_source });
          for (const [key, value] of [['xero_account_id', choice.id], ['xero_account_code', choice.code], ['xero_account_name', choice.name]]) {
            if (Object.hasOwn(codingPatch, key) || Object.hasOwn(prior, key)) codingPatch[key] = value;
          }
          Object.assign(payload, codingPatch);
        }
        codingPatch.accepted_coding_policy = codingPolicyReceipt(currentPolicy);
        payload.accepted_coding_policy = codingPatch.accepted_coding_policy;
      }

      await client.query(
        `update transaction_review_queue
         set status = $3,
             payload = payload || $4::jsonb,
             updated_at = now()
         where firm_id = $1 and id = $2`,
        [firmId, reviewItemId, finalStatus, JSON.stringify(payload)]
      );
      // Pod-safety #2: pre-read the transaction fields this write mutates so the
      // before/after pair is captured race-free inside the same transaction.
      let txBefore = null;
      // G2 PR-14: the confirmation bump this apply drove, if any. Recorded onto the
      // capture's AFTER side only — the reverse SURFACES it and never un-bumps it (a
      // confirmation is evidence of a past confirm), and an after-only key cannot leak
      // into reversePatchFromBeforeAfter's patch, which is built from `before`.
      let ruleConfirmationBump = null;
      if (item.item_type === 'transaction' || item.payload?.transaction_id) {
        const transactionId = item.payload?.transaction_id || item.item_id;
        if (captureBeforeState) {
          const txBeforeResult = await client.query(
            "select account_code, category, reconciliation_status, payload->>'account_name' as account_name from transactions where firm_id = $1 and id = $2",
            [firmId, transactionId]
          );
          txBefore = txBeforeResult.rows[0] || null;
        }
        await assertTransactionAccountingMutable({
          client,
          firmId,
          transactionId,
          patch: {
            ...codingPatch,
            ...(nextCodingState && nextCodingState !== priorCodingState ? { coding_state: nextCodingState } : {})
          }
        });
        await client.query(
          `update transactions
           set account_code = coalesce($5, account_code),
               category = coalesce($6, category),
               reconciliation_status = case
                 when $7::boolean
                  and (reconciliation_status is null
                       or reconciliation_status not in ('reconciled', 'posted', 'auto_reconciled'))
                   then 'explained'
                 else reconciliation_status
               end,
               payload = payload || $4::jsonb,
               updated_at = now()
           where firm_id = $1
             and client_id = $2
             and id = $3`,
          [
            firmId,
            item.client_id,
            transactionId,
            JSON.stringify({
              ...(acceptExplains
                ? { support_status: 'explained', support_explained_at: Date.now() }
                : {}),
              ...codingPatch,
              review_status: finalStatus,
              review_updated_at: Date.now()
            }),
            codingPatch.account_code || codingPatch.xero_account_code || null,
            codingPatch.category || codingPatch.account_label || codingPatch.account_name || null,
            acceptExplains
          ]
        );
        if (nextCodingState) {
          await applyCodingTransition(client, { firmId, clientId: item.client_id, transactionId, to: nextCodingState });
        }
      }
      if ((patch.learn_rule || patch.remember_merchant_rule) && item.client_id) {
        const transactionId = item.payload?.transaction_id || item.item_id;
        const ruleAccountCode = codingPatch.account_code || payload.account_code || payload.proposed_account || '';
        if (transactionId && ruleAccountCode && normalizeIntelText(ruleAccountCode) !== 'suspense') {
          const txRow = await client.query(
            'select description, raw_description, payload from transactions where firm_id = $1 and id = $2',
            [firmId, transactionId]
          );
          if (txRow.rows.length) {
            const tx = txRow.rows[0];
            const rulePayload = {
              ...(tx.payload || {}),
              ...codingPatch,
              description: tx.description,
              raw_description: tx.raw_description,
              merchant_pattern: patch.merchant_pattern || (tx.payload || {}).merchant_pattern || '',
              merchant_rule_account: ruleAccountCode
            };
            const savedRule = await saveMerchantRuleForPayload({
              client,
              firmId,
              clientId: item.client_id,
              transactionId,
              payload: rulePayload,
              supportNote: codingPatch.support_note || '',
              source: 'review_item_accept',
              actorId
            });
            if (savedRule?.ruleId) learning.rules_minted.push({ rule_id: savedRule.ruleId, status: savedRule.status, inserted: savedRule.inserted });
            if (savedRule && savedRule.status === 'active') {
              await client.query(
                `update transactions
                 set payload = payload || $3::jsonb, updated_at = now()
                 where firm_id = $1 and id = $2`,
                [firmId, transactionId, JSON.stringify({
                  matched_client_rule_id: savedRule.ruleId,
                  matched_client_rule_label: savedRule.rulePayload.label,
                  merchant_rule_cascade: savedRule.cascadeResult
                })]
              );
            }
          }
        }
      }

      // Auto-promote discipline for LLM-suggested categorizations (Phase 3)
      const existingSource = (item.payload || {}).auto_categorize_source || '';
      const isLlmSuggested = existingSource.startsWith('merchant_lookup');
      if (isLlmSuggested && item.client_id) {
        const transactionId = (item.payload || {}).transaction_id || item.item_id;
        const matchedRuleId = (item.payload || {}).matched_client_rule_id || '';
        const llmAccountCode = (item.payload || {}).account_code || '';
        const firmAccountCode = codingPatch.account_code || payload.account_code || '';
        const isConfirm = (reviewState === 'accepted' || reviewState === 'resolved')
          && (!firmAccountCode || firmAccountCode === llmAccountCode);
        const isEdit = (reviewState === 'accepted' || reviewState === 'resolved')
          && firmAccountCode && firmAccountCode !== llmAccountCode;
        const isReject = finalStatus === 'cancelled';

        if (transactionId) {
          const decisionRow = await client.query(
            `select id from llm_decisions
             where firm_id = $1 and client_id = $2 and target_id = $3
               and decision_type = 'categorize' and human_outcome is null
             order by created_at desc limit 1`,
            [firmId, item.client_id, transactionId]
          );
          if (decisionRow.rows.length) {
            const outcome = isConfirm ? 'confirmed' : isEdit ? 'edited' : isReject ? 'rejected' : null;
            if (outcome) {
              await recordHumanOutcome({
                client,
                decisionId: decisionRow.rows[0].id,
                outcome,
                metadata: {
                  firm_account_code: firmAccountCode,
                  llm_account_code: llmAccountCode,
                  review_state: reviewState
                }
              });
            }
          }
        }

        if (isConfirm && matchedRuleId) {
          const ruleRow = await client.query(
            'select payload from client_rules where id = $1 and firm_id = $2',
            [matchedRuleId, firmId]
          );
          // PR-13 state guard: the bump is review-item-keyed (see
          // __shouldBumpRuleConfirmation) — a crash-window replay of this
          // apply, or a later same-item update re-deriving the accepted
          // state, skips instead of double-incrementing toward auto-apply.
          if (ruleRow.rows.length && __shouldBumpRuleConfirmation(ruleRow.rows[0].payload || {}, reviewItemId)) {
            const rulePayload = ruleRow.rows[0].payload || {};
            const bumpPatch = __ruleConfirmationBumpPatch(rulePayload);
            await client.query(
              `update client_rules
               set payload = payload || $3::jsonb, updated_at = now()
               where id = $1 and firm_id = $2`,
              [matchedRuleId, firmId, JSON.stringify({
                ...bumpPatch,
                last_confirmed_at: Date.now(),
                last_confirmed_review_item_id: String(reviewItemId)
              })]
            );
            // "Nothing silent": the bump rewrites the rule's confidence (a
            // 2nd confirm promotes it to auto-apply strength) — audited
            // inside the same transaction (audit-as-precondition), attributed
            // to the operator whose confirm drove it, like the #733 mint.
            await client.query(
              `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
               values ($1, $2, 'firm', $3, 'client_rule.confirmation_bumped', 'client_rule', $4, $5::jsonb)`,
              [
                firmId,
                item.client_id,
                actorId || 'system',
                matchedRuleId,
                JSON.stringify({
                  transaction_id: transactionId,
                  review_item_id: reviewItemId,
                  prior_count: Number(rulePayload.confirmation_count || 0),
                  confirmation_count: bumpPatch.confirmation_count,
                  confidence: bumpPatch.confidence
                })
              ]
            );
            ruleConfirmationBump = {
              rule_id: matchedRuleId,
              review_item_id: String(reviewItemId),
              prior_count: Number(rulePayload.confirmation_count || 0),
              confirmation_count: bumpPatch.confirmation_count,
              confidence: bumpPatch.confidence
            };
          }
        }
      }

      if (caseTransaction.payload?.review_scope) {
        const after = (await client.query('select * from transactions where firm_id=$1 and id=$2', [firmId,caseTransactionId])).rows[0];
        if (nativeReviewFocalChanged(caseTransaction, after)) {
          await client.query("update transactions set payload=payload-'review_scope' where firm_id=$1 and id=$2", [firmId,caseTransactionId]);
        }
      }
      const reviewScope = nativeAcceptancePolicy && nextCodingState === 'applied'
        ? nativeReviewScopeBody({ transaction: rowToTransactionPayload((await client.query(
          'select * from transactions where firm_id=$1 and client_id=$2 and id=$3',
          [firmId,item.client_id,caseTransactionId])).rows[0]), policy: nativeAcceptancePolicy, actorId,
          authorityBasis: reviewAcceptanceBasis || (nativeCodingAuthority ? 'authenticated_saved_coding_action' : 'authenticated_review_acceptance') }) : null;
      let auditAction = null;
      if (finalStatus === 'resolved') {
        auditAction = (codingPatch.account_code || codingPatch.category)
          ? 'review.overridden'
          : 'review.accepted';
      } else if (finalStatus === 'cancelled') {
        auditAction = 'review.deferred';
      }
      if (reviewScope && !auditAction) auditAction = 'review.accepted';
      if (auditAction) {
        const auditId = await emitReviewAudit(client, {
          firmId,
          clientId: item.client_id,
          itemType: item.item_type || 'transaction',
          itemId: reviewItemId,
          action: auditAction,
          metadata: { status: finalStatus, review_state: reviewState, coding_state: nextCodingState ?? null,
            ...(reviewScope ? { review_scope: reviewScope, transaction_id: caseTransactionId, model: nativeAcceptanceModel } : {}),
            ...(codingPatch.tax_posting_facts ? { tax_posting_facts_digest: taxFactsDigest(codingPatch.tax_posting_facts), transaction_id: caseTransactionId } : {}) },
          legacyAction: 'transaction_review.update',
          legacyResourceType: 'transaction_review',
          legacyResourceId: reviewItemId,
          actorId,
          actorType: reviewScope && !reviewAcceptanceBasis ? (reviewAuthority?.principal?.principalType || 'firm_member') : 'system'
        });
        if (reviewScope) {
          if (!auditId) throw new Error('Native review acceptance audit was not persisted.');
          await client.query("update transactions set payload=payload || jsonb_build_object('review_scope',$4::jsonb) where firm_id=$1 and client_id=$2 and id=$3",
            [firmId,item.client_id,caseTransactionId,JSON.stringify({ ...reviewScope, acceptance_audit: { store: 'audit_events', id: auditId } })]);
        }
      } else {
        // Non-terminal update — keep the legacy emit only, no new
        // review.* event (the FE workflow state already captures it).
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, 'transaction_review.update', 'transaction_review', $4, $5::jsonb)`,
          [firmId, item.client_id, actorId, reviewItemId, JSON.stringify({ status: finalStatus, review_state: reviewState, coding_state: nextCodingState ?? null,
            ...(codingPatch.tax_posting_facts ? { tax_posting_facts_digest: taxFactsDigest(codingPatch.tax_posting_facts), transaction_id: caseTransactionId } : {}) })]
        );
      }
      await client.query('commit');

      // Layer-2 distillation (drawer recode): the feed picker AND the
      // chat apply_category both funnel through this function, so this
      // is the single live choke point for human-applied coding. Runs
      // AFTER the commit and soft-fails end to end — memory must never
      // break the apply it rides. The review-item update above never
      // touches payload.ai_suggestion, so the post-commit read still
      // sees the prior verdict.
      try {
        const transactionId = item.payload?.transaction_id || item.item_id;
        const humanAccount = codingPatch.account_name || codingPatch.category || codingPatch.account_label || codingPatch.account_code;
        if (item.client_id && transactionId && humanAccount && ['accepted', 'resolved'].includes(reviewState)) {
          const txRow = await client.query(
            'select description, money_in, money_out, currency, payload from transactions where firm_id = $1 and id = $2 limit 1',
            [firmId, transactionId]
          );
          const transactionRow = txRow.rows[0] || null;
          const priorVerdict = transactionRow?.payload?.ai_suggestion;
          if (transactionRow && __shouldDistillReviewRecode({ reviewState, codingPatch, priorVerdict })) {
            const clientRowResult = await client.query(
              'select id, company_name, uen, jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1',
              [firmId, item.client_id]
            );
            const { event, provenance } = __buildReviewRecodeDistillation({
              item,
              codingPatch,
              reviewState,
              reviewerNote: payload.reviewer_note || '',
              transactionRow,
              clientRow: clientRowResult.rows[0] || {}
            });
            // W1 (INV-02 / INV-03, S04/L1b-L1c): the distiller STAGES `suggested`
            // memory candidates for the owner to govern — it mints no active fact.
            // Post-commit, no-throw; gated on the MEMORY_CANDIDATES posture inside
            // the staging entry. What it staged is the writer's committed learning.
            const staged = await distillFactsFn({ client, firmId, clientId: item.client_id, event, provenance });
            const stagedList = Array.isArray(staged) ? staged : (Array.isArray(staged?.staged) ? staged.staged : []);
            learning.candidates_staged += stagedList.length;
            learning.candidate_ids.push(...stagedList.map((row) => row?.id).filter(Boolean));
            if (staged && !Array.isArray(staged) && staged.posture) learning.candidates_posture = staged.posture;
          }
        }
      } catch {
        // Distillation must never fail the review update.
      }

      if (captureBeforeState) {
        // The capture speaks the projected label on both sides (the reverse
        // target read projects the same way), so a reverse's precondition
        // compares like with like.
        const itemForCapture = { ...item, review_state: reviewCaseLegacyLabel(priorCodingState, item.status) };
        const beforeAfter = __reviewItemBeforeAfter({
          item: itemForCapture, txBefore, codingPatch, finalStatus, reviewState, acceptExplains, ruleConfirmationBump
        });
        return {
          ...beforeAfter,
          // A newly minted review sidecar has no prior account. Preserve the
          // transaction's authoritative pre-write name for the ledger handoff.
          prior_transaction_coding: {account_name:txBefore?.account_name || null},
          // W1 (S04/L3, INV-04): the COMMITTED learning effects of this apply —
          // the receipt builders derive rule_minted / memory_minted from these,
          // never from the surface's intent.
          learning
        };
      }
      return null;
    } catch (error) {
      await client.query('rollback');
      if (isCodingPolicyError(error) && policyFailureContext) await recordCodingPolicyFailure({ client, firmId, ...policyFailureContext, error });
      throw error;
    }
  });
  const snapshot = returnSnapshot ? await getFirmSnapshotFromDb({ firmId }) : null;
  return captureBeforeState ? { snapshot, ...result } : snapshot;
};
