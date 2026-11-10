// G15/D12 — the owner Actions surface (the workspace tab the digest
// deep-links into). D12 recorded the existing entity workspace as the owner
// dashboard shell; this module is the tab's server half.
//
// Read posture (render the persisted verdict): the tab renders THE SAME
// gather the digest email renders — gatherOwnerDigest — plus the digest's own
// display copy (describePendingAction / holdCopyFor / GAP_COPY). No parallel
// gather logic, no UI-layer inference call, no second phrasing table. The one
// divergence is a READ option on that gather (includeNotifiedAutoSent): the
// email FYIs each auto-send exactly once, the standing tab shows the whole
// recent window.
//
// Write posture (no-third-spine): every mutation routes to the EXISTING
// audited writers — approveOutboundAction / cancelOutboundAction (the same
// pair the digest's one-tap links hit, same idempotency: a second decision
// reports the already-decided state), editHeldOutboundActionDraft (the
// bounded edit writer, which records the D1 'edited_held_draft' correction
// itself — writer-level, so no surface can skip it), and the receivable-case
// owner verbs pauseReceivableCase / markReceivableCaseDisputed. This module
// adds transactions and response shaping only — zero new apply paths.
//
// Token hygiene: the read NEVER returns approval/unsubscribe bearer tokens.
// The workspace acts through authenticated routes; the tokens stay an
// email-capability concern.
//
// Sections mirror the digest: needs-approval, must-review (failed + stale +
// escalated), needs-info, sent-FYI (decide-and-notify — read-only, never a
// click queue; the ONE recorded exception is the quiet reply_if_wrong
// corrective verb below, which changes no action state), and the EARNED FYI.
//
// Keep-layer posture: deterministic reads + writer-routed mutations. No LLM.

import { readClientConfigSnapshot } from '../clientConfig.js';
import {
  outboundGateMode, OUTBOUND_ACTION_TYPES, OWNER_DIRECTED_ACTION_TYPES
} from './actionGate.js';
import {
  approveOutboundAction, cancelOutboundAction,
  editHeldOutboundActionDraft, markExecutedOutboundActionWrong,
  reverseExecutedOutboundArPost,
  EDITABLE_DRAFT_RENDER_KEYS
} from './actionStore.js';
import {
  gatherOwnerDigest, describePendingAction, describeOwnerReply, holdCopyFor,
  ownerActionLanguageFor, GAP_COPY, ACTION_TYPE_LABELS, BLOCKED_RECURRENCE_COPY
} from './ownerDigest.js';
import {
  pauseReceivableCase, markReceivableCaseDisputed, syncReceivableCaseAfterCancel
} from './receivableCases.js';
import { cleanSendTargetFor } from './earnedAutoLadder.js';
import { setPartyAttribute } from './partyStore.js';
import { loadOutboundPack } from './packs.js';

const pickEditableValues = (action) => {
  const values = action?.payload?.render_values || {};
  const out = {};
  for (const key of EDITABLE_DRAFT_RENDER_KEYS) {
    if (values[key] !== undefined && values[key] !== null) out[key] = values[key];
  }
  return out;
};

const shapeCase = (caseRow) => ({
  id: caseRow.id,
  status: caseRow.status,
  invoice_number: caseRow.invoice_number || null,
  anchor_id: caseRow.anchor_id,
  amount: caseRow.amount != null ? caseRow.amount : null,
  currency: caseRow.currency || null,
  current_step: Number(caseRow.current_step) || 0,
  gaps: String(caseRow.status_reason || '').split(',')
    .map((g) => g.trim()).filter(Boolean)
    .map((g) => ({ reason: g, copy: GAP_COPY[g] || g }))
});

// The tab's read: one gather, shaped for display, tokens withheld.
export const readOwnerActionsSurface = async (client, {
  firmId, clientId, env = process.env
}) => {
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  const pipelineActive = OUTBOUND_ACTION_TYPES.some(
    (actionType) => outboundGateMode({ actionType, snapshot, env }).mode === 'act'
  );
  const digest = await gatherOwnerDigest(client, {
    firmId, clientId, includeNotifiedAutoSent: true, includeNotifiedOwnerReplies: true
  });

  return {
    pipeline_active: pipelineActive,
    editable_keys: [...EDITABLE_DRAFT_RENDER_KEYS],
    blocked_invoices: digest.pending.filter((action) => action.invoice_admission_refusal).map((action) => ({
      id: action.id, description: describePendingAction(action), explanation: holdCopyFor(action),
      heading: 'Blocked invoices', stop_label: 'Don’t send'
    })),
    blocked_recurrences: digest.pending.filter((action) => action.payload?.recurrence_refusal).map((action) => ({
      id: action.id, description: describePendingAction(action),
      explanation: holdCopyFor(action), next_issue_date: action.payload.recurrence_refusal.next_issue_date,
      heading: BLOCKED_RECURRENCE_COPY.heading, stop_label: BLOCKED_RECURRENCE_COPY.stop
    })),
    pending: digest.pending.filter((action) => !action.payload?.recurrence_refusal && !action.invoice_admission_refusal).map((action) => {
      const language = ownerActionLanguageFor(action);
      return ({
      id: action.id,
      action_type: action.action_type,
      owner_directed: OWNER_DIRECTED_ACTION_TYPES.includes(action.action_type),
      description: describePendingAction(action),
      hold_copy: holdCopyFor(action),
      approval_blocked: language.reason === 'requested_language_unavailable',
      language,
      party_name: action.party_name || null,
      amount: action.amount != null ? action.amount : null,
      currency: action.currency || null,
      cadence_step: Number(action.cadence_step) || 0,
      created_at: action.created_at || null,
      editable_values: pickEditableValues(action)
      });
    }),
    failed: digest.failed.map((action) => ({
      id: action.id,
      description: describePendingAction(action),
      send_error: action.send_error || null,
      party_name: action.party_name || null,
      updated_at: action.updated_at || null
    })),
    stale: digest.stale.map((action) => ({
      id: action.id,
      party_name: action.party_name || null,
      claimed_at: action.claimed_at || null
    })),
    escalated: digest.escalated.map(shapeCase),
    needs_input: digest.needsInput.map(shapeCase),
    auto_sent: digest.autoSent.map((action) => ({
      id: action.id,
      description: describePendingAction(action),
      sent_at: action.receipt_created_at || null,
      // The corrective verbs the sent-FYI carries (reply_if_wrong v1 +
      // post_send_reversal): already-acted rows render the quiet
      // acknowledgement, not the button.
      marked_wrong_at: action.payload?.owner_marked_wrong_at || null,
      // post_send_reversal: only an issue_invoice whose AR leg POSTED carries
      // the reverse verb; a reversed row renders the acknowledgement.
      ar_journal_id: action.action_type === 'issue_invoice'
        ? action.payload?.ar_journal_id || null : null,
      ar_post_reversed_at: action.payload?.ar_post_reversed_at || null
    })),
    earned: digest.earned.map((row) => ({
      id: row.id,
      action_type: row.action_type,
      label: ACTION_TYPE_LABELS[row.action_type] || String(row.action_type).replace(/_/g, ' '),
      clean_streak: Number(row.clean_streak) || 0,
      clean_target: cleanSendTargetFor(row)
    })),
    // reply_if_wrong v2: email replies Donna read but couldn't act on — the
    // digest line's standing twin (the whole recent needs_owner window, the
    // includeNotifiedAutoSent shape). Same phrasing home as the digest; the
    // owner acts via the existing mark-wrong verb on the sent-FYI rows.
    owner_replies: (digest.ownerReplies || []).map((reply) => ({
      id: reply.id,
      subject: reply.subject || null,
      received_at: reply.received_at || reply.created_at || null,
      description: describeOwnerReply(reply)
    }))
  };
};

// Party-language correction or explicit fallback consent is action-keyed at
// the authenticated surface.
// Browser input never names a raw party id; this wrapper resolves scope and
// routes the mutation through the existing effective-dated party writer.
export const setOwnerActionPartyLanguage = async (client, {
  firmId, clientId, actionId, attribute, language, actorType, actorId = null
}) => {
  if (!['preferred_language', 'fallback_language'].includes(attribute)) {
    const error = new Error('Language control must change the preference or explicit fallback.');
    error.statusCode = 400;
    error.code = 'OUTBOUND_LANGUAGE_ATTRIBUTE_INVALID';
    throw error;
  }
  const value = String(language || '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(value)) {
    const error = new Error('Language must be a two-letter code.');
    error.statusCode = 400;
    error.code = 'OUTBOUND_PARTY_LANGUAGE_INVALID';
    throw error;
  }
  await client.query('begin');
  try {
    const action = await client.query(
      `select a.id, a.action_type, a.status, a.target_party_id, a.pack_id,
              p.preferred_language, p.fallback_language
         from outbound_actions a
         join client_parties p on p.id = a.target_party_id
        where a.id = $1 and a.firm_id = $2 and a.client_id = $3`,
      [actionId, firmId, clientId]
    ).then((result) => result.rows[0] || null);
    if (!action) {
      const error = new Error('Action not found.');
      error.statusCode = 404;
      error.code = 'OUTBOUND_ACTION_NOT_FOUND';
      throw error;
    }
    if (action.status !== 'hold_for_approval'
        || OWNER_DIRECTED_ACTION_TYPES.includes(action.action_type)) {
      const error = new Error('Party language controls are not available for this action.');
      error.statusCode = 409;
      error.code = 'OUTBOUND_FALLBACK_NOT_APPLICABLE';
      throw error;
    }
    const pack = loadOutboundPack(action.pack_id);
    if (!pack.correspondence.languages.includes(value)) {
      const error = new Error('That language is not supported by this pack.');
      error.statusCode = 400;
      error.code = 'OUTBOUND_PARTY_LANGUAGE_UNSUPPORTED';
      throw error;
    }
    if (action[attribute] === value) {
      await client.query('commit');
      return { updated: false, attribute, language: value };
    }
    await setPartyAttribute(client, {
      firmId, clientId, partyId: action.target_party_id,
      attribute, value,
      source: 'owner_action_language_control', actorType, actorId
    });
    await client.query('commit');
    return { updated: true, attribute, language: value };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

// The owner's optional note on a decline or a "this was wrong": their own
// words, trimmed, at most 2000 characters, stored on the decision's audit row.
export const OWNER_NOTE_MAX_LENGTH = 2000;
export const normalizeOwnerNote = (note) => {
  if (note == null) return null;
  if (typeof note !== 'string' || note.trim().length > OWNER_NOTE_MAX_LENGTH) {
    const error = new Error(`note must be text of at most ${OWNER_NOTE_MAX_LENGTH} characters.`);
    error.statusCode = 400;
    error.code = 'OWNER_NOTE_INVALID';
    throw error;
  }
  return note.trim() || null;
};

// Approve / decline a held action — the workspace twin of the digest link
// route: same writers, same idempotency, the authenticated principal instead
// of the bearer token. Owns one transaction. `note` (decline only) and
// `channel` land on the writer's own audit row in that transaction.
export const decideOwnerAction = async (client, {
  firmId, clientId, actionId, decision, actorType, actorId = null, note = null, channel = null
}) => {
  if (!['approve', 'decline'].includes(decision)) {
    const error = new Error(`Unknown decision '${decision}'.`);
    error.statusCode = 400;
    error.code = 'OUTBOUND_DECISION_UNKNOWN';
    throw error;
  }
  const ownerNote = normalizeOwnerNote(note);
  if (ownerNote && decision !== 'decline') {
    const error = new Error('A note is recorded with a decline only.');
    error.statusCode = 400;
    error.code = 'OWNER_NOTE_NOT_ACCEPTED';
    throw error;
  }
  const action = await client.query(
    'select * from outbound_actions where id = $1 and firm_id = $2 and client_id = $3',
    [actionId, firmId, clientId]
  ).then((r) => r.rows[0] || null);
  if (!action) {
    const error = new Error('Action not found.');
    error.statusCode = 404;
    error.code = 'OUTBOUND_ACTION_NOT_FOUND';
    throw error;
  }
  if (action.status !== 'hold_for_approval') {
    return { decided: false, already: action.status };
  }
  await client.query('begin');
  try {
    if (decision === 'approve') {
      const approved = await approveOutboundAction(client, {
        firmId, clientId, actionId, actorType, actorId, channel
      });
      await client.query('commit');
      return approved
        ? { decided: true, decision: 'approve', status: approved.status }
        : { decided: false, already: 'decided_concurrently' };
    }
    const cancelled = await cancelOutboundAction(client, {
      firmId, clientId, actionId, reason: 'owner_declined',
      actorType, actorId, authority: 'per_send_owner_decline', note: ownerNote, channel
    });
    if (cancelled) {
      await syncReceivableCaseAfterCancel(client, {
        firmId, clientId, action: cancelled, reasons: ['owner_declined']
      });
    }
    await client.query('commit');
    return cancelled
      ? { decided: true, decision: 'decline', status: cancelled.status }
      : { decided: false, already: 'decided_concurrently' };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

// Owner edit of a held draft. The writer refuses non-held rows and non-
// editable keys, and records the D1 correction itself. Owns one transaction.
export const editOwnerHeldDraft = async (client, {
  firmId, clientId, actionId, renderValues, actorType, actorId = null
}) => {
  await client.query('begin');
  let edited;
  try {
    edited = await editHeldOutboundActionDraft(client, {
      firmId, clientId, actionId, renderValues, actorType, actorId
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    if (!error.statusCode && error.code === 'OUTBOUND_EDIT_KEY_FORBIDDEN') error.statusCode = 400;
    if (!error.statusCode && error.code === 'OUTBOUND_EDIT_EMPTY') error.statusCode = 400;
    throw error;
  }
  if (edited) {
    return { edited: true, editable_values: pickEditableValues(edited) };
  }
  const action = await client.query(
    'select status from outbound_actions where id = $1 and firm_id = $2 and client_id = $3',
    [actionId, firmId, clientId]
  ).then((r) => r.rows[0] || null);
  if (!action) {
    const error = new Error('Action not found.');
    error.statusCode = 404;
    error.code = 'OUTBOUND_ACTION_NOT_FOUND';
    throw error;
  }
  return { edited: false, already: action.status };
};

// Owner "this was wrong" on a sent-FYI row — the reply_if_wrong verb. Routes
// to the WRITER (which records the D1 correction itself and is idempotent at
// the UPDATE's WHERE guard); this wrapper adds the transaction and the
// already-marked / not-executed idempotency report. No action-state change:
// the send happened — this is a correction record, not a cancel.
export const markOwnerAutoSentWrong = async (client, {
  firmId, clientId, actionId, actorType, actorId = null, channel = null, note = null
}) => {
  const ownerNote = normalizeOwnerNote(note);
  await client.query('begin');
  let marked;
  try {
    marked = await markExecutedOutboundActionWrong(client, {
      firmId, clientId, actionId, actorType, actorId, channel, note: ownerNote
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  if (marked) {
    return { marked: true, marked_wrong_at: marked.payload?.owner_marked_wrong_at || null };
  }
  const action = await client.query(
    'select status, payload from outbound_actions where id = $1 and firm_id = $2 and client_id = $3',
    [actionId, firmId, clientId]
  ).then((r) => r.rows[0] || null);
  if (!action) {
    const error = new Error('Action not found.');
    error.statusCode = 404;
    error.code = 'OUTBOUND_ACTION_NOT_FOUND';
    throw error;
  }
  if (action.payload?.owner_marked_wrong_at) {
    return { marked: false, already: 'marked' };
  }
  return { marked: false, already: action.status };
};

// Owner "reverse this invoice's books entry" on a sent-FYI issue_invoice row —
// the post_send_reversal verb. Routes to the WRITER (which reverses through
// the firmDb correction machinery, records the D1 correction itself, and is
// idempotent at the UPDATE's WHERE guard); this wrapper adds the transaction
// and the already/not-applicable idempotency report. Workspace-click only —
// the email-reply channel never reaches this.
export const reverseOwnerAutoSentPost = async (client, {
  firmId, clientId, actionId, actorType, actorId = null
}) => {
  await client.query('begin');
  let reversed;
  try {
    reversed = await reverseExecutedOutboundArPost(client, {
      firmId, clientId, actionId, actorType, actorId
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  if (reversed) {
    return {
      reversed: true,
      reversal_journal_id: reversed.reversal.reversal_journal_id,
      ar_post_reversed_at: reversed.action.payload?.ar_post_reversed_at || null
    };
  }
  const action = await client.query(
    'select status, action_type, payload from outbound_actions where id = $1 and firm_id = $2 and client_id = $3',
    [actionId, firmId, clientId]
  ).then((r) => r.rows[0] || null);
  if (!action) {
    const error = new Error('Action not found.');
    error.statusCode = 404;
    error.code = 'OUTBOUND_ACTION_NOT_FOUND';
    throw error;
  }
  if (action.payload?.ar_post_reversed_at) {
    return { reversed: false, already: 'reversed' };
  }
  if (action.action_type !== 'issue_invoice' || !action.payload?.ar_journal_id) {
    return { reversed: false, already: 'no_ar_post' };
  }
  return { reversed: false, already: action.status };
};

// Pause / dispute a receivable case — the existing owner case verbs, wrapped
// in one transaction. Both rest the case on the owner (their terminal until
// the owner acts again).
export const actOnOwnerReceivableCase = async (client, {
  firmId, clientId, caseId, verb, reason = null, actorType, actorId = null
}) => {
  if (!['pause', 'dispute'].includes(verb)) {
    const error = new Error(`Unknown case verb '${verb}'.`);
    error.statusCode = 400;
    error.code = 'RECEIVABLE_CASE_VERB_UNKNOWN';
    throw error;
  }
  await client.query('begin');
  let updated;
  try {
    updated = verb === 'pause'
      ? await pauseReceivableCase(client, {
          firmId, clientId, caseId,
          reason: reason || 'owner_paused', actorType, actorId
        })
      : await markReceivableCaseDisputed(client, {
          firmId, clientId, caseId,
          reason: reason || 'owner_reported_dispute', actorType, actorId
        });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  if (updated) return { applied: true, status: updated.status };
  const row = await client.query(
    'select status from receivable_cases where id = $1 and firm_id = $2 and client_id = $3',
    [caseId, firmId, clientId]
  ).then((r) => r.rows[0] || null);
  if (!row) {
    const error = new Error('Case not found.');
    error.statusCode = 404;
    error.code = 'RECEIVABLE_CASE_NOT_FOUND';
    throw error;
  }
  return { applied: false, already: row.status };
};
