// Feed-chat action application — the writer side of the mass-command
// surface (feedChat.js). One firm click applies an action to its
// whole resolved set; every row funnels through the SAME single
// writers the drawer and the per-transaction chat use, so the #376
// reconciliation-layer stamp, the post step (#375), and the #358
// distiller all ride along per row. Nothing here is a new way to
// write a verdict — it is a loop around the existing ones.
//
// Per-row failures do not abort the batch: each row reports its own
// outcome and the action result carries the full receipt
// (applied/failed per transaction id). Dependencies are injectable
// for tests (the repo's mock-deps pattern).

import {
  queryFirmDb,
  withFirmDbClient,
  ensureTransactionReviewItemInDb,
  updateTransactionReviewItemInDb,
  postLedgerTransactionInDb,
  postLedgerAdjustmentInDb,
  getClientAccountingSystemFromDb,
  createClientEvidenceRequestInDb,
  deliverEvidenceAsksOnAllChannels,
  setTransactionAiEvidenceRequiredInDb,
  appendTransactionChatMessageInDb,
  saveMerchantRuleForPayload,
  appendXeroHistoryNoteForTransactionInDb,
  updateClientRuleStatusInDb,
  cancelClientEvidenceRequestInDb,
  amendClientEvidenceRequestInDb,
  resendClientEvidenceRequestInDb,
  DEFAULT_FIRM_ID
} from './firmDb.js';
import { readRetainedProcessingScopeInDb } from './runtimeReadinessAdmission.js';
import { validateCodingPolicyForChatActionInDb } from './db/coding.js';
import { findLedgerAccountByNameOrAlias } from './db/ledger.js';
import { legacyReviewStateFor } from './codingState.js';
import { attemptLedgerReclass } from './ledgerReclass.js';
import { getAccountingSystemAdapter } from './accountingSystems/index.js';
import { saveFirmFact, dismissFirmFact } from './firmFacts.js';
import { approveRoleGrant, revokeRoleGrant, offeredShapeForAction } from './roles/roleEmployment.js';
import { findRoleDefinition, roleForActionIdentity } from './roles/roleRegistry.js';
import { benchUiMode } from './roles/roleRoster.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { retryParseRunsInDb } from './parseDocumentsDb.js';
import { newTransactionChatMessageId } from './transactionChat.js';
import { FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES, FEED_CHAT_MAX_ACTION_TRANSACTIONS } from './feedChat.js';
import { factIsJurisdictionKnowledge, factRequestsAutonomy } from './operatorMemoryPolicy.js';
import {
  buildCorrectionTeachingReceipt,
  mergeCommittedLearning,
  validateCorrectionFieldsForApply
} from './correctionTeaching.js';
import { auditChatApplyEvent } from './chatApplySpine.js';
// G2 PR-14 — the capture half of "the reverse covers what the action taught, not just
// what it posted". The pure row shape lives beside the reverse builder that reads it,
// so the two can never drift (the discipline __matchBeforeAfter already keeps).
import { memoryMintBeforeAfterRow } from './reversePatch.js';

const badRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const DEFAULT_DEPS = {
  readRetainedProcessingScopeInDb,
  validateCodingPolicyForChatActionInDb,
  queryFirmDb,
  withFirmDbClient,
  ensureTransactionReviewItemInDb,
  updateTransactionReviewItemInDb,
  postLedgerTransactionInDb,
  postLedgerAdjustmentInDb,
  attemptLedgerReclass,
  getClientAccountingSystemFromDb,
  createClientEvidenceRequestInDb,
  deliverEvidenceAsksOnAllChannels,
  setTransactionAiEvidenceRequiredInDb,
  appendTransactionChatMessageInDb,
  saveMerchantRuleForPayload,
  saveFirmFact,
  dismissFirmFact,
  updateClientRuleStatusInDb,
  cancelClientEvidenceRequestInDb,
  amendClientEvidenceRequestInDb,
  resendClientEvidenceRequestInDb,
  retryParseRunsInDb,
  getAccountingSystemAdapter,
  appendXeroHistoryNoteForTransactionInDb,
  approveRoleGrant,
  revokeRoleGrant,
  readClientConfigSnapshot,
  benchUiMode
};

const actionTransactionIds = (action = {}) =>
  [...new Set((Array.isArray(action.transaction_ids) ? action.transaction_ids : []).map(String))]
    .slice(0, FEED_CHAT_MAX_ACTION_TRANSACTIONS);

// Shared per-row lookup: the open review item for a transaction —
// same SQL the per-transaction chat apply uses.
const findReviewItemId = async ({ d, firmId, clientId, transactionId }) => {
  const lookup = await d.queryFirmDb(
    `select id from transaction_review_queue
      where firm_id = $1 and client_id = $2
        and (payload->>'transaction_id' = $3 or item_id = $3)
      order by updated_at desc nulls last
      limit 1`,
    [firmId, clientId, transactionId]
  );
  return lookup.rows[0]?.id || null;
};

// Lookup + bare-line mint: when the transaction has no queue row (bare —
// confidently coded straight onto the transaction, never flagged by intel),
// mint the case-file row so the EXISTING writer can proceed. Returns
// { reviewItemId, minted }; reviewItemId null means the transaction itself
// doesn't exist for this (firm, client) — the honest error is
// transaction_not_found, not no_review_item.
const findOrMintReviewItemId = async ({ d, firmId, clientId, transactionId, source }) => {
  const existing = await findReviewItemId({ d, firmId, clientId, transactionId });
  if (existing) return { reviewItemId: existing, minted: false };
  const minted = await d.ensureTransactionReviewItemInDb({ firmId, clientId, transactionId, source });
  return { reviewItemId: minted, minted: Boolean(minted) };
};

const summarizeResults = (results = []) => ({
  requested: results.length,
  applied: results.filter((r) => r.applied).length,
  failed: results.filter((r) => !r.applied).length
});

// The autonomy/policy detector now lives in operatorMemoryPolicy.js
// (factRequestsAutonomy, imported above) so the proposal-time demotion in
// feedChat.__sanitizeFeedChatActions and the apply-time refusal below share ONE
// conservative copy and can never drift.

// ─── apply_category (batch) ──────────────────────────────────────────────

// Pod-safety #2 capture (feed-chat leg): the per-row writer captures the
// before/after of exactly the fields it mutates. The pairs are returned as a
// SIBLING `before_after` array on the batch outcome — never on the per-row
// result rows — so the persisted action result (and the HTTP receipt the FE
// renders) stays lean while the shadow hook can still put the capture on the
// proposal card. actorId rides into the writer so the per-row review audit
// records the operator, not 'system' (pod-safety #1, same as the drawer).
const applyCategoryBatch = async ({ firmId, clientId, action, actorId, messageId, actionIndex, surface, nativeMemberId, d }) => {
  if (!action.account_name) throw badRequest('apply_category requires account_name.');
  // G1d apply-time backstop (mirrors the factRequestsAutonomy dual guard):
  // the sanitizer demotes teaching-claiming correction fields at proposal
  // time; a stale/forged apply request is refused here so a correction can
  // never carry a scope its receipt would have to lie about.
  const correctionRefusal = validateCorrectionFieldsForApply(action);
  if (correctionRefusal) throw badRequest(correctionRefusal);
  const transactionIds = actionTransactionIds(action);
  if (!transactionIds.length) throw badRequest('apply_category requires at least one transaction_id.');

  // Resolve the account code ONCE for the whole batch — every row in
  // the set gets the same account by definition of the command.
  let accountCode = action.account_code || null;
  if (!accountCode) {
    accountCode = (await findLedgerAccountByNameOrAlias({
      query: d.queryFirmDb, firmId, clientId, name: action.account_name
    }))?.code || null;
  }
  const accountingSystem = String(
    (await d.getClientAccountingSystemFromDb({ firmId, clientId }).catch(() => 'none')) || 'none'
  );

  const results = [];
  const beforeAfter = [];
  for (const transactionId of transactionIds) {
    const row = { transaction_id: transactionId, applied: false, posting: null, error: null };
    try {
      const codingPolicyReceipt = await d.validateCodingPolicyForChatActionInDb({ firmId, clientId, transactionId, action });
      const { reviewItemId, minted } = await findOrMintReviewItemId({
        d, firmId, clientId, transactionId, source: 'feed_chat_apply'
      });
      if (!reviewItemId) {
        row.error = 'transaction_not_found';
        results.push(row);
        continue;
      }
      if (minted) row.review_item_minted = true;
      const patch = {
        coding_policy: codingPolicyReceipt,
        require_coding_policy: true,
        ...(action.native_choice ? { native_choice: action.native_choice, native_source: action.native_source_by_transaction?.[transactionId], account_id: action.account_id, proposed_account: action.account_name, account_code: action.account_code } : {}),
        status: 'accepted',
        review_state: 'accepted',
        category: action.account_name,
        account_name: action.account_name,
        account_label: action.account_name,
        ...(accountCode ? { account_code: accountCode, xero_account_code: accountCode } : {}),
        ...(action.tax_treatment
          ? { xero_tax_type: action.tax_treatment, tax_treatment: action.tax_treatment }
          : {}),
        ...(action.contact_name ? { contact: action.contact_name } : {})
        // No learn_rule here: rule minting from a mass command is the
        // separate remember_merchant action the firm applies (or
        // doesn't) on its own — one command must not mint N rules.
      };
      const writerResult = await d.updateTransactionReviewItemInDb({
        firmId,
        reviewItemId,
        patch,
        returnSnapshot: false,
        actorId,
        ...(action.native_choice ? { nativeCodingAuthority: { surface, messageId, actionIndex, memberId: nativeMemberId } } : {}),
        captureBeforeState: true
      });
      if (writerResult?.before_state && writerResult?.after_state) {
        beforeAfter.push({
          target: String(transactionId),
          before: writerResult.before_state,
          after: writerResult.after_state
        });
      }
      // W1 (S04/L3): the writer's committed learning rides the row so the
      // receipt below is derived from it, never from this surface's intent.
      row.learning = writerResult?.learning || null;
      row.review_item_id = reviewItemId;
      row.applied = true;

      // Persist the firm's free-text reason as a review note (#388
      // follow-up) so the artifact echoes the firm's OWN words ("all
      // NORTHWIND deposits are part of the loan…") instead of a generic
      // "Categorized by the firm". Same payload-merge as
      // leave_review_note; best-effort — the accept stands regardless.
      const reason = String(action.reason || '').trim();
      if (reason) {
        try {
          await d.queryFirmDb(
            `update transaction_review_queue
                set payload = payload || $3::jsonb,
                    updated_at = now()
              where firm_id = $1 and id = $2`,
            [firmId, reviewItemId, JSON.stringify({ reviewer_note: reason })]
          );
          row.reviewer_note = true;
        } catch (noteError) {
          row.note_error = noteError?.message || 'note persist failed';
        }
      }

      // The firm's evidence word, when stated ("invoice to follow" /
      // "bank line is enough"). Soft-fails: the accept stands.
      if (typeof action.evidence_owed === 'boolean') {
        try {
          await d.setTransactionAiEvidenceRequiredInDb({
            firmId,
            clientId,
            transactionId,
            evidenceRequired: action.evidence_owed,
            source: 'feed_chat',
            actorId
          });
          row.evidence_owed = action.evidence_owed;
        } catch (evidenceError) {
          row.evidence_error = evidenceError?.message || 'evidence stamp failed';
        }
      }

      // Same post step as row-Apply and the per-transaction chat
      // (#375): Donna-ledger clients post locally, connector clients
      // run the adapter writeback. Best-effort per row — a posting
      // failure rides the receipt, the accept stands.
      // An ALREADY-POSTED row must not blind-post (LEDGER_ALREADY_POSTED
      // 409, the Dadant split-state): the reclass helper completes the
      // recode with a delta adjustment when unambiguous, or reports the
      // honest pending state — never a swallowed 409.
      try {
        const scope = await d.readRetainedProcessingScopeInDb({ firmId,clientId });
        if (!scope.allowed) {
          row.posting = { step:'review_saved',status:'unavailable',reason:scope.reason_code,accounting_ready:false };
        } else if (accountingSystem === 'none') {
          const reclass = await d.attemptLedgerReclass({
            firmId,
            clientId,
            transactionId,
            newAccount: { name: action.account_name, code: accountCode },
            previousAccountName:
              writerResult?.prior_transaction_coding?.account_name || writerResult?.before_state?.account_name || writerResult?.before_state?.category || null,
            reason: reason || `Recode to ${action.account_name} via feed chat`,
            actorId,
            d: { queryFirmDb: d.queryFirmDb, postLedgerAdjustmentInDb: d.postLedgerAdjustmentInDb }
          });
          if (reclass.status === 'not_posted') {
            const posted = await d.postLedgerTransactionInDb({ firmId, clientId, transactionId, dryRun: false, actorId });
            row.posting = { step: 'ledger_post', status: posted?.ledger_posting?.status || 'posted' };
          } else if (reclass.status === 'reclassed') {
            row.posting = {
              step: 'ledger_reclass',
              status: 'posted',
              original_journal_id: reclass.original_journal_id,
              adjustment_journal_ids: (reclass.ledger_adjustment?.journals || []).map((j) => j.ledger_journal_id)
            };
          } else if (reclass.status === 'noop') {
            row.posting = { step: 'ledger_reclass', status: 'noop', original_journal_id: reclass.original_journal_id };
          } else {
            row.posting = {
              step: 'ledger_adjustment_required',
              status: 'pending',
              original_journal_id: reclass.original_journal_id || null,
              reason: reclass.reason || null
            };
          }
        } else {
          const adapter = d.getAccountingSystemAdapter(accountingSystem);
          const written = await adapter.writebackTransaction({ firmId, clientId, transactionId, dryRun: false, actorId });
          row.posting = { step: 'writeback', status: written?.xero_writeback?.status || 'synced' };
        }
      } catch (postError) {
        row.posting = { step: 'post', status: 'error', error: postError?.message || 'Posting failed.' };
      }
    } catch (err) {
      row.error = err?.message || 'apply_failed';
    }
    results.push(row);
  }
  const summary = summarizeResults(results);
  return {
    result: {
      action_type: 'apply_category',
      account_name: action.account_name,
      account_code: accountCode,
      ...(typeof action.evidence_owed === 'boolean' ? { evidence_owed: action.evidence_owed } : {}),
      ...summary,
      results,
      // The correction≠teaching receipt (G1d): this surface mints no
      // rule or fact (the loop above deliberately never sets learn_rule)
      // and no correction surface has a signal path since §7.6
      // (2026-08-14) — the receipt states the full negative from its own
      // writer outcomes, identical on both chat surfaces.
      teaching: buildCorrectionTeachingReceipt({
        action,
        changedCount: summary.applied,
        // W1 (S04/L3): from the writers' COMMITTED learning, never intent.
        committed: mergeCommittedLearning(results.map((row) => row.learning))
      })
    },
    before_after: beforeAfter
  };
};

// ─── ask_client (batch) ──────────────────────────────────────────────────

const askClientBatch = async ({ firmId, clientId, action, actorId, d }) => {
  if (!action.question) throw badRequest('ask_client requires question.');
  const transactionIds = actionTransactionIds(action);
  if (!transactionIds.length) throw badRequest('ask_client requires at least one transaction_id.');
  const evidenceType = action.evidence_type || 'business_purpose';

  const results = [];
  for (const transactionId of transactionIds) {
    const row = { transaction_id: transactionId, applied: false, error: null };
    try {
      const evidenceResult = await d.createClientEvidenceRequestInDb({
        firmId,
        clientId,
        transactionId,
        question: action.question,
        evidenceType,
        actorId,
        returnSnapshot: false
      });
      row.evidence_request_id = evidenceResult?.evidence_request?.id || null;
      // G2 PR-14: did this row MINT the ask, or collapse onto a live one for the same
      // anchor (the F-19 id is deterministic, so a second ask about one line is one
      // row)? The reverse leg may only cancel what this apply actually opened.
      row.evidence_request_minted = evidenceResult?.minted ?? null;
      row.applied = true;
      // Mirror the question into the row's own case file so opening
      // the transaction artifact shows what was asked. Best-effort.
      try {
        await d.appendTransactionChatMessageInDb({
          firmId,
          clientId,
          transactionId,
          id: newTransactionChatMessageId({ transactionId, kind: 'user' }),
          role: 'user',
          content: action.question,
          payload: {
            kind: 'client_question_sent',
            evidence_request_id: row.evidence_request_id,
            evidence_type: evidenceType,
            source: 'feed_chat'
          },
          actorType: 'firm'
        });
      } catch {
        // Case-file mirror is cosmetic; the evidence request stands.
      }
    } catch (err) {
      row.error = err?.message || 'ask_failed';
    }
    results.push(row);
  }

  // Channel fan-out for the asks that minted — the SAME deliverers the
  // ask-batch send runs, each self-gating (binding / env / config-plane flag),
  // so an unbound or dark channel is an internal no-op. Before this, a firm
  // chat ask stopped at the DB and reached the owner only when they next
  // opened the portal (audit §4). Fail-soft: a fan-out failure never unwinds
  // the minted asks, it just shows on the receipt.
  // De-duplicated: the F-19 anchor-deterministic ids mean two rows can
  // legitimately collapse onto one open request, which must not be delivered
  // twice in one fan-out.
  const mintedIds = [...new Set(results.filter((row) => row.applied && row.evidence_request_id).map((row) => row.evidence_request_id))];
  let channelFanout = null;
  if (mintedIds.length) {
    channelFanout = await d.withFirmDbClient((client) =>
      d.deliverEvidenceAsksOnAllChannels({ client, firmId, clientId, evidenceRequestIds: mintedIds })
    ).catch((err) => ({ error: err?.message || 'fanout_failed' }));
  }

  return {
    action_type: 'ask_client',
    evidence_type: evidenceType,
    channel_fanout: channelFanout,
    ...summarizeResults(results),
    results
  };
};

// ─── leave_review_note (batch) ───────────────────────────────────────────

const leaveReviewNoteBatch = async ({ firmId, clientId, action, actorId = 'system', d }) => {
  if (!action.note) throw badRequest('leave_review_note requires a note.');
  const transactionIds = actionTransactionIds(action);
  if (!transactionIds.length) throw badRequest('leave_review_note requires at least one transaction_id.');

  const results = [];
  for (const transactionId of transactionIds) {
    const row = { transaction_id: transactionId, applied: false, error: null };
    try {
      // NO bare-line mint here, deliberately: a note is commentary, not a
      // decision — minting an OPEN 'suggested' row from it would manufacture
      // a hanging queue row (and could visually un-terminalize an
      // auto-explained bare line). Coding doors mint because their writer
      // immediately terminalizes the row; a note on a bare line stays an
      // honest no_review_item.
      const reviewItemId = await findReviewItemId({ d, firmId, clientId, transactionId });
      if (!reviewItemId) {
        row.error = 'no_review_item';
        results.push(row);
        continue;
      }
      await d.queryFirmDb(
        `update transaction_review_queue
            set payload = payload || $3::jsonb,
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, reviewItemId, JSON.stringify({
          reviewer_note: action.note,
          ...(action.follow_up_at ? { follow_up_at: action.follow_up_at } : {})
        })]
      );
      // #4 audit half: the spine emitter. bestEffort: false keeps this site's
      // existing semantics — an audit failure marks the row failed via the
      // per-row catch, same as before the convergence.
      await auditChatApplyEvent({
        query: d.queryFirmDb,
        firmId,
        clientId,
        actorId,
        action: 'review.note_added',
        resourceType: 'transaction_review',
        resourceId: reviewItemId,
        metadata: {
          note: action.note,
          follow_up_at: action.follow_up_at || null,
          source: 'feed_chat'
        },
        bestEffort: false
      });
      row.review_item_id = reviewItemId;
      row.applied = true;
      // G7 best-effort: mirror the firm note into the Xero BankTransaction's
      // History & Notes when the row is already synced (no-op if unsynced). The
      // saved review note is the source of truth; the Xero note is enrichment.
      try {
        if (d.appendXeroHistoryNoteForTransactionInDb) {
          await d.appendXeroHistoryNoteForTransactionInDb({
            firmId,
            clientId,
            transactionId,
            note: `Firm note: ${action.note}`
          });
        }
      } catch {
        // audit note is best-effort; never fail the saved review note on it
      }
    } catch (err) {
      row.error = err?.message || 'note_failed';
    }
    results.push(row);
  }
  return {
    action_type: 'leave_review_note',
    ...summarizeResults(results),
    results
  };
};

// ─── mark_evidence_owed (batch) ────────────────────────────────────────────

// A pure STATE correction: flip the set to "Waiting evidence" via the SAME
// trusted evidence writer apply_category uses for the firm's "invoice to follow"
// word. It ONLY stamps the evidence flag — it does NOT code, post, match, or
// reconcile (no review-item write, no ledger post, no reconciliation touch).
const markEvidenceOwedBatch = async ({ firmId, clientId, action, actorId, d }) => {
  const transactionIds = actionTransactionIds(action);
  if (!transactionIds.length) throw badRequest('mark_evidence_owed requires at least one transaction_id.');

  const results = [];
  for (const transactionId of transactionIds) {
    const row = { transaction_id: transactionId, applied: false, error: null };
    try {
      await d.setTransactionAiEvidenceRequiredInDb({
        firmId,
        clientId,
        transactionId,
        evidenceRequired: true,
        source: 'feed_chat',
        actorId
      });
      row.evidence_owed = true;
      row.applied = true;
    } catch (err) {
      row.error = err?.message || 'evidence_owed_failed';
    }
    results.push(row);
  }
  return {
    action_type: 'mark_evidence_owed',
    evidence_owed: true,
    ...summarizeResults(results),
    results
  };
};

// ─── sync_to_accounting (batch) ────────────────────────────────────────────

// POST a set of already-DECIDED rows to the client's accounting system (Xero/
// QBO) or the Donna ledger — the standalone "sync to Xero" verb. It is the post
// step from apply_category, lifted out: NO coding, matching, or state change
// beyond the post. POST-ACCEPTED-ONLY (the firm's choice): a row posts only when
// it is already accepted/resolved AND not already synced/posted; every other row
// is SKIPPED with a reason (not_accepted / already_synced / not_found) and
// reported back, never force-posted. Routes through the SAME writers the per-row
// Apply and apply_category's post step use — one writer, no new verdict.
const syncToAccountingBatch = async ({ firmId, clientId, action, actorId = 'system', d }) => {
  const transactionIds = actionTransactionIds(action);
  if (!transactionIds.length) throw badRequest('sync_to_accounting requires at least one transaction_id.');
  const accountingSystem = String(
    (await d.getClientAccountingSystemFromDb({ firmId, clientId }).catch(() => 'none')) || 'none'
  );

  const results = [];
  for (const transactionId of transactionIds) {
    const row = { transaction_id: transactionId, applied: false, posting: null, error: null };
    try {
      // The post gate reads the row's OWN persisted state (render the persisted
      // verdict): only an accepted/resolved row that is not already synced is
      // eligible. A suggested / awaiting-evidence row is skipped, not posted.
      // RT-16: the ONE coding state, projected to the legacy label this
      // gate speaks (the transaction status is the fallback wording).
      const stateRow = await d.queryFirmDb(
        `select coalesce(coding_state, status, '') as review_state,
                coalesce(payload->>'xero_writeback_status', payload->>'xero_sync_status', '') as sync_status,
                coalesce(payload->>'xero_bank_transaction_id', '') as xero_id
           from transactions
          where firm_id = $1 and client_id = $2 and id = $3
          limit 1`,
        [firmId, clientId, transactionId]
      );
      const stateInfo = stateRow.rows[0];
      if (!stateInfo) {
        row.skipped = true;
        row.error = 'not_found';
        results.push(row);
        continue;
      }
      const reviewState = legacyReviewStateFor(stateInfo.review_state) || String(stateInfo.review_state || '').toLowerCase();
      const alreadySynced =
        stateInfo.sync_status === 'synced' || String(stateInfo.xero_id || '').length > 0;
      if (alreadySynced || reviewState === 'synced' || reviewState === 'posted') {
        row.skipped = true;
        row.error = 'already_synced';
        results.push(row);
        continue;
      }
      if (reviewState !== 'accepted' && reviewState !== 'resolved') {
        row.skipped = true;
        row.error = 'not_accepted';
        results.push(row);
        continue;
      }

      // Same post step as row-Apply and apply_category (#375): Donna-ledger
      // clients post locally; connector clients run the adapter writeback.
      if (accountingSystem === 'none') {
        const posted = await d.postLedgerTransactionInDb({ firmId, clientId, transactionId, dryRun: false, actorId });
        row.posting = { step: 'ledger_post', status: posted?.ledger_posting?.status || 'posted' };
      } else {
        const adapter = d.getAccountingSystemAdapter(accountingSystem);
        const written = await adapter.writebackTransaction({ firmId, clientId, transactionId, dryRun: false, actorId });
        row.posting = { step: 'writeback', status: written?.xero_writeback?.status || 'synced' };
      }
      row.applied = true;
    } catch (err) {
      row.error = err?.message || 'sync_failed';
      if (err?.code === 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE') { row.code = err.code; row.retryable = false; }
    }
    results.push(row);
  }

  const applied = results.filter((r) => r.applied).length;
  const skipped = results.filter((r) => !r.applied && r.skipped).length;
  const failed = results.filter((r) => !r.applied && !r.skipped).length;
  return {
    action_type: 'sync_to_accounting',
    accounting_system: accountingSystem,
    requested: results.length,
    applied,
    skipped,
    failed,
    results
  };
};

// ─── remember_merchant ───────────────────────────────────────────────────

const rememberMerchant = async ({ firmId, clientId, action, actorId, d }) => {
  if (!action.account_name) throw badRequest('remember_merchant requires account_name.');
  if (!action.merchant_pattern) throw badRequest('remember_merchant requires merchant_pattern.');
  // Optional anchor row — gives the rule writer a real description to
  // canonicalise against when one was matched.
  const anchorId = actionTransactionIds(action)[0] || null;
  let anchorTx = null;
  if (anchorId) {
    const txRow = await d.queryFirmDb(
      'select id, description, raw_description from transactions where firm_id = $1 and client_id = $2 and id = $3 limit 1',
      [firmId, clientId, anchorId]
    );
    anchorTx = txRow.rows[0] || null;
  }
  const writerPayload = {
    merchant_pattern: action.merchant_pattern,
    description: anchorTx?.description || '',
    raw_description: anchorTx?.raw_description || '',
    account_code: action.account_code || action.account_name,
    proposed_account: action.account_name,
    account_name: action.account_name,
    account_label: action.account_name,
    xero_tax_type: action.tax_treatment || null,
    tax_treatment: action.tax_treatment || null,
    contact: action.contact_name || null
  };
  const rule = await d.withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      // Pod-safety #1 + the #4 audit half: the writer now emits the mint's
      // audit row inside THIS transaction (audit-as-precondition — a failed
      // audit rolls the rule back), with the spine-attributed operator on it.
      const saved = await d.saveMerchantRuleForPayload({
        client,
        firmId,
        clientId,
        transactionId: anchorTx?.id || null,
        payload: writerPayload,
        supportNote: action.reason || '',
        source: 'feed_chat_remember_merchant',
        actorId
      });
      await client.query('commit');
      return saved;
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
  if (!rule) {
    return {
      action_type: 'remember_merchant',
      applied: 0,
      requested: 0,
      failed: 0,
      skipped_reason: 'merchant_pattern_unusable'
    };
  }
  return {
    action_type: 'remember_merchant',
    requested: 1,
    applied: 1,
    failed: 0,
    rule_id: rule.ruleId,
    // G2 PR-14: did this apply CREATE the rule, or re-teach one that already existed?
    // The reverse may only retire a rule the reversed action brought into being.
    rule_inserted: rule.inserted ?? null,
    merchant_pattern: rule.rulePayload?.merchant_pattern || action.merchant_pattern,
    account_name: action.account_name,
    cascade: rule.cascadeResult || null
  };
};

// ─── remember_fact ───────────────────────────────────────────────────────

// Record a durable LOCAL fact in the firm's cross-entity memory
// (firm_facts, Layer 2) so it informs FUTURE proposals. Mirrors
// remember_merchant: appliable without a row set, wraps the single
// writer (saveFirmFact) in a transaction, soft-reports an unusable
// fact. The triggering rows + the firm's reason ride along as
// provenance, so the mint is auditable back to the command that made
// it. model='firm_operator' marks the fact as a DIRECT human assertion
// (not a distiller's output) — the model-id-is-the-receipt rail.
const rememberFact = async ({ firmId, clientId, action, messageId, d }) => {
  if (!action.fact_text) throw badRequest('remember_fact requires fact_text.');
  if (!action.fact_scope) throw badRequest('remember_fact requires fact_scope.');
  if (!action.fact_subject) throw badRequest('remember_fact requires fact_subject.');
  // The apply-time autonomy backstop — the FINAL guard. The proposal-time
  // sanitizer normally demotes such an action to a non-appliable future_action
  // before it ever reaches here; this still refuses a stale/forged request.
  if (factRequestsAutonomy(action)) {
    throw badRequest(
      'remember_fact stores judgment memory, not autonomy or policy. Changing auto-apply, ' +
      'stopping the ask flow, or posting unattended is a policy decision — it cannot be saved as a fact.'
    );
  }
  if (factIsJurisdictionKnowledge(action)) {
    throw badRequest(
      'remember_fact stores memory about a business, a client or a merchant. A rule for a whole ' +
      'jurisdiction is general tax or accounting knowledge: it belongs in the reviewed country ' +
      'policy and cannot be saved as a fact.'
    );
  }
  const transactionIds = actionTransactionIds(action);
  const provenance = {
    source: 'feed_chat_remember_fact',
    client_id: clientId,
    message_id: messageId || null,
    transaction_ids: transactionIds,
    operator_note: String(action.reason || '').slice(0, 300) || null
  };
  const fact = await d.withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const saved = await d.saveFirmFact({
        client,
        firmId,
        scope: action.fact_scope,
        subject: action.fact_subject,
        fact: action.fact_text,
        confidence: action.fact_confidence || 'medium',
        provenance,
        model: 'firm_operator',
        // W1 (INV-03): remember_fact IS the explicit teaching action — the one
        // chat verb that may activate a fact. The writer refuses without it.
        teach: 'explicit'
      });
      await client.query('commit');
      return saved;
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
  if (!fact) {
    return {
      action_type: 'remember_fact',
      requested: 0,
      applied: 0,
      failed: 0,
      skipped_reason: 'fact_unusable'
    };
  }
  if (fact.blocked_by_erasure) {
    // The restore-after-erasure rail (G1c): this exact content was erased
    // ("delete this personal information") and may never re-mint. An honest
    // skip, named as what it is — never 'fact_unusable'.
    return {
      action_type: 'remember_fact',
      requested: 1,
      applied: 0,
      failed: 0,
      skipped_reason: 'blocked_by_erasure'
    };
  }
  return {
    action_type: 'remember_fact',
    requested: 1,
    applied: 1,
    failed: 0,
    fact_id: fact.id,
    scope: fact.scope,
    subject: fact.subject,
    confidence: fact.confidence,
    status: fact.status,
    already_present: fact.inserted === false,
    // Surface the provenance that was ALREADY persisted on the fact above
    // (provenance jsonb) so the apply receipt can prove the mint back to the
    // operator's own words and the count of rows in view at mint time. Pure
    // render-the-persisted-verdict: both values were written, not invented here.
    operator_note: provenance.operator_note,
    transaction_count: transactionIds.length
  };
};

// ─── forget_fact ("stop using") ──────────────────────────────────────────

// Dismiss ONE firm fact — the inverse of remember_fact (G1c / build-spec
// PR-10). Routes to the SAME tombstone writer the settings governance route
// uses (dismissFirmFact, INV-1), which now emits the in-transaction
// `firm_fact.dismissed` audit with the spine-attributed actor. INV-4: the
// fact is re-read server-side at apply time — the sanitizer's known_facts
// demotion keeps dead Apply buttons off the card, but the writer-side state
// is what decides. An already-inactive fact reports skipped, never a silent
// no-op and never a forced flip.
const forgetFact = async ({ firmId, action, actorId, d }) => {
  if (!action.fact_id) throw badRequest('forget_fact requires fact_id.');
  const factId = String(action.fact_id);
  return d.withFirmDbClient(async (client) => {
    await client.query('begin');
    try {
      const existing = await client.query(
        'select id, scope, subject, status from firm_facts where firm_id = $1 and id = $2',
        [firmId, factId]
      );
      const row = existing.rows[0] || null;
      if (!row || row.status !== 'active') {
        await client.query('rollback');
        return {
          action_type: 'forget_fact',
          requested: 1,
          applied: 0,
          failed: 0,
          fact_id: factId,
          skipped_reason: row ? `not_active_${row.status}` : 'fact_not_found'
        };
      }
      const dismissed = await d.dismissFirmFact({
        client,
        firmId,
        factId,
        actorId,
        reason: action.reason || null,
        source: 'feed_chat_forget_fact'
      });
      await client.query('commit');
      return {
        action_type: 'forget_fact',
        requested: 1,
        applied: dismissed ? 1 : 0,
        failed: dismissed ? 0 : 1,
        fact_id: factId,
        scope: row.scope,
        subject: row.subject,
        status: dismissed ? 'dismissed' : row.status
      };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
};

// ─── retire_rule ─────────────────────────────────────────────────────────

// Retire ONE of this client's ACTIVE rules — the inverse of
// remember_merchant (G1c). Routes to the EXISTING rule-status writer's
// explicit active→retired transition (updateClientRuleStatusInDb with
// allowActiveRetire — the "later PR" its comment named; INV-1, no new
// writer), which emits `client_rule.retired` with the actor in its own
// transaction. The pre-read pins the rule to THIS client (the feed chat is
// client-scoped; a rule id from another book reports rule_not_found, never
// a cross-client write) and reports an already-retired rule as skipped; the
// writer re-verifies the status under its own lock at write time (INV-4).
const retireRule = async ({ firmId, clientId, action, actorId, d }) => {
  if (!action.rule_id) throw badRequest('retire_rule requires rule_id.');
  const ruleId = String(action.rule_id);
  const lookup = await d.queryFirmDb(
    'select id, status, pattern_text, account_code from client_rules where firm_id = $1 and client_id = $2 and id = $3',
    [firmId, clientId, ruleId]
  );
  const rule = lookup.rows[0] || null;
  if (!rule || (rule.status !== 'active' && rule.status !== 'proposed')) {
    return {
      action_type: 'retire_rule',
      requested: 1,
      applied: 0,
      failed: 0,
      rule_id: ruleId,
      skipped_reason: rule ? `not_retirable_${rule.status}` : 'rule_not_found'
    };
  }
  const result = await d.updateClientRuleStatusInDb({
    firmId,
    ruleId,
    nextStatus: 'retired',
    decidedBy: actorId,
    allowActiveRetire: true,
    actorId
  });
  return {
    action_type: 'retire_rule',
    requested: 1,
    applied: 1,
    failed: 0,
    rule_id: ruleId,
    prior_status: result.prior_status,
    status: result.next_status,
    merchant_pattern: rule.pattern_text || null,
    account_code: rule.account_code || null
  };
};

// ─── cancel_ask ──────────────────────────────────────────────────────────

// Close ONE live owner ask (G1b / build-spec PR-9). Routes to the new
// cancelClientEvidenceRequestInDb writer — new because `'cancelled'` was a
// DEAD enum value: migration 009's CHECK has always admitted it and two
// readers already depend on its meaning, but nothing ever wrote it (see the
// plan's §5 G1b audit). The writer refuses an already-ANSWERED ask and emits
// `evidence_request.cancelled` in-transaction with the actor.
//
// The receipt carries the two-terminal-states cost. Cancelling takes the line
// OFF the owner without auto-reconciling it, so unless the row is already
// coded (or still carries another live ask) it returns to HANGING — resting
// on neither of the two sanctioned terminals. The FIRST principle says that is
// a violation to SURFACE, not to hide, so `leaves_line_hanging` rides the
// receipt rather than being glossed as "done". The writer computes it (one
// owner, identical on both chat surfaces); this handler passes it through.
const cancelAsk = async ({ firmId, clientId, action, actorId, d }) => {
  if (!action.ask_id) throw badRequest('cancel_ask requires ask_id.');
  const askId = String(action.ask_id);
  const outcome = await d.cancelClientEvidenceRequestInDb({
    firmId,
    clientId,
    evidenceRequestId: askId,
    reason: action.reason || '',
    actorId
  });
  if (!outcome.cancelled) {
    return {
      action_type: 'cancel_ask',
      requested: 1,
      applied: 0,
      failed: 0,
      ask_id: askId,
      status: outcome.status,
      skipped_reason: outcome.skipped_reason
    };
  }

  return {
    action_type: 'cancel_ask',
    requested: 1,
    applied: 1,
    failed: 0,
    ask_id: askId,
    transaction_id: outcome.transaction_id,
    prior_status: outcome.prior_status,
    status: outcome.status,
    question: outcome.question,
    // The writer computes this once for every surface: true → the line now
    // rests on NEITHER terminal; false → coded or still carrying another live
    // ask; null → no anchor / the state read failed.
    leaves_line_hanging: outcome.leaves_line_hanging ?? null
  };
};

// ─── amend_ask ───────────────────────────────────────────────────────────

// Amend ONE already-SENT owner ask (§7.2's dated call, 2026-08-14): no
// silent edit — the writer preserves the original as the head of the
// composite question and appends the marked amendment; a draft refuses
// (rewording a draft is the asks tab's editor), an answered ask refuses
// (the owner did their part). One writer, both chat surfaces.
const amendAsk = async ({ firmId, clientId, action, actorId, d }) => {
  if (!action.ask_id) throw badRequest('amend_ask requires ask_id.');
  if (!action.amendment_text) throw badRequest('amend_ask requires amendment_text.');
  const askId = String(action.ask_id);
  const outcome = await d.amendClientEvidenceRequestInDb({
    firmId,
    clientId,
    evidenceRequestId: askId,
    amendmentText: String(action.amendment_text),
    reason: action.reason || '',
    actorId
  });
  if (!outcome.amended) {
    return {
      action_type: 'amend_ask',
      requested: 1,
      applied: 0,
      failed: 0,
      ask_id: askId,
      status: outcome.status,
      skipped_reason: outcome.skipped_reason
    };
  }
  return {
    action_type: 'amend_ask',
    requested: 1,
    applied: 1,
    failed: 0,
    ask_id: askId,
    transaction_id: outcome.transaction_id,
    status: outcome.status,
    question: outcome.question,
    prior_question: outcome.prior_question,
    amendment_count: outcome.amendment_count
  };
};

// ─── resend_ask ──────────────────────────────────────────────────────────

// Re-deliver ONE already-open owner ask (G1b). NO new writer (INV-1): the
// orchestrator routes to deliverEvidenceAsksOnAllChannels — the SAME one ask
// fan-out ask_client uses — which is also what makes minting a duplicate ask
// structurally impossible (the KUILI rule). The fan-out names the asks a
// deliverer delivered — the same ones whose send_count it bumped, only on a
// genuinely successful send — so `delivered: false` means every channel was
// dark or refused, never a silent "sent". A draft, replied, or closed ask
// reports skipped.
const resendAsk = async ({ firmId, clientId, action, actorId, d }) => {
  if (!action.ask_id) throw badRequest('resend_ask requires ask_id.');
  const askId = String(action.ask_id);
  const outcome = await d.resendClientEvidenceRequestInDb({
    firmId,
    clientId,
    evidenceRequestId: askId,
    reason: action.reason || '',
    actorId
  });
  if (!outcome.resent) {
    return {
      action_type: 'resend_ask',
      requested: 1,
      applied: 0,
      failed: 0,
      ask_id: askId,
      status: outcome.status,
      skipped_reason: outcome.skipped_reason
    };
  }
  return {
    action_type: 'resend_ask',
    requested: 1,
    // A resend that reached no channel is NOT applied — the action stays
    // proposed so the firm sees that nothing actually left, rather than a
    // green tick over an undelivered nudge.
    applied: outcome.delivered ? 1 : 0,
    failed: outcome.delivered ? 0 : 1,
    ask_id: askId,
    transaction_id: outcome.transaction_id,
    status: outcome.status,
    question: outcome.question,
    delivered: outcome.delivered,
    prior_send_count: outcome.prior_send_count,
    send_count: outcome.send_count,
    channel_fanout: outcome.channel_fanout,
    previously_escalated_to_firm: outcome.previously_escalated_to_firm,
    ...(outcome.delivered ? {} : { skipped_reason: 'no_channel_delivered' })
  };
};

// ─── retry_parse (batch, remedial) ───────────────────────────────────────

// Re-queue the parse of each row's matched document. The feed grammar is
// transaction_id-based but the parse-requeue targets a DOCUMENT, so this
// resolves the matched document per row server-side (the active reconciliation
// match — anti-self-licensing, never the model's word for which doc) and calls
// the EXISTING retryParseRunsInDb writer (INV-1) per row. The writer re-verifies
// the retryable state at write time (INV-4): a document no longer in a
// failed/duplicate_pending state is reported back as skipped, never force-run.
// Per-row failures don't abort the batch; all-rows-skipped returns applied: 0 so
// the action stays proposed (the route keeps it so the firm sees why).
const retryParseBatch = async ({ firmId, action, d }) => {
  const transactionIds = actionTransactionIds(action);
  if (!transactionIds.length) throw badRequest('retry_parse requires at least one transaction_id.');

  const results = [];
  for (const transactionId of transactionIds) {
    const row = { transaction_id: transactionId, applied: false, document_id: null, error: null };
    try {
      // Resolve the active reconciliation match for this row → its matched
      // document. Same status priority the per-transaction surface uses;
      // suggested/auto_matched/confirmed all count as "this row has a doc".
      const matchLookup = await d.queryFirmDb(
        `select matched_object_id
           from reconciliation_matches
          where firm_id = $1 and bank_transaction_id = $2
            and status in ('confirmed', 'auto_matched', 'suggested')
          order by case status
                     when 'confirmed' then 1
                     when 'auto_matched' then 2
                     when 'suggested' then 3
                   end
          limit 1`,
        [firmId, transactionId]
      );
      const matchedDocId = matchLookup.rows[0]?.matched_object_id || null;
      if (!matchedDocId) {
        row.error = 'no_matched_document';
        results.push(row);
        continue;
      }
      row.document_id = matchedDocId;
      const retryResult = await d.retryParseRunsInDb({ firmId, documentIds: [matchedDocId] });
      const retried = retryResult?.retried?.[0] || null;
      if (retried) {
        row.applied = true;
        row.parse_run_id = retried.parse_run_id || null;
        row.parse_status = retried.parse_status || 'pending';
      } else {
        // The writer re-verified and refused (not in a retryable state, or the
        // status changed under us). Surface the observed reason; the row stays
        // not-applied rather than a silent no-op.
        const skip = retryResult?.skipped?.[0] || null;
        row.skipped = skip || { reason: 'not_retryable' };
        row.error = skip?.reason || 'not_retryable';
      }
    } catch (err) {
      row.error = err?.message || 'retry_failed';
    }
    results.push(row);
  }
  return {
    action_type: 'retry_parse',
    ...summarizeResults(results),
    results
  };
};

// ─── approve_role_grant / revoke_role_grant (standing authority) ─────────

// The owner's employment-contract acts, moved into chat (team-screen recede,
// Kari 2026-08-14). Both route to the S2 roleEmployment writers (INV-1) in
// ONE transaction, both require the bench flag ACTING for the venture (the
// same gate the roster's owner routes run), and both pass actorType 'owner'
// with the spine-attributed actorId — the writers' own guards (owner actor,
// active hire, shape offered, authority ⊆ leash, time bound, store mint
// rules) all re-verify at write time. Capability class is founder-only
// (operatorCapability): a scoped reviewer may never widen a teammate's
// authority.

const GRANT_REVIEW_AFTER_DAYS = 90;

const requireActingBench = async ({ client, firmId, clientId, d }) => {
  const snapshot = await d.readClientConfigSnapshot(client, { firmId, clientId });
  if (d.benchUiMode({ snapshot }) !== 'act') {
    const err = new Error('The team surface is not enabled for this venture.');
    err.statusCode = 403;
    throw err;
  }
};

const approveRoleGrantAction = async ({ firmId, clientId, action, actorId, d }) => {
  const grantAction = String(action.grant_action || '');
  const roleId = roleForActionIdentity(grantAction);
  const role = roleId ? findRoleDefinition(roleId) : null;
  if (!role) throw badRequest('approve_role_grant: grant_action is not a teammate\'s delegable verb.');
  const grantShape = offeredShapeForAction(role, grantAction);
  if (!grantShape) throw badRequest(`approve_role_grant: role '${role.id}' offers no grant shape covering '${grantAction}'.`);
  const scopeKey = String(action.grant_scope_key || '').trim();
  if (!scopeKey) throw badRequest('approve_role_grant requires grant_scope_key (the counterparty it covers).');
  const ceiling = Number(action.grant_ceiling);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw badRequest('approve_role_grant requires a positive grant_ceiling.');
  const currency = String(action.grant_currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('approve_role_grant requires a 3-letter grant_currency.');
  const reviewAfter = new Date(Date.now() + GRANT_REVIEW_AFTER_DAYS * 86_400_000).toISOString();

  return d.withFirmDbClient(async (client) => {
    await requireActingBench({ client, firmId, clientId, d });
    await client.query('begin');
    try {
      const out = await d.approveRoleGrant(client, {
        firmId, clientId, roleId: role.id, grantShape,
        actionType: grantAction, scopeKey,
        amountCeiling: ceiling, currency,
        reviewAfter,
        actorType: 'owner', actorId,
        reason: action.reason || null
      });
      await client.query('commit');
      return {
        action_type: 'approve_role_grant',
        requested: 1,
        applied: 1,
        failed: 0,
        grant_id: out.grant_id,
        role_id: role.id,
        grant_action: grantAction,
        scope_key: scopeKey,
        amount_ceiling: ceiling,
        currency,
        review_after: reviewAfter
      };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
};

const revokeRoleGrantAction = async ({ firmId, clientId, action, actorId, d }) => {
  const grantId = String(action.grant_id || '');
  if (!grantId) throw badRequest('revoke_role_grant requires grant_id.');
  return d.withFirmDbClient(async (client) => {
    await requireActingBench({ client, firmId, clientId, d });
    await client.query('begin');
    try {
      const out = await d.revokeRoleGrant(client, {
        firmId, clientId, grantId,
        actorType: 'owner', actorId,
        reason: action.reason || null
      });
      await client.query('commit');
      if (!out.revoked) {
        return {
          action_type: 'revoke_role_grant',
          requested: 1,
          applied: 0,
          failed: 0,
          grant_id: grantId,
          skipped_reason: 'not_found_or_already_revoked'
        };
      }
      return {
        action_type: 'revoke_role_grant',
        requested: 1,
        applied: 1,
        failed: 0,
        grant_id: grantId,
        role_id: out.role_id || null
      };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
};

// ─── Mint capture (G2 PR-14) ─────────────────────────────────────────────

// The TAUGHT/ASKED half of the reverse capture: one before_after row per object this
// apply minted, so `reverseAppliesInDb` can plan the dismiss / retire / cancel through
// that object's own governed writer. Rides the SIBLING `before_after` array, exactly
// like the coding leg's writer-captured pairs — never the persisted per-row receipt.
//
// `minted` is the load-bearing bit, and every one of these writers is an upsert that
// can land on an existing row (deterministic fact id, deterministic rule id, the F-19
// ask id). A row captured with minted=false is still recorded — the plan must be able
// to SAY "this apply re-taught a fact it did not create" — but it plans to a surfaced
// skip, never a write. A missing/unknown mint flag reads as NOT minted: fail-closed.
// Pure; exported for tests.
export const __mintBeforeAfterRows = (result = {}) => {
  const rows = [];
  if (result.action_type === 'remember_fact' && result.fact_id) {
    rows.push(memoryMintBeforeAfterRow({
      kind: 'firm_fact',
      id: result.fact_id,
      minted: result.already_present === false,
      status: result.status || 'active'
    }));
  }
  if (result.action_type === 'remember_merchant' && result.rule_id) {
    rows.push(memoryMintBeforeAfterRow({
      kind: 'client_rule',
      id: result.rule_id,
      minted: result.rule_inserted === true,
      status: 'active',
      // The cascade this mint already ran: retiring the rule stops FUTURE matches, it
      // does not un-code the rows it already touched. Surfaced in the plan, not undone.
      detail: { cascade_matched: Number(result.cascade?.matched || 0) }
    }));
  }
  if (result.action_type === 'ask_client' && Array.isArray(result.results)) {
    const seen = new Set();
    for (const row of result.results) {
      const askId = row?.applied ? row.evidence_request_id : null;
      if (!askId || seen.has(String(askId))) continue;
      seen.add(String(askId));
      rows.push(memoryMintBeforeAfterRow({
        kind: 'client_evidence_request',
        id: askId,
        minted: row.evidence_request_minted === true,
        status: 'open'
      }));
    }
  }
  return rows.filter(Boolean);
};

// ─── Entry point ─────────────────────────────────────────────────────────

// Returns { applied: boolean, result, before_after } — `applied` is true when
// at least one row landed (the action flips to applied with the full
// per-row receipt in result; partial failures are visible, not
// retried silently). All-rows-failed keeps the action proposed so
// the firm can retry. `before_after` (pod-safety #2, apply_category only
// today) is the writer-captured [{target, before, after}] pairs — a sibling
// of `result` so it reaches the shadow proposal card without riding the
// persisted action result.
export const applyFeedChatAction = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  action,
  actorId = 'system',
  messageId = null,
  actionIndex = null,
  surface = 'feed_chat',
  nativeMemberId = null,
  deps = {}
} = {}) => {
  if (!clientId) throw badRequest('client_id is required.');
  if (!action || !FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES.includes(action.type)) {
    throw badRequest(`Apply not supported for feed-chat action type '${action?.type || 'unknown'}'.`);
  }
  const d = { ...DEFAULT_DEPS, ...deps };

  let result;
  let beforeAfter = [];
  if (action.type === 'apply_category') {
    const batch = await applyCategoryBatch({ firmId, clientId, action, actorId, messageId, actionIndex, surface, nativeMemberId, d });
    result = batch.result;
    beforeAfter = batch.before_after;
  } else if (action.type === 'ask_client') {
    result = await askClientBatch({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'leave_review_note') {
    result = await leaveReviewNoteBatch({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'mark_evidence_owed') {
    result = await markEvidenceOwedBatch({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'sync_to_accounting') {
    result = await syncToAccountingBatch({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'remember_fact') {
    result = await rememberFact({ firmId, clientId, action, messageId, d });
  } else if (action.type === 'forget_fact') {
    result = await forgetFact({ firmId, action, actorId, d });
  } else if (action.type === 'retire_rule') {
    result = await retireRule({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'cancel_ask') {
    result = await cancelAsk({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'amend_ask') {
    result = await amendAsk({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'resend_ask') {
    result = await resendAsk({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'retry_parse') {
    result = await retryParseBatch({ firmId, action, d });
  } else if (action.type === 'approve_role_grant') {
    result = await approveRoleGrantAction({ firmId, clientId, action, actorId, d });
  } else if (action.type === 'revoke_role_grant') {
    result = await revokeRoleGrantAction({ firmId, clientId, action, actorId, d });
  } else {
    result = await rememberMerchant({ firmId, clientId, action, actorId, d });
  }

  // The mint legs' capture (G2 PR-14) — derived from the writers' own outcomes, so a
  // verb that minted nothing contributes nothing.
  if (!beforeAfter.length) beforeAfter = __mintBeforeAfterRows(result);

  const applied = (result.applied || 0) > 0;
  // One feed-level audit event per command — the receipt that a mass
  // apply happened, distinct from the per-row events the writers
  // already emit. #4 audit half: the spine emitter; bestEffort: false
  // (G2 PR-12, audit-as-precondition): a failed command receipt propagates —
  // the per-row writes stand (their writers already receipted them), but the
  // command reports the error and the action is not stamped applied.
  await auditChatApplyEvent({
    query: d.queryFirmDb,
    firmId,
    clientId,
    actorId,
    action: 'transaction.feed_chat_apply',
    resourceType: 'feed_chat',
    resourceId: messageId || 'feed_chat',
    metadata: {
      action_type: result.action_type,
      action_index: actionIndex,
      requested: result.requested ?? null,
      applied: result.applied ?? null,
      failed: result.failed ?? null,
      account_name: result.account_name || null,
      // S4 role attribution (INV-S7's "which hat"): the sanitized lane tag the
      // proposal carried — the teammate whose lane this command was, distinct
      // from the ACTOR (actorId, the principal who applied it).
      ...(typeof action.role_id === 'string' && action.role_id ? { role_id: action.role_id } : {}),
      ...(result.fact_id ? { fact_id: result.fact_id } : {}),
      ...(result.rule_id ? { rule_id: result.rule_id } : {}),
      ...(result.ask_id ? { ask_id: result.ask_id } : {}),
      ...(result.grant_id ? { grant_id: result.grant_id } : {}),
      // The two-terminal-states consequence rides the feed receipt too, so a
      // cancel that left a row on neither terminal is diagnosable from the
      // audit trail alone (G1b).
      ...(result.leaves_line_hanging != null ? { leaves_line_hanging: result.leaves_line_hanging } : {}),
      // Per-row failure detail — without this an all-rows-failed apply
      // leaves NO diagnosable record (the detail only rode the ephemeral
      // HTTP response; sighted on the 2026-07-03 tx-22 failure). Capped so
      // a large batch can't bloat the audit row.
      ...(Array.isArray(result.results) && result.results.some((r) => r && !r.applied)
        ? {
            errors: result.results
              .filter((r) => r && !r.applied)
              .slice(0, 10)
              .map((r) => ({
                transaction_id: r.transaction_id,
                error: r.error || r.posting?.error || 'unknown'
              }))
          }
        : {})
    },
    bestEffort: false
  });
  return { applied, result, before_after: beforeAfter };
};
