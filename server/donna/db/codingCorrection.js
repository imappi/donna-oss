// Posted-evidence recovery is a consumer of the existing coding clock, case
// reader, Jev-first coder, ask writer and ledger adjustment writer. A saved
// decision is never a completed correction. Journal history remains immutable.
import { retainedNativeMarkerSql } from '../nativeChartLineage.js';
import { assertNativeCodingChoice, codingChoiceFailure } from '../codingAccountChoices.js';
import { correctionDeltaLines } from '../ledgerCorrectionLines.js';
export { correctionDeltaLines } from '../ledgerCorrectionLines.js';
import { hash } from '../jevEvidenceContract.js';
import { readJevCase, jevCasePrompt, codingCaseRevision, caseReplyProvenance } from '../jevPreview.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { makeJevTrialProvider, readJevDecisionPolicy } from '../jevTrialProvider.js';
import { suggestTransactionCoding } from '../transactionLlm.js';
import { hasJevResolvedCoding, JEV_DOCUMENT_ASK_SELECTIONS } from '../jevDecisionReceipt.js';
import { assertExecutionBudgetActive } from '../executionBudget.js';
import { checkEntityReadinessAdmissionWithClient, EntityReadinessAdmissionError, evaluateRetainedProcessingScopeWithClient } from '../runtimeReadinessAdmission.js';
import { withFirmDbClient } from './pool.js';
import { isFenceContention, isUnexpectedFailure, unexpectedFailureDetails } from './codingPolicyContext.js';
import { taxRegistrationRuleFor, taxRegistrationPeriodState } from './taxRegistrationChange.js';
import { isTransactionSyncedToXero } from './xero.js';
import { rowToTransactionPayload } from './transactions.js';
import { loadClientOwnBankAccounts } from './clients.js';
import { CODING_FACT_ADMISSION_FLAG, codingFactSubjects, getFirmFactsForSubjects } from '../firmFacts.js';
import { loadActiveClientRulesForAuthority, demotedRuleAsSuggestion } from './memory.js';
import { resolveClientCodingPolicyWithClient, withClientCodingPolicy, resolveCodingTransport,
  assertCodingSuggestionForPolicy } from './coding.js';
import { nativeCodingSourceReceipt, codingEvidenceDigest, codingSourceIdentityConflicts, hasCurrentSourceIdentityReply, CODING_CONFLICT_MAX_RECONSIDERATIONS } from './codingEvidence.js';
import { __donnaChartMenuAccounts, getDonnaLedgerAccountsForClient,
  __prepareLedgerTransactionPosting, postLedgerAdjustmentInDb, rowToLedgerLinePayload } from './ledger.js';
import { __createClientEvidenceRequestWithClient, resolveOpenEvidenceRequestsForTransaction, markCodingAutoPostFyiPendingInDb } from './asks.js';
import { evaluateCodingAutoPost, codingOwnerTransferPostAllows, buildOwnerAsk } from '../codingAutoPost.js';

export const CODING_CORRECTION_FLAG = 'CODING_CORRECTION_AUTO_APPLY';
const ACTOR = 'coding_correction';
const fail = (code, details = null) => { throw Object.assign(new Error(code), {code, details, statusCode:409}); };
const acts = (snapshot, flagKey) => clientFlagActs({flagKey,snapshot,envFallback:()=>false});

// A rejected accounting choice needs reconsideration with its refusal. A
// missing grant, unavailable host or contended writer can reuse the unchanged
// decision after that execution dependency recovers.
const needsReconsideration = recovery => [
  'TRANSACTION_ALV_CODING_SOURCE_CONFLICT',
  'TRANSACTION_SOURCE_IDENTITY_UNRESOLVED',
  'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT',
  'CODING_CORRECTION_SOURCE_USE_CONFLICT'
].includes(recovery?.code) || (recovery?.code === 'CODING_CORRECTION_EXECUTION_REFUSED'
  && ['statutory_evidence_required','revenue_source_required','cross_entity_relation'].includes(recovery.details?.reason));
// A NOWAIT fence that lost to another holder (a producer, or autovacuum's
// SHARE UPDATE EXCLUSIVE) is not an outcome of the case. A blocker stored
// under that code before this rule is pending again: its decision, if any, is
// ready to replay; without one the case reasons as if never blocked.
const contentionBlocker = recovery => ['blocked','failed'].includes(recovery?.state) && isFenceContention(recovery);
const pendingAfterContention = requirement => {
  if (!contentionBlocker(requirement?.recovery)) return requirement;
  const {code,details,state,retrying_blocker,...recovery}=requirement.recovery;
  return {...requirement,recovery:recovery.decision?{...recovery,state:'ready'}:recovery};
};
const blockerIdentity = recovery => hash({code:recovery?.code,
  reason_code:recovery?.details?.reason_code,reason:recovery?.details?.reason,
  constraint:recovery?.details?.constraint});

// Corrections require a separate, exact-client grant made by a current firm
// member. Ordinary coding/experiment enrollment is not retroactive authority.
async function authorityWithClient({client,firmId,clientId}) {
  const snapshot = await readClientConfigSnapshot(client,{firmId,clientId,strict:true});
  if (!acts(snapshot,CODING_CORRECTION_FLAG) || !acts(snapshot,'JEV_RECONCILIATION')
    || !acts(snapshot,'CODING_AUTO_POST') || !acts(snapshot,'LEDGER_AUTO_POST')) fail('CODING_CORRECTION_AUTHORITY_REQUIRED');
  const grant = (await client.query(`select c.id,c.stage,c.reason,c.set_by_actor_id
    from client_capability_config c join firm_members m on m.firm_id=c.firm_id and m.id=c.set_by_actor_id
    where c.firm_id=$1 and c.client_id=$2 and c.flag_key=$3 and c.valid_to is null
      and c.source='manual' and c.stage in ('canary','auto') and m.status='active' and c.set_by_actor_type='firm_member'`,
    [firmId,clientId,CODING_CORRECTION_FLAG])).rows[0];
  if (!grant?.reason) fail('CODING_CORRECTION_AUTHORITY_REQUIRED');
  const { policy } = await readJevDecisionPolicy({client,firmId,clientId,snapshot});
  return {snapshot,receipt:{basis:'explicit_client_autonomous_correction',config_id:grant.id,
    authorized_by:grant.set_by_actor_id,reason:grant.reason,stage:grant.stage,
    decision_policy_basis:policy.basis,experiment_id:policy.id || null,experiment:policy.experiment || null}};
}

// Short final-write fence includes inserts, not only rows already discovered.
// NOWAIT yields to any active producer; provider work runs outside this fence.
// No lock is kept while waiting on another producer or on a remote model.
export async function lockCodingSourceInputs(client) {
  await client.query(`lock table clients,transactions,documents,document_lines,reconciliation_matches,
    document_obligations,client_evidence_requests,ledger_journals,ledger_lines,ledger_accounts,
    client_capability_config,cohort_capability_config,client_cohort_members,firm_members,
    model_lane_policy,client_rules,firm_facts,close_periods,qbo_journal_mirrors in share row exclusive mode nowait`);
}
async function admission({client,firmId,clientId}) {
  const result=await checkEntityReadinessAdmissionWithClient({client,firmId,clientId,
    boundary:'worker_discovery',resourceType:'client_worker_pool',resourceId:clientId});
  if(!result.allowed)throw new EntityReadinessAdmissionError(result);
}
async function readInputs({client,firmId,clientId,transactionId}) {
  const row=(await client.query('select * from transactions where firm_id=$1 and client_id=$2 and id=$3',
    [firmId,clientId,transactionId])).rows[0];
  const requirement=row?.payload?.coding_correction_required;
  if(!row || !requirement)fail('CODING_CORRECTION_NOT_FOUND');
  const transaction=rowToTransactionPayload(row);
  if (requirement.status==='corrected') return {completed:true,receipt:requirement};
  if (requirement.native_registration) fail('CODING_CORRECTION_REGISTRATION_AUTHORITY_UNQUALIFIED', {
    reason: 'registration_driven_tax_correction_not_qualified',
    previous_revision_digest: requirement.native_registration.previous?.revision_digest || null,
    current_revision_digest: requirement.native_registration.current?.revision_digest || null
  });
  // A registration change on a line in a locked period or a filed VAT return
  // (db/taxRegistrationChange.js): nothing is posted into it, and an
  // adjustment dated today would restate a closed VAT position by Donna's own
  // hand. Read live, so a reopened period is consumed as any other case.
  if (requirement.status==='pending' && requirement.tax_registration) {
    const company=(await client.query('select jurisdiction,profile from clients where firm_id=$1 and id=$2',[firmId,clientId])).rows[0];
    const period=await taxRegistrationPeriodState({client,firmId,clientId,
      rule:taxRegistrationRuleFor(company?.jurisdiction || company?.profile?.jurisdiction),onDate:requirement.tax_registration.on_date});
    if (period.locked || period.return_filed) fail('CODING_CORRECTION_TAX_PERIOD_CLOSED',{
      reason:period.return_filed?'vat_return_filed':'close_period_locked',on_date:requirement.tax_registration.on_date,
      close_period_id:period.close_period_id,filed_return_id:period.filed_return_id});
  }
  if (requirement.status!=='pending' || !transaction.ledger_journal_id
    || transaction.ledger_journal_id!==requirement.original_journal_id
    || transaction.accepted_coding_evidence || transaction.ai_suggestion_status!=='auto_applied'
    || !['','coding_auto_post'].includes(transaction.reviewed_by || '')
    || !['','coding_auto_post'].includes(transaction.approved_by || '')
    || ['client_rule','merchant_lookup'].includes(transaction.auto_categorize_source)) fail('CODING_CORRECTION_HUMAN_OR_UNSUPPORTED_HISTORY');
  const current=await readJevCase({client,firmId,clientId,transactionId,evidenceOnly:true,includePostingLines:true});
  if(current.caseEvidence.coverage.status!=='complete_within_scope'
    || current.caseEvidence.coverage.unread_sources.length) fail('CODING_CORRECTION_EVIDENCE_INCOMPLETE');
  if(String(current.caseEvidence.company.profile?.accounting_system || 'none')!=='none')fail('CODING_CORRECTION_EXTERNAL_LEDGER_UNSUPPORTED');
  const journal=(await client.query(`select * from ledger_journals where firm_id=$1 and client_id=$2 and id=$3`,
    [firmId,clientId,requirement.original_journal_id])).rows[0];
  if(!journal || journal.source_type!=='transaction' || journal.source_id!==transactionId
    || !['posted','closed'].includes(journal.status))fail('CODING_CORRECTION_ORIGINAL_CHANGED');
  if (isTransactionSyncedToXero(transaction) || (await client.query(`select 1 from qbo_journal_mirrors
    where journal_id=$1 and status='synced' limit 1`,[journal.id])).rows.length)
    fail('CODING_CORRECTION_EXPORTED_HISTORY');
  const adjustments=(await client.query(`select * from ledger_journals where firm_id=$1 and client_id=$2
    and (correction_of_journal_id=$3 or reversal_of_journal_id=$3) order by id`,[firmId,clientId,journal.id])).rows;
  // Only this consumer's prior deltas can be replayed autonomously. Human
  // corrections or reversals require their own authority; never re-reverse them.
  if(adjustments.some(j=>j.payload?.actor_id!==ACTOR || j.reversal_of_journal_id || !['posted','closed'].includes(j.status)))fail('CODING_CORRECTION_EXISTING_ADJUSTMENT');
  const originalLines=(await client.query(`select l.*,a.account_type,a.normal_balance from ledger_lines l
    join ledger_accounts a on a.id=l.account_id and a.firm_id=l.firm_id and a.client_id=l.client_id
    where l.firm_id=$1 and l.client_id=$2 and l.journal_id=any($3::text[]) order by l.journal_id,l.line_no,l.id`,
    [firmId,clientId,[journal.id,...adjustments.map(j=>j.id)]])).rows.map(rowToLedgerLinePayload);
  const policy=await resolveClientCodingPolicyWithClient({client,firmId,clientId,businessDate:transaction.date});
  const company=current.caseEvidence.company;
  const profile=withClientCodingPolicy({...company.profile,id:clientId,companyName:company.company_name,
    uen:company.uen,chartAutoMints:true},policy);
  profile.knownBankAccounts=(await loadClientOwnBankAccounts(client,{firmId,clientId}))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const accounts=__donnaChartMenuAccounts(await getDonnaLedgerAccountsForClient({client,firmId,clientId}),profile);
  const rules=await loadActiveClientRulesForAuthority({client,firmId,clientId,limit:50});
  const clientRules=[...rules.authoritative,...rules.demoted.map(demotedRuleAsSuggestion)];
  const facts=await getFirmFactsForSubjects({client,firmId,clientId,
    codingAdmission:acts(await readClientConfigSnapshot(client,{firmId,clientId,strict:true}),CODING_FACT_ADMISSION_FLAG),
    subjects:codingFactSubjects({transaction,clientProfile:profile,firmId})});
  const transport=await resolveCodingTransport(client,{firmId,clientId});
  const authority=await authorityWithClient({client,firmId,clientId});
  const asks=(await client.query(`select * from client_evidence_requests where firm_id=$1 and client_id=$2
    and transaction_id=$3 and audience='client' and status in ('draft','open','replied') order by id`,[firmId,clientId,transactionId])).rows;
  const revision=hash({case: codingCaseRevision(current.caseEvidence),
    // Bind all supplied source context, including other documents and postings.
    documents:current.caseEvidence.documents,transactions:current.caseEvidence.transactions,
    matches:current.caseEvidence.matches,postings:current.caseEvidence.postings,
    // Preserve the exact coder transaction shape too, not only its display
    // projection. Exclude this consumer's own housekeeping and observer clocks.
    transaction:{...transaction,coding_correction_required:undefined,updated_at:undefined,
      convergence_state:undefined,convergence_reason:undefined},
    version:5,original:journal,adjustments,originalLines,policy,profile,transport,
    // The chart reader orders by code and name only; same-name rows tie, and
    // PostgreSQL may return ties in either order between two reads. The
    // revision binds the menu's content, not that order.
    accounts:[...accounts].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    clientRules,facts,authority:authority.receipt});
  return {row,transaction,requirement,current,journal,originalLines,policy,profile,accounts,clientRules,facts,authority,transport,asks,revision};
}


async function saveRequirement({client,firmId,clientId,transactionId,requirement,action}) {
  await client.query("update transactions set payload=jsonb_set(payload,'{coding_correction_required}',$4::jsonb),updated_at=now() where firm_id=$1 and client_id=$2 and id=$3",
    [firmId,clientId,transactionId,JSON.stringify(requirement)]);
  await client.query(`update transaction_review_queue set payload=payload || jsonb_build_object('coding_correction_required',$4::jsonb),
    status=$5,updated_at=now() where firm_id=$1 and client_id=$2 and item_id=$3 and reason='posted_evidence_changed'`,
    [firmId,clientId,transactionId,JSON.stringify(requirement),requirement.status==='corrected'?'resolved':'open']);
  if(action)await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,'system',$3,$4,'transaction',$5,$6::jsonb)`,[firmId,clientId,ACTOR,action,transactionId,JSON.stringify(requirement)]);
}

// A registration case on a line Donna will not correct herself (a locked
// period or a filed VAT return: CODING_CORRECTION_TAX_PERIOD_CLOSED) waits on
// a person. A person's own full reversal and replacement of that journal,
// through the adjustment writer and in its transaction, is that decision: the
// case closes with the adjustment as its receipt. Other cases keep their own
// closing rule (codingEvidence.js completeCodingEvidenceCorrectionWithClient).
export async function closeRegistrationCaseByPersonAdjustmentWithClient({client,firmId,clientId,transactionId,originalJournalId,correctionJournalIds,actorId,reason}) {
  if(!transactionId || !correctionJournalIds?.length)return false;
  const requirement=(await client.query('select payload from transactions where firm_id=$1 and client_id=$2 and id=$3 for update',
    [firmId,clientId,transactionId])).rows[0]?.payload?.coding_correction_required;
  if(requirement?.status!=='pending' || !requirement.tax_registration || requirement.original_journal_id!==originalJournalId)return false;
  await saveRequirement({client,firmId,clientId,transactionId,action:'coding.correction_completed',requirement:{...requirement,
    status:'corrected',next_action:null,actor_id:actorId,
    correction_journal_ids:[...new Set([...(requirement.correction_journal_ids || []),...correctionJournalIds])],
    authority_basis:{basis:'person_ledger_adjustment',actor_id:actorId,reason,correction_journal_ids:correctionJournalIds}}});
  return true;
}

export async function prepareCodingCorrectionWithClient(args) {
  const {client,firmId,clientId,transactionId,expectedDecisionDigest}=args;
  await admission(args);
  await lockCodingSourceInputs(client);
  const input=await readInputs(args);
  if(input.completed)return input;
  const decision=input.requirement.recovery?.decision;
  if(!decision || hash(decision)!==expectedDecisionDigest || decision.revision!==input.revision)fail('CODING_CORRECTION_STALE');
  const suggestion=decision.suggestion;
  if(suggestion.posting_requirement==='owner_fact' || suggestion.evidence_required)fail('CODING_CORRECTION_FACT_REQUIRED');
  if(!hasJevResolvedCoding(suggestion) && !(suggestion.decision_engine==='strong_after_jev'
    && suggestion.jev_handoff?.terminal==='needs_reasoning' && suggestion.confidence==='high'))fail('CODING_CORRECTION_REASONING_UNRESOLVED');
  assertCodingSuggestionForPolicy(input.policy,suggestion);
  if (input.policy.nativeMenu) {
    assertNativeCodingChoice(input.policy.nativeMenu, suggestion, { applying: true });
    if (hash(suggestion.native_source) !== hash(nativeCodingSourceReceipt(input.current.caseEvidence))) codingChoiceFailure('source_changed');
  }
  const doc=input.current.matchedDocument;
  const currentConflicts=codingSourceIdentityConflicts(input.current.caseEvidence,transactionId);
  const identityConflicts=await hasCurrentSourceIdentityReply({...args,
    transaction:{...input.transaction,ai_suggestion:suggestion},conflicts:currentConflicts})?[]:currentConflicts;
  const verdict=evaluateCodingAutoPost({suggestion,hasDocMatch:['confirmed','auto_matched'].includes(doc?.match_status),
    crossEntity:identityConflicts.length?{own_side:[...new Set(identityConflicts.map(r=>r.own_side))].join('; ')}:null,
    moneyIn:Number(input.transaction.money_in),moneyOut:Number(input.transaction.money_out),
    revenueDocument:doc,statutoryDocument:doc,amount:Number(input.transaction.money_in || input.transaction.money_out),
    correctionOwnerReply:input.asks.some(r=>decision.reply_evidence_request_ids?.includes(r.id) && caseReplyProvenance(r)==='attributable_owner_reply'),
    ownerTransferAllowed:codingOwnerTransferPostAllows({snapshot:input.authority.snapshot}),
    clientContext:input.profile,snapshot:input.authority.snapshot});
  if(verdict.action!=='auto_post')fail('CODING_CORRECTION_EXECUTION_REFUSED',{
    ...verdict,...(verdict.reason==='cross_entity_relation'?{
      source_relationships:identityConflicts.map(r=>({own_side:r.own_side,status:r.status}))}:{})});
  const prepared=await __prepareLedgerTransactionPosting({client,firmId,clientId,transactionId,
    dryRun:true,correctionSuggestion:suggestion});
  if(prepared.apSettlement?.planned || prepared.arSettlement?.planned || prepared.settlementSplit?.planned)
    fail('CODING_CORRECTION_OBLIGATION_EXECUTION_UNSUPPORTED');
  const lines=correctionDeltaLines(input.originalLines,prepared.ledgerPreview.lines);
  // A correction changes treatment, never the amount or identity of cash.
  if(lines.some(line=>line.role==='bank'))fail('CODING_CORRECTION_BANK_CHANGED');
  assertExecutionBudgetActive({stage:'coding_correction:write'});
  return {...input,suggestion,verdict,lines,targetLines:prepared.ledgerPreview.lines,actorId:ACTOR,authority:input.authority.receipt,authoritySnapshot:input.authority.snapshot,
    originalJournalId:input.journal.id,decisionDigest:expectedDecisionDigest};
}

export async function finishCodingCorrectionWithClient({client,firmId,clientId,transactionId,recovery,journalIds}) {
  const written = journalIds.length ? (await client.query(`select l.*,a.account_type,a.normal_balance
    from ledger_lines l join ledger_accounts a on a.id=l.account_id and a.firm_id=l.firm_id and a.client_id=l.client_id
    where l.firm_id=$1 and l.client_id=$2 and l.journal_id=any($3::text[]) order by l.journal_id,l.line_no,l.id`,
    [firmId,clientId,journalIds])).rows.map(rowToLedgerLinePayload) : [];
  if (correctionDeltaLines([...recovery.originalLines,...written],recovery.targetLines).length)
    fail('CODING_CORRECTION_VERIFICATION_FAILED');
  const requirement={...recovery.requirement,status:'corrected',next_action:null,actor_id:ACTOR,
    current_evidence_digest:codingEvidenceDigest(recovery.current.matchedDocument),
    correction_journal_ids:[...new Set([...(recovery.requirement.correction_journal_ids || []),...journalIds])],authority_basis:recovery.authority,
    previous_coding:recovery.transaction.ai_suggestion,
    model:recovery.suggestion.model,verified_no_change:recovery.lines.length===0,
    recovery:{...recovery.requirement.recovery,state:'completed',decision_digest:recovery.decisionDigest}};
  // The transaction projection changes only with the verified journal consequence.
  // The original coding is retained above; the original journal pointer is immutable.
  await client.query(`update transactions set category=$4,account_code=$5,payload=(payload
    - 'accepted_coding_evidence' - 'accepted_coding_policy' - 'tax_posting_facts'
    - 'xero_account_code' - 'xero_account_name' - 'xero_account_type' - 'xero_tax_type'
    - 'tax_type' - 'tax_code' - 'account_name' - 'account_label') || $6::jsonb where firm_id=$1 and client_id=$2 and id=$3`,
    [firmId,clientId,transactionId,recovery.suggestion.proposed_account,
      recovery.suggestion.account_code || recovery.suggestion.proposed_account,
      JSON.stringify({ai_suggestion:recovery.suggestion,ai_suggestion_status:'auto_applied',
        category:recovery.suggestion.proposed_account,proposed_account:recovery.suggestion.proposed_account,
        account_code:recovery.suggestion.account_code || recovery.suggestion.proposed_account,
        account_name:recovery.suggestion.proposed_account,account_label:recovery.suggestion.proposed_account,
        tax_treatment:recovery.suggestion.tax_treatment})]);
  if (recovery.verdict.fyi_owner) {
    const grant=recovery.authoritySnapshot['CODING_OWNER_TRANSFER_POST'];
    const marked=await markCodingAutoPostFyiPendingInDb({client,firmId,clientId,transactionId,
      receipt:{policy:'owner_transfer_decide_and_notify',owner_notified:false,
        flag_key:'CODING_OWNER_TRANSFER_POST',flag_stage:grant?.stage,flag_source:grant?.source,
        proposed_account:recovery.suggestion.proposed_account,posted_at:new Date().toISOString(),
        correction_journal_ids:journalIds,authority_basis:recovery.authority}});
    if (!marked.marked) fail('CODING_CORRECTION_FYI_RECEIPT_FAILED');
  }
  await saveRequirement({client,firmId,clientId,transactionId,requirement,action:'coding.correction_completed'});
  await resolveOpenEvidenceRequestsForTransaction({client,firmId,clientId,transactionId,actorId:ACTOR,
    evidenceRequestIds:recovery.asks.filter(r=>r.request_payload?.coding_correction
      || (recovery.requirement.recovery.decision.reply_evidence_request_ids?.includes(r.id)
        && caseReplyProvenance(r)==='attributable_owner_reply')).map(r=>r.id),
    note:'Current evidence was reconsidered and the verified correction committed. Original journals are preserved.'});
}

export async function recoverPostedCodingCorrectionsInDb({firmId,limit=3,runWorkerAdmissionFn=async({work})=>work(),suggestFn=suggestTransactionCoding}={}) {
  const candidates=await withFirmDbClient(async client=>(await client.query(`select id,client_id from transactions t
    where firm_id=$1 and not ${retainedNativeMarkerSql('t')} and payload->'coding_correction_required'->>'status'='pending'
    order by coalesce((payload->'coding_correction_required'->>'last_checked_at')::timestamptz,'-infinity'::timestamptz),id limit $2`,[firmId,limit])).rows);
  const results=[];
  for(const row of candidates){
    const scope={firmId,clientId:row.client_id,transactionId:row.id};
    // The reasoning claim as committed, and the case it replaced. Contention
    // after the claim returns the case to what it was before it.
    let claimed=null;
    try {
      const staged=await runWorkerAdmissionFn({...scope,work:()=>withFirmDbClient(async client=>{
        const args={...scope,client};
        const processingScope=await evaluateRetainedProcessingScopeWithClient({...scope,client,lock:false});
        if(!processingScope.allowed)return {state:'processing_review_only',reason:processingScope.reason_code,retryable:false};
        // Serializes model spending; death releases the lease. Final apply uses
        // its own transaction fence after this checkout has been returned.
        const lease=`coding-correction:${firmId}:${row.id}`;
        if(!(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked',[lease])).rows[0].locked)return {state:'busy'};
        try {
          await client.query('begin isolation level repeatable read');
          await admission(args);
          // Rotate waiting and failed cases too: one owner question cannot occupy
          // a bounded discovery slot forever and starve later corrections.
          await client.query(`update transactions set payload=jsonb_set(payload,
            '{coding_correction_required,last_checked_at}',to_jsonb(now()))
            where firm_id=$1 and client_id=$2 and id=$3
              and payload->'coding_correction_required'->>'status'='pending'`,[firmId,row.client_id,row.id]);
          let input;
          try{input=await readInputs(args);}catch(error){await client.query('rollback');throw error;}
          // Probe the final-write fence after a real refusal had its chance and
          // before any claim or model call: a held fence rolls this scan back,
          // so the case is skipped for the tick exactly as it was.
          if(!input.completed)await lockCodingSourceInputs(client);
          await client.query('commit');
          if(input.completed)return {state:'completed'};
          const prior=input.requirement.recovery;
          const same=prior?.revision===input.revision;
          if(same && prior?.state==='owner_question' && input.asks.some(r=>r.id===prior.evidence_request_id && ['draft','open'].includes(r.status)))return {state:'owner_question',evidence_request_id:prior.evidence_request_id};
          if(same && prior?.decision && ['ready','failed','blocked'].includes(prior.state) && !needsReconsideration(prior))return {decision_digest:hash(prior.decision)};
          const attempts=same?Number(prior?.attempts || 0):0;
          if(attempts>=CODING_CONFLICT_MAX_RECONSIDERATIONS)return {state:'failed',code:prior?.code || 'CODING_CORRECTION_ATTEMPTS_EXHAUSTED'};
          const previousRefusal=same ? (needsReconsideration(prior) ? {code:prior.code,details:prior.details} : prior?.previous_refusal || null) : null;
          const recovery={revision:input.revision,attempts:attempts+1,state:'reasoning',attempted_at:new Date().toISOString(),
            ...(previousRefusal?{previous_refusal:previousRefusal}:{}),
            ...(same && prior?.state==='blocked'?{retrying_blocker:{code:prior.code,details:prior.details}}:{})};
          await client.query('begin');
          const claim=(await client.query('select payload from transactions where firm_id=$1 and client_id=$2 and id=$3 for update',
            [firmId,row.client_id,row.id])).rows[0]?.payload?.coding_correction_required;
          if(hash(claim)!==hash(input.requirement))fail('CODING_CORRECTION_STALE');
          await saveRequirement({...args,requirement:{...input.requirement,recovery},action:'coding.correction_attempt'});
          await client.query('commit');
          claimed={from:input.requirement,to:JSON.parse(JSON.stringify({...input.requirement,recovery}))};
          const replied=input.asks.find(r=>r.status==='replied' && r.response_payload?.reply?.trim()
            && r.response_payload?.reply_processing?.actor_id && r.response_payload.reply_processing.actor_id!=='system');
          const transaction={...input.transaction,case_evidence:jevCasePrompt(input.current.caseEvidence),
            matched_document:input.current.matchedDocument,
            correction_context:{task:'Select the complete correct treatment of this already-posted transaction. The existing adjustment writer computes only the difference from its original journal; this is not a second recognition. A genuine missing business fact needs a precise question; an execution or authority gap needs repair, never an owner question. An explicit personal-use source is already a use fact: reconsider a contradictory expense choice rather than asking the owner to repeat the annotation. Preserve every correct principal, tax and cash component in the complete target. A previous_refusal is the actual execution failure of the earlier selection. Do not repeat that unsupported action: use the supplied source to correct it, select the specific missing-source/relationship question if that fact is absent, or explicitly request reasoning if you cannot establish a supported treatment. A bank payment description is not the statutory filing, and another company named on evidence is an unresolved relationship until attributable evidence establishes it.',
              reason:input.requirement.reason,current_posting:correctionDeltaLines([],input.originalLines),
              unresolved_source_relationships:codingSourceIdentityConflicts(input.current.caseEvidence,row.id).map(r=>({own_side:r.own_side,status:r.status})),
              ...(previousRefusal?{previous_refusal:previousRefusal}: {})},
            ...(previousRefusal?{posting_recovery:{review:{previous_refusal:previousRefusal}}}:{}),
            ...(replied?{reply_evidence_request_id:replied.id,client_reply_context:{client_reply:replied.response_payload.reply,
              asked_question:replied.question}}:{}),
            _jevProvider:await makeJevTrialProvider({...args,resourceType:'transaction',resourceId:row.id,decisionKind:'coding_correction'})};
          const suggestion=await suggestFn({clientProfile:input.profile,transaction,clientRules:input.clientRules,
            xeroAccounts:input.accounts,firmFacts:input.facts,jevEnabled:true,
            transport:input.transport});
          if(suggestion?.provider_failure)fail(suggestion.provider_failure.code,suggestion.provider_failure);
          // sanitizeSuggestion protects ordinary posting by turning a source-use
          // conflict into a question. Here the source fact is already known and
          // this consumer owns correction: a guard-generated question is not the
          // model's missing-fact decision. Reconsider it through the same clock.
          if(suggestion.source_business_use_guard && !suggestion.source_business_use_override)
            fail('CODING_CORRECTION_SOURCE_USE_CONFLICT',{
              classification:suggestion.source_business_use_guard.classification,
              source_quote:suggestion.source_business_use_guard.source_quote,
              business_use_percent:suggestion.source_business_use_guard.business_use_percent,
              constraint:suggestion.source_business_use_guard.constraint || null,
              selected_account:suggestion.proposed_account,selected_tax_treatment:suggestion.tax_treatment});
          suggestion.evidence_digest=codingEvidenceDigest(input.current.matchedDocument);
          if (input.policy.nativeMenu) suggestion.native_source = nativeCodingSourceReceipt(input.current.caseEvidence);
          const sourceRelationships=codingSourceIdentityConflicts(input.current.caseEvidence,row.id);
          if(suggestion.source_identity_resolution==='owner_explained_relationship' && replied
            && caseReplyProvenance(replied)==='attributable_owner_reply'
            && replied.request_payload?.question_basis==='current_source_relationship'
            && Array.isArray(replied.request_payload?.source_relationships)
            && sourceRelationships.length && hash(replied.request_payload.source_relationships)===hash(sourceRelationships)) {
            suggestion.source_identity_reply={authority_basis:'attributable_source_relationship_reply',
              evidence_request_id:replied.id,actor_id:replied.response_payload.reply_processing.actor_id,
              reply_digest:hash(replied.response_payload.reply.trim()),question_digest:hash(replied.question || ''),
              source_relationship_digest:hash(sourceRelationships)};
          }
          assertCodingSuggestionForPolicy(input.policy,suggestion);
          const decision={revision:input.revision,suggestion,
            reply_evidence_request_ids:input.asks.filter(r=>caseReplyProvenance(r)==='attributable_owner_reply').map(r=>r.id)};
          await client.query('begin');
          await admission(args);
          await lockCodingSourceInputs(client);
          const fresh=await readInputs(args);
          if(fresh.revision!==input.revision)fail('CODING_CORRECTION_STALE');
          assertExecutionBudgetActive({stage:'coding_correction:decision'});
          delete recovery.retrying_blocker;
          let outcome;
          if(suggestion.posting_requirement==='owner_fact' && suggestion.evidence_required===true && suggestion.ask_client_question?.trim()) {
            // The model must name a genuinely absent business fact. Writer,
            // authority and vocabulary refusals never enter this branch.
            if(input.asks.some(r=>!r.request_payload?.coding_correction))fail('CODING_CORRECTION_EXISTING_ASK_REQUIRES_RECONCILIATION');
            await resolveOpenEvidenceRequestsForTransaction({...args,actorId:ACTOR,
              evidenceRequestIds:input.asks.map(r=>r.id),note:'Reconsidered the saved answer/current evidence; a specific fact is still missing.'});
            const relationships=codingSourceIdentityConflicts(fresh.current.caseEvidence,row.id);
            const relationshipQuestion=relationships.length && ['ask_source_relationship','ask_recipient','ask_business_purpose'].includes(suggestion.jev_decision?.selected)
              ? buildOwnerAsk({reason:'cross_entity_relation',suggestion,line:fresh.transaction,
                crossEntity:{own_side:[...new Set(relationships.map(r=>r.own_side))].join('; ')}}):null;
            const ask=await __createClientEvidenceRequestWithClient({...args,question:relationshipQuestion?.question || suggestion.ask_client_question,
              evidenceType:JEV_DOCUMENT_ASK_SELECTIONS.includes(suggestion.jev_decision?.selected)?'supporting_document':'business_purpose',actorId:ACTOR,markTransactionNeedsClient:false,
              requestContext:{coding_correction:{original_journal_id:input.journal.id,revision:input.revision},
                authority_basis:input.authority.receipt,model:suggestion.model,
                ...(relationshipQuestion?{question_basis:'current_source_relationship',source_relationships:relationships}:{})}});
            outcome={...recovery,state:'owner_question',decision,evidence_request_id:ask.id};
          }else outcome={...recovery,state:'ready',decision};
          await saveRequirement({...args,requirement:{...fresh.requirement,recovery:outcome},action:'coding.correction_decided'});
          await client.query('commit');
          return outcome.state==='ready'?{decision_digest:hash(decision)}:{state:outcome.state,evidence_request_id:outcome.evidence_request_id};
        }catch(error){await client.query('rollback');throw error;}
        finally{const unlocked=await client.query('select pg_advisory_unlock(hashtextextended($1,0)) as unlocked',[lease]);if(!unlocked.rows[0].unlocked)fail('CODING_CORRECTION_LEASE_RELEASE_FAILED');}
      })});
      if(staged.decision_digest){
        const result=await postLedgerAdjustmentInDb({...scope,reason:'Source-supported autonomous correction',codingCorrection:staged});
        results.push({...scope,state:'completed',journal_ids:result.ledger_adjustment?.journals.map(j=>j.ledger_journal_id)||[]});
      }else results.push({...scope,...staged});
    }catch(error){
      if(isFenceContention(error)){
        // Someone else held a source table for a moment. Nothing was decided
        // or refused: no receipt, no blocked code, no attempt spent. The case
        // is taken again on the next tick; this tick moves to the next case.
        await withFirmDbClient(async client=>{
          await client.query('begin');
          try{
            const current=(await client.query('select payload from transactions where firm_id=$1 and client_id=$2 and id=$3 for update',[firmId,row.client_id,row.id])).rows[0]?.payload?.coding_correction_required;
            if(current?.status==='pending'){
              const restored=pendingAfterContention(claimed && hash(current)===hash(claimed.to)?claimed.from:current);
              if(hash(restored)!==hash(current))await saveRequirement({client,...scope,requirement:restored});
            }
            await client.query('commit');
          }catch(writeError){await client.query('rollback');throw writeError;}
        });
        results.push({...scope,state:'contended',retryable:true});
        continue;
      }
      // A named refusal is recorded as itself. An error with no business code
      // (a raw SQLSTATE, a programming error) is recorded as what it is, an
      // unexpected failure with its message, never under that raw code.
      const unexpected=isUnexpectedFailure(error);
      if(unexpected)console.error('[coding_correction] unexpected failure (case blocked, receipted)',{transaction_id:row.id,code:error?.code || null,message:error?.message || String(error),stack:error?.stack || null});
      const code=unexpected?'CODING_CORRECTION_FAILED':error.code,details=unexpected?unexpectedFailureDetails(error):error.details || null;
      const state=needsReconsideration({code,details})?'failed':'blocked';
      await withFirmDbClient(async client=>{
        await client.query('begin');
        try{
          const current=(await client.query('select payload from transactions where firm_id=$1 and client_id=$2 and id=$3 for update',[firmId,row.client_id,row.id])).rows[0]?.payload?.coding_correction_required;
          // Admission can fail before the scan timestamp, and readInputs can
          // roll it back. Persist rotation with the failure receipt so a denied
          // head cannot starve later cases without spending any model budget.
          const checkedAt=new Date().toISOString();
          if(current?.status==='pending'){
            const recovery={...current.recovery,state,code,details,attempted_at:checkedAt};
            // A transport or admission failure after the reasoning claim made
            // no accounting decision. Return that claim's reconsideration slot.
            if(state==='blocked' && current.recovery?.state==='reasoning')
              recovery.attempts=Math.max(0,Number(current.recovery.attempts || 0)-1);
            const priorBlocker=current.recovery?.state==='reasoning'
              ?current.recovery.retrying_blocker:current.recovery;
            const unchangedBlock=state==='blocked' && priorBlocker?.code
              && blockerIdentity(priorBlocker)===blockerIdentity({code,details});
            delete recovery.retrying_blocker;
            if(unchangedBlock){
              // Keep discovery fair while the dependency is probed. One durable
              // blocked receipt names the cause; the five-minute clock does not
              // mint an identical failure event on every pass.
              await saveRequirement({client,...scope,requirement:{...current,last_checked_at:checkedAt,recovery}});
            }else await saveRequirement({client,...scope,requirement:{...current,last_checked_at:checkedAt,
              recovery},action:'coding.correction_failed'});
          }
          await client.query('commit');
        }catch(writeError){await client.query('rollback');throw writeError;}
      });
      results.push({...scope,state,code});
    }
  }
  return results;
}
