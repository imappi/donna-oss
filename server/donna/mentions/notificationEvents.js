// Donna — universal @mentions: the notification law (build 2 slice 4,
// docs/design-donna-universal-mentions.md §7, D10).
//
// Notifications are DELIVERY STATE for named customer-side HUMANS — "did this
// principal see this event" — never a work store and never an agent channel:
//
//   - The store of record stays where it always was: the comment row (123)
//     with its audit receipt, the ask row (122). A notification row can hide
//     nothing load-bearing — the Mentions lane reads open seat asks LIVE from
//     client_evidence_requests and uses mention_notifications (124) only for
//     mention/assign entries and unread state.
//   - AGENTS are never notified: the runtime picks its asks up from the store
//     of record. An agent-addressed notification row would be the forbidden
//     agent-resting-state with extra steps, so the row builder refuses to
//     mint one (agents are simply skipped at fan-out).
//   - Fan-out reaches ELIGIBLE principals only (§3 defense-in-depth layer 2):
//     rows are built from mention refs the roster already validated in the
//     same request, so a ref outside the artifact's client eligibility cannot
//     reach this builder without having been refused upstream.
//
// Deterministic ids make fan-out idempotent (insert .. on conflict do
// nothing): a retried write cannot double-notify.
//
// Pure leaf: node:crypto only — no DB, no LLM — so it loads in-sandbox under
// `node --test`, same discipline as mentionResolution.js / commentEvents.js.

import { createHash } from 'node:crypto';

export const MENTION_NOTIFICATION_KINDS = Object.freeze([
  'mention',        // a plain @mention on an artifact comment
  'assign',         // ownership handed to the recipient (/assign)
  'ask',            // a seat-audience blocking question addressed to the recipient
  'ask_answered',   // an ask the recipient minted got its answer (agent lane)
  'agent_escalation'// an instructed agent escalated back to the recipient
]);

export const NOTIFIABLE_PRINCIPAL_TYPES = Object.freeze(['firm_member', 'firm_collaborator']);

const norm = (v) => (v == null ? '' : String(v).trim());
const lower = (v) => norm(v).toLowerCase();

// One line, bounded — what the lane and the digest render. Never the whole
// comment: the artifact thread is one click away.
export const notificationExcerpt = (text, max = 140) => {
  const firstLine = norm(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
};

export const mentionNotificationId = ({
  firmId, principalType, principalId, kind, messageId = null, askId = null
} = {}) => {
  const key = [
    lower(firmId), lower(principalType), norm(principalId),
    lower(kind), norm(messageId), norm(askId)
  ].join('|');
  return `ntf-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
};

const artifactTypeForSurface = (surface) =>
  (lower(surface) === 'document_chat' ? 'document' : 'transaction');

// Fan-out rows for one validated comment submission. `resolvedMentions` are
// roster entries from validateMentionSubmission (already eligible); agent
// entries and the acting principal are skipped — you are not notified of
// your own words.
export const buildMentionNotificationRows = ({
  firmId,
  clientId,
  surface,
  threadId,
  messageId,
  askId = null,
  flavor = 'mention',
  resolvedMentions = [],
  actorPrincipal = null, // { principal_type, principal_id } of the poster
  actorId = null,
  actorDisplay = null,
  text = '',
  now = null
} = {}) => {
  const kind = lower(flavor) === 'assign' ? 'assign' : lower(flavor) === 'ask' ? 'ask' : 'mention';
  const artifactType = artifactTypeForSurface(surface);
  const createdAt = now instanceof Date ? now.toISOString() : new Date().toISOString();
  const rows = [];
  for (const m of Array.isArray(resolvedMentions) ? resolvedMentions : []) {
    if (lower(m?.actor_type) !== 'seat') continue; // agents are never notified
    const principalType = lower(m?.principal_type);
    const principalId = norm(m?.principal_id);
    if (!NOTIFIABLE_PRINCIPAL_TYPES.includes(principalType) || !principalId) continue;
    if (actorPrincipal
      && lower(actorPrincipal.principal_type) === principalType
      && norm(actorPrincipal.principal_id) === principalId) continue;
    rows.push({
      id: mentionNotificationId({ firmId, principalType, principalId, kind, messageId, askId }),
      firm_id: firmId,
      client_id: clientId,
      principal_type: principalType,
      principal_id: principalId,
      kind,
      artifact_type: artifactType,
      artifact_id: norm(threadId),
      actor_id: norm(actorId) || null,
      actor_display: norm(actorDisplay) || null,
      excerpt: notificationExcerpt(text) || null,
      message_id: norm(messageId) || null,
      ask_id: norm(askId) || null,
      created_at: createdAt
    });
  }
  return rows;
};

// A single runtime-produced notification (the agent lane: ask_answered /
// agent_escalation back to the instructing seat).
export const buildRuntimeNotificationRow = ({
  firmId,
  clientId,
  kind,
  artifactType,
  artifactId,
  principal = null, // { principal_type, principal_id }
  actorId = null,
  actorDisplay = null,
  text = '',
  askId = null,
  messageId = null,
  now = null
} = {}) => {
  if (!MENTION_NOTIFICATION_KINDS.includes(lower(kind))) return null;
  const principalType = lower(principal?.principal_type);
  const principalId = norm(principal?.principal_id);
  if (!NOTIFIABLE_PRINCIPAL_TYPES.includes(principalType) || !principalId) return null;
  return {
    id: mentionNotificationId({ firmId, principalType, principalId, kind: lower(kind), messageId, askId }),
    firm_id: firmId,
    client_id: clientId,
    principal_type: principalType,
    principal_id: principalId,
    kind: lower(kind),
    artifact_type: lower(artifactType) === 'document' ? 'document' : 'transaction',
    artifact_id: norm(artifactId),
    actor_id: norm(actorId) || null,
    actor_display: norm(actorDisplay) || null,
    excerpt: notificationExcerpt(text) || null,
    message_id: norm(messageId) || null,
    ask_id: norm(askId) || null,
    created_at: now instanceof Date ? now.toISOString() : new Date().toISOString()
  };
};

// The §7 payload shape, verbatim — written for contract/mobile-api.yaml to
// adopt (D8: the yaml change itself belongs to the mobile session, never
// this repo's). Keep the keys stable.
export const buildNotificationPayload = (row = {}) => ({
  kind: norm(row.kind),
  artifact: {
    type: norm(row.artifact_type),
    id: norm(row.artifact_id),
    client_id: norm(row.client_id)
  },
  actor: {
    id: norm(row.actor_id) || null,
    display: norm(row.actor_display) || null
  },
  excerpt: norm(row.excerpt) || null,
  deep_link: null // reserved for the mobile contract; the app navigates from artifact refs
});

// Digest wording (§7 — proposed to Kari, veto welcome):
//   headline: "2 questions waiting on you · 3 mentions"
//   items:    `<actor> asked on <artifact>: "<first line>"`
export const buildMentionDigest = ({ openAsks = [], notifications = [] } = {}) => {
  const askCount = Array.isArray(openAsks) ? openAsks.length : 0;
  const mentionRows = (Array.isArray(notifications) ? notifications : [])
    .filter((n) => !n.read_at && (n.kind === 'mention' || n.kind === 'assign'));
  const parts = [];
  if (askCount > 0) parts.push(`${askCount} question${askCount === 1 ? '' : 's'} waiting on you`);
  if (mentionRows.length > 0) parts.push(`${mentionRows.length} mention${mentionRows.length === 1 ? '' : 's'}`);
  const artifactLabel = (row) =>
    `${norm(row.artifact_type) || 'artifact'} ${norm(row.artifact_id || row.transaction_id || row.document_id)}`.trim();
  // An actor id is often an email (chatApplyActorId); the digest line renders
  // the local part, same fallback the roster display uses.
  const actorLabel = (value) => {
    const v = norm(value);
    return (v.includes('@') ? v.slice(0, v.indexOf('@')) : v) || 'A colleague';
  };
  const items = [
    ...openAsks.map((a) => `${actorLabel(a.actor_display || a.created_by)} asked on ${artifactLabel(a)}: "${notificationExcerpt(a.question || a.excerpt || '')}"`),
    ...mentionRows.map((n) => `${actorLabel(n.actor_display || n.actor_id)} ${n.kind === 'assign' ? 'assigned you' : 'mentioned you'} on ${artifactLabel(n)}: "${norm(n.excerpt)}"`)
  ];
  return { headline: parts.join(' · '), items, ask_count: askCount, mention_count: mentionRows.length };
};
