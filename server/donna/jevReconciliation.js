import { hash } from './jevEvidenceContract.js';
// Client-scoped Jev execution on the existing reconciliation writer.
// The first executable vocabulary is one full same-currency settlement. Other
// selected plans remain visible as unsupported; no legacy model decides instead.
import { decideJevReconciliation } from './jevRuntimeDecision.js';
import { ZERO_STATS, CANDIDATE_TX_STATUS_SQL, getAutoMatchPolicy, authorizeJevMatch,
  applyMaterialAutoFyi, upsertMatchAndCascade, recordReconciliationEvaluation } from './reconciliationLlmCore.js';
import { persistConfigSnapshot, clientFlagActs } from './clientConfig.js';
import { readJevCase } from './jevPreview.js';
import { isProviderFailure } from './providerTransport.js';
import { applyReminderSettlementWithClient } from './creditNoteApplications.js';
import { planRefundGroup } from './jevRefundGroup.js';
import { NO_SETTLEMENT_OBLIGATION_TYPES, JEV_PREPARATION_CONTRACT } from './documentDispositionShape.js';
import { suggestedMatchHasSettleLane } from './reconciliationTwinAging.js';
import { ensureNoSettlementAskWithClient, noSettlementAskStatsKey } from './salesRecognitionGap.js';

export const __jevReconciliation = {
  decide: args => decideJevReconciliation(args),
  write: args => upsertMatchAndCascade(args),
  record: args => recordReconciliationEvaluation(args),
  authorize: args => authorizeJevMatch(args),
  noSettlementAsk: args => ensureNoSettlementAskWithClient(args)
};
const familyFor = type => type === 'issued_receipt' ? 'sales_invoice' : type === 'deposit_slip' ? 'payout_statement' : type;
const minor = n => Math.round(Number(n || 0) * 100);
const activeMatch = status => status === 'confirmed' || status === 'auto_matched';
// HELMIKUU S7: with this client flag, the owner's confirmation of a held first
// match completes a multi-member plan (completeOwnerConfirmedJevPlanWithClient).
export const HELD_PLAN_COMPLETION_FLAG = 'JEV_HELD_PLAN_COMPLETION';
export const heldPlanCompletionActs = snapshot => clientFlagActs({ flagKey: HELD_PLAN_COMPLETION_FLAG, snapshot, envFallback: () => false });
const multiMember = plan => Boolean(plan?.settlement_rows || plan?.refund_group || plan?.reminder_obligation);
const heldRow = match => match?.status === 'suggested' && match.payload?.authorization?.band === 'suggested'
  && suggestedMatchHasSettleLane(match.payload.authorization.reasons);
// The writer persisted this proposal and held it for authority. The held-match
// owner confirmation (the same admission as reconciliationTwinAging's gathers)
// is its terminal; another Jev call would reach the same hold. A multi-member
// plan is held only where that confirmation also completes the rest of it.
const heldForAuthority = (receipt, plan, completion = false) => heldRow(receipt) && (completion || !multiMember(plan));

// The plan's members after its first match, for Jev's own write and for the
// owner-confirmed completion alike. Statement rows are each authorized, and
// under the completion flag a row may rest held on its own owner question. The
// refund group and the reminder settlement follow the first match's authority.
const completePlanMembers = async ({ client, firmId, clientId, documentId, plan, family, document, bankLines, firstId, proposal,
  authorization, policy, configSnapshot, configSnapshotId, stats, model, freshGroup, writerReceipt, allowHeldRows, writtenRowsStand = false }) => {
  const selectedIds = plan.refund_group?.transaction_ids || plan.allocations.map(a => a.transaction_id);
  if (plan.settlement_rows) {
    // HELMIKUU S8: an owner confirmation settles only its own row. A row Jev
    // already wrote stands as written (held on its own question, or settled);
    // only a row with no match yet is written here.
    const written = writtenRowsStand ? new Set((await client.query(`select bank_transaction_id from reconciliation_matches where firm_id=$1 and client_id=$2
      and matched_object_id=$3 and bank_transaction_id=any($4::text[]) and matched_line_id is not null and status in ('confirmed','auto_matched','suggested')`,
    [firmId, clientId, documentId, selectedIds])).rows.map(m => m.bank_transaction_id)) : new Set();
    for (const allocation of plan.allocations.filter(a => a.transaction_id !== firstId && !written.has(a.transaction_id))) {
      const member = bankLines.find(t => t.id === allocation.transaction_id);
      const rowProposal = { ...proposal, bank_transaction_id: member.id, hops: ['jev_direct_action', `statement_row:${allocation.settlement_row.line_no}`] };
      const rowAuthorization = applyMaterialAutoFyi(__jevReconciliation.authorize({ proposal: rowProposal, bankLine: member, document, clientId, configSnapshot, policy, settlementRow: allocation.settlement_row }), { clientId, configSnapshot });
      await __jevReconciliation.write({ client, firmId, clientId, proposal: rowProposal, document, objectType: family, matchAmount: allocation.amount_minor / 100, autoThreshold: null,
        authorization: rowAuthorization, returnedModel: model, source: `${family}_reconciliation_llm`, matchKind: family, configSnapshotId, stats, logTag: 'jevReconciliation', settlementRow: allocation.settlement_row });
    }
    const rows = (await client.query(`select bank_transaction_id, status, payload from reconciliation_matches where firm_id=$1 and client_id=$2 and matched_object_id=$3
      and bank_transaction_id=any($4::text[]) and matched_line_id is not null and status in ('confirmed','auto_matched','suggested')`, [firmId, clientId, documentId, selectedIds])).rows;
    const active = new Set(rows.filter(m => activeMatch(m.status)).map(m => m.bank_transaction_id));
    const held = new Set(rows.filter(m => allowHeldRows && heldRow(m)).map(m => m.bank_transaction_id));
    if (active.size + held.size !== selectedIds.length) throw Object.assign(new Error('Statement rows did not all settle'), { code: 'JEV_SETTLEMENT_ROWS_REFUSED' });
    return { complete: held.size === 0, heldRows: held.size };
  }
  if (plan.refund_group) {
    const groupReceipt = { ...freshGroup, status: 'selected', actor_id: 'jev_reconciliation', model, authority_basis: 'jev_group_selection_under_existing_reconciliation_authority' };
    for (const member of bankLines.filter(t => t.id !== firstId)) {
      await __jevReconciliation.write({ client, firmId, clientId,
        proposal: { ...proposal, bank_transaction_id: member.id, reasoning: 'Selected duplicate-charge/refund group; identity of the reversed identical debit is unspecified.' },
        document, objectType: family, matchAmount: 0, autoThreshold: null,
        authorization: { ...authorization, decision_contract: 'jev-refund-group-v1', refund_group: groupReceipt },
        returnedModel: model, source: `${family}_reconciliation_llm`, matchKind: family, configSnapshotId, stats, logTag: 'jevReconciliation' });
    }
    const active = (await client.query(`select bank_transaction_id from reconciliation_matches where firm_id=$1 and client_id=$2
      and matched_object_id=$3 and bank_transaction_id=any($4::text[]) and status in ('confirmed','auto_matched')`, [firmId, clientId, documentId, selectedIds])).rows;
    if (new Set(active.map(m => m.bank_transaction_id)).size !== 3) throw Object.assign(new Error('Every refund group member must settle atomically'), { code: 'REFUND_GROUP_MATCH_REFUSED' });
    await client.query(`update transactions set payload=payload||jsonb_build_object('jev_refund_group',$4::jsonb),updated_at=now()
      where firm_id=$1 and client_id=$2 and id=any($3::text[])`, [firmId, clientId, selectedIds, JSON.stringify(groupReceipt)]);
    writerReceipt.refund_group = groupReceipt;
  }
  if (plan.reminder_obligation) {
    writerReceipt.reminder_obligation = await applyReminderSettlementWithClient({ client, firmId, clientId,
      matchId: writerReceipt.id, reminderDocumentId: documentId, invoiceDocumentId: plan.reminder_obligation.invoice_document_id,
      plan: plan.reminder_obligation, actorId: 'jev_reconciliation', model });
  }
  return { complete: true, heldRows: 0 };
};

export function executableJevSettlement(result) {
  const { document, candidates = [], decision } = result;
  const plan = decision?.plan;
  if (decision?.terminal !== 'resolve') return { ok: false, reason: `jev_${decision?.terminal || 'invalid_decision'}` };
  if (decision?.refusals?.length) return { ok: false, reason: 'jev_validator_refused' };
  if (!plan || (!plan.settlement_rows && plan.allocations?.length !== 1) || !plan.allocations?.length || plan.requests?.length || plan.fact_request
      || Number(plan.retained_balance_minor || 0) !== 0 || plan.surplus_disposition) return { ok: false, reason: 'jev_unsupported_complete_plan' };
  const allocation = plan.allocations[0];
  const bankLine = candidates.find(t => t.id === allocation.transaction_id);
  const incoming = ['sales_invoice', 'issued_receipt', 'payout_statement', 'deposit_slip'].includes(document?.document_type);
  const amount = Number(bankLine?.[incoming ? 'money_in' : 'money_out'] || 0);
  if (!bankLine || amount <= 0 || Number(bankLine[incoming ? 'money_out' : 'money_in'] || 0) !== 0
      || bankLine.currency !== document.currency || allocation.currency !== document.currency
      || Number(allocation.fee_minor || 0) !== 0 || Number(allocation.surplus_minor || 0) !== 0
      || allocation.amount_minor !== minor(allocation.settlement_row?.net ?? document.total_amount) || allocation.amount_minor !== minor(amount)) {
    return { ok: false, reason: 'jev_unsupported_amount_plan' };
  }
  if(plan.settlement_rows && (new Set(plan.allocations.map(a=>a.transaction_id)).size!==plan.allocations.length
    || plan.allocations.some(a=>!a.settlement_row || a.amount_minor!==minor(a.settlement_row.net))))return {ok:false,reason:'jev_invalid_settlement_rows'};
  return { ok: true, bankLine, matchAmount: amount, settlementRow:allocation.settlement_row || null, proposal: {
    bank_transaction_id: bankLine.id, confidence: decision.probability,
    decision_source: 'jev_full_settlement',
    reasoning: plan.text || 'Jev selected this complete settlement plan.', hops: ['jev_direct_action',...(allocation.settlement_row?[`statement_row:${allocation.settlement_row.line_no}`]:[])]
  } };
}

// HELMIKUU S7: the owner's attributable yes to a held-match question settles
// that Jev match and completes the rest of its plan through the same writer and
// the same member step Jev uses. Called by the owner-reply consumer inside its
// transaction, only after that consumer bound the reply to this held document
// (source_reply_authority). No model call and no standing grant: the owner's
// reply is the per-item authority, receipted on the match. A plan whose facts
// changed is handed back to Jev for a current decision; an unexpected failure
// throws so the reply stays unprocessed and the owner-reply recovery retries it.
export async function completeOwnerConfirmedJevPlanWithClient({ client, firmId, clientId, transactionId, documentId,
  actorId, evidenceRequestId, configSnapshot, matchId = null, scopeDecision = null, answeredTransactionId = null }) {
  if (!heldPlanCompletionActs(configSnapshot)) return { completed: false, skipped: 'flag_off' };
  const held = (await client.query(`select * from reconciliation_matches where firm_id=$1 and client_id=$2 and bank_transaction_id=$3
    and matched_object_id=$4 and status='suggested' order by id for update`, [firmId, clientId, transactionId, documentId])).rows;
  if (held.length !== 1 || !heldRow(held[0]) || (matchId && held[0].id !== matchId)) return { completed: false, skipped: 'no_held_match' };
  const prior = (await client.query(`select matcher_family, model, payload from reconciliation_evaluations
    where firm_id=$1 and client_id=$2 and target_id=$3 and payload->>'decision_engine'='jev' and verdict <> 'superseded'
      and matcher_family not in ('document_no_line_disposition','jev_first_decision') order by evaluated_at desc limit 1`, [firmId, clientId, documentId])).rows[0];
  const plan = prior?.payload?.selected_plan;
  const selectedIds = plan?.refund_group?.transaction_ids || plan?.allocations?.map(a => a.transaction_id) || [];
  if (prior?.payload?.selected_terminal !== 'resolve' || !selectedIds.includes(transactionId)) return { completed: false, skipped: 'not_a_jev_plan_member' };
  const family = prior.matcher_family;
  const document = (await client.query(`select * from documents where firm_id=$1 and client_id=$2 and id=$3 for update`, [firmId, clientId, documentId])).rows[0];
  const bankLines = (await client.query(`select *, ${CANDIDATE_TX_STATUS_SQL} as eligible from transactions where firm_id=$1 and client_id=$2
    and id=any($3::text[]) order by id for update`, [firmId, clientId, selectedIds])).rows;
  const others = (await client.query(`select bank_transaction_id, matched_object_id, matched_line_id, status from reconciliation_matches
    where firm_id=$1 and client_id=$2 and (bank_transaction_id=any($3::text[]) or matched_object_id=$4) and status in ('confirmed','auto_matched')`,
  [firmId, clientId, selectedIds, documentId])).rows;
  const executable = document ? executableJevSettlement({ document, candidates: bankLines,
    decision: { terminal: 'resolve', probability: prior.payload.probability, refusals: [], plan } }) : { ok: false };
  const allocation = plan.settlement_rows ? plan.allocations.find(a => a.transaction_id === transactionId) : plan.allocations[0];
  const confirmed = bankLines.find(t => t.id === transactionId);
  const lines = plan.settlement_rows ? (await client.query(`select id, amount, payload from document_lines where firm_id=$1 and client_id=$2 and document_id=$3 for share`,
    [firmId, clientId, documentId])).rows : [];
  const freshGroup = plan.refund_group ? planRefundGroup({ document: (await readJevCase({ client, firmId, clientId, documentId, evidenceOnly: true }))
    .caseEvidence.documents.find(d => d.id === documentId), transactions: bankLines }) : null;
  // The facts the owner confirmed must still be the facts of the plan: the
  // same document, the same bank amounts, the same rows and group, no member
  // settled elsewhere. The confirmed line itself was just explained by the
  // owner's reply; every other member must still be an eligible candidate.
  // HELMIKUU S8: each statement row is its own authority (Kari, 2026-09-24),
  // so for a statement the owner's yes is checked against its own row: that
  // row's document line and bank line, and nothing settled against either.
  // Another row whose facts changed does not block this one; it fails its own
  // check when it is confirmed. The group and the reminder stay whole-plan.
  const ownRow = m => plan.settlement_rows && m.matched_object_id === documentId && m.matched_line_id
    && plan.allocations.some(a => a.transaction_id === m.bank_transaction_id && a.settlement_row.line_id === m.matched_line_id);
  const scoped = plan.settlement_rows ? [allocation] : plan.allocations;
  const touchesConfirmedRow = m => !plan.settlement_rows || m.bank_transaction_id === transactionId || m.matched_line_id === allocation.settlement_row.line_id;
  const exact = executable.ok && document.parse_status === 'completed' && !document.duplicate_of && confirmed
    && familyFor(document.document_type) === family
    && bankLines.length === selectedIds.length
    && bankLines.every(t => t.id === transactionId || plan.settlement_rows || t.eligible || others.some(m => m.bank_transaction_id === t.id && ownRow(m)))
    && (!plan.settlement_rows || scoped.every(a => {
      const line = lines.find(l => l.id === a.settlement_row?.line_id), bank = bankLines.find(t => t.id === a.transaction_id);
      return line && hash(line.payload?.raw_extraction?.settlement_row || null) === hash(a.settlement_row.settlement_row) && minor(line.amount) === a.amount_minor
        && bank && bank.currency === document.currency && minor(bank.money_in) === a.amount_minor && !Number(bank.money_out);
    }))
    && (!plan.refund_group || (freshGroup.ok && freshGroup.source_digest === plan.refund_group.source_digest))
    && others.filter(touchesConfirmedRow).every(ownRow);
  const configSnapshotId = await persistConfigSnapshot(client, { firmId, clientId, snapshot: configSnapshot });
  // HELMIKUU S8: a row settled by an answer to another row's question carries
  // that answer's scope decision and the row it was asked about.
  const scopeReceipt = scopeDecision ? { scope_decision: scopeDecision,
    ...(answeredTransactionId && answeredTransactionId !== transactionId ? { answered_bank_transaction_id: answeredTransactionId } : {}) } : {};
  const record = async ({ verdict, execution, reason, nextAction, writerReceipt }) => __jevReconciliation.record({ client, firmId, clientId, targetId: documentId,
    matcherFamily: family, verdict, unmatchableReason: verdict === 'proposed' ? null : reason, proposalCount: verdict === 'proposed' ? 1 : 0,
    candidateCount: selectedIds.length, eligibleCount: bankLines.filter(t => t.eligible).length, model: prior.model, configSnapshotId,
    recordDecision: true, logTag: 'jevReconciliation',
    payload: { ...prior.payload, next_action: nextAction, failure_class: nextAction ? 'writer_refusal' : null,
      execution, execution_reason: reason, writer_receipt: writerReceipt,
      owner_confirmation: { actor_id: actorId, evidence_request_id: evidenceRequestId, bank_transaction_id: transactionId, ...scopeReceipt } } });
  if (!exact) {
    await record({ verdict: 'no_match', execution: 'not_applied', reason: 'jev_evidence_changed_before_write', nextAction: 'reconsider_current_evidence', writerReceipt: null });
    return { completed: false, reason: 'jev_evidence_changed_before_write' };
  }
  // A deterministic refusal from a writer (a capped member, a changed reminder
  // relationship) must not wedge the owner's reply: it rolls back only this
  // completion and hands the plan back to Jev for a current decision.
  await client.query('savepoint jev_owner_confirmation');
  try {
    const completed = await settleOwnerConfirmedPlan({ client, firmId, clientId, transactionId, documentId, actorId, evidenceRequestId,
      configSnapshot, configSnapshotId, plan, family, prior, document, bankLines, executable, allocation, confirmed, held: held[0], freshGroup, selectedIds, record, scopeReceipt });
    await client.query('release savepoint jev_owner_confirmation');
    return completed;
  } catch (error) {
    await client.query('rollback to savepoint jev_owner_confirmation');
    await client.query('release savepoint jev_owner_confirmation');
    if (!OWNER_CONFIRMATION_REFUSALS.has(error?.code)) throw error;
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'system',$3,'reconciliation_match.owner_confirmation_refused','reconciliation_match',$4,$5::jsonb)`,
    [firmId, clientId, actorId, held[0].id, JSON.stringify({ code: error.code, message: error.message, document_id: documentId, evidence_request_id: evidenceRequestId })]);
    await record({ verdict: 'no_match', execution: 'not_applied', reason: 'jev_evidence_changed_before_write', nextAction: 'reconsider_current_evidence', writerReceipt: null });
    return { completed: false, reason: 'jev_evidence_changed_before_write', refusal: error.code };
  }
}

// HELMIKUU S8 (Kari, 2026-09-24): each held statement row keeps its own
// question, and a question whose statement has other held rows names them so
// the owner can confirm all the remaining rows in one answer. These are the
// other held rows of the same statement, as the question shows them.
export async function readHeldStatementSiblingsWithClient({ client, firmId, clientId, documentId, transactionId }) {
  // Only rows of the same Jev statement plan: the answer settles them through
  // that plan's owner confirmation, so a row outside it is never offered.
  const plan = (await client.query(`select payload->'selected_plan' as plan from reconciliation_evaluations
    where firm_id=$1 and client_id=$2 and target_id=$3 and payload->>'decision_engine'='jev' and verdict <> 'superseded'
      and matcher_family not in ('document_no_line_disposition','jev_first_decision') order by evaluated_at desc limit 1`, [firmId, clientId, documentId])).rows[0]?.plan;
  const members = new Set(plan?.settlement_rows ? (plan.allocations || []).map(a => `${a.transaction_id}:${a.settlement_row?.line_id}`) : []);
  if (!members.has(`${transactionId}:${plan?.allocations?.find(a => a.transaction_id === transactionId)?.settlement_row?.line_id}`)) return [];
  const rows = (await client.query(`select m.id as match_id, m.bank_transaction_id, m.matched_line_id, m.status, m.payload,
      to_char(t.transaction_date, 'YYYY-MM-DD') as transaction_day, t.money_in, t.money_out, t.currency, dl.line_no, dl.description as line_description
    from reconciliation_matches m
    join transactions t on t.firm_id=m.firm_id and t.client_id=m.client_id and t.id=m.bank_transaction_id
    join document_lines dl on dl.firm_id=m.firm_id and dl.client_id=m.client_id and dl.id=m.matched_line_id and dl.document_id=m.matched_object_id
    where m.firm_id=$1 and m.client_id=$2 and m.matched_object_id=$3 and m.bank_transaction_id<>$4 and m.status='suggested'
    order by dl.line_no, m.id`, [firmId, clientId, documentId, transactionId])).rows;
  return rows.filter(row => heldRow(row) && members.has(`${row.bank_transaction_id}:${row.matched_line_id}`)).map(row => ({ match_id: row.match_id, transaction_id: row.bank_transaction_id, document_id: documentId,
    line_id: row.matched_line_id, line_no: row.line_no ?? null, line_description: row.line_description || '',
    date: row.transaction_day || null,
    amount: Math.abs(Number(row.money_out) || Number(row.money_in)).toFixed(2), currency: row.currency || '',
    direction: Number(row.money_out) ? 'paid' : 'received' }));
}

// The owner answered one row's question and the typed scope decision read the
// answer as covering all the remaining rows. Settle each row the question
// named that is still held, as shown, through the same owner confirmation, one
// receipt per row carrying the answer's actor, question id and scope decision.
// A row that changed since the question, or that the writer refuses, is handed
// back to Jev and keeps its own open question; it never blocks the others.
export async function confirmRemainingHeldRowsWithClient({ client, firmId, clientId, documentId, answeredTransactionId, actorId,
  evidenceRequestId, siblings = [], scopeDecision, configSnapshot }) {
  if (!heldPlanCompletionActs(configSnapshot) || scopeDecision?.scope !== 'all_remaining_rows') return [];
  const results = [];
  for (const shown of [...siblings].filter(row => row && typeof row.match_id === 'string' && typeof row.transaction_id === 'string'
    && row.document_id === documentId && row.transaction_id !== answeredTransactionId).sort((a, b) => a.transaction_id.localeCompare(b.transaction_id))) {
    const current = (await readHeldStatementSiblingsWithClient({ client, firmId, clientId, documentId, transactionId: answeredTransactionId }))
      .find(row => row.match_id === shown.match_id);
    if (!current) {
      const settled = (await client.query(`select 1 from reconciliation_matches where firm_id=$1 and client_id=$2 and id=$3 and status in ('confirmed','auto_matched')`,
        [firmId, clientId, shown.match_id])).rowCount > 0;
      results.push({ transaction_id: shown.transaction_id, match_id: shown.match_id, skipped: settled ? 'already_settled' : 'no_longer_held' });
      continue;
    }
    const asShown = ['transaction_id', 'line_id', 'date', 'amount', 'currency', 'direction'].every(key => current[key] === shown[key]);
    const outcome = asShown
      ? await completeOwnerConfirmedJevPlanWithClient({ client, firmId, clientId, transactionId: shown.transaction_id, documentId, actorId,
        evidenceRequestId, configSnapshot, matchId: shown.match_id, scopeDecision, answeredTransactionId })
      : { completed: false, reason: 'jev_evidence_changed_before_write', refusal: 'JEV_ROW_CHANGED_SINCE_QUESTION' };
    results.push({ transaction_id: shown.transaction_id, match_id: shown.match_id, ...outcome });
  }
  // The last word on the plan: any refused row hands it back to Jev, even when
  // a later row settled after it (the evaluation is one row per document).
  const refused = results.filter(row => row.reason === 'jev_evidence_changed_before_write');
  if (refused.length) {
    const prior = (await client.query(`select matcher_family, model, payload from reconciliation_evaluations
      where firm_id=$1 and client_id=$2 and target_id=$3 and payload->>'decision_engine'='jev' and verdict <> 'superseded'
        and matcher_family not in ('document_no_line_disposition','jev_first_decision') order by evaluated_at desc limit 1`, [firmId, clientId, documentId])).rows[0];
    if (prior) await __jevReconciliation.record({ client, firmId, clientId, targetId: documentId, matcherFamily: prior.matcher_family,
      verdict: 'no_match', unmatchableReason: 'jev_evidence_changed_before_write', proposalCount: 0,
      candidateCount: prior.payload?.selected_plan?.allocations?.length || 0, eligibleCount: 0, model: prior.model,
      configSnapshotId: await persistConfigSnapshot(client, { firmId, clientId, snapshot: configSnapshot }), recordDecision: true, logTag: 'jevReconciliation',
      payload: { ...prior.payload, next_action: 'reconsider_current_evidence', failure_class: 'writer_refusal', execution: 'not_applied',
        execution_reason: 'jev_evidence_changed_before_write', writer_receipt: null,
        owner_confirmation: { actor_id: actorId, evidence_request_id: evidenceRequestId, bank_transaction_id: answeredTransactionId,
          scope_decision: scopeDecision, refused_rows: refused.map(row => ({ transaction_id: row.transaction_id, match_id: row.match_id, refusal: row.refusal || null })) } } });
  }
  for (const row of results.filter(r => r.refusal === 'JEV_ROW_CHANGED_SINCE_QUESTION')) {
    await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'system',$3,'reconciliation_match.owner_confirmation_refused','reconciliation_match',$4,$5::jsonb)`,
    [firmId, clientId, actorId, row.match_id, JSON.stringify({ code: row.refusal, document_id: documentId, evidence_request_id: evidenceRequestId,
      bank_transaction_id: row.transaction_id, answered_bank_transaction_id: answeredTransactionId })]);
  }
  return results;
}

const OWNER_CONFIRMATION_REFUSALS = new Set(['JEV_OWNER_CONFIRMATION_REFUSED', 'JEV_SETTLEMENT_ROWS_REFUSED', 'REFUND_GROUP_MATCH_REFUSED', 'REMINDER_OBLIGATION_REFUSED']);

const settleOwnerConfirmedPlan = async ({ client, firmId, clientId, transactionId, documentId, actorId, evidenceRequestId, configSnapshot, configSnapshotId,
  plan, family, prior, document, bankLines, executable, allocation, confirmed, held, freshGroup, selectedIds, record, scopeReceipt }) => {
  const { rows: identities } = await client.query('select jurisdiction from clients where firm_id=$1 and id=$2', [firmId, clientId]);
  const policy = getAutoMatchPolicy({ jurisdiction: identities[0]?.jurisdiction || null });
  const proposal = { ...executable.proposal, bank_transaction_id: transactionId,
    ...(plan.settlement_rows ? { hops: ['jev_direct_action', `statement_row:${allocation.settlement_row.line_no}`] } : {}) };
  const settlementRow = plan.settlement_rows ? allocation.settlement_row : null;
  const base = __jevReconciliation.authorize({ proposal, bankLine: confirmed, document, clientId, configSnapshot, policy, settlementRow });
  const authorization = { ...base, band: 'auto_matched', reasons: [...(base.reasons || []), 'owner_confirmed_held_match'] };
  const stats = { ...ZERO_STATS(), decision_engine: 'jev' };
  await __jevReconciliation.write({ client, firmId, clientId, proposal, document, objectType: held.matched_object_type,
    matchAmount: allocation.amount_minor / 100, autoThreshold: null, authorization, returnedModel: prior.model,
    source: `${family}_reconciliation_llm`, matchKind: family, configSnapshotId, stats, logTag: 'jevReconciliation', settlementRow });
  const receipt = { authority_basis: 'owner_confirmed_held_match', actor_id: actorId, evidence_request_id: evidenceRequestId, confirmed_at: new Date().toISOString(), ...scopeReceipt };
  const writerReceipt = (await client.query(`update reconciliation_matches set payload=payload || jsonb_build_object('owner_confirmation',$3::jsonb), updated_at=now()
    where firm_id=$1 and id=$2 returning id, status, payload`, [firmId, held.id, JSON.stringify(receipt)])).rows[0];
  if (!activeMatch(writerReceipt.status)) throw Object.assign(new Error('The owner-confirmed match did not settle.'), { code: 'JEV_OWNER_CONFIRMATION_REFUSED' });
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,'system',$3,'reconciliation_match.owner_confirmed','reconciliation_match',$4,$5::jsonb)`,
  [firmId, clientId, actorId, writerReceipt.id, JSON.stringify({ ...receipt, document_id: documentId, bank_transaction_id: transactionId, plan_members: selectedIds })]);
  const members = await completePlanMembers({ client, firmId, clientId, documentId, plan, family, document, bankLines, firstId: transactionId,
    proposal, authorization, policy, configSnapshot, configSnapshotId, stats, model: prior.model, freshGroup, writerReceipt, allowHeldRows: true, writtenRowsStand: true });
  await record({ verdict: 'proposed', execution: members.complete ? 'existing_reconciliation_writer' : 'held_for_authority',
    reason: members.complete ? 'jev_owner_confirmed_held_match' : 'jev_match_held_for_authority', nextAction: null, writerReceipt });
  return { completed: members.complete, held_rows: members.heldRows, match_id: writerReceipt.id };
};

export async function runJevReconciliationForDocument({ client, firmId, clientId, documentId, configSnapshot, fetchImpl, family = null }) {
  const stats = { ...ZERO_STATS(), decision_engine: 'jev' };
  let result = null, configSnapshotId = null, reason = null, wrote = false, held = false, writerReceipt = null, negativeAccepted = false;
  try {
    const prior = (await client.query(`select payload from reconciliation_evaluations where firm_id=$1 and client_id=$2 and target_id=$3
      and payload->>'decision_engine'='jev' order by evaluated_at desc limit 1`,[firmId,clientId,documentId])).rows[0];
    stats.jev_attempt_count = (prior?.payload?.preparation_contract === JEV_PREPARATION_CONTRACT ? Number(prior.payload.attempt_count || 0) : 0)+1;
    configSnapshotId = await persistConfigSnapshot(client, { firmId, clientId, snapshot: configSnapshot });
    result = await __jevReconciliation.decide({ client, firmId, clientId, documentId, fetchImpl });
    family ||= familyFor(result.document?.document_type);
    const executable = executableJevSettlement(result);
    if (result.decision?.terminal === 'no_settlement') {
      let ownsTransaction = false;
      try { await client.query('savepoint jev_negative_assessment'); }
      catch (error) { if(error.code !== '25P01') throw error; await client.query('begin'); ownsTransaction=true; }
      try {
        const fresh = await readJevCase({client,firmId,clientId,documentId,evidenceOnly:true,lockEvidence:true});
        negativeAccepted = Boolean(result.consumed_evidence) && hash(result.consumed_evidence)===hash(fresh.caseEvidence);
        reason=negativeAccepted?'jev_no_settlement':'jev_evidence_changed_before_write';
        if(negativeAccepted && NO_SETTLEMENT_OBLIGATION_TYPES.includes(result.document?.document_type)) await __jevReconciliation.record({client,firmId,clientId,targetId:documentId,
          matcherFamily:'document_no_line_disposition',verdict:'no_match',unmatchableReason:'jev_no_settlement',
          model:result.model,configSnapshotId,recordDecision:true,logTag:'jevReconciliation',
          payload:{decision_engine:'jev',disposition:'no_settlement',probability:result.decision.probability,
            evidence_packet_sha256:result.evidence_packet_sha256,assessment:'No supplied payment settles this document. The obligation remains open.',
            scope:{transaction_ids:result.candidates.map(t=>t.id),absence_proven:false},accounting_complete:false}});
        // FI-09: an open sales-invoice or supplier-bill obligation on accrual
        // books is not recorded anywhere yet; put it on the owner (the
        // existing doc ask, one lane per obligation type).
        const askKey=noSettlementAskStatsKey(result.document?.document_type);
        if(negativeAccepted && askKey) stats[askKey]=await __jevReconciliation.noSettlementAsk({client,firmId,clientId,documentId,documentType:result.document.document_type,reason:'jev_no_settlement'});
        await client.query(ownsTransaction?'commit':'release savepoint jev_negative_assessment');
      } catch(error) {
        negativeAccepted=false;
        await client.query(ownsTransaction?'rollback':'rollback to savepoint jev_negative_assessment');
        if(!ownsTransaction) await client.query('release savepoint jev_negative_assessment');
        throw error;
      }
    }
    else if (!executable.ok) reason = executable.reason;
    else {
      // Model work precedes the lock. Re-read the real rows and consumption
      // under the lock before dispatching to the existing named writer.
      let ownsTransaction = false;
      try { await client.query('savepoint jev_reconciliation_write'); }
      catch (error) {
        if (error.code !== '25P01') throw error;
        await client.query('begin');
        ownsTransaction = true;
      }
      const statsBeforeWrite = {...stats};
      try {
        const { rows: documents } = await client.query(`select * from documents where firm_id=$1 and client_id=$2 and id=$3 for update`, [firmId, clientId, documentId]);
        const group = result.decision.plan.refund_group;
        const selectedIds = group?.transaction_ids || result.decision.plan.allocations.map(a=>a.transaction_id);
        const { rows: bankLines } = await client.query(`select *, ${CANDIDATE_TX_STATUS_SQL} as eligible from transactions where firm_id=$1 and client_id=$2 and id=any($3::text[]) order by id for update`, [firmId, clientId, selectedIds]);
        const document = documents[0], bankLine = bankLines.find(t=>t.id===executable.bankLine.id);
        const { rows: matches } = await client.query(`select matched_object_id, bank_transaction_id, status from reconciliation_matches
          where firm_id=$1 and client_id=$2 and (bank_transaction_id=any($3::text[]) or matched_object_id=$4)
          and status in ('confirmed','auto_matched','rejected')`, [firmId, clientId, selectedIds, documentId]);
        const consumed = matches.some(m => activeMatch(m.status) && (selectedIds.includes(m.bank_transaction_id) || !result.decision.plan.settlement_rows)
          || (m.status === 'rejected' && selectedIds.includes(m.bank_transaction_id) && m.matched_object_id === documentId));
        const freshCase = await readJevCase({ client, firmId, clientId, documentId, allowUnsupported:true, lockEvidence:true });
        const evidenceFresh = result.consumed_evidence
          ? hash(result.consumed_evidence) === hash(freshCase.caseEvidence)
          : Boolean(result.evidence_packet_sha256) && freshCase.prepared?.packet_sha256 === result.evidence_packet_sha256;
        const freshGroup=group ? planRefundGroup({document:freshCase.caseEvidence.documents.find(d=>d.id===documentId),transactions:bankLines}) : null;
        const rowPlansValid=!result.decision.plan.settlement_rows || result.decision.plan.allocations.every(a=>{
          const line=freshCase.caseEvidence.documents.find(d=>d.id===documentId)?.lines.find(l=>l.id===a.settlement_row?.line_id);
          const bank=bankLines.find(t=>t.id===a.transaction_id);
          return line && hash(line.settlement_row)===hash(a.settlement_row.settlement_row) && minor(line.amount)===a.amount_minor
            && bank?.eligible && bank.currency===document.currency && minor(bank.money_in)===a.amount_minor && !Number(bank.money_out);
        });
        const stillExact = rowPlansValid && (!group || freshGroup.ok && freshGroup.source_digest===group.source_digest && bankLines.every(t=>t.eligible))
          && evidenceFresh && document && bankLine && bankLine.eligible && !consumed && document.parse_status === 'completed' && !document.duplicate_of
          && document.document_type === result.document.document_type
          && document.currency === result.document.currency && minor(document.total_amount) === minor(result.document.total_amount)
          && bankLine.description === executable.bankLine.description && bankLine.currency === executable.bankLine.currency
          && minor(bankLine.money_in) === minor(executable.bankLine.money_in) && minor(bankLine.money_out) === minor(executable.bankLine.money_out);
        if (!stillExact) reason = 'jev_evidence_changed_before_write';
        else {
          const { rows: identities } = await client.query('select jurisdiction from clients where firm_id=$1 and id=$2', [firmId, clientId]);
          const policy = getAutoMatchPolicy({ jurisdiction: identities[0]?.jurisdiction || null });
          const authorization = applyMaterialAutoFyi(__jevReconciliation.authorize({ proposal: executable.proposal, bankLine, document, clientId, configSnapshot, policy,settlementRow:executable.settlementRow }), { clientId, configSnapshot });
          await __jevReconciliation.write({ client, firmId, clientId, proposal: executable.proposal, document,
            objectType: document.document_type === 'deposit_slip' ? 'deposit_slip' : family, matchAmount: executable.matchAmount, autoThreshold: null, authorization,
            returnedModel: result.model, source: `${family}_reconciliation_llm`, matchKind: family,
            configSnapshotId, stats, logTag: 'jevReconciliation',settlementRow:executable.settlementRow });
          const { rows: persisted } = await client.query(`select id, status, payload from reconciliation_matches
            where firm_id=$1 and client_id=$2 and bank_transaction_id=$3 and matched_object_id=$4 and matched_object_type=$5`,
          [firmId, clientId, bankLine.id, documentId, document.document_type === 'deposit_slip' ? 'deposit_slip' : family]);
          writerReceipt = persisted[0] || null;
          const plan = result.decision.plan, completion = heldPlanCompletionActs(configSnapshot);
          const firstWrote = activeMatch(writerReceipt?.status);
          const firstHeld = !firstWrote && heldForAuthority(writerReceipt, plan, completion);
          // Rows are each authorized, so under the completion flag every row is
          // written even when the first is held; each held row gets its own ask.
          // The group and the reminder wait for their first match's authority.
          let members = { complete: true, heldRows: 0 };
          if (firstWrote || (firstHeld && plan.settlement_rows)) members = await completePlanMembers({ client, firmId, clientId, documentId, plan, family,
            document, bankLines, firstId: bankLine.id, proposal: executable.proposal, authorization, policy, configSnapshot, configSnapshotId, stats,
            model: result.model, freshGroup, writerReceipt, allowHeldRows: completion });
          wrote = firstWrote && members.complete;
          held = !wrote && (firstHeld || (firstWrote && members.heldRows > 0));
          if (!wrote) reason = held ? 'jev_match_held_for_authority' : 'jev_writer_did_not_auto_reconcile';
        }
        await client.query(ownsTransaction ? 'commit' : 'release savepoint jev_reconciliation_write');
      } catch (error) {
        wrote=false; held=false; writerReceipt=null;
        for(const key of Object.keys(stats)) delete stats[key];
        Object.assign(stats,statsBeforeWrite);
        await client.query(ownsTransaction ? 'rollback' : 'rollback to savepoint jev_reconciliation_write');
        if (!ownsTransaction) await client.query('release savepoint jev_reconciliation_write');
        throw error;
      }
    }
  } catch (error) {
    // The family wrapper persists transport/configuration failures through the
    // existing provider-failure writer and retry clock. No model verdict exists.
    if (isProviderFailure(error)) throw error;
    // Returning the normal stats shape is load-bearing: the family wrappers
    // must never switch to weighted/strong semantics after an active Jev run.
    // A source the preparation contract cannot express (no issue or due date,
    // no currency) is deterministic: retrying unchanged data repeats it.
    reason = error?.code === 'already_settled' ? 'already_settled'
      : error?.code === 'incomplete_document' ? 'jev_source_incomplete' : 'jev_runtime_failed';
    stats.jev_error = error?.code || error?.message || 'Unknown Jev failure';
  }
  const terminal = result?.decision?.terminal || null;
  if(result && (!negativeAccepted || !NO_SETTLEMENT_OBLIGATION_TYPES.includes(result.document?.document_type))) await client.query(`update reconciliation_evaluations set verdict='superseded',evaluated_at=now()
    where firm_id=$1 and client_id=$2 and target_id=$3 and matcher_family='document_no_line_disposition'
      and verdict <> 'superseded'
      and payload->>'disposition'='no_settlement'`,[firmId,clientId,documentId]);
  await __jevReconciliation.record({ client, firmId, clientId, targetId: documentId,
    matcherFamily: family || 'supplier_bill', verdict: wrote || held ? 'proposed' : 'no_match', unmatchableReason: held ? null : reason,
    proposalCount: wrote || held ? 1 : 0, candidateCount: result?.candidates?.length || 0,
    eligibleCount: result?.candidates?.filter(t => t.eligible !== false).length || 0,
    model: result?.model || null, configSnapshotId, recordDecision: true, logTag: 'jevReconciliation',
    payload: { decision_engine: 'jev', preparation_contract: JEV_PREPARATION_CONTRACT, attempt_count: stats.jev_attempt_count || 1, evidence_packet_sha256: result?.evidence_packet_sha256 || null,
      next_action: wrote || held || negativeAccepted || reason === 'jev_source_incomplete' ? null : reason === 'jev_evidence_changed_before_write' ? 'reconsider_current_evidence' : terminal === 'abstain' ? 'reasoning' : 'retry_writer',
      failure_class: wrote || held || negativeAccepted ? null : reason === 'jev_source_incomplete' ? 'source_incomplete' : reason?.includes('unsupported') ? 'vocabulary_gap' : stats.jev_error ? 'technical_failure' : 'writer_refusal',
      selected_terminal: terminal, selected_plan: result?.decision?.plan || null,
      probability: result?.decision?.probability ?? null, validator_refusals: result?.decision?.refusals || [],
      execution: wrote ? 'existing_reconciliation_writer' : held ? 'held_for_authority' : 'not_applied', execution_reason: reason,
      writer_receipt: writerReceipt,
      usage: result?.usage || null, runtime_error: stats.jev_error || null,
      ...(result?.request_sha256s ? { request_sha256s: result.request_sha256s } : {}),
      ...(result?.jev_basis ? { jev_basis: result.jev_basis } : {}) } });
  if (terminal === 'abstain') {
    // This separate evaluation survives the final executor overwriting its
    // family verdict. It is the explicit, model-authored permission to hand off.
    const handoff = { terminal: 'needs_reasoning', selected: result.decision.selected,
      probability: result.decision.probability, model: result.model,
      reason: result.decision.limits?.contract_limit || 'selected_plan_needs_more_work',
      evidence_packet_sha256: result.evidence_packet_sha256 };
    const recorded = await __jevReconciliation.record({ client, firmId, clientId, targetId: documentId,
      matcherFamily: 'jev_first_decision', verdict: 'no_match', unmatchableReason: 'jev_needs_reasoning',
      model: result.model, configSnapshotId, recordDecision: true,
      payload: { decision_engine: 'jev', selected_terminal: 'needs_reasoning', handoff, jev_handoff: handoff, probability: handoff.probability } });
    if (!recorded) throw new Error('Jev handoff receipt could not be saved');
    stats.jev_handoff = handoff;
  }
  stats.jev_reason = reason;
  return stats;
}
