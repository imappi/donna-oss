// buildCaseTimeline — Slice 1 of the per-line audit timeline
// (docs/design-donna-line-audit-timeline.md).
//
// PURE merge of PERSISTED receipts into one time-ordered event list — the
// read model behind the line drawer's Audit tab. No DB access, no LLM call:
// prose is a RENDER concern (Slice 2 templates over these fields), and
// re-narrating receipts with a fresh model call is the design's named
// anti-pattern (§5.1 — a narrated trace that can drift from the receipts is
// fabricated transparency). If a step left no receipt, the hole is VISIBLE
// (`gaps`), never papered over.
//
// Consumed by operatorCaseSnapshot's `timeline` include block (the ONE
// assembler — §5.2 forbids a second per-line read path). This module stays
// pure so the merge policy is unit-testable without a DB, the same split as
// reconcileConvergenceState.
//
// Event shape (stable — the drawer and any future consumer key off it):
//   { at, kind, actor, actor_id, actor_name, density, fields, receipt_ref }
//   - at:          ISO timestamp string, or null when the receipt carries no
//                  time (null-at events sort LAST, never dropped).
//   - kind:        one of TIMELINE_EVENT_KINDS.
//   - density:     'owner' — rendered in the default owner view;
//                  'debug'  — rendered only in the debug (firm/Kari) view.
//                  Density gates whole events; owner templates additionally
//                  choose which FIELDS to prose-ify. One timeline, two
//                  densities — never two systems (§7).
//   - fields:      the receipt's own persisted fields, flat and verbatim.
//   - receipt_ref: { table, id, path? } — where the underlying receipt
//                  lives, so every rendered line is answerable to its row.

export const TIMELINE_EVENT_KINDS = Object.freeze([
  'document_received',   // documents — persisted evidence provenance
  'transaction_imported', // transactions — bank-line intake provenance
  'triage_evaluation',   // reconciliation_evaluations — a matcher family ran
  'match',               // reconciliation_matches — proposed/settled, with the authority receipt
  'cascade',             // match payload.cascade — the settle cascade outcome
  'coding_suggested',    // transactions.payload.ai_suggestion — the coder's proposal
  'ask_drafted',         // client_evidence_requests.created_at
  'ask_sent',            // client_evidence_requests.first_sent_at
  'ask_replied',         // client_evidence_requests.responded_at
  'ask_resolved',        // client_evidence_requests.resolved_at
  'comment',             // chat-message rows with payload.kind 'comment' /
                         // 'thread_resolution' — human deliberation on the
                         // artifact (universal mentions slice 3). Verbatim
                         // text at fields.text, never re-narrated.
  'audit'                // audit_events — every other recorded mutation
]);

// Audit actions the OWNER sees by default. Everything else is debug density.
// Deliberately small; extend by adding here (one place), never by ad-hoc
// checks in a renderer.
export const OWNER_VISIBLE_AUDIT_ACTIONS = Object.freeze([
  'reconciliation.auto_explain',
  'client_rule.merchant_rule_saved',
  'client_evidence_request.auto_resolved_by_match',
  // A chat-guided rejection is a user decision, not debug machinery. Its
  // reason is the durable correction context on the rejected match.
  'reconciliation.reject_match',
  // The ledger post is the line's terminal moment — "shows you what she did".
  // Its refusal twin (ledger.auto_post_refused) stays debug: the pinned
  // terminal verdict already tells the owner when a line is stuck.
  'ledger.post_transaction'
]);

const toIso = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    // ai_suggestion.suggested_at is Date.now() epoch millis.
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = new Date(String(value));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

const cleanIdentity = (value) => {
  const clean = String(value || '').trim();
  return clean || null;
};

const actorDirectoryFrom = (rows = []) => {
  const directory = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = cleanIdentity(row?.name || row?.display_name);
    if (!name) continue;
    const identity = { name, actor: cleanIdentity(row?.actor_type) || null };
    for (const key of [row?.id, row?.user_id, row?.email]) {
      const normalized = cleanIdentity(key)?.toLowerCase();
      if (normalized) directory.set(normalized, identity);
    }
  }
  return directory;
};

const actorIdentity = ({ actor = 'donna', actorId = null, actorName = null }, directory) => {
  const id = cleanIdentity(actorId);
  const normalizedActor = cleanIdentity(actor)?.toLowerCase() || 'donna';
  const automated = normalizedActor === 'system'
    || normalizedActor === 'donna'
    || /^system(?::|$)/i.test(id || '')
    || /^donna(?::|$)/i.test(id || '');
  if (automated) return { actor: 'donna', actor_id: id, actor_name: null };
  const found = id ? directory.get(id.toLowerCase()) : null;
  return {
    actor: found?.actor || normalizedActor,
    actor_id: id,
    actor_name: cleanIdentity(actorName) || found?.name || null
  };
};

const event = ({
  at,
  kind,
  actor = 'donna',
  actor_id = null,
  actor_name = null,
  density = 'debug',
  fields = {},
  receipt_ref = null
}) => ({
  at: toIso(at),
  kind,
  actor,
  actor_id,
  actor_name,
  density,
  fields,
  receipt_ref
});

const sourceActor = (source) => {
  const normalized = String(source || '').toLowerCase();
  if (normalized === 'firm_upload' || normalized === 'firm_intake') return 'firm';
  if (['client_portal', 'client_upload', 'whatsapp', 'telegram', 'email'].includes(normalized)) return 'owner';
  return 'donna';
};

const fromDocument = (row, directory) => {
  const source = row.source || row.payload?.source;
  const documentActorId =
    row.actor_id || row.uploaded_by || row.uploaded_by_id
    || row.payload?.actor_id || row.payload?.uploaded_by || row.payload?.uploaded_by_id;
  const identity = actorIdentity({
    actor: documentActorId ? 'user' : sourceActor(source),
    actorId: documentActorId,
    actorName:
      row.actor_name || row.uploaded_by_name
      || row.payload?.actor_name || row.payload?.uploaded_by_name
  }, directory);
  return event({
    at: row.uploaded_at || row.created_at,
    kind: 'document_received',
    ...identity,
    density: 'owner',
    fields: {
      document_id: row.id || null,
      filename: row.filename || row.original_filename || row.payload?.filename || null,
      document_type: row.document_type || row.payload?.document_type || null,
      source: source || null
    },
    receipt_ref: { table: 'documents', id: row.id || null }
  });
};

const fromTransactionImport = (transaction, sourceDocument = null) => event({
  at: transaction?.created_at || sourceDocument?.uploaded_at || sourceDocument?.created_at,
  kind: 'transaction_imported',
  actor: 'donna',
  density: 'owner',
  fields: {
    transaction_id: transaction?.id || null,
    source_document_id: sourceDocument?.id || transaction?.document_id || null,
    source_filename:
      sourceDocument?.filename || sourceDocument?.original_filename
      || transaction?.source_filename || transaction?.payload?.source_filename || null,
    source: sourceDocument?.source || sourceDocument?.payload?.source || transaction?.source || transaction?.payload?.source || null
  },
  receipt_ref: { table: 'transactions', id: transaction?.id || null, path: 'source_document' }
});

// Preserve the first decision and an explicit reasoning handoff in the same
// owner-visible receipt as the model that ultimately decided.
const jevTrace = (payload = {}) => {
  const first = payload?.jev_handoff || payload?.jev_decision || payload?.jev_first;
  if (!first) return {};
  return { decision_engine: payload.decision_engine || null,
    jev_model: first.model || null, jev_probability: first.probability ?? null,
    jev_selected: first.selected || null,
    jev_requested_reasoning: Boolean(payload.jev_handoff || first.handed_off || first.terminal === 'needs_reasoning') };
};

const fromEvaluation = (row) => event({
  at: row.evaluated_at || row.created_at,
  kind: 'triage_evaluation',
  density: Object.keys(jevTrace(row.payload)).length ? 'owner' : 'debug',
  fields: {
    ...jevTrace(row.payload),
    matcher_family: row.matcher_family || null,
    matcher_mode: row.matcher_mode || null,
    verdict: row.verdict || null,
    model: row.model || row.payload?.model || null,
    proposal_count: row.proposal_count ?? null,
    candidate_count: row.candidate_count ?? null,
    eligible_count: row.eligible_count ?? null,
    unmatchable_reason: row.unmatchable_reason || null,
    target_type: row.target_type || null,
    target_id: row.target_id || null
  },
  receipt_ref: { table: 'reconciliation_evaluations', id: row.id || null }
});

const fromMatch = (row) => {
  const payload = row.payload || {};
  const reason = payload.match_reason || {};
  const authorization = payload.authorization || {};
  const authority = authorization.delegated_authority
    ? 'delegated_authority'
    : (authorization.material_auto_fyi ? 'material_auto_fyi' : (authorization.band || null));
  return event({
    at: row.created_at,
    kind: 'match',
    density: 'owner',
    fields: {
      status: row.status || null,
      matched_object_type: row.matched_object_type || null,
      matched_object_id: row.matched_object_id || null,
      amount: row.match_amount ?? null,
      confidence: row.match_confidence ?? null,
      summary: reason.summary || row.match_reason || null,
      reasoning: reason.reasoning || null,
      band: authorization.band || null,
      hold_reasons: Array.isArray(authorization.reasons) ? authorization.reasons : [],
      gates: authorization.gates || null,
      authority,
      model: authorization.model || null,
      owner_notified: authorization.material_auto_fyi?.owner_notified ?? null
    },
    receipt_ref: { table: 'reconciliation_matches', id: row.id || null }
  });
};

const fromCascade = (row) => {
  const cascade = row.payload?.cascade;
  if (!cascade || !cascade.state) return null;
  return event({
    at: cascade.at || row.updated_at,
    kind: 'cascade',
    // 'applied' is the owner-visible "the line settled" moment; internal
    // retries/failures surface in the debug view (the terminal verdict
    // already tells the owner when a line is stuck).
    density: cascade.state === 'applied' ? 'owner' : 'debug',
    fields: {
      state: cascade.state,
      attempts: cascade.attempts ?? null,
      error_class: cascade.error_class || null,
      match_id: row.id || null
    },
    receipt_ref: { table: 'reconciliation_matches', id: row.id || null, path: 'payload.cascade' }
  });
};

const fromAiSuggestion = (transaction) => {
  const s = transaction?.payload?.ai_suggestion;
  if (!s || typeof s !== 'object') return null;
  return event({
    at: s.suggested_at ?? null,
    kind: 'coding_suggested',
    density: 'owner',
    fields: {
      ...jevTrace(s),
      proposed_account: s.proposed_account || s.account_name || s.account_code || null,
      confidence: s.confidence ?? null,
      evidence_required: s.evidence_required ?? null,
      model: s.model || null,
      reasoning: s.reasoning || null
    },
    receipt_ref: { table: 'transactions', id: transaction.id || null, path: 'payload.ai_suggestion' }
  });
};

const fromEvidenceRequest = (row, directory) => {
  const out = [];
  const ref = { table: 'client_evidence_requests', id: row.id || null };
  if (row.created_at) {
    const createdIdentity = actorIdentity({
      actor: row.created_by && row.created_by !== 'system' ? 'firm' : 'donna',
      actorId: row.created_by
    }, directory);
    out.push(event({
      at: row.created_at,
      kind: 'ask_drafted',
      ...createdIdentity,
      density: 'debug', // a draft isn't owner-visible until it is sent
      fields: { question: row.question || null, evidence_type: row.evidence_type || null, status: row.status || null },
      receipt_ref: ref
    }));
  }
  // DMEM-R1 W1 (INV-14, S10/L2): `ask_sent` renders only a send a deliverer
  // actually made — the stamp AND a positive send_count (108: the only bump is
  // after a genuine send). A stamp with send_count 0 is the LR-2 legacy
  // contradiction, not an event the owner experienced.
  if (row.first_sent_at && Number(row.send_count || 0) > 0) {
    out.push(event({
      at: row.first_sent_at,
      kind: 'ask_sent',
      density: 'owner',
      fields: { question: row.question || null, evidence_type: row.evidence_type || null, send_count: row.send_count ?? null },
      receipt_ref: ref
    }));
  }
  if (row.responded_at) {
    const response = row.response_payload || {};
    const responseActorId =
      response.answer_recorded_by || response.actor_id || response.responded_by
      || response.sender_id || row.responded_by || null;
    const repliedIdentity = actorIdentity({
      actor: response.answer_recorded_by ? 'firm' : 'owner',
      actorId: responseActorId,
      actorName: response.actor_name || response.responded_by_name || response.sender_name
    }, directory);
    out.push(event({
      at: row.responded_at,
      kind: 'ask_replied',
      ...repliedIdentity,
      density: 'owner',
      fields: { status: row.status || null },
      receipt_ref: ref
    }));
  }
  if (row.resolved_at) {
    const response = row.response_payload || {};
    const resolvedIdentity = actorIdentity({
      actor: row.resolved_by && row.resolved_by !== 'system' ? 'firm' : 'donna',
      actorId: row.resolved_by,
      actorName: response.resolved_by_name || response.actor_name
    }, directory);
    out.push(event({
      at: row.resolved_at,
      kind: 'ask_resolved',
      ...resolvedIdentity,
      density: 'owner',
      fields: {
        auto_resolved_by_match: response.auto_resolved_by_match === true,
        match_id: response.reconciliation_match_id || null,
        resolved_by: row.resolved_by || null
      },
      receipt_ref: ref
    }));
  }
  return out;
};

const fromAuditEvent = (row, directory) => {
  const action = row.action || '';
  const ownerVisible = (row.metadata?.review_scope?.scope === 'document_processing_review_only'
    && ['review.accepted','review.overridden'].includes(action)) || OWNER_VISIBLE_AUDIT_ACTIONS.some(
    (allowed) => action === allowed || action.startsWith(`${allowed}.`)
  );
  const identity = actorIdentity({
    actor: row.actor_type || (row.actor_id ? 'user' : 'system'),
    actorId: row.actor_id,
    actorName: row.actor_name || row.metadata?.actor_name || row.metadata?.display_name
  }, directory);
  return event({
    at: row.created_at,
    kind: 'audit',
    ...identity,
    density: ownerVisible ? 'owner' : 'debug',
    fields: {
      action: action || null,
      resource_type: row.resource_type || null,
      model: row.metadata?.model || null,
      metadata: row.metadata ?? null
    },
    receipt_ref: { table: 'audit_events', id: row.id || null }
  });
};

// Universal mentions (slice 3): a human COMMENT on the artifact joins the
// SAME timeline — the event contract always carried actor/actor_id/actor_name
// for exactly this. Only comment-lane rows map (payload.kind 'comment' /
// 'thread_resolution'); plain chat conversation stays a chat-surface concern.
// The text renders VERBATIM at fields.text — the timeline is a pure merge of
// persisted receipts, and a comment is its own receipt.
const fromChatComment = (row, directory) => {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const kind = String(payload.kind || '').trim();
  if (kind !== 'comment' && kind !== 'thread_resolution') return null;
  const identity = actorIdentity({
    actor: cleanIdentity(row.actor_type) || 'firm',
    actorId: row.actor_id,
    actorName: null
  }, directory);
  return event({
    at: row.created_at,
    kind: 'comment',
    ...identity,
    density: 'owner',
    fields: {
      kind,
      text: row.content ?? null,
      ...(kind === 'comment'
        ? {
            flavor: payload.flavor || 'mention',
            mentions: (Array.isArray(payload.mentions) ? payload.mentions : [])
              .map((m) => m?.display || m?.agent_id || m?.principal_id || null)
              .filter(Boolean),
            supersedes_message_id: payload.supersedes_message_id || null,
            ask_id: payload.ask_id || null,
            content_redacted: payload.content_redacted === true
          }
        : {
            outcome_note: payload.outcome_note || null,
            policy_memory_candidate: payload.policy_memory_candidate === true
          })
    },
    receipt_ref: { table: cleanIdentity(row.chat_table) || 'transaction_chat_messages', id: row.id || null }
  });
};

// Merge + order. Ascending by `at`; events with no timestamp sort LAST in
// input order (a receipt without a time is a §4 gap to close at its writer,
// but it is still shown — visible, never dropped).
export const buildCaseTimeline = ({
  transaction = null,
  documents = [],
  matches = [],
  evaluations = [],
  evidenceRequests = [],
  auditEvents = [],
  chatMessages = [],
  actors = []
} = {}) => {
  const events = [];
  const actorDirectory = actorDirectoryFrom(actors);
  const documentRows = Array.isArray(documents) ? documents.filter(Boolean) : [];
  for (const row of documentRows) events.push(fromDocument(row, actorDirectory));
  if (transaction) {
    const sourceDocument = documentRows.find((row) => row.id === transaction.document_id) || null;
    events.push(fromTransactionImport(transaction, sourceDocument));
  }
  for (const row of Array.isArray(evaluations) ? evaluations : []) events.push(fromEvaluation(row));
  for (const row of Array.isArray(matches) ? matches : []) {
    events.push(fromMatch(row));
    const cascade = fromCascade(row);
    if (cascade) events.push(cascade);
  }
  const coding = fromAiSuggestion(transaction);
  if (coding) events.push(coding);
  for (const row of Array.isArray(evidenceRequests) ? evidenceRequests : []) {
    events.push(...fromEvidenceRequest(row, actorDirectory));
  }
  for (const row of Array.isArray(auditEvents) ? auditEvents : []) events.push(fromAuditEvent(row, actorDirectory));
  for (const row of Array.isArray(chatMessages) ? chatMessages : []) {
    const comment = fromChatComment(row, actorDirectory);
    if (comment) events.push(comment);
  }

  const timed = events.filter((e) => e.at != null);
  const untimed = events.filter((e) => e.at == null);
  timed.sort((a, b) => a.at.localeCompare(b.at));

  // Visible holes (§4). Cheap, receipt-shaped checks only — a gap entry is a
  // statement that a persisted receipt SHOULD exist and does not.
  const gaps = [];
  const evaluatedTargets = new Set(
    (Array.isArray(evaluations) ? evaluations : []).map((r) => r.target_id).filter(Boolean)
  );
  for (const match of Array.isArray(matches) ? matches : []) {
    const docId = match?.matched_object_id;
    if (docId && !evaluatedTargets.has(docId) && !evaluatedTargets.has(match.bank_transaction_id)) {
      gaps.push({
        kind: 'no_triage_receipt_for_match',
        match_id: match.id || null,
        matched_object_id: docId
      });
    }
  }
  for (const timelineEvent of events) {
    if (!['owner', 'client', 'firm', 'user'].includes(timelineEvent.actor)) continue;
    if (!timelineEvent.actor_id) {
      gaps.push({
        kind: 'missing_actor_identity',
        event_kind: timelineEvent.kind,
        receipt_ref: timelineEvent.receipt_ref
      });
    } else if (!timelineEvent.actor_name) {
      gaps.push({
        kind: 'missing_actor_name',
        event_kind: timelineEvent.kind,
        actor_id: timelineEvent.actor_id,
        receipt_ref: timelineEvent.receipt_ref
      });
    }
  }
  if (!timed.length && !untimed.length) gaps.push({ kind: 'empty_timeline' });

  return { events: [...timed, ...untimed], gaps };
};
