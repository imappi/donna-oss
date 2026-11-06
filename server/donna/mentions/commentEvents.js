// Donna — universal @mentions: the comment event law (build 2 slice 3,
// docs/design-donna-universal-mentions.md §6).
//
// A comment is a chat-message row in the ARTIFACT'S existing thread — never a
// new event store — discriminated by the established payload.kind pattern:
//
//   { kind: 'comment', flavor, mentions: [structured refs],
//     supersedes_message_id? }         — human speech (edit = a NEW row
//                                        superseding the original; content is
//                                        never UPDATEd)
//   { kind: 'thread_resolution', outcome_note,
//     policy_memory_candidate? }       — the explicit resolution event; the
//                                        candidate flag is FLAG-ONLY for the
//                                        correction-compilation pass (D11),
//                                        never auto-compiled.
//
// Comments are NOT plain conversation: unlike a bare user turn, each one
// writes an audit row in the same transaction as the insert
// (audit-as-precondition, the G2 PR-12 posture). Redaction is the ONE
// sanctioned content mutation — mirroring the 119 erasure-scrub shape: the
// body is replaced by the marker, the payload is stamped, and the act is
// audited as an owner-capability action.
//
// Pure leaf: no DB, no LLM. The wiring writers (firmDb appenders + the
// redaction writer) consume these shapes; the routes validate mention refs
// via mentionResolution.js BEFORE any of this persists.

export const COMMENT_PAYLOAD_KINDS = Object.freeze(['comment', 'thread_resolution']);

export const COMMENT_AUDIT_ACTIONS = Object.freeze({
  posted: 'chat.comment_posted',
  edited: 'chat.comment_edited',
  redacted: 'chat.comment_redacted',
  thread_resolved: 'chat.thread_resolved'
});

// The redaction marker body. The original text is GONE from the row (that is
// redaction's legal point); the audit row records the act, never the text.
export const REDACTED_CONTENT_MARKER = '[redacted]';

const norm = (v) => (v == null ? '' : String(v).trim());

// Build the persisted payload for a comment row from an ALREADY-VALIDATED
// mention submission (mentionResolution.validateMentionSubmission — callers
// must refuse before reaching here; this module re-checks only shape, not
// eligibility, and throws on the violations a route bug could produce).
export const buildCommentPayload = ({
  flavor = 'mention',
  mentions = [],
  supersedesMessageId = null,
  askId = null
} = {}) => {
  const refs = (Array.isArray(mentions) ? mentions : []).map((m) => ({
    actor_type: norm(m?.actor_type),
    ...(norm(m?.actor_type) === 'seat'
      ? { principal_type: norm(m?.principal_type), principal_id: norm(m?.principal_id) }
      : { agent_id: norm(m?.agent_id), role: norm(m?.role) || null }),
    display: norm(m?.display) || null
  }));
  if (refs.some((r) => r.actor_type !== 'seat' && r.actor_type !== 'agent')) {
    throw new Error('buildCommentPayload: unvalidated mention ref reached the payload builder.');
  }
  return {
    kind: 'comment',
    flavor: norm(flavor) || 'mention',
    mentions: refs,
    ...(supersedesMessageId ? { supersedes_message_id: String(supersedesMessageId) } : {}),
    // The ask the ASK flavor minted (slice 2's primitive), so the thread row
    // and the blocker point at each other.
    ...(askId ? { ask_id: String(askId) } : {})
  };
};

export const buildThreadResolutionPayload = ({
  outcomeNote = '',
  policyMemoryCandidate = false
} = {}) => ({
  kind: 'thread_resolution',
  outcome_note: norm(outcomeNote) || null,
  // FLAG ONLY (D11): the correction-compilation pass keeps its own review
  // gate; nothing auto-compiles off this bit.
  policy_memory_candidate: policyMemoryCandidate === true
});

export const isCommentPayload = (payload = {}) =>
  COMMENT_PAYLOAD_KINDS.includes(norm(payload?.kind));

// The audit event for a comment-lane row, computed BEFORE the insert so the
// wiring writer commits both or neither (the __chatProposalAuditEvent
// pattern, for human speech instead of machine proposals). Returns null for
// anything that is not a comment-lane row — plain conversation stays
// un-audited, exactly as before.
// `actorSeat` (optional): the acting SEAT's ladder metadata
// ({ seat_role, affiliation }) — present only when the poster is a staff
// seat, mirroring how the seat.* receipts carry it (build 1). The receipt
// then answers "which human, wearing which role" without a join.
export const chatCommentAuditEvent = ({ surface, message, actorId = null, threadRef = {}, actorSeat = null } = {}) => {
  const payload = message?.payload || {};
  if (!message?.id || !isCommentPayload(payload)) return null;
  const kind = norm(payload.kind);
  const action = kind === 'thread_resolution'
    ? COMMENT_AUDIT_ACTIONS.thread_resolved
    : (payload.supersedes_message_id ? COMMENT_AUDIT_ACTIONS.edited : COMMENT_AUDIT_ACTIONS.posted);
  const resourceType = surface === 'document_chat'
    ? 'document_chat_message'
    : surface === 'client_chat'
      ? 'client_chat_message'
      : surface === 'firm_feed_chat'
        ? 'firm_chat_message'
        : 'transaction_chat_message';
  return {
    action,
    resourceType,
    resourceId: message.id,
    actorId: norm(actorId) || null,
    metadata: {
      surface,
      kind,
      ...(norm(actorSeat?.seat_role)
        ? {
            actor_seat_role: norm(actorSeat.seat_role),
            actor_affiliation: norm(actorSeat.affiliation) === 'external' ? 'external' : 'internal'
          }
        : {}),
      ...(kind === 'comment'
        ? {
            flavor: norm(payload.flavor) || 'mention',
            mention_count: Array.isArray(payload.mentions) ? payload.mentions.length : 0,
            mention_actors: (Array.isArray(payload.mentions) ? payload.mentions : [])
              .map((m) => (m?.actor_type === 'seat'
                ? `seat:${m.principal_type}:${m.principal_id}`
                : `agent:${m?.agent_id || ''}`)),
            ...(payload.supersedes_message_id ? { supersedes_message_id: payload.supersedes_message_id } : {}),
            ...(payload.ask_id ? { ask_id: payload.ask_id } : {})
          }
        : {
            policy_memory_candidate: payload.policy_memory_candidate === true
          }),
      ...threadRef
    }
  };
};

// Who holds an artifact now — a PROJECTION over the persisted comment lane,
// never a store (slice 4 /assign; the notification row is delivery state and
// the audit row the receipt, so assignment state has exactly one source: the
// latest un-redacted 'assign' comment on the thread). Returns null when the
// artifact was never assigned. Rows may be raw DB rows or mapped payloads;
// order does not matter (created_at decides).
export const latestAssignmentFromComments = (rows = []) => {
  let latest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const payload = row?.payload || {};
    if (norm(payload.kind) !== 'comment' || norm(payload.flavor) !== 'assign') continue;
    if (payload.content_redacted === true) continue;
    const addressee = (Array.isArray(payload.mentions) ? payload.mentions : [])
      .find((m) => norm(m?.actor_type) === 'seat');
    if (!addressee) continue;
    const at = row?.created_at ? new Date(row.created_at).getTime() : 0;
    if (latest && at < latest.__at) continue;
    latest = {
      __at: at,
      assigned_to: {
        principal_type: norm(addressee.principal_type),
        principal_id: norm(addressee.principal_id),
        display: norm(addressee.display) || null
      },
      assigned_by: norm(row?.actor_id) || null,
      assigned_at: row?.created_at || null,
      note: norm(row?.content) || null,
      message_id: row?.id || null
    };
  }
  if (!latest) return null;
  const { __at, ...assignment } = latest;
  return assignment;
};

// The payload stamp a redaction leaves on the row (the content itself becomes
// REDACTED_CONTENT_MARKER; the stamp is the in-row receipt, the audit row the
// durable one — both carry the actor).
export const redactionPayloadStamp = ({ actorId, reason = null } = {}) => ({
  content_redacted: true,
  redacted_by: norm(actorId) || null,
  ...(norm(reason) ? { redaction_reason: norm(reason) } : {})
});
