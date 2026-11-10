// Stage 2.5 — payment_confirmation matcher.
// Stage 2.6 — auto-match promotion for the deterministic tier 1 case.
//
// Slice E — this orchestrator delegates unconditionally to
// paymentConfirmationReconciliationLlm.js (the strong path, which routes
// every proposal through the full authorizeMatch gate stack incl. the
// materiality ceiling + ambiguity/twin guard); the matcher-mode gate is
// deleted (batch-2 terminal state 1). The weighted Stage 2.6 promotion
// described below is the LLM-self-disable / LLM-failure fallback only —
// see the delegation block in runPaymentConfirmationReconciliationForDocument.
//
// A `payment_confirmation` document is a SINGLE-event outbound payment
// receipt: confirms one ACH / wire / card-rail payment happened.
// Examples: Amex payment confirmations ("you paid Amex $941.42 via ACH
// from your business checking"), IRS EFTPS tax payment confirmations,
// lender payment receipts, ACH notification emails.
//
// Historically these landed with no extractor wired up — the worker
// marked them skipped with extractor_unavailable, and the documents
// row's vendor/amount/date stayed filename-derived only. Stage 2.5
// routes them through the generic extractor (see pickExtractor) so the
// PDF body is actually read; this module then matches the extracted
// total_amount + counterparty + date against the outbound bank ACH.
//
// Stage 2.6 — auto-promote tier 1. A payment_confirmation IS the
// confirmation of an ACH that happened; the bank line IS that same
// ACH. Linking them under tier 1 conditions (exact amount + vendor
// alias overlap + within window + healthy extraction confidence + no
// amount_mismatch warning) is bookkeeping certainty, not judgment.
// `evaluateBillAutoMatch` already encodes those gates. When the gate
// passes, write `status='auto_matched'` directly, run the cascade
// (transaction → 'explained', document → payment_status='paid') in
// the same writer transaction.
//
// Structurally identical to paymentAccountStatementReconciliation.js
// — the level-1 match shape (one doc amount settled by one outbound
// bank line) is the same. The semantic distinction lives in
// matched_object_type='payment_confirmation' on the row and the audit
// trail. Modules are intentionally separate so each type carries its
// own kill switch and the matches table cleanly distinguishes the two.
//
// Scoring delegates to billReconciliation.generateBillCandidates with
// objectType='payment_confirmation' so existing-match suppression
// scopes to this row type (the bill matcher's rows on the same tx are
// ignored — cross-matcher competition is surfaced in the inbox).

import { generateBillCandidates } from './billReconciliation.js';
import { cascadeAutoMatch } from './reconciliationTriage.js';
import { applyDocumentPaymentStatusAfterMatch, withFirmDbClient } from './firmDb.js';
// Q8 (the model lab, all-entities call 2026-08-16): the lane's experiment
// policy + the Opus reverse-shadow hook. The wrapper resolves the policy per
// run and builds the hook (it owns firmDb access); the Llm orchestrator only
// fires it post-stamp.
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import {
  RECONCILIATION_REASONING_LANE,
  makeReconciliationReasoningChallengerHook
} from './reconciliationReasoningChallenger.js';
import { assessDocumentEntityAlignment, crossEntityPayload, readClientIdentityWithClient } from './crossEntityGuard.js';
import {
  CANDIDATE_TX_EXPLAIN_SELECT_SQL,
  CANDIDATE_TX_STATUS_SQL,
  clientAllowedToAutoMatch
} from './reconciliationLlmCore.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { runPaymentConfirmationReconciliationLlmForDocument } from './paymentConfirmationReconciliationLlm.js';
// The provider-failure contract (2026-09-13, reconciliationProviderFailure.js):
// a typed provider failure from the LLM matcher — a missing/rejected key, a
// rate limit, an outage, a reset socket, a hung request, an unreadable body —
// is receipted on the document and re-driven by the convergence clock. It
// NEVER enters the weighted body below: the weighted matcher is a heuristic
// replacement decision, and a provider failure is not a matching judgment.
import {
  clearReconciliationProviderFailureWithClient,
  isProviderFailure,
  providerFailureFromDisabledStats,
  providerFailureStats
} from './reconciliationProviderFailure.js';

const FLAG_ENABLED = () => {
  const raw = process?.env?.PAYMENT_CONFIRMATION_MATCHER_ENABLED;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const OBJECT_TYPE = 'payment_confirmation';
const SOURCE_LABEL = 'payment_confirmation_reconciliation';

const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

const slugify = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

const makeMatchId = (clientId, txId, docId) => {
  const raw = `${clientId}|${txId}|${OBJECT_TYPE}|${docId}`;
  return (
    `recon-${slugify(clientId)}-${slugify(txId)}-${slugify(OBJECT_TYPE)}-${slugify(docId)}`.slice(0, 118) +
    `-${shortHash(raw)}`
  );
};

const ZERO_STATS = () => ({
  suggested_inserted: 0,
  suggested_refreshed: 0,
  auto_match_inserted: 0,
  auto_match_refreshed: 0,
  auto_match_upgraded: 0,
  skipped_rejected: 0,
  skipped_confirmed: 0,
  skipped_auto_matched: 0,
  auto_match_eligible: 0,
  disabled: false,
  disabled_reason: null
});

const DISABLED_STATS = (reason) => ({ ...ZERO_STATS(), disabled: true, disabled_reason: reason });

// Test seam — defaults to the real LLM matcher (the same shape as
// receiptReconciliation.js `__llmMatcher`). Production always calls the real
// import through this object; the weighted-body suites stub `run` to a
// non-provider self-disable so the weighted body under test still runs —
// a MISSING key is no longer a way into it (it is a provider failure now).
// The default `run` WRAPS the import in an arrow rather than aliasing it,
// so the binding is read at CALL time (the wrapper ↔ LLM module ↔ core ↔
// firmDb import cycle would otherwise hit a temporal dead zone).
export const __llmMatcher = {
  run: (params) => runPaymentConfirmationReconciliationLlmForDocument(params)
};

export const runPaymentConfirmationReconciliationForDocument = async ({
  client,
  firmId,
  clientId,
  documentId
} = {}) => {
  if (!FLAG_ENABLED()) return DISABLED_STATS('PAYMENT_CONFIRMATION_MATCHER_ENABLED not enabled');
  if (!client || !firmId || !clientId || !documentId) return ZERO_STATS();

  // The SIXTH LLM matcher — the strong path is PRIMARY, unconditionally
  // (batch-2 terminal state 1: the RECONCILIATION_MATCHER_MODE gate is
  // deleted, docs/donna-batch2-matcher-mode-dead-branch-plan.md). The LLM
  // matcher returns the same stats shape so callers can `accumulate(stats)`
  // unchanged. This RETIRES the weighted auto-match authority below: the
  // strong path routes every proposal through authorizeMatch (materiality
  // ceiling + ambiguity/twin guard + a persisted authorization receipt),
  // closing the gap where this legacy path auto-matched a large confirmed
  // payment straight through the ceiling on the client allowlist alone.
  // When the LLM matcher self-disables (e.g. no ANTHROPIC_API_KEY) or
  // throws on infrastructure, fall through to the weighted matcher below —
  // same shape the AR / AP / receipt / payment_account_statement paths use.
  // Q8 (the model lab): the lane's active experiment policy for this
  // (firm, client). Non-claude rung seated => the deciding call rides the
  // compatible endpoint, Opus reverse-shadows, and the weighted matcher is
  // NOT a fallback — policy-run failures fail LOUD.
  let decidingPolicy = null;
  try {
    decidingPolicy = await readLaneDecidingPolicy({
      client, firmId, clientId, laneId: RECONCILIATION_REASONING_LANE
    });
  } catch { decidingPolicy = null; } // missing table => no policy, byte-identical
  const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  const policyActive = Boolean(policyModel) && !policyModel.startsWith('claude');
  let challengerHook = null;
  if (policyActive) {
    const challengerSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    challengerHook = makeReconciliationReasoningChallengerHook({
      decidingPolicy,
      family: 'payment_confirmation',
      firmId,
      clientId,
      snapshot: challengerSnapshot,
      withClient: withFirmDbClient
    });
  }

  try {
    const llmStats = await __llmMatcher.run({
      client,
      firmId,
      clientId,
      documentId,
      decidingPolicy,
      challengerHook
    });
    if (!llmStats?.disabled) {
      // The strong model ran (any verdict): a provider-failure receipt from
      // an earlier attempt is cleared — the document has left the re-drive
      // pool. No-op when there is none.
      await clearReconciliationProviderFailureWithClient({ client, firmId, clientId, documentId, logTag: 'paymentConfirmationReconciliation' });
      return llmStats;
    }
    const keyMissing = providerFailureFromDisabledStats(llmStats);
    if (keyMissing) {
      // No Anthropic key: a provisioning gap that rests on the OPERATOR —
      // receipted on the document, re-driven once a key exists. Never the
      // weighted body (a heuristic replacement decision), never a verdict.
      return providerFailureStats({ client, firmId, clientId, documentId, family: 'payment_confirmation', failure: keyMissing, logTag: 'paymentConfirmationReconciliation', zeroStats: ZERO_STATS });
    }
    if (policyActive) {
      console.error('[paymentConfirmationReconciliation] LLM matcher disabled under an ACTIVE model policy — refusing the weighted fallback', {
        documentId,
        reason: llmStats?.disabled_reason || null,
        policy_model: policyModel
      });
      return llmStats;
    }
  } catch (error) {
    // A typed provider failure (providerTransport.js) is a TRANSPORT fact:
    // receipt it on the document (the convergence clock re-drives it) and
    // return the zero shape. Under an active policy the run still fails
    // LOUD after the receipt; without one, nothing replaces the strong
    // model's judgment — the weighted body is for infrastructure throws only.
    if (isProviderFailure(error)) {
      const stats = await providerFailureStats({ client, firmId, clientId, documentId, family: 'payment_confirmation', failure: error, logTag: 'paymentConfirmationReconciliation', zeroStats: ZERO_STATS });
      if (policyActive) throw error;
      return stats;
    }
    if (policyActive) {
      console.error('[paymentConfirmationReconciliation] LLM matcher threw under an ACTIVE model policy — refusing the weighted fallback', {
        documentId,
        policy_model: policyModel,
        error: error?.message || String(error)
      });
      throw error;
    }
    console.error('[paymentConfirmationReconciliation] LLM matcher threw, falling back to weighted (infrastructure failure, not a provider failure)', {
      documentId,
      error: error?.message || String(error)
    });
  }

  const docResult = await client.query(
    `select id, firm_id, client_id, document_type, vendor_name, document_date,
            due_date, total_amount, currency, extraction_confidence, parse_summary,
            duplicate_of, reference_number, filename, payment_status
       from documents
      where firm_id = $1
        and client_id = $2
        and id = $3
        and document_type = 'payment_confirmation'
        and parse_status = 'completed'
        and total_amount is not null
        and duplicate_of is null`,
    [firmId, clientId, documentId]
  );
  if (!docResult.rows.length) return ZERO_STATS();
  const document = docResult.rows[0];

  // Candidate status filter is the SHARED carve-out (reconciliationLlmCore.js)
  // — admits standalone machine-explained lines so document evidence can
  // outrank them. The companion SELECT carries the markers that
  // isBankLineOnlyExplained reads inside generateBillCandidates' guard.
  const txResult = await client.query(
    `select id, firm_id, client_id, money_in, money_out, currency,
            transaction_date as date,
            description, raw_description,
            payload->>'contact' as contact,
            payload->>'source_line' as source_line,
            ${CANDIDATE_TX_EXPLAIN_SELECT_SQL},
            payload->>'bank_line_disposition_explained' as bank_line_disposition_explained,
            payload->>'ai_suggestion_status' as ai_suggestion_status,
            reconciliation_status, account_code,
            status
       from transactions
      where firm_id = $1
        and client_id = $2
        and money_out > 0
        and (money_in is null or money_in = 0)
        and ${CANDIDATE_TX_STATUS_SQL}`,
    [firmId, clientId]
  );

  const existingResult = await client.query(
    `select id, bank_transaction_id, matched_object_type, matched_object_id,
            status, match_amount, match_confidence, payload
       from reconciliation_matches
      where firm_id = $1
        and client_id = $2
        and matched_object_type = 'payment_confirmation'
        and matched_object_id = $3`,
    [firmId, clientId, documentId]
  );

  const {
    candidates,
    skipped_rejected,
    skipped_confirmed,
    skipped_auto_matched
  } = generateBillCandidates({
    transactions: txResult.rows,
    document,
    existingMatches: existingResult.rows,
    objectType: OBJECT_TYPE
  });

  const stats = ZERO_STATS();
  stats.skipped_rejected = skipped_rejected;
  stats.skipped_confirmed = skipped_confirmed;
  stats.skipped_auto_matched = skipped_auto_matched;

  // 0A.10 — resolve the per-run config snapshot ONCE (client + firmId + clientId
  // in scope) so the auto-match canary on this legacy path is config-plane-aware.
  // Soft-fails to {} ⇒ env fallback, byte-identical until a DB row exists.
  const configSnapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  // Cross-entity intake guard (2026-08-04, findings §4b-xvi — the Amex /
  // Desert Bloom case): the persisted extraction's OWN-SIDE party is compared
  // against the book's identity. A confident mismatch DEMOTES to 'suggested'
  // (never auto) and stamps the relation for the ask lane; unknown/aligned is
  // byte-identical to before.
  const clientIdentity = await readClientIdentityWithClient(client, { firmId, clientId });
  const entityAlignment = assessDocumentEntityAlignment({ clientIdentity, document });
  for (const candidate of candidates) {
    const matchId = makeMatchId(clientId, candidate.transaction.id, document.id);
    // Stage 2.6 — promote tier 1 with full evaluateBillAutoMatch
    // verdict to status='auto_matched' on insert. Below the gate we
    // still write 'suggested' for firm review.
    // Client-scoped auto-match canary (RECONCILIATION_AUTO_MATCH_CLIENTS): honor the
    // same allowlist on this legacy path. No-op without an allowlist; otherwise a
    // non-allowlisted client is held to 'suggested' (surfaced, never hidden).
    const writeStatus = (candidate.auto_match_passed && entityAlignment.verdict !== 'mismatch' && clientAllowedToAutoMatch(clientId, undefined, { configSnapshot })) ? 'auto_matched' : 'suggested';
    const payload = {
      source: SOURCE_LABEL,
      ...(entityAlignment.verdict === 'mismatch' ? { cross_entity: crossEntityPayload(entityAlignment) } : {}),
      match_reason: {
        ...candidate.match_reason,
        source: SOURCE_LABEL,
        auto_match_passed: candidate.auto_match_passed,
        auto_match_blockers: candidate.auto_match_blockers
      },
      recommended_action: writeStatus === 'auto_matched' ? 'auto_matched' : 'review'
    };
    // The CTE captures the pre-write `status` so we can detect the
    // `suggested → auto_matched` transition that an upsert refresh
    // would otherwise hide. Before this, the SET clause omitted
    // `status` entirely, so a `suggested` row that the matcher now
    // rates as auto-matchable would stay `suggested` forever on
    // re-runs — and cascadeAutoMatch (gated on writeStatus, not on
    // DB state) would still fire, creating split-brain state
    // (bank tx flipped to 'explained' while the match stays
    // 'suggested'). The CASE in SET upgrades only suggested →
    // auto_matched; the WHERE keeps confirmed/rejected/auto_matched
    // rows immutable as before.
    const insertResult = await client.query(
      `with prior as (
         select status as prior_status
         from reconciliation_matches
         where bank_transaction_id = $4
           and matched_object_type = $5
           and matched_object_id = $6
       )
       insert into reconciliation_matches (
         id, firm_id, client_id, bank_transaction_id,
         matched_object_type, matched_object_id,
         match_amount, match_confidence, match_reason,
         status, created_by, payload
       ) values (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8, $9,
         $10, 'system', $11::jsonb
       )
       on conflict (bank_transaction_id, matched_object_type, matched_object_id) do update
         set match_amount = excluded.match_amount,
             match_confidence = excluded.match_confidence,
             match_reason = excluded.match_reason,
             payload = reconciliation_matches.payload || excluded.payload,
             status = case
               when reconciliation_matches.status = 'suggested'
                and excluded.status = 'auto_matched'
               then 'auto_matched'
               else reconciliation_matches.status
             end,
             updated_at = now()
         where reconciliation_matches.status not in ('confirmed', 'rejected', 'auto_matched')
       returning
         id,
         (xmax = 0) as inserted,
         status as final_status,
         coalesce((select prior_status from prior), 'inserted') as prior_status`,
      [
        matchId,
        firmId,
        clientId,
        candidate.transaction.id,
        OBJECT_TYPE,
        document.id,
        Number(candidate.transaction.money_out || 0),
        candidate.score,
        candidate.summary,
        writeStatus,
        JSON.stringify(payload)
      ]
    );

    if (!insertResult.rows.length) continue;

    const wasInserted = Boolean(insertResult.rows[0].inserted);
    const priorStatus = insertResult.rows[0].prior_status;
    const finalStatus = insertResult.rows[0].final_status;
    const wasUpgraded = !wasInserted
      && priorStatus === 'suggested'
      && finalStatus === 'auto_matched';

    if (wasInserted) {
      const auditAction = writeStatus === 'auto_matched'
        ? 'reconciliation.candidate.auto_matched'
        : 'reconciliation.candidate.suggested';
      if (writeStatus === 'auto_matched') stats.auto_match_inserted += 1;
      else stats.suggested_inserted += 1;
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          auditAction,
          matchId,
          JSON.stringify({
            match_id: matchId,
            bank_transaction_id: candidate.transaction.id,
            matched_object_id: document.id,
            match_kind: OBJECT_TYPE,
            confidence_tier: candidate.match_reason.confidence_tier,
            score: candidate.score,
            status: writeStatus,
            auto_match_passed: candidate.auto_match_passed,
            auto_match_blockers: candidate.auto_match_blockers
          })
        ]
      );
    } else if (wasUpgraded) {
      stats.auto_match_upgraded += 1;
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
        [
          firmId,
          clientId,
          'reconciliation.candidate.status_upgraded',
          matchId,
          JSON.stringify({
            match_id: matchId,
            bank_transaction_id: candidate.transaction.id,
            matched_object_id: document.id,
            match_kind: OBJECT_TYPE,
            confidence_tier: candidate.match_reason.confidence_tier,
            score: candidate.score,
            prior_status: priorStatus,
            status: finalStatus,
            auto_match_passed: candidate.auto_match_passed,
            auto_match_blockers: candidate.auto_match_blockers
          })
        ]
      );
    } else if (writeStatus === 'auto_matched') {
      stats.auto_match_refreshed += 1;
    } else {
      stats.suggested_refreshed += 1;
    }

    if (candidate.auto_match_passed) {
      stats.auto_match_eligible += 1;
    }

    // Stage 2.6 cascade — only on auto_matched. cascadeAutoMatch
    // flips the bank tx to 'explained'; applyDocumentPaymentStatusAfterMatch
    // takes the 1:1 'paid' branch for non-supplier_bill / non-sales_invoice
    // matched_object_types, which is exactly the right semantics for a
    // payment_confirmation (single-event, fully settled by construction).
    // Soft-degrade — a cascade failure doesn't roll back the match row.
    if (writeStatus === 'auto_matched') {
      try {
        await cascadeAutoMatch({
          client,
          firmId,
          clientId,
          matchId,
          bankTransactionId: candidate.transaction.id,
          matchedObjectType: OBJECT_TYPE,
          documentId: document.id
        });
        await applyDocumentPaymentStatusAfterMatch({
          client,
          firmId,
          matchId,
          matchedObjectType: OBJECT_TYPE,
          documentId: document.id
        });
      } catch (error) {
        console.error('[paymentConfirmationReconciliation] auto-match cascade failed', {
          matchId,
          error: error?.message || String(error)
        });
      }
    }
  }

  return stats;
};

export const __OBJECT_TYPE = OBJECT_TYPE;
export const __SOURCE_LABEL = SOURCE_LABEL;
