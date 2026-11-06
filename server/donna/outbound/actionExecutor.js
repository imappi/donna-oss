// Outbound action executor (M0.3, G2 — execution plan A3). THE one send path:
// every outbound action executes here or not at all. All safety interlocks
// live in this module:
//   - fresh interlock re-check AT SEND TIME, never trusted from schedule time
//     (suppression, party do_not_contact, paid-truth via the injected guard,
//     config-plane stage) — ambiguity HOLDS (back to the owner), a settled
//     anchor CANCELS with a receipt, never a silent skip;
//   - claim via FOR UPDATE SKIP LOCKED + an 'executing' lease flipped BEFORE
//     the provider call (no external API inside the claim transaction —
//     INV-11); the sent-flip and its receipt commit together (finalizeSend
//     pattern); a stale lease is surfaced and NEVER auto-retried (a
//     possibly-sent send is not re-sent);
//   - rendering is pack-template, fail-closed (an unresolved token refuses
//     the send rather than leaking '{{token}}' to a counterparty);
//   - cadence advance (M0.5's generalized askReaskCadence mechanic): after an
//     executed reminder the NEXT pack-cadence step is minted through the same
//     gate; an exhausted cadence escalates to the OWNER (audited now; the G9
//     digest surface renders it in M1) — two-terminal-states holds.
//
// The paid-truth guard is INJECTED (paidTruthCheck): M1's G4 module composes
// both settlement mechanisms; M0's default returns null, which the gate
// treats as 'missing' — a reminder without a fresh verdict rests on the
// owner, never sends. Conservative by construction.
//
// Trust-the-strong-LLM: the model drafts/proposes upstream (mint); this
// module is pure Keep layer — deterministic checks that refuse, a renderer
// that refuses, receipts that explain. No LLM call anywhere in here.

import { readClientConfigSnapshot } from '../clientConfig.js';
import {
  loadOutboundPack, renderPackTemplate, dunningCadenceForPack,
  escalationForPack, formatPackAmount, formatPackDate
} from './packs.js';
import {
  classifyOutboundAction, outboundGateMode, OWNER_DIRECTED_ACTION_TYPES
} from './actionGate.js';
import { recordCleanApprovedSend } from './earnedAutoLadder.js';
import { getPartyById, listPartyChannels } from './partyStore.js';
import {
  isOutboundSuppressed, listDueOutboundActions, claimOutboundActionForExecution,
  holdClaimedOutboundAction, cancelClaimedOutboundAction, finalizeOutboundSend,
  markOutboundActionFailed, mintOutboundAction, listStaleExecutingActions,
  insertOutboundReceipt
} from './actionStore.js';
import {
  fingerprintIssuanceConsequence, STALE_CONSEQUENCE_REASON
} from './consequenceFingerprint.js';
import {
  syncReceivableCaseAfterSend, syncReceivableCaseAfterCancel
} from './receivableCases.js';
import {
  buildCounterpartySendingIdentity, buildOutboundUnsubscribeUrl,
  buildUnsubscribeHeaders, outboundPublicBaseUrl, resolveOwnerReplyTo,
  completeOutboundSendingIdentity
} from './sendingIdentity.js';
import {
  checkIssuanceAnchorState, checkCurrentInvoiceFacts, finalizeIssuanceAnchor, advanceIssuanceAfterSend,
  postIssuanceArLeg, documentTitleForInvoice, buildLinesBlock
} from './issuance.js';
import { renderInvoicePdfArtifact, renderQuotePdfArtifact } from './invoicePdfArtifact.js';
import { buildInvoiceStatutoryValues } from './invoiceStatutoryValues.js';
import { hasBuyerRegistrationFloor } from './buyerRegistration.js';
import { bidiSafeRenderValues } from './bidiText.js';
import {
  OUTBOUND_DELIVERY_CONTRACT_VERSION, buildOutboundEmailArtifact,
  resolveOutboundActionLanguage
} from './emailArtifact.js';
import { getActivePayLinkForAnchor } from './payLinks.js';
import { paymentLinkInstructionsForPack } from './packs.js';
import {
  findActiveActionAuthorityGrant, recordActionGrantUse
} from '../actionAuthorityGrants.js';
import {
  decideRoleAction, roleForActionIdentity, specialistRoleGateMode,
  logSpecialistRoleWouldBlock, recordRoleWouldBlock
} from '../roles/roleAuthority.js';
import { recordOutboundRoleTransition } from '../roles/roleEvents.js';

const ISSUANCE_ACTION_TYPES = ['issue_invoice', 'send_quote'];
// Anchors that carry a payment block a live D4 pay-link may replace.
const PAY_LINK_ACTION_TYPES = ['issue_invoice', 'send_receivable_reminder'];

const DEFAULT_LIMIT = 25;
const DAY_MS = 86400000;

const deterministicModelId = (pack) =>
  `deterministic:pack:${pack?.pack?.id}@v${pack?.pack?.version}`;

// Resolve the recipient from the party's ACTIVE email channels (primary
// first). The party store is the channel of record — payload overrides are
// deliberately not honoured.
const resolveRecipient = async (client, { firmId, clientId, partyId }) => {
  const channels = await listPartyChannels(client, {
    firmId, clientId, partyId, activeOnly: true
  });
  const emails = channels.filter((c) => c.channel_kind === 'email');
  if (!emails.length) return null;
  return (emails.find((c) => c.is_primary) || emails[0]).normalized_value;
};

const buildRenderValues = ({ action, party, now, env = process.env }) => {
  const payloadValues = (action.payload && typeof action.payload === 'object'
    ? action.payload.render_values : null) || {};
  const derived = {
    counterparty_name: party?.display_name,
    step_number: action.cadence_step != null ? String(action.cadence_step) : undefined,
    currency: action.currency || undefined
  };
  const dueDate = action.payload?.due_date ? Date.parse(action.payload.due_date) : NaN;
  if (Number.isFinite(dueDate)) {
    derived.days_overdue = String(Math.max(0, Math.floor((now - dueDate) / DAY_MS)));
    // M4 payable notices: days UNTIL due, computed fresh at render so a
    // notice that slips a sweep still states the true remaining days (floor
    // 0 — an already-due bill reads "0 days", never a negative).
    derived.days_until_due = String(Math.max(0, Math.ceil((dueDate - now) / DAY_MS)));
  }
  // G8: the unsubscribe URL resolves from the action's bearer token + the
  // deployment base URL. Both missing → the value stays absent and a template
  // that uses {{unsubscribe_url}} REFUSES to render (fail-closed; a reminder
  // must never ship a dead unsubscribe link).
  const unsubscribeUrl = buildOutboundUnsubscribeUrl(
    outboundPublicBaseUrl(env), action.unsubscribe_token
  );
  if (unsubscribeUrl) derived.unsubscribe_url = unsubscribeUrl;
  const merged = { ...derived };
  for (const [key, value] of Object.entries(payloadValues)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') merged[key] = value;
  }
  return merged;
};

// AR-4D: re-materialize locale-sensitive presentation from canonical values
// after the executor resolves the FINAL template language. Mint-time values
// remain the approval/digest preview, but a changed party preference cannot
// pair a new-language template with stale amount/date bytes at send time.
// Missing canonical fields retain the persisted value for legacy actions;
// present canonical fields fail closed if their language locale is unusable.
export const formatOutboundRenderValuesForLanguage = ({
  pack, language, action, anchorRow = null, values = {}
} = {}) => {
  const formatted = { ...values };
  const setAmount = (key, value) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    if (!Number.isFinite(Number(value))) return;
    const rendered = formatPackAmount(pack, value, language);
    if (rendered === null) {
      const error = new Error(`no correspondence locale for language '${language}'`);
      error.code = 'OUTBOUND_CORRESPONDENCE_LOCALE_UNRESOLVED';
      throw error;
    }
    formatted[key] = rendered;
  };
  const setDate = (key, value) => {
    const day = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const rendered = formatPackDate(pack, day, language);
    if (rendered === null) {
      const error = new Error(`no correspondence locale for language '${language}'`);
      error.code = 'OUTBOUND_CORRESPONDENCE_LOCALE_UNRESOLVED';
      throw error;
    }
    formatted[key] = rendered;
  };

  if (['send_receivable_reminder', 'send_payable_notice'].includes(action?.action_type)) {
    setAmount('amount_due', action?.amount);
    setDate('due_date', action?.payload?.due_date);
  }

  const issuance = action?.action_type === 'issue_invoice'
    ? anchorRow?.draft?.invoice
    : action?.action_type === 'send_quote' ? anchorRow?.draft?.quote : null;
  if (issuance) {
    const isInvoice = action.action_type === 'issue_invoice';
    if (isInvoice) Object.assign(formatted, buildInvoiceStatutoryValues({ pack, invoice: issuance, language }));
    if (isInvoice && hasBuyerRegistrationFloor(pack)) Object.assign(formatted, {
      owner_business_name: issuance.seller.name, counterparty_name: issuance.buyer.name,
      invoice_number: issuance.invoiceNumber, currency: issuance.currency
    });
    setAmount(isInvoice ? 'invoice_total' : 'quote_total', issuance.total);
    setDate('issue_date', issuance.date);
    setDate(isInvoice ? 'due_date' : 'valid_until', isInvoice
      ? issuance.dueDate : issuance.validUntil);
    if (Array.isArray(issuance.lines) && issuance.lines.length > 0) {
      formatted.lines_block = buildLinesBlock({
        pack, lines: issuance.lines,
        currency: issuance.currency || action.currency,
        language
      });
    }
  }
  return formatted;
};

// After an executed reminder: mint the next pack-cadence step through the
// same gate, or — cadence exhausted — audit the escalation to the owner.
// Returns { minted, exhausted } so the caller can sync the receivable case.
const advanceCadence = async (client, {
  firmId, clientId, action, pack, snapshot, env, paidTruth, now, stats
}) => {
  if (action.action_type !== 'send_receivable_reminder') return { minted: null, exhausted: false };
  const steps = dunningCadenceForPack(pack);
  const currentStep = Number(action.cadence_step) || 0;
  const next = steps.find((s) => s.step === currentStep + 1);
  if (!next) {
    const escalation = escalationForPack(pack);
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'outbound_action.cadence_exhausted', 'outbound_action', $3, $4::jsonb)`,
      [firmId, clientId, action.id, JSON.stringify({
        action_type: action.action_type, final_step: currentStep,
        escalate_to: escalation.to, anchor: `${action.anchor_type}:${action.anchor_id}`
      })]
    );
    // S5 role event (roles/roleEvents.js): an exhausted cadence rests the
    // chase on the OWNER — the role→owner handoff on the escalation, when the
    // lane belongs to an actively hired role. Soft; same finalize txn.
    await recordOutboundRoleTransition(client, {
      firmId, clientId, action, transition: 'handed_to_owner',
      nextCommitment: 'decide_collection_next_step',
      reasons: ['cadence_exhausted']
    });
    stats.cadence_escalations += 1;
    return { minted: null, exhausted: true };
  }
  const dueDate = action.payload?.due_date ? Date.parse(action.payload.due_date) : NaN;
  if (!Number.isFinite(dueDate)) {
    stats.cadence_skipped_no_due_date += 1;
    return { minted: null, exhausted: false };
  }
  const party = await getPartyById(client, { firmId, clientId, partyId: action.target_party_id });
  const recipient = await resolveRecipient(client, {
    firmId, clientId, partyId: action.target_party_id
  });
  const suppressed = recipient
    ? await isOutboundSuppressed(client, { firmId, clientId, channelKind: 'email', value: recipient })
    : false;
  const gate = classifyOutboundAction({
    actionType: action.action_type, snapshot, env,
    suppressed, doNotContact: Boolean(party?.do_not_contact),
    hasRecipient: Boolean(recipient), paidTruth, confidence: action.confidence
  });
  const minted = await mintOutboundAction(client, {
    firmId, clientId, actionType: action.action_type,
    targetPartyId: action.target_party_id,
    anchorType: action.anchor_type, anchorId: action.anchor_id,
    packId: action.pack_id, template: next.template, language: action.language,
    payload: action.payload, amount: action.amount, currency: action.currency,
    confidence: action.confidence, gate,
    scheduledFor: new Date(dueDate + next.daysAfterDue * DAY_MS).toISOString(),
    cadenceStep: next.step, createdBy: 'cadence_sweep',
    model: action.model, configSnapshotId: action.config_snapshot_id
  });
  if (minted.action && !minted.deduped) stats.cadence_minted += 1;
  return { minted: minted.action || null, exhausted: false };
};

// The bounded per-client execution sweep. Per-action posture: each due row is
// handled in its OWN short transactions (claim txn, finalize txn) so one
// poisoned action never rolls back the rest. The caller holds no open txn.
export const executeDueOutboundActions = async ({
  client, firmId, clientId, env = process.env, now = Date.now(),
  limit = DEFAULT_LIMIT, deliverers = {}, paidTruthCheck = null,
  // Injectable like paidTruthCheck (tests exercise the degrade posture);
  // runtime callers never pass them — the defaults are the real renderers.
  invoicePdfRenderer = renderInvoicePdfArtifact,
  quotePdfRenderer = renderQuotePdfArtifact,
  // Injectable only for synthetic language-contract integration proofs. The
  // runtime always loads a validated shipping pack through the default.
  packLoader = loadOutboundPack,
  // The converged role/authority decision (roles/roleAuthority.js — INV-S2);
  // injectable so tests can exercise the denial postures without a registry edit.
  roleDecisionFn = decideRoleAction,
  logger = console
} = {}) => {
  if (!client || !firmId || !clientId) return { skipped: true, reason: 'missing_args' };
  const stats = {
    skipped: false, considered: 0, sent: 0, held: 0, cancelled: 0, failed: 0,
    shadow_would_send: 0, stale_executing: 0, held_stale_consequence: 0,
    held_language_unavailable: 0, held_delivery_contract_changed: 0,
    cadence_minted: 0, cadence_escalations: 0, cadence_skipped_no_due_date: 0,
    issuance_follow_ups_minted: 0, recurrence_minted: 0, grant_authorized: 0,
    clean_sends_recorded: 0, ladder_graduated: 0,
    role_would_block: 0, role_leash_held: 0,
    errors: 0
  };
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const nowIso = new Date(now).toISOString();

  // D7 sending identity, resolved once per client: the customer's business
  // name in the From display over the shared verified domain, owner reply-to.
  const identityRow = await client.query(
    'select company_name, profile from clients where firm_id = $1 and id = $2',
    [firmId, clientId]
  ).then((r) => r.rows[0] || null).catch(() => null);
  const identity = buildCounterpartySendingIdentity({
    ownerBusinessName: identityRow?.company_name, profile: identityRow?.profile
  });

  let due;
  try {
    due = await listDueOutboundActions(client, { firmId, clientId, now: nowIso, limit });
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return { ...stats, skipped: true, reason: 'tables_absent' };
    }
    throw error;
  }
  stats.considered = due.length;

  // Shadow lane (askReaskCadence shape): one would-execute receipt per sweep,
  // nothing mutated. Off lane: leave rows untouched (a kill switch stops
  // acting; it does not cancel standing work).
  const shadowIds = [];
  const actable = [];
  for (const action of due) {
    const { mode } = outboundGateMode({ actionType: action.action_type, snapshot, env });
    if (mode === 'act') actable.push(action);
    else if (mode === 'shadow') shadowIds.push(action.id);
  }
  if (shadowIds.length) {
    stats.shadow_would_send = shadowIds.length;
    try {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', 'outbound_action.would_execute', 'client', $2, $3::jsonb)`,
        [firmId, clientId, JSON.stringify({ action_ids: shadowIds, count: shadowIds.length })]
      );
    } catch { /* best-effort shadow receipt */ }
  }

  for (const dueAction of actable) {
    try {
      // ── Claim transaction: re-check state, flip the executing lease. ──────
      await client.query('begin');
      const action = await claimOutboundActionForExecution(client, {
        firmId, clientId, actionId: dueAction.id, now: nowIso
      });
      if (!action) { await client.query('rollback'); continue; }

      // S1 role leash (INV-S2): the ONE converged role/authority decision at
      // the one send path. Attribution is by action_set claim
      // (roleForActionIdentity) — the three AR sends belong to
      // invoicing_collections; an unclaimed type (send_payable_notice) runs
      // on Donna core's own delegated surface and the leash does not bind.
      // A denial under an ACTING SPECIALIST_ROLE_ENFORCE holds the row to the
      // OWNER with a named reason (the second terminal state, never an error
      // terminal); at off/shadow it logs a would-block (receipted at shadow)
      // and proceeds unchanged.
      const roleDecision = roleDecisionFn({
        actionType: action.action_type,
        roleId: roleForActionIdentity(action.action_type)
      });
      let roleWouldBlock = false;
      if (!roleDecision.allowed) {
        const roleMode = specialistRoleGateMode({ snapshot, env });
        if (roleMode === 'act') {
          await holdClaimedOutboundAction(client, {
            firmId, clientId, actionId: action.id,
            reasons: ['role_leash_denied', ...(roleDecision.reasons || [])]
          });
          await insertOutboundReceipt(client, {
            firmId, clientId, actionId: action.id, actionType: action.action_type,
            targetPartyId: action.target_party_id, channel: 'email',
            outcome: 'refused', reason: 'role_leash_denied',
            approvedBy: 'system:role_gate', authority: 'specialist_role_leash',
            model: action.model || 'deterministic:gate',
            checks: [{
              check: 'role_leash', status: 'fail',
              detail: (roleDecision.reasons || []).join(',') || 'denied'
            }],
            configSnapshotId: action.config_snapshot_id
          });
          await client.query('commit');
          stats.role_leash_held += 1;
          continue;
        }
        roleWouldBlock = true;
        stats.role_would_block += 1;
        logSpecialistRoleWouldBlock({
          logger, seam: 'outbound_executor', firmId, clientId, decision: roleDecision
        });
        if (roleMode === 'shadow') {
          await recordRoleWouldBlock({
            query: (sql, params) => client.query(sql, params),
            firmId, clientId, seam: 'outbound_executor', decision: roleDecision,
            warn: (...args) => logger.warn?.(...args)
          });
        }
      }

      // Issuance interlock (M2): the anchor's lifecycle is re-checked fresh
      // at send time — a drifted anchor (already issued, cancelled,
      // converted, expired) cancels with a named reason, never a stale send.
      let anchorRow = null;
      if (ISSUANCE_ACTION_TYPES.includes(action.action_type)) {
        const anchorState = await checkIssuanceAnchorState(client, { firmId, clientId, action, now });
        if (anchorState.cancel) {
          await cancelClaimedOutboundAction(client, {
            firmId, clientId, actionId: action.id,
            reason: anchorState.cancel,
            approvedBy: 'system:send_guard', authority: 'send_time_interlock',
            model: action.model || 'deterministic:gate',
            checks: [{ check: 'anchor_state', status: 'fail', detail: anchorState.cancel }]
          });
          await client.query('commit');
          stats.cancelled += 1;
          continue;
        }
        anchorRow = anchorState.row;
      }

      // M4 payable-notice interlock: the supplier bill is re-read fresh at
      // send time — a bill that settled (or vanished) since mint cancels with
      // a named reason, never a stale "schedule payment?" in the owner's inbox.
      const ownerDirected = OWNER_DIRECTED_ACTION_TYPES.includes(action.action_type);
      if (action.action_type === 'send_payable_notice') {
        const bill = await client.query(
          `select payment_status from documents
            where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, action.anchor_id]
        ).then((r) => r.rows[0] || null).catch(() => null);
        const billState = String(bill?.payment_status || '').trim().toLowerCase();
        const cancelReason = !bill ? 'anchor_missing'
          : ['paid', 'void', 'credit_note'].includes(billState) ? 'bill_settled'
            : null;
        if (cancelReason) {
          await cancelClaimedOutboundAction(client, {
            firmId, clientId, actionId: action.id,
            reason: cancelReason,
            approvedBy: 'system:send_guard', authority: 'send_time_interlock',
            model: action.model || 'deterministic:gate',
            checks: [{ check: 'payable_anchor_state', status: 'fail', detail: cancelReason }]
          });
          await client.query('commit');
          stats.cancelled += 1;
          continue;
        }
      }

      const wasApproved = action.status === 'approved';
      const party = await getPartyById(client, { firmId, clientId, partyId: action.target_party_id });
      // G13(b) THE STALE-CONSEQUENCE INTERLOCK. The checks above re-read the
      // anchor's LIFECYCLE; this re-reads its BUSINESS FACTS. If the recipient,
      // invoice number, currency, total, due date or lines moved between the
      // owner's approval and now, the thing about to be sent is not the thing
      // that was approved.
      //
      // A mismatch HOLDS, it does not cancel: a cancel is a terminal Donna
      // chose, and this is precisely the case where the decision is the
      // owner's. The row goes back to hold_for_approval with a named reason —
      // the second terminal state, not a third.
      //
      // NULL fingerprint (never approved, pre-104 row, or a soft failure at
      // stamp time) ⇒ nothing to compare ⇒ no-op, byte-identical to before.
      //
      // Owner-directed types mail the OWNER (the client profile is the
      // channel of record), never the party's channels — a third-party send
      // is structurally impossible for them. Supplier-level suppression and
      // do_not_contact govern contacting the SUPPLIER, so they do not bind a
      // notice to the owner about that supplier's bill.
      const recipient = ownerDirected
        ? resolveOwnerReplyTo(identityRow?.profile)
        : await resolveRecipient(client, {
          firmId, clientId, partyId: action.target_party_id
        });

      // AR-4E: strict correspondence language resolution happens before any
      // authority shortcut. A requested language is never silently replaced
      // by the pack default, and a supplier preference never controls an
      // owner-directed payable notice.
      let pack = null;
      let languageResolution = null;
      try {
        pack = packLoader(action.pack_id);
        languageResolution = resolveOutboundActionLanguage({
          pack,
          actionLanguage: action.language,
          preferredLanguage: party?.preferred_language,
          fallbackLanguage: party?.fallback_language,
          ownerDirected
        });
      } catch { /* the existing render-failure path receipts invalid packs */ }
      if (languageResolution && !languageResolution.ok) {
        await holdClaimedOutboundAction(client, {
          firmId, clientId, actionId: action.id,
          reasons: [languageResolution.reason]
        });
        await insertOutboundReceipt(client, {
          firmId, clientId, actionId: action.id, actionType: action.action_type,
          targetPartyId: action.target_party_id, channel: 'email', recipient,
          outcome: 'refused', reason: languageResolution.reason,
          approvedBy: 'system:send_guard', authority: 'send_time_interlock',
          model: action.model || (pack ? deterministicModelId(pack) : 'deterministic:pack'),
          requestedLanguage: languageResolution.requestedLanguage,
          actualLanguage: languageResolution.actualLanguage,
          languageSource: languageResolution.languageSource,
          languageFallbackBasis: languageResolution.fallbackBasis,
          correspondenceLocale: languageResolution.locale,
          templateName: action.template,
          templateCatalogId: pack?.pack?.id || action.pack_id,
          templateCatalogVersion: pack?.pack?.version || null,
          deliveryContractVersion: OUTBOUND_DELIVERY_CONTRACT_VERSION,
          checks: [{ check: 'correspondence_language', status: 'fail', detail: languageResolution.reason }],
          configSnapshotId: action.config_snapshot_id
        });
        await client.query('commit');
        stats.held_language_unavailable += 1;
        continue;
      }

      const invoiceFacts = await checkCurrentInvoiceFacts(client, { firmId, clientId, action, pack, anchorRow });
      if (!invoiceFacts.ok) {
        await holdClaimedOutboundAction(client, {
          firmId, clientId, actionId: action.id, reasons: [invoiceFacts.reason]
        });
        await insertOutboundReceipt(client, {
          firmId, clientId, actionId: action.id, actionType: action.action_type,
          targetPartyId: action.target_party_id, channel: 'email', recipient,
          outcome: 'refused', reason: invoiceFacts.reason,
          approvedBy: 'system:send_guard', authority: 'send_time_interlock',
          model: action.model || 'deterministic:gate',
          checks: [{ check: 'current_invoice_facts', status: 'fail', detail: invoiceFacts.reason }],
          configSnapshotId: action.config_snapshot_id
        });
        await client.query('commit');
        stats.held_stale_consequence += 1;
        continue;
      }

      if (action.approved_consequence_fingerprint && anchorRow) {
        const current = fingerprintIssuanceConsequence({ recipient, anchorRow });
        if (current && current !== action.approved_consequence_fingerprint) {
          await holdClaimedOutboundAction(client, {
            firmId, clientId, actionId: action.id,
            reasons: [STALE_CONSEQUENCE_REASON]
          });
          await insertOutboundReceipt(client, {
            firmId, clientId, actionId: action.id, actionType: action.action_type,
            targetPartyId: action.target_party_id, channel: 'email',
            outcome: 'refused', reason: STALE_CONSEQUENCE_REASON,
            approvedBy: 'system:send_guard', authority: 'send_time_interlock',
            model: action.model || 'deterministic:gate',
            checks: [{
              check: 'approved_consequence_fingerprint',
              status: 'fail',
              detail: `approved ${action.approved_consequence_fingerprint}, now ${current}`
            }],
            configSnapshotId: action.config_snapshot_id
          });
          await client.query('commit');
          stats.held_stale_consequence += 1;
          continue;
        }
      }

      const suppressed = !ownerDirected && recipient
        ? await isOutboundSuppressed(client, { firmId, clientId, channelKind: 'email', value: recipient })
        : false;
      const paidTruth = typeof paidTruthCheck === 'function'
        ? await paidTruthCheck({ client, firmId, clientId, action })
        : null;
      const gate = classifyOutboundAction({
        actionType: action.action_type, snapshot, env,
        suppressed,
        doNotContact: ownerDirected ? false : Boolean(party?.do_not_contact),
        hasRecipient: Boolean(recipient), paidTruth, confidence: action.confidence
      });

      // Authority resolution: an owner approval carries the send; a scheduled
      // row needs the fresh auto_execute verdict. Hard blocks bind both.
      // D6 seam (M2): a scheduled row held ONLY by stage/confidence may
      // instead be carried by a covering ACTIVE action_authority_grant — the
      // owner's standing, ceilinged, per-counterparty authority. Paid-truth
      // holds and hard blocks are NEVER grant-overridable. Dormant today: no
      // runtime surface mints grants yet, so the lookup finds nothing.
      const stageOnlyHold = gate.verdict === 'hold_for_approval'
        && gate.reasons.every((r) => r === 'stage_below_auto' || r === 'confidence_below_auto_floor');
      let grant = null;
      if (stageOnlyHold && !wasApproved) {
        grant = await findActiveActionAuthorityGrant(client, {
          firmId, clientId, domain: 'outbound',
          actionType: action.action_type,
          scopeKind: 'counterparty', scopeKey: action.target_party_id,
          amount: action.amount, currency: action.currency
        });
      }
      const authorityHold = gate.verdict === 'hold_for_approval'
        && !(wasApproved && stageOnlyHold) && !grant;
      if (gate.verdict === 'blocked') {
        await cancelClaimedOutboundAction(client, {
          firmId, clientId, actionId: action.id,
          reason: gate.reasons.join(','),
          approvedBy: 'system:send_guard', authority: 'send_time_interlock',
          model: action.model || 'deterministic:gate',
          checks: gate.reasons.map((r) => ({ check: r, status: 'fail' }))
        });
        // Case sync (G5): already_settled closes the chase as settled; a hard
        // block (suppressed / do_not_contact) is the honest stop.
        await syncReceivableCaseAfterCancel(client, {
          firmId, clientId, action, reasons: gate.reasons
        });
        await client.query('commit');
        stats.cancelled += 1;
        continue;
      }
      if (authorityHold) {
        await holdClaimedOutboundAction(client, {
          firmId, clientId, actionId: action.id, reasons: gate.reasons
        });
        await client.query('commit');
        stats.held += 1;
        continue;
      }

      // Render inside the claim txn (deterministic, no external call). A
      // render refusal is a receipted failure, never a leaked placeholder.
      let rendered;
      let attachment = null;
      let artifactFailure = null;
      let emailArtifact = null;
      let statutoryTitle = null;
      let statutoryTitleLimb = null;
      const approvedBy = wasApproved
        ? `${action.approved_by_actor_type}:${action.approved_by_actor_id || 'unknown'}`
        : grant
          ? `${grant.authorized_by_actor_type}:${grant.authorized_by_actor_id || 'unknown'}`
          : `config_stage:${ownerDirected ? gate.stage : 'auto'}`;
      const authority = wasApproved
        ? 'per_send_owner_approval'
        : grant
          ? `action_authority_grant:${grant.id}`
          : ownerDirected
            ? `owner_directed_notice:${gate.flagKey}`
            : `stage:auto:${gate.flagKey}`;
      try {
        pack ||= packLoader(action.pack_id);
        languageResolution ||= resolveOutboundActionLanguage({
          pack,
          actionLanguage: action.language,
          preferredLanguage: party?.preferred_language,
          fallbackLanguage: party?.fallback_language,
          ownerDirected
        });
        if (!languageResolution.ok) throw new Error(languageResolution.reason);
        // Owner-directed sends render in the persisted owner/pack language
        // resolved above, never the SUPPLIER's preference.
        const language = languageResolution.actualLanguage;
        let values = buildRenderValues({ action, party, now, env });
        values = formatOutboundRenderValuesForLanguage({
          pack, language, action, anchorRow, values
        });
        // AR-4C: statutory titles resolve against the SAME final language as
        // the template. A party preference can change between mint and send;
        // recomputing this deterministic value from the persisted invoice
        // prevents an Arabic template from carrying a stale English title (or
        // vice versa). Packs without statutory titles return null and remain
        // byte-identical.
        if (action.action_type === 'issue_invoice') {
          const documentTitle = documentTitleForInvoice({
            pack, invoice: anchorRow?.draft?.invoice, language
          });
          if (documentTitle) {
            values.document_title = documentTitle;
            statutoryTitle = documentTitle;
            statutoryTitleLimb = anchorRow?.draft?.invoice?.seller?.taxRegistered
              ? 'tax_registered' : 'otherwise';
          }
        }
        // D4: a LIVE pay-link replaces the standing payment_instructions
        // block (the pack's localized fragment — never a code literal). The
        // link row is a DB read; Stripe is never called here.
        if (PAY_LINK_ACTION_TYPES.includes(action.action_type)) {
          const payLink = await getActivePayLinkForAnchor(client, {
            firmId, clientId, anchorType: action.anchor_type, anchorId: action.anchor_id
          });
          if (payLink?.status === 'active' && payLink.url) {
            const fragment = paymentLinkInstructionsForPack(pack, language);
            if (fragment) {
              values.payment_link_url = payLink.url;
              values.payment_instructions = fragment.replace(/\{\{payment_link_url\}\}/g, payLink.url);
            }
          }
        }
        // AR-4A: compose all dynamic values at the final template boundary.
        // buildLinesBlock may already carry isolates from the issuance mint;
        // this pass is deliberately idempotent and also covers the persisted
        // raw values plus party/clock/URL values resolved only at send time.
        values = bidiSafeRenderValues(values, { force: languageResolution.direction === 'rtl' });
        rendered = renderPackTemplate(pack, {
          template: action.template,
          language,
          values
        });
        // The issuance PDF artifacts (pack-driven: the pack's 'invoice_pdf' /
        // 'quote_pdf' template typeset onto the pack-declared page). A broken
        // artifact never blocks the send going out — the email IS the
        // complete document (the v1 posture) — but the degradation is
        // RECEIPTED via the artifact check below, never silent. The quote
        // artifact rides the quote SEND only, never a follow-up (the
        // follow-up is the reminder analog, and reminders carry no PDF).
        // AR-4B1's Unicode path understands the same isolate controls as the
        // email path and removes them only after UAX #9 has resolved visual
        // runs. Passing the one composed value set preserves LTR islands in
        // Arabic dates, formulas and identifiers; normal LTR documents carry
        // no controls and remain on the original pdf-lib renderer.
        if (action.action_type === 'issue_invoice') {
          try {
            attachment = await invoicePdfRenderer({
              pack, language, values
            });
          } catch (artifactError) {
            artifactFailure = String(artifactError?.message || artifactError);
          }
        } else if (action.action_type === 'send_quote' && action.template === 'quote_send') {
          try {
            attachment = await quotePdfRenderer({
              pack, language, values
            });
          } catch (artifactError) {
            artifactFailure = String(artifactError?.message || artifactError);
          }
        }
        const deliveryIdentity = completeOutboundSendingIdentity(ownerDirected ? null : identity);
        const deliveryHeaders = ownerDirected ? {} : buildUnsubscribeHeaders(
          buildOutboundUnsubscribeUrl(outboundPublicBaseUrl(env), action.unsubscribe_token)
        );
        emailArtifact = buildOutboundEmailArtifact({
          recipient,
          from: deliveryIdentity.from,
          replyTo: deliveryIdentity.replyTo,
          headers: deliveryHeaders,
          subject: rendered.subject,
          text: rendered.body,
          language,
          languageResolution,
          pack,
          templateName: action.template,
          statutoryTitle,
          statutoryTitleLimb,
          attachments: attachment ? [attachment] : []
        });

        // A language, fallback, recipient, pack/template version or statutory
        // title change after approval returns the action to its owner. The
        // established consequence hash remains untouched and independently
        // guards issuance economics.
        const guardedDeliveryContract = action.approved_delivery_contract_fingerprint
          && action.approved_delivery_contract_version != null
          && action.approved_delivery_contract_version !== 1;
        if (guardedDeliveryContract
            && (action.approved_delivery_contract_version !== OUTBOUND_DELIVERY_CONTRACT_VERSION
              || action.approved_delivery_contract_fingerprint !== emailArtifact.deliveryContractFingerprint)) {
          const reason = 'approved_delivery_contract_changed';
          await holdClaimedOutboundAction(client, {
            firmId, clientId, actionId: action.id, reasons: [reason]
          });
          await insertOutboundReceipt(client, {
            firmId, clientId, actionId: action.id, actionType: action.action_type,
            targetPartyId: action.target_party_id, channel: 'email', recipient,
            outcome: 'refused', reason,
            approvedBy: 'system:send_guard', authority: 'send_time_interlock',
            model: action.model || deterministicModelId(pack),
            requestedLanguage: languageResolution.requestedLanguage,
            actualLanguage: languageResolution.actualLanguage,
            languageSource: languageResolution.languageSource,
            languageFallbackBasis: languageResolution.fallbackBasis,
            correspondenceLocale: languageResolution.locale,
            templateName: action.template,
            templateCatalogId: pack.pack.id,
            templateCatalogVersion: pack.pack.version,
            deliveryContractVersion: OUTBOUND_DELIVERY_CONTRACT_VERSION,
            deliveryContractFingerprint: emailArtifact.deliveryContractFingerprint,
            checks: [{
              check: 'approved_delivery_contract_fingerprint', status: 'fail',
              detail: `approved v${action.approved_delivery_contract_version}:${action.approved_delivery_contract_fingerprint}, now v${OUTBOUND_DELIVERY_CONTRACT_VERSION}:${emailArtifact.deliveryContractFingerprint}`
            }],
            configSnapshotId: action.config_snapshot_id
          });
          await client.query('commit');
          stats.held_delivery_contract_changed += 1;
          continue;
        }
      } catch (renderError) {
        await markOutboundActionFailed(client, {
          firmId, clientId, actionId: action.id,
          error: `render_failed: ${renderError?.message || renderError}`,
          receipt: {
            channel: 'email', recipient, approvedBy, authority,
            model: action.model || (pack ? deterministicModelId(pack) : 'deterministic:pack'),
            requestedLanguage: languageResolution?.requestedLanguage || null,
            actualLanguage: languageResolution?.actualLanguage || null,
            languageSource: languageResolution?.languageSource || null,
            languageFallbackBasis: languageResolution?.fallbackBasis || null,
            correspondenceLocale: languageResolution?.locale || null,
            templateName: action.template,
            templateCatalogId: pack?.pack?.id || action.pack_id,
            templateCatalogVersion: pack?.pack?.version || null,
            deliveryContractVersion: OUTBOUND_DELIVERY_CONTRACT_VERSION,
            checks: [{ check: 'render', status: 'fail', detail: String(renderError?.message || renderError) }]
          }
        });
        await client.query('commit');
        stats.failed += 1;
        continue;
      }
      await client.query('commit');

      // ── Provider call OUTSIDE any transaction (INV-11). ───────────────────
      const deliver = deliverers.email;
      const model = action.model || deterministicModelId(pack);
      const checks = [
        // INV-S7: the receipt names which role's leash covered the send (or
        // that the leash observed a would-block in shadow — never silent).
        {
          check: 'role_leash',
          status: roleWouldBlock ? 'would_block' : 'pass',
          role: roleDecision.role_id || 'donna_core',
          ...(roleWouldBlock ? { detail: (roleDecision.reasons || []).join(',') } : {})
        },
        ...(ownerDirected
          ? [{ check: 'owner_directed', status: 'pass', detail: 'recipient is the owner profile email' }]
          : [
              { check: 'suppression', status: 'pass' },
              { check: 'do_not_contact', status: 'pass' }
            ]),
        { check: 'recipient_channel', status: 'pass' },
        ...(action.action_type === 'send_receivable_reminder'
          ? [{ check: 'paid_truth', status: 'pass', verdict: paidTruth }] : []),
        ...(ISSUANCE_ACTION_TYPES.includes(action.action_type)
          ? [{ check: 'anchor_state', status: 'pass' }] : []),
        ...(action.action_type === 'issue_invoice'
          ? [attachment
              ? { check: 'invoice_pdf', status: 'pass', detail: attachment.filename }
              : { check: 'invoice_pdf', status: 'degraded', detail: artifactFailure || 'artifact_unavailable' }]
          : []),
        ...(action.action_type === 'send_quote' && action.template === 'quote_send'
          ? [attachment
              ? { check: 'quote_pdf', status: 'pass', detail: attachment.filename }
              : { check: 'quote_pdf', status: 'degraded', detail: artifactFailure || 'artifact_unavailable' }]
          : []),
        ...(action.action_type === 'send_payable_notice'
          ? [{ check: 'payable_anchor_state', status: 'pass' }] : []),
        {
          check: 'correspondence_language', status: 'pass',
          requested_language: languageResolution.requestedLanguage,
          actual_language: languageResolution.actualLanguage,
          fallback_basis: languageResolution.fallbackBasis
        },
        { check: 'authority', status: 'pass', basis: authority }
      ];
      let providerResult = null;
      let providerError = null;
      if (typeof deliver !== 'function') {
        providerError = 'no_deliverer_for_channel:email';
      } else {
        try {
          // Owner-directed mail is Donna's own operational channel (the
          // digest's posture): default From identity, no unsubscribe headers
          // — the owner's out is the flag stage, not a suppression list.
          providerResult = await deliver({
            action, recipient, subject: emailArtifact.subject,
            body: emailArtifact.text, text: emailArtifact.text, html: emailArtifact.html,
            identity: ownerDirected ? null : identity,
            headers: ownerDirected ? {} : buildUnsubscribeHeaders(
              buildOutboundUnsubscribeUrl(outboundPublicBaseUrl(env), action.unsubscribe_token)
            ),
            ...(attachment ? { attachments: [attachment] } : {})
          });
        } catch (error) {
          providerError = error?.message || String(error);
        }
      }

      // ── Finalize transaction: flip + receipt together. ────────────────────
      await client.query('begin');
      if (providerError) {
        await markOutboundActionFailed(client, {
          firmId, clientId, actionId: action.id, error: providerError,
          receipt: {
            channel: 'email', recipient, approvedBy, authority, model,
            renderedSubject: emailArtifact.subject, renderedBody: emailArtifact.text,
            renderedHtml: emailArtifact.html,
            requestedLanguage: languageResolution.requestedLanguage,
            actualLanguage: languageResolution.actualLanguage,
            languageSource: languageResolution.languageSource,
            languageFallbackBasis: languageResolution.fallbackBasis,
            correspondenceLocale: languageResolution.locale,
            templateName: action.template,
            templateCatalogId: pack.pack.id,
            templateCatalogVersion: pack.pack.version,
            attachmentManifest: emailArtifact.attachmentManifest,
            contentFingerprint: emailArtifact.contentFingerprint,
            deliveryContractVersion: OUTBOUND_DELIVERY_CONTRACT_VERSION,
            deliveryContractFingerprint: emailArtifact.deliveryContractFingerprint,
            checks
          }
        });
        await client.query('commit');
        stats.failed += 1;
        continue;
      }
      // The AR ledger leg (the M2 'not_wired_outbound_m2' closer): runs FIRST
      // in the finalize txn so the send receipt carries its outcome. Savepoint-
      // guarded inside — a books refusal is a NAMED receipted skip, never a
      // blocked finalize (the send already happened).
      let arPost = null;
      if (action.action_type === 'issue_invoice') {
        arPost = await postIssuanceArLeg(client, {
          firmId, clientId, action, anchorRow, authority, approvedBy
        });
      }
      const finalized = await finalizeOutboundSend(client, {
        firmId, clientId, actionId: action.id,
        receipt: {
          channel: 'email', recipient, approvedBy, authority, model,
          renderedSubject: emailArtifact.subject, renderedBody: emailArtifact.text,
          renderedHtml: emailArtifact.html,
          requestedLanguage: languageResolution.requestedLanguage,
          actualLanguage: languageResolution.actualLanguage,
          languageSource: languageResolution.languageSource,
          languageFallbackBasis: languageResolution.fallbackBasis,
          correspondenceLocale: languageResolution.locale,
          templateName: action.template,
          templateCatalogId: pack.pack.id,
          templateCatalogVersion: pack.pack.version,
          attachmentManifest: emailArtifact.attachmentManifest,
          contentFingerprint: emailArtifact.contentFingerprint,
          deliveryContractVersion: OUTBOUND_DELIVERY_CONTRACT_VERSION,
          deliveryContractFingerprint: emailArtifact.deliveryContractFingerprint,
          providerMessageId: providerResult?.providerMessageId || null,
          checks: [
            ...checks,
            ...(arPost
              ? [arPost.status === 'posted'
                  ? { check: 'ar_ledger_post', status: 'pass', detail: arPost.journal_id }
                  : { check: 'ar_ledger_post', status: 'skipped', detail: arPost.reason }]
              : [])
          ]
        },
        payloadPatch: arPost?.status === 'posted' ? { ar_journal_id: arPost.journal_id } : null
      });
      // D6: a grant-carried send stamps the grant's use in the same txn.
      if (grant) {
        await recordActionGrantUse(client, { firmId, grantId: grant.id });
        stats.grant_authorized += 1;
      }
      // D1 earned-auto ladder: an owner-approved send that went out unchanged
      // is a CLEAN send — counted in the same finalize txn (savepoint-guarded
      // inside, so a pre-100 DB skips without poisoning the commit). Reaching
      // the target flips the ladder to 'earned'; graduation happens through
      // the audited config-plane writer only for a Kari-approved terminal.
      if (authority === 'per_send_owner_approval') {
        const ladder = await recordCleanApprovedSend(client, {
          firmId, clientId, actionType: action.action_type,
          actionId: action.id, receiptId: finalized?.receiptId || null,
          snapshot
        });
        if (!ladder?.skipped) {
          stats.clean_sends_recorded += 1;
          if (ladder.graduated) stats.ladder_graduated += 1;
        }
      }
      if (ISSUANCE_ACTION_TYPES.includes(action.action_type)) {
        // M2: lifecycle flip (invoice → issued; quote step 1 → sent) commits
        // WITH the send receipt, then the follow-on work mints through the
        // same gate (quote follow-ups; recurring next period).
        await finalizeIssuanceAnchor(client, {
          firmId, clientId, action, anchorRow, approvedBy, authority,
          recipient, providerMessageId: providerResult?.providerMessageId || null,
          arPost
        });
        await advanceIssuanceAfterSend(client, {
          firmId, clientId, action, pack, party, snapshot, env, now, recipient, stats
        });
      } else {
        const advance = await advanceCadence(client, {
          firmId, clientId, action, pack, snapshot, env, paidTruth, now, stats
        });
        // Case sync (G5): stamp the executed step; an exhausted cadence rests
        // the case ON THE OWNER (escalated) — the G9 digest renders it.
        await syncReceivableCaseAfterSend(client, {
          firmId, clientId, action,
          nextDueAt: advance.minted?.scheduled_for || null,
          exhausted: advance.exhausted,
          at: new Date(now).toISOString()
        });
      }
      await client.query('commit');
      stats.sent += 1;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      try {
        logger.warn?.(`[outboundActions] action ${dueAction.id} sweep failed: ${error?.message || error}`);
      } catch { /* never throw from the logger */ }
      stats.errors += 1;
    }
  }

  // Stale executing leases: surface, never auto-retry.
  try {
    const stale = await listStaleExecutingActions(client, { firmId, clientId });
    stats.stale_executing = stale.length;
    if (stale.length) {
      logger.warn?.(`[outboundActions] ${stale.length} stale executing lease(s) for client ${clientId} — must-review, not auto-retried`);
    }
  } catch { /* best-effort */ }
  return stats;
};
