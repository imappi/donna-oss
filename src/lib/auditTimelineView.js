// View model for the per-line audit timeline (Slice 2 of
// docs/design-donna-line-audit-timeline.md) — the case-snapshot `timeline`
// block rendered as template prose over PERSISTED receipt fields.
//
// Render-the-persisted-verdict rail, applied twice over:
//   - every headline/detail below is a TEMPLATE over `event.fields` — no LLM
//     call renders or narrates anything on this path (design §5.1: a narrated
//     trace that can drift from the receipts is fabricated transparency);
//   - a receipt the templates cannot label renders its raw kind/action rather
//     than being hidden — an unlabelable receipt is drift to surface.
//
// Density is decided SERVER-side (caseTimeline.js assigns 'owner'/'debug' per
// event); this module only filters on it. One timeline, two densities — never
// two systems (design §7).

const viewMessage = (formatMessage, id, defaultMessage, values = {}) => (
  typeof formatMessage === 'function'
    ? formatMessage({ id, defaultMessage }, values)
    : defaultMessage.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? ''))
);

const TERMINAL_VIEWS = {
  auto_reconciled: {
    tone: 'settled',
    messageId: 'transaction.audit.terminal.autoReconciled',
    headline: 'Reconciled — Donna finished this line herself.'
  },
  on_owner: {
    tone: 'owner',
    messageId: 'transaction.audit.terminal.onOwner',
    headline: 'Waiting on you — there is an open question only you can answer.'
  },
  hanging: {
    tone: 'violation',
    messageId: 'transaction.audit.terminal.hanging',
    headline: 'Stuck — this line is resting in neither terminal state.'
  }
};

// The terminal verdict pinned at the top of the tab. `terminal` is the
// snapshot block's deriveCaseConvergence output ({ present, state, reason })
// or an absent marker; hanging keeps its violation framing on purpose — the
// two-terminal-states principle says that state is a bug to surface, never a
// status to normalize.
export const buildTerminalView = (terminal, formatMessage = null) => {
  if (!terminal || terminal.present === false || !terminal.state) {
    return {
      tone: 'unknown',
      headline: viewMessage(
        formatMessage,
        'transaction.audit.terminal.missing',
        'No terminal verdict recorded for this line.'
      ),
      reason: terminal?.reason || null
    };
  }
  const correctionFailure = /^posted_(?:evidence|tax_registration)_correction_(blocked|failed):(.+)$/.exec(terminal.reason || '');
  if (terminal.state === 'hanging' && correctionFailure) {
    const code = correctionFailure[2];
    const hanging = TERMINAL_VIEWS.hanging;
    return {
      tone: 'violation',
      headline: `${viewMessage(formatMessage, hanging.messageId, hanging.headline)} (${code})`,
      reason: terminal.reason
    };
  }
  const view = TERMINAL_VIEWS[terminal.state] || {
    tone: 'unknown',
    headline: String(terminal.state)
  };
  return {
    tone: view.tone,
    headline: view.messageId
      ? viewMessage(formatMessage, view.messageId, view.headline)
      : view.headline,
    reason: terminal.reason || null
  };
};

export const labelForTimelineActor = (
  actor,
  { actorName = null, actorId = null, formatMessage = null } = {}
) => {
  if (String(actorName || '').trim()) return String(actorName).trim();
  const normalized = String(actor || '').toLowerCase();
  if (!normalized || normalized === 'donna' || normalized === 'system') return 'Donna';
  if (String(actorId || '').trim()) return String(actorId).trim();
  if (normalized === 'owner' || normalized === 'client') {
    return viewMessage(formatMessage, 'transaction.audit.actor.ownerUnknown', 'Owner · identity not recorded');
  }
  if (normalized === 'firm' || normalized === 'user') {
    return viewMessage(formatMessage, 'transaction.audit.actor.firmUnknown', 'Firm user · identity not recorded');
  }
  return String(actor);
};

const SOURCE_LABELS = {
  firm_upload: ['transaction.audit.source.firmUpload', 'firm upload'],
  firm_intake: ['transaction.audit.source.firmIntake', 'firm intake'],
  client_portal: ['transaction.audit.source.clientPortal', 'client portal'],
  client_upload: ['transaction.audit.source.clientUpload', 'client upload'],
  whatsapp: ['transaction.audit.source.whatsapp', 'WhatsApp'],
  telegram: ['transaction.audit.source.telegram', 'Telegram'],
  email: ['transaction.audit.source.email', 'email'],
  documents_sync: ['transaction.audit.source.accountingSync', 'accounting-system sync'],
  bank_statement: ['transaction.audit.source.bankStatement', 'bank-statement import'],
  xero: ['transaction.audit.source.xero', 'Xero'],
  qbo: ['transaction.audit.source.quickBooks', 'QuickBooks']
};

const sourceLabel = (source, formatMessage) => {
  if (!source) {
    return viewMessage(formatMessage, 'transaction.audit.source.recorded', 'recorded source');
  }
  const known = SOURCE_LABELS[String(source).toLowerCase()];
  return known ? viewMessage(formatMessage, known[0], known[1]) : String(source).replace(/_/g, ' ');
};

const confidenceChip = (value, formatMessage) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1 ? n * 100 : n;
  if (typeof formatMessage !== 'function') return `${Math.round(pct)}% confidence`;
  return viewMessage(
    formatMessage,
    'transaction.audit.confidence',
    '{percent, number}% confidence',
    { percent: Math.round(pct) }
  );
};

const jevChips = (fields, formatMessage) => fields.jev_model ? [
  fields.jev_requested_reasoning
    ? viewMessage(formatMessage, 'transaction.audit.jev.reasoning', 'Jev requested reasoning')
    : viewMessage(formatMessage, 'transaction.audit.jev.decided', 'Jev decision'),
  fields.jev_model,
  Number.isFinite(fields.jev_probability)
    ? viewMessage(formatMessage, 'transaction.audit.jev.probability', 'Jev choice probability {percent}%', { percent: Math.round(fields.jev_probability * 100) })
    : null
].filter(Boolean) : [];

// Authority provenance on a match receipt, in owner words. The keys mirror
// what caseTimeline's fromMatch derives from payload.authorization.
const AUTHORITY_LABELS = {
  material_auto_fyi: ['transaction.audit.authority.aboveLimit', 'Above your auto-approve limit — recorded and flagged to you'],
  delegated_authority: ['transaction.audit.authority.delegated', 'Under your standing authority'],
  auto_matched: ['transaction.audit.authority.autoMatched', 'Auto-matched'],
  matched_pending_authority: ['transaction.audit.authority.pending', 'Held for authority']
};

const authorityChip = (authority, formatMessage) => {
  if (!authority) return null;
  const known = AUTHORITY_LABELS[authority];
  return known ? viewMessage(formatMessage, known[0], known[1]) : String(authority);
};

// Owner-visible audit actions → owner prose. Prefix-matched the same way
// caseTimeline's OWNER_VISIBLE_AUDIT_ACTIONS gate is, so a dotted sub-action
// inherits its family's label.
const AUDIT_ACTION_LABELS = {
  'reconciliation.auto_explain': ['transaction.audit.action.autoExplain', 'Explained automatically from the bank line.'],
  'reconciliation.reject_match': ['transaction.audit.action.rejectMatch', 'Match rejected.'],
  'client_rule.merchant_rule_saved': ['transaction.audit.action.ruleSaved', 'Saved a merchant rule — next time is automatic.'],
  'client_evidence_request.auto_resolved_by_match': ['transaction.audit.action.askAutoResolved', 'Your open question was closed by the match.'],
  'ledger.post_transaction': ['transaction.audit.action.ledgerPosted', 'Posted to the ledger.'],
  'ledger.auto_post_refused': ['transaction.audit.action.ledgerRefused', 'Ledger post refused — line stays accepted.']
};

const labelForAuditAction = (action, formatMessage) => {
  if (!action) return viewMessage(formatMessage, 'transaction.audit.event.recorded', 'Recorded event');
  if (AUDIT_ACTION_LABELS[action]) {
    const known = AUDIT_ACTION_LABELS[action];
    return viewMessage(formatMessage, known[0], known[1]);
  }
  const family = Object.keys(AUDIT_ACTION_LABELS).find((key) => action.startsWith(`${key}.`));
  if (!family) return action;
  const known = AUDIT_ACTION_LABELS[family];
  return viewMessage(formatMessage, known[0], known[1]);
};

const countLabel = (value) => (value == null ? '—' : String(value));

// Two receipt fields can legitimately carry the same string (the Land-lease
// sighting: match_reason.summary === match_reason.reasoning, and
// status === band === 'suggested'). Render each fact once.
const dedupeChips = (chips) => [...new Set(chips.filter(Boolean))];

const detailUnlessEcho = (detail, headline) =>
  detail && detail !== headline ? detail : null;

// One event → { headline, detail, chips } plus passthroughs the renderer
// needs. Pure templates; every branch reads only `event.fields`.
export const buildTimelineEventView = (event, formatMessage = null) => {
  const fields = event?.fields || {};
  const base = {
    at: event?.at || null,
    kind: event?.kind || 'audit',
    density: event?.density === 'owner' ? 'owner' : 'debug',
    actor: event?.actor || null,
    actorId: event?.actor_id || null,
    actorName: event?.actor_name || null,
    actorLabel: labelForTimelineActor(event?.actor, {
      actorName: event?.actor_name,
      actorId: event?.actor_id,
      formatMessage
    }),
    fields,
    receiptRef: event?.receipt_ref || null,
    detail: null,
    chips: []
  };
  switch (event?.kind) {
    case 'document_received':
      return {
        ...base,
        headline: fields.filename
          ? viewMessage(formatMessage, 'transaction.audit.event.evidenceReceivedNamed', 'Evidence received: {filename}.', { filename: fields.filename })
          : viewMessage(formatMessage, 'transaction.audit.event.evidenceReceived', 'Evidence received.'),
        detail: viewMessage(formatMessage, 'transaction.audit.event.receivedThrough', 'Received through {source}.', {
          source: sourceLabel(fields.source, formatMessage)
        })
      };
    case 'transaction_imported':
      return {
        ...base,
        headline: fields.source_filename
          ? viewMessage(formatMessage, 'transaction.audit.event.bankImportedNamed', 'Bank line imported from {filename}.', { filename: fields.source_filename })
          : viewMessage(formatMessage, 'transaction.audit.event.bankImported', 'Bank line imported.'),
        detail: fields.source
          ? viewMessage(formatMessage, 'transaction.audit.event.importedThrough', 'Imported through {source}.', {
              source: sourceLabel(fields.source, formatMessage)
            })
          : null
      };
    case 'triage_evaluation':
      return {
        ...base,
        headline: fields.verdict
          ? viewMessage(formatMessage, 'transaction.audit.event.triageVerdict', 'Triage — {matcher} → {verdict}', {
              matcher: fields.matcher_family || 'matcher', verdict: fields.verdict
            })
          : viewMessage(formatMessage, 'transaction.audit.event.triage', 'Triage — {matcher}', {
              matcher: fields.matcher_family || 'matcher'
            }),
        detail: fields.unmatchable_reason
          ? viewMessage(formatMessage, 'transaction.audit.event.triageDetailReason', '{candidateCount} candidates · {eligibleCount} eligible · {reason}', {
              candidateCount: countLabel(fields.candidate_count),
              eligibleCount: countLabel(fields.eligible_count),
              reason: fields.unmatchable_reason
            })
          : viewMessage(formatMessage, 'transaction.audit.event.triageDetail', '{candidateCount} candidates · {eligibleCount} eligible', {
              candidateCount: countLabel(fields.candidate_count),
              eligibleCount: countLabel(fields.eligible_count)
            }),
        chips: dedupeChips([...jevChips(fields, formatMessage), fields.model])
      };
    case 'match': {
      const headline = fields.summary || (fields.matched_object_type
        ? viewMessage(formatMessage, 'transaction.audit.event.matchedType', 'Matched to a {objectType}', {
            objectType: String(fields.matched_object_type).replace(/_/g, ' ')
          })
        : viewMessage(formatMessage, 'transaction.audit.event.matchedDocument', 'Matched to a document'));
      return {
        ...base,
        headline,
        detail: detailUnlessEcho(fields.reasoning, headline),
        chips: dedupeChips([
          confidenceChip(fields.confidence, formatMessage),
          authorityChip(fields.authority, formatMessage),
          fields.status && fields.status !== 'settled' ? String(fields.status) : null,
          // The model id is part of the receipt (CLAUDE.md; the sole-model
          // lab): every model-derived event names WHICH model, in view.
          fields.model
        ])
      };
    }
    case 'cascade':
      return fields.state === 'applied'
        ? {
            ...base,
            headline: viewMessage(formatMessage, 'transaction.audit.event.settled', 'Settled in the books.'),
            detail: Number(fields.attempts) > 1
              ? viewMessage(formatMessage, 'transaction.audit.event.attempts', 'after {attempts} attempts', { attempts: fields.attempts })
              : null
          }
        : {
            ...base,
            headline: viewMessage(formatMessage, 'transaction.audit.event.settleState', 'Settle {state}', { state: fields.state || 'attempt' }),
            detail: fields.error_class || null
          };
    case 'coding_suggested':
      return {
        ...base,
        // Render the persisted verdict: this event IS a suggestion
        // (payload.ai_suggestion) — "Coded to X" over-claimed a posting that
        // has its own receipt when it happens (the 2026-08-25 SW Gas panel).
        headline: fields.proposed_account
          ? viewMessage(formatMessage, 'transaction.audit.event.codingSuggestedNamed', 'Suggested: {account}', { account: fields.proposed_account })
          : viewMessage(formatMessage, 'transaction.audit.event.codingSuggested', 'Coding proposed'),
        detail: fields.reasoning || null,
        chips: dedupeChips([
          ...jevChips(fields, formatMessage),
          confidenceChip(fields.confidence, formatMessage),
          fields.evidence_required
            ? viewMessage(formatMessage, 'transaction.audit.event.evidenceRequired', 'evidence required')
            : null,
          // The model id is part of the receipt (CLAUDE.md; the sole-model
          // lab): the coder's chip row names WHICH model coded the line —
          // reading it out of the raw fields JSON was the visibility gap.
          fields.model
        ])
      };
    case 'ask_drafted':
      return {
        ...base,
        headline: viewMessage(formatMessage, 'transaction.audit.event.questionDrafted', 'Question drafted'),
        detail: fields.question || null
      };
    case 'ask_sent':
      return {
        ...base,
        headline: fields.question
          ? viewMessage(formatMessage, 'transaction.audit.event.askedYou', 'Asked you: “{question}”', { question: fields.question })
          : viewMessage(formatMessage, 'transaction.audit.event.questionSent', 'Question sent to you'),
        chips: Number(fields.send_count) > 1
          ? [viewMessage(formatMessage, 'transaction.audit.event.sentCount', 'sent {count}×', { count: fields.send_count })]
          : []
      };
    case 'ask_replied':
      return { ...base, headline: viewMessage(formatMessage, 'transaction.audit.event.replyReceived', 'Reply received.') };
    case 'ask_resolved':
      return {
        ...base,
        headline: fields.auto_resolved_by_match
          ? viewMessage(formatMessage, 'transaction.audit.event.questionClosedByMatch', 'Question closed — the match answered it.')
          : viewMessage(formatMessage, 'transaction.audit.event.questionClosed', 'Question closed.')
      };
    // Universal mentions (slice 3): human speech in the same stream, rendered
    // VERBATIM as the detail (the timeline never re-narrates a comment) and
    // visually distinguished by the actor label carrying the human's name.
    case 'comment': {
      if (fields.kind === 'thread_resolution') {
        return {
          ...base,
          headline: viewMessage(formatMessage, 'transaction.audit.event.threadResolved', 'Thread resolved.'),
          detail: fields.outcome_note ? String(fields.outcome_note) : null,
          chips: fields.policy_memory_candidate
            ? [viewMessage(formatMessage, 'transaction.audit.event.policyMemoryCandidate', 'policy-memory candidate')]
            : []
        };
      }
      const mentionChips = Array.isArray(fields.mentions) ? fields.mentions.map((m) => `@${m}`) : [];
      return {
        ...base,
        headline: fields.content_redacted
          ? viewMessage(formatMessage, 'transaction.audit.event.commentRedacted', 'Comment (redacted).')
          : viewMessage(formatMessage, 'transaction.audit.event.comment', 'Comment'),
        detail: fields.content_redacted ? null : (fields.text ? String(fields.text) : null),
        chips: [
          ...(fields.flavor && fields.flavor !== 'mention' ? [fields.flavor] : []),
          ...mentionChips,
          ...(fields.supersedes_message_id
            ? [viewMessage(formatMessage, 'transaction.audit.event.edited', 'edited')]
            : [])
        ]
      };
    }
    case 'audit':
      return {
        ...base,
        headline: fields.metadata?.review_scope?.scope === 'document_processing_review_only'
          && ['review.accepted','review.overridden'].includes(fields.action)
          ? viewMessage(formatMessage,'transaction.audit.action.reviewSaved','Review saved; accounting remains incomplete.')
          : labelForAuditAction(fields.action, formatMessage),
        detail: fields.metadata?.reason
          ? String(fields.metadata.reason)
          : (base.density === 'debug' && fields.resource_type ? String(fields.resource_type) : null),
        chips: [fields.model].filter(Boolean)
      };
    default:
      return {
        ...base,
        headline: event?.kind
          ? String(event.kind)
          : viewMessage(formatMessage, 'transaction.audit.event.recorded', 'Recorded event')
      };
  }
};

// Named gaps (caseTimeline `gaps`) in visible words — design §5.1: a step with
// no receipt shows the hole, it is never papered over.
const GAP_LABELS = {
  no_triage_receipt_for_match: ['transaction.audit.gap.noTriage', 'No triage receipt behind this match — no record of which matcher proposed it.'],
  missing_actor_identity: ['transaction.audit.gap.missingActorIdentity', 'A human action has no recorded actor identity.'],
  missing_actor_name: ['transaction.audit.gap.missingActorName', 'A human action records an identifier, but not the user’s name.'],
  empty_timeline: ['transaction.audit.gap.empty', 'No receipts recorded for this line yet.']
};

export const labelForTimelineGap = (gap, formatMessage = null) => {
  const known = GAP_LABELS[gap?.kind];
  return known
    ? viewMessage(formatMessage, known[0], known[1])
    : viewMessage(formatMessage, 'transaction.audit.gap.missingReceipt', 'Missing receipt: {kind}', {
        kind: gap?.kind || 'unknown'
      });
};

export const visibleTimelineEvents = (eventViews = [], { debug = false } = {}) =>
  debug ? eventViews : eventViews.filter((view) => view.density === 'owner');

// The whole block → one render-ready view. `timeline` is the snapshot's
// timeline block ({ present, terminal, events, gaps } or an absent marker).
export const buildAuditTimelineView = (timeline, formatMessage = null) => {
  if (!timeline || timeline.present !== true) {
    return { present: false, reason: timeline?.reason || 'not_included' };
  }
  return {
    present: true,
    terminal: buildTerminalView(timeline.terminal, formatMessage),
    events: (Array.isArray(timeline.events) ? timeline.events : [])
      .map((event) => buildTimelineEventView(event, formatMessage)),
    gaps: (Array.isArray(timeline.gaps) ? timeline.gaps : [])
      .map((gap) => labelForTimelineGap(gap, formatMessage))
  };
};
