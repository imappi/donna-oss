// Operator proposal cards — "ProposalCard v2" metadata (pure, FE-shared).
//
// The model proposes a chat action; the operator confirms it. That confirm
// step is the OTHER HALF of trust-the-strong-LLM (CLAUDE.md): render what an
// action will DO so a wrong proposal is caught BEFORE it becomes terminal,
// then let the human apply it cheaply. This helper turns a proposed action
// (feed mass-command OR per-transaction) into a compact, bounded description
// of its blast radius:
//
//   - writer            the NAMED persisted writer the apply routes to (INV-1);
//                       null for read-only / preview actions (diagnose,
//                       future_action). Surfacing the writer is the receipt
//                       that the verb routes to a known writer, never
//                       re-implements one.
//   - blastRadius       one line: what changes when this is applied.
//   - reversibility     a posture token (see REVERSIBILITY_LABELS).
//   - clientVisible     true when applying it reaches the client (ask_client).
//   - guarded           true for the remedial / guarded verbs (retry_parse,
//                       recode_decided): they act on a TERMINAL state the
//                       bread-and-butter verbs refuse, re-verified at write time.
//   - targetResolution  for verbs whose destructive target / current state is
//                       resolved server-side (not named in the proposal), one
//                       line of copy stating where it comes from and that a
//                       stale proposal is refused (anti-self-licensing / INV-4).
//                       This is the ONLY place server-side resolution is stated
//                       — it is never faked into a diff row's "before".
//   - warnings          0..N operator-facing cautions (decided-row, reject…).
//   - beforeAfter       0..N bounded diff rows. The card is HONEST about what it
//                       knows: a row only carries a `before` (left-hand side)
//                       when the proposal genuinely holds a known current value
//                       (state `known`). When it does not, the row is
//                       PROPOSED-ONLY — it shows the proposed value (state
//                       `proposed`) plus a muted `note`, instead of pretending a
//                       server-resolved value is data. Verbs with no field
//                       change (retry_parse, reject_match) emit no diff row at
//                       all; their meaning lives in blastRadius + targetResolution.
//
// This is a DESCRIPTION of the existing grammar — the named writers and the
// guarded sets defined server-side. It performs no inference and no network
// call; the server re-validates every apply regardless (INV-4). It is keyed by
// action.type and shared by both chat surfaces so the two cards cannot drift.

const safeString = (value) => (value == null ? '' : String(value));

const truncate = (value, max) => {
  const str = safeString(value).trim();
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
};

// A coding action (apply_category / recode_decided) whose target is the Suspense
// holding account is a PARK, not a final coding: it says "not known yet / awaiting
// evidence", so the card must not frame it as a posted, reconciled verdict.
// Detected from the proposed account name — the only place the target lives
// pre-apply — matching the server's own case-insensitive 'suspense' test.
export const isSuspenseCoding = (action) =>
  Boolean(action)
  && (action.type === 'apply_category' || action.type === 'recode_decided')
  && safeString(action.account_name).trim().toLowerCase() === 'suspense';

const MAX_BEFORE_AFTER_ROWS = 6;
const MAX_WARNINGS = 6;

export const REVERSIBILITY_LABELS = Object.freeze({
  reversible: 'Reversible',
  reversible_with_care: 'Reversible — with care',
  one_way: 'One-way — cannot be unsent',
  safe_rerun: 'Safe to re-run',
  read_only: 'Read-only'
});

// Per-side state of a before/after diff row. A side is only ever `known` (a
// real value the proposal carries) or `proposed` (the value the model wants to
// write). There is deliberately NO "server_resolved" state here: a value that
// only persisted state holds is NOT rendered as a diff side — it is stated in
// `targetResolution` / a row `note` instead (see header).
export const DIFF_STATE_LABELS = Object.freeze({
  known: 'known now',
  proposed: 'proposed'
});

// Static per-type description of the EXISTING grammar. Keyed by action.type,
// shared by the feed and per-transaction cards. Any new appliable verb must
// register here or it renders without v2 metadata (the surfaces fall back to
// their v1 summary / describe line).
const ACTION_META = Object.freeze({
  apply_category: {
    writer: 'updateTransactionReviewItemInDb',
    blastRadius: 'Codes the bank line and posts it to the ledger.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  ask_client: {
    writer: 'createClientEvidenceRequestInDb',
    blastRadius: 'Sends a question (evidence request) to the client.',
    reversibility: 'one_way',
    clientVisible: true,
    guarded: false
  },
  remember_merchant: {
    writer: 'saveMerchantRuleForPayload',
    blastRadius: 'Saves a rule that codes future matching lines.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  remember_fact: {
    writer: 'saveFirmFact',
    blastRadius: 'Writes a fact into firm memory; informs future proposals.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  mark_personal: {
    writer: 'updateTransactionReviewItemInDb',
    blastRadius: 'Marks the line as personal (out of the business books).',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  link_document: {
    writer: 'createManualReconciliationMatchInDb',
    blastRadius: 'Links the line to a document (creates a reconciliation match).',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  resolve_match_group: {
    writer: 'createManualReconciliationMatchInDb',
    blastRadius: 'Confirms every date-aligned pair and retires crossed suggestions atomically.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  reject_match: {
    writer: 'updateReconciliationMatchInDb',
    blastRadius: 'Rejects the current reconciliation match for this line.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  correct_document_field: {
    writer: 'recordDocumentCorrectionInDb',
    blastRadius: 'Corrects a parsed field on the matched document and feeds the next-parse few-shot.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  leave_review_note: {
    writer: 'transaction_review_queue (reviewer note)',
    blastRadius: 'Attaches an internal review note to the line.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  mark_evidence_owed: {
    writer: 'setTransactionAiEvidenceRequiredInDb',
    blastRadius: 'Marks the line "Waiting evidence" — does not code, post, match, or reconcile it.',
    reversibility: 'reversible',
    clientVisible: false,
    guarded: false
  },
  sync_to_accounting: {
    writer: 'adapter.writebackTransaction / postLedgerTransactionInDb',
    blastRadius: 'Posts already-accepted lines to the accounting system (Xero/QBO) or the Donna ledger; rows not yet accepted are skipped, not posted.',
    reversibility: 'reversible_with_care',
    clientVisible: false,
    guarded: false
  },
  diagnose: {
    writer: null,
    blastRadius: 'Read-only finding; explains the current state and writes nothing.',
    reversibility: 'read_only',
    clientVisible: false,
    guarded: false
  },
  retry_parse: {
    writer: 'retryParseRunsInDb',
    blastRadius: 'Re-queues the parse of the matched document.',
    reversibility: 'safe_rerun',
    clientVisible: false,
    guarded: true
  },
  recode_decided: {
    writer: 'updateTransactionReviewItemInDb',
    blastRadius: 'Re-codes a row you have already decided (can move posted ledger state).',
    reversibility: 'reversible_with_care',
    clientVisible: false,
    guarded: true
  },
  future_action: {
    writer: null,
    blastRadius: 'Preview only; not yet appliable.',
    reversibility: 'read_only',
    clientVisible: false,
    guarded: false
  }
});

// The set of action types this helper can describe. A new appliable verb that
// is not registered here renders without v2 metadata — a useful tripwire.
export const PROPOSAL_CARD_ACTION_TYPES = Object.freeze(Object.keys(ACTION_META));

// Verbs whose destructive target / current state is resolved server-side from
// persisted state rather than named in the proposal. The copy is the operator's
// assurance that the model is not self-licensing the target (anti-self-licensing
// / INV-4): the card shows WHERE the target comes from and that a stale proposal
// is refused. This — not a fake diff "before" — is the home for that guidance.
const TARGET_RESOLUTION = Object.freeze({
  reject_match:
    'The match to reject is resolved server-side from the active reconciliation match; a stale proposal is refused.',
  correct_document_field:
    'The matched document is resolved server-side from the active match; the prior value is read at apply, not taken from the proposal.',
  retry_parse:
    'The document to re-queue is resolved server-side from the active match; the retryable state is re-verified at write time.',
  recode_decided:
    'The row is re-read server-side and refused unless it is still decided before the re-code applies.',
  link_document:
    'The reconciliation match is created server-side; the proposed document is verified against the case.',
  resolve_match_group:
    'The complete collision group is re-read server-side; stale or incomplete pair sets are refused as a unit.'
});

// Note text for a PROPOSED-ONLY row whose current value is resolved server-side
// at apply (so we honestly do not render a "before"). Per verb; null leaves the
// row with no note.
const PROPOSED_ONLY_NOTE = Object.freeze({
  apply_category: 'current coding resolved on apply',
  recode_decided: 'current coding resolved on apply',
  correct_document_field: 'prior value read at apply'
});

// Dynamic, action-specific cautions layered on top of the static posture.
// Bounded so a runaway action object cannot flood the card.
const buildWarnings = (action, meta) => {
  const warnings = [];
  switch (action.type) {
    case 'recode_decided':
      warnings.push('Changes a row you have already decided — may move posted ledger state.');
      break;
    case 'reject_match':
      warnings.push('Rejects the current reconciliation match.');
      break;
    case 'retry_parse':
      warnings.push('Re-queues a parse. A hung (not failed) parse is a bug — escalate rather than blind-retry.');
      break;
    default:
      break;
  }
  // A proposed remember_fact naming a subject the firm ALREADY has an active
  // fact about (server-annotated memory_conflicts): surface it so the operator
  // can supersede/keep/cancel before minting a possibly-contradictory second
  // fact. Rendered here, never re-derived client-side.
  const conflicts = Array.isArray(action.memory_conflicts) ? action.memory_conflicts : [];
  if (conflicts.length) {
    warnings.push(`Conflicts with ${conflicts.length} existing fact${conflicts.length === 1 ? '' : 's'} about this subject — review before Apply.`);
  }
  // A broad-scope set proposal ("all Northwind deposits") the server found to OMIT a
  // matching visible row: surface the miss so the operator can widen or confirm
  // the set before applying an incomplete batch. Server-annotated (feedChat
  // sanitizer); never re-derived client-side.
  const omitted = Array.isArray(action.omitted_matching_transaction_ids)
    ? action.omitted_matching_transaction_ids
    : [];
  if (omitted.length) {
    const shown = omitted.slice(0, 3).join(', ');
    const more = omitted.length > 3 ? `, +${omitted.length - 3} more` : '';
    warnings.push(`This broad-scope proposal excludes ${omitted.length} matching row${omitted.length === 1 ? '' : 's'} (${shown}${more}).`);
  }
  if (meta.clientVisible) {
    warnings.push('Reaches the client once applied; it cannot be unsent.');
  }
  return warnings.slice(0, MAX_WARNINGS);
};

const diffRow = ({ label, before = null, beforeState = null, after = null, afterState = null, note = null }) =>
  ({ label, before, beforeState, after, afterState, note });

// Build a proposed-value row. The left-hand side is emitted ONLY when the
// proposal carries a real current value (`currentValue`) — then it is a
// known→proposed diff. Otherwise the row is proposed-only: the proposed value
// plus a muted `note`, never a faked server-resolved "before".
const proposedRow = (label, after, { currentValue = null, note = null } = {}) => {
  const before = truncate(currentValue, 80);
  return diffRow({
    label,
    before: before || null,
    beforeState: before ? 'known' : null,
    after,
    afterState: 'proposed',
    note: before ? null : (note || null)
  });
};

// A row showing a value the proposal carries as a fact (a re-verification hint,
// e.g. a document id). No diff, no note — just a known value for context.
const knownRow = (label, value) => diffRow({ label, after: value, afterState: 'known' });

// Bounded before/after rows, per verb. See the header's `beforeAfter` note for
// the honesty rule: `before` only when a real current value is known; otherwise
// proposed-only + note; no fake "resolved on apply" left-hand sides; no diff
// row at all for verbs with no field change.
const buildBeforeAfter = (action) => {
  const rows = [];
  switch (action.type) {
    case 'apply_category':
    case 'recode_decided': {
      const acct = truncate(action.account_name, 80);
      if (acct) {
        const code = truncate(action.account_code, 24);
        rows.push(proposedRow('Account', code ? `${acct} (${code})` : acct, {
          currentValue: action.current_account_name,
          note: PROPOSED_ONLY_NOTE[action.type]
        }));
      }
      const tax = truncate(action.tax_treatment, 48);
      if (tax) rows.push(proposedRow('Tax', tax));
      break;
    }
    case 'correct_document_field': {
      const label = truncate(action.field_path, 48);
      if (label) {
        const cleared = action.corrected_value == null
          || safeString(action.corrected_value).trim() === '';
        rows.push(proposedRow(label, cleared ? '(cleared)' : truncate(action.corrected_value, 80), {
          currentValue: action.current_value,
          note: PROPOSED_ONLY_NOTE.correct_document_field
        }));
      }
      const doc = truncate(action.document_id, 64);
      if (doc) rows.push(knownRow('Document', doc));
      break;
    }
    case 'reject_match': {
      // No field change → no fake diff row. The "rejects the active match"
      // meaning lives in blastRadius + the warning + targetResolution; the only
      // diff-worthy value is the optional re-verification document hint.
      const doc = truncate(action.document_id, 64);
      if (doc) rows.push(knownRow('Document', doc));
      break;
    }
    case 'link_document': {
      const doc = truncate(action.document_id, 64);
      if (doc) rows.push(proposedRow('Document', doc));
      break;
    }
    case 'resolve_match_group': {
      for (const [index, pair] of (Array.isArray(action.match_pairs) ? action.match_pairs : []).slice(0, 6).entries()) {
        const tx = truncate(pair?.transaction_id, 48);
        const doc = truncate(pair?.document_id, 48);
        if (tx && doc) rows.push(proposedRow(`Pair ${index + 1}`, `${tx} → ${doc}`));
      }
      break;
    }
    case 'remember_fact': {
      // Proposed-only preview of the firm memory about to be written. There is
      // no "before" — firm memory is additive — so every row is proposed-only,
      // and the note states the write is deferred to Apply and reversible
      // through governance (inspectable memory, not silent expansion).
      const scope = truncate(action.fact_scope, 32);
      if (scope) rows.push(proposedRow('Scope', scope));
      const subject = truncate(action.fact_subject, 64);
      if (subject) rows.push(proposedRow('Subject', subject));
      const fact = truncate(action.fact_text, 120);
      if (fact) {
        rows.push(proposedRow('Fact', fact, {
          note: 'written to firm memory on Apply; dismissable later via governance'
        }));
      }
      const confidence = truncate(action.fact_confidence, 24);
      if (confidence) rows.push(proposedRow('Confidence', confidence));
      // Any same-subject fact already on file (server-annotated): a known-value
      // row so the operator sees what they have before minting a second one.
      for (const conflict of Array.isArray(action.memory_conflicts) ? action.memory_conflicts : []) {
        const existing = truncate(conflict?.fact, 120);
        if (existing) {
          rows.push(diffRow({
            label: 'Existing fact',
            after: existing,
            afterState: 'known',
            note: conflict?.id ? `current fact ${truncate(conflict.id, 48)} — supersede or keep` : 'review before Apply'
          }));
        }
      }
      break;
    }
    // retry_parse: intentionally NO before/after diff (it changes no field). Its
    // meaning lives in blastRadius + targetResolution + the warning.
    default:
      break;
  }
  return rows.slice(0, MAX_BEFORE_AFTER_ROWS);
};

const MAX_PROOF_NOTES = 4;
const MAX_PROOF_WARNINGS = 4;
const PROOF_NOTE_MAX = 120;

const numberOrNull = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

// The agreement-evidence CheckReport's `reasons` codes rendered as plain
// English for the operator. Mirrors the artifact panel's copy so the two
// surfaces describe the same verdict identically.
const CHECK_REASON_LABELS = Object.freeze({
  totals_mismatch: 'Declared total doesn’t match the extracted obligations',
  missing_obligations: 'An expected payment has no matching deposit',
  ambiguous_rows: 'An obligation matches more than one transaction',
  extra_rows: 'There are deposits the agreement doesn’t explain',
  no_matches: 'No transactions matched the obligations',
  total_only_low_confidence: 'Only the totals agree — no per-payment match',
  no_obligations: 'No obligations were extracted to check'
});

// Normalize a server-provided agreement-evidence CheckReport (the shape from
// agreementEvidenceCheckReport: { status, reasons, currency, totals, check })
// into a BOUNDED, read-only proof block the pre-Apply card renders. This is
// evidence the operator reads before deciding — it compares the agreement's
// already-extracted obligations with the visible bank lines. It is NOT a
// reconciliation: it never posts, reconciles, or clears (CLAUDE.md trust
// principle). Returns null when the action carries no checkable agreement
// evidence, so the strip stays absent rather than rendering an empty proof.
const buildCheckReportProof = (action) => {
  const report = action?.agreement_evidence;
  if (!report || typeof report !== 'object') return null;
  const check = report.check && typeof report.check === 'object' ? report.check : null;
  if (!check) return null; // unsupported / no obligations → nothing to prove
  const obligations = Array.isArray(check.obligations) ? check.obligations : [];
  const totals = (report.totals && typeof report.totals === 'object' && report.totals)
    || (check.totals && typeof check.totals === 'object' && check.totals)
    || {};
  return {
    status: report.status || check.status || null,
    currency: report.currency || null,
    summary: check.summary || null,
    totals: {
      // Obligations' expected total, the matched bank-row total, and the gap.
      expected: numberOrNull(totals.expected),
      observed: numberOrNull(totals.observed),
      variance: numberOrNull(totals.variance)
    },
    counts: {
      matched: obligations.filter((o) => o.status === 'matched').length,
      missing: obligations.filter((o) => o.status === 'missing').length,
      ambiguous: obligations.filter((o) => o.status === 'ambiguous').length,
      extra: Array.isArray(check.extras) ? check.extras.length : 0
    },
    // Matched-row notes (e.g. "matched on amount and date only") — the caveats
    // behind a green check, bounded so a long report can't flood the card.
    notes: obligations
      .filter((o) => o.status === 'matched' && o.note)
      .map((o) => truncate(o.note, PROOF_NOTE_MAX))
      .filter(Boolean)
      .slice(0, MAX_PROOF_NOTES),
    // Why the report wants a human eye, in the report's stable order.
    warnings: (Array.isArray(report.reasons) ? report.reasons : [])
      .map((reason) => CHECK_REASON_LABELS[reason] || reason)
      .slice(0, MAX_PROOF_WARNINGS)
  };
};

// Public: build the v2 metadata for a proposed action, or null when the type
// is unknown (the surfaces fall back to their v1 summary line). Pure.
export const buildProposalCardMetadata = (action) => {
  if (!action || typeof action !== 'object') return null;
  const meta = ACTION_META[action.type];
  if (!meta) return null;
  // Suspense coding is a park, not a post — override the static "codes and
  // posts" blast radius so the operator reads it as deferred review, not a
  // final reconciliation. (Both cards consume this; the framing can't drift.)
  const blastRadius = isSuspenseCoding(action)
    ? 'Parks the line in Suspense for later review — not a final coding or ledger posting.'
    : meta.blastRadius;
  return {
    type: action.type,
    writer: meta.writer,
    blastRadius,
    reversibility: meta.reversibility,
    reversibilityLabel: REVERSIBILITY_LABELS[meta.reversibility] || meta.reversibility,
    clientVisible: meta.clientVisible,
    guarded: meta.guarded,
    targetResolution: TARGET_RESOLUTION[action.type] || null,
    warnings: buildWarnings(action, meta),
    beforeAfter: buildBeforeAfter(action),
    // Read-only agreement-evidence proof block when the server attached a
    // CheckReport to this action; null otherwise (the strip renders nothing).
    checkReport: buildCheckReportProof(action)
  };
};

// Deterministic descriptive display lines for a built metadata object — the
// text the cards render beneath the flag chips (blast radius, the
// target-resolution assurance, the named writer). Pure + bounded so the
// rendering carries no branching logic of its own and stays unit-testable.
export const proposalMetadataLines = (meta) => {
  if (!meta) return [];
  const lines = [];
  if (meta.blastRadius) lines.push(meta.blastRadius);
  if (meta.targetResolution) lines.push(meta.targetResolution);
  if (meta.writer) lines.push(`→ ${meta.writer}`);
  return lines;
};

// Render one before/after row's DIFF text as a single deterministic line:
//   - known→proposed (a real current value exists): "label: X (known now) → Y (proposed)"
//   - proposed-only:                                  "label: Y (proposed)"
// An absent side is dropped entirely — there is no "(resolved on apply)"
// placeholder. The row's muted `note` is rendered separately by the card, not
// folded into this string. Pure so both cards render identical copy.
export const formatDiffRow = (row) => {
  if (!row || typeof row !== 'object') return '';
  const sideText = (value, state) => {
    const v = value == null ? '' : String(value);
    if (!v) return '';
    const label = state ? (DIFF_STATE_LABELS[state] || state) : '';
    return label ? `${v} (${label})` : v;
  };
  const before = sideText(row.before, row.beforeState);
  const after = sideText(row.after, row.afterState);
  const label = row.label != null ? String(row.label) : '';
  return before ? `${label}: ${before} → ${after}` : `${label}: ${after}`;
};

// ─── Apply receipts (post-apply proof) ───────────────────────────────────
//
// The proposal metadata above is the PRE-apply view. Once an action is applied
// the card should show the OTHER half: a receipt of what the server actually
// did — proof, not the pre-apply guess. buildProposalApplyReceiptMetadata
// normalizes the SERVER-RETURNED `action.result` (the persisted verdict) into a
// bounded receipt. It invents nothing client-side: every value comes from the
// result the apply route returned. Returns null for a not-yet-applied action
// (the card renders proposal metadata instead).
//
// Note the honesty payoff: correct_document_field's result carries the real
// `prior_value` the server read at apply, so the RECEIPT can show a genuine
// before→after even though the PROPOSAL could not (it only knew the new value).

const MAX_RECEIPT_ROWS = 6;
const MAX_RECEIPT_NOTES = 6;

const receiptRow = (label, value) => ({ label, value });

// The server-minted proof id an APPLIED batch row carries — the evidence
// request, review item, or parse run the writer created (first present wins),
// with the resolved document id as a generic fallback. null when the row holds
// no id (then the count row is the only proof). Read straight from the server
// result; never invented client-side.
const perRowProofId = (r) =>
  r.evidence_request_id || r.review_item_id || r.parse_run_id || r.document_id || null;

// Count of batch rows that APPLIED (review coding saved) but whose ledger post
// errored — a per-row r.posting.status === 'error' (feedChatApply shape). A
// batch can have zero apply-failures yet still be partial because of these.
const batchPostingFailures = (result) =>
  (Array.isArray(result.results) ? result.results : []).filter(
    (r) => r && typeof r === 'object' && r.applied === true && r.posting && r.posting.status === 'error'
  );

// Rows whose review coding saved but whose posted journal still shows the
// PRIOR coding (reclass declined: split journal, unknown prior). The ledger
// is stale for these — the batch must read partial, never clean.
const batchPostingPending = (result) =>
  (Array.isArray(result.results) ? result.results : []).filter(
    (r) => r && typeof r === 'object' && r.applied === true
      && r.posting && r.posting.step === 'ledger_adjustment_required' && r.posting.status === 'pending'
  );

// applied (clean) · partial (some rows / a posting failed) · skipped (nothing
// landed, by design) · failed (nothing landed, in error). Derived from the
// server result, never asserted by the client.
const deriveReceiptStatus = (result) => {
  if (result.skipped_reason) return 'skipped';
  if (Number.isFinite(result.applied)) {
    if (result.applied === 0) return Number.isFinite(result.failed) && result.failed > 0 ? 'failed' : 'skipped';
    // A row can apply (review coding saved) yet fail to POST to the ledger —
    // or still be awaiting a ledger adjustment; both are partial outcomes,
    // never a clean apply.
    const failedApply = Number.isFinite(result.failed) && result.failed > 0;
    return failedApply || batchPostingFailures(result).length > 0 || batchPostingPending(result).length > 0
      ? 'partial'
      : 'applied';
  }
  if (result.posting && result.posting.status === 'error') return 'partial';
  return 'applied';
};

const receiptSummary = (action, result) => {
  const n = result.applied;
  const plural = (count) => (count === 1 ? '' : 's');
  switch (action.type) {
    case 'correct_document_field': return 'Document field corrected';
    case 'retry_parse':
      return Number.isFinite(n) ? `Re-queued ${n}/${result.requested ?? n} parse${plural(n)}` : 'Parse re-queued';
    case 'apply_category':
      if (result.posting?.status === 'error') return 'Coding saved; posting failed';
      return Number.isFinite(n) ? `Coded ${n} line${plural(n)}` : 'Coded and posted';
    case 'recode_decided': return 'Decided row re-coded';
    case 'reject_match': return 'Match rejected';
    // The manual-link writer confirms + reconciles in one transaction; when
    // the server result says so, the summary states the real consequence —
    // "Document linked" alone under-claims and reads as a step short of done.
    case 'link_document':
      return result.match_status === 'confirmed' ? 'Match confirmed — line reconciled' : 'Document linked';
    case 'resolve_match_group':
      return `${Number(result.reconciled_count) || 0} matches confirmed — ${Number(result.reconciled_count) || 0} lines reconciled`;
    case 'ask_client':
      return Number.isFinite(n) ? `Question sent to ${n} line${plural(n)}` : 'Question sent to client';
    case 'remember_merchant': return result.rule_id ? 'Merchant rule saved' : 'No rule saved';
    case 'remember_fact': return result.already_present ? 'Fact updated' : (result.fact_id ? 'Fact saved' : 'No fact saved');
    case 'mark_personal': return 'Marked personal';
    case 'leave_review_note': return 'Review note saved';
    case 'mark_evidence_owed':
      return Number.isFinite(n) ? `Marked ${n} line${plural(n)} waiting evidence` : 'Marked waiting evidence';
    case 'sync_to_accounting': {
      const skipped = Number.isFinite(result.skipped) && result.skipped > 0 ? `, ${result.skipped} skipped` : '';
      return Number.isFinite(n) ? `Posted ${n} line${plural(n)} to the books${skipped}` : 'Posted to the books';
    }
    default: return Number.isFinite(n) ? `Applied to ${n}` : 'Applied';
  }
};

// Single-result (per-transaction) detail rows, read straight from the result.
const receiptDetailRows = (action, result, notes, warnings) => {
  const rows = [];
  switch (action.type) {
    case 'correct_document_field': {
      const field = truncate(result.field_path, 48);
      if (field) {
        const before = truncate(result.prior_value, 80);
        const after = result.corrected_value == null ? '(cleared)' : truncate(result.corrected_value, 80);
        rows.push(receiptRow(field, before ? `${before} → ${after}` : after));
      }
      if (result.document_id) rows.push(receiptRow('Document', truncate(result.document_id, 64)));
      break;
    }
    case 'apply_category':
    case 'recode_decided': {
      const acct = truncate(result.account_name, 80);
      if (acct) rows.push(receiptRow('Account', result.account_code ? `${acct} (${truncate(result.account_code, 24)})` : acct));
      if (action.type === 'recode_decided' && result.review_item_id) {
        rows.push(receiptRow('Review item', truncate(result.review_item_id, 64)));
      }
      const posting = result.posting && typeof result.posting === 'object' ? result.posting : null;
      if (posting?.status) {
        rows.push(receiptRow('Posting', truncate(posting.status, 24)));
        if (posting.status === 'error') warnings.push(`Posting failed: ${truncate(posting.error || 'unknown', 80)}`);
      }
      // The reversal-adjustment path names the journal that still reflects the
      // old coding — the evidence behind the ledger-adjustment warning below.
      if (posting?.original_journal_id) rows.push(receiptRow('Original journal', truncate(posting.original_journal_id, 64)));
      if (result.from_review_state) notes.push(`was ${truncate(result.from_review_state, 32)}`);
      if (result.ledger_adjustment_required) warnings.push('Prior posted state needs a ledger adjustment.');
      break;
    }
    case 'retry_parse': {
      if (result.parse_status) rows.push(receiptRow('Parse', truncate(result.parse_status, 32)));
      if (result.parse_run_id) rows.push(receiptRow('Parse run', truncate(result.parse_run_id, 64)));
      if (result.document_id) rows.push(receiptRow('Document', truncate(result.document_id, 64)));
      break;
    }
    case 'reject_match': {
      if (result.match_id) rows.push(receiptRow('Match', truncate(result.match_id, 64)));
      if (result.from_status) rows.push(receiptRow('Was', truncate(result.from_status, 24)));
      if (result.matched_object_id) rows.push(receiptRow('Document', truncate(result.matched_object_id, 64)));
      if (result.leaves_line_hanging) {
        warnings.push('Wrong link removed; this line still needs its replacement match or an owner answer.');
      }
      break;
    }
    case 'link_document': {
      if (result.document_id) rows.push(receiptRow('Document', truncate(result.document_id, 64)));
      if (result.match_id) rows.push(receiptRow('Match', truncate(result.match_id, 64)));
      // Consequence rows, read straight from the server result (honest-row
      // discipline: rendered only when the apply actually reported them).
      if (result.match_status) rows.push(receiptRow('Status', truncate(result.match_status, 24)));
      if (result.from_status) rows.push(receiptRow('Was', truncate(result.from_status, 24)));
      if (result.reconciliation_status) rows.push(receiptRow('Line', truncate(result.reconciliation_status, 24)));
      break;
    }
    case 'resolve_match_group': {
      for (const [index, pair] of (Array.isArray(result.pairings) ? result.pairings : []).slice(0, 5).entries()) {
        const tx = truncate(pair?.transaction_id, 48);
        const doc = truncate(pair?.document_id, 48);
        if (tx && doc) rows.push(receiptRow(`Pair ${index + 1}`, `${tx} → ${doc}`));
      }
      if (Array.isArray(result.retired_match_ids) && result.retired_match_ids.length) {
        rows.push(receiptRow('Crossed suggestions retired', String(result.retired_match_ids.length)));
      }
      break;
    }
    case 'ask_client':
      if (result.evidence_request_id) rows.push(receiptRow('Request', truncate(result.evidence_request_id, 64)));
      break;
    case 'remember_merchant':
      if (result.rule_id) rows.push(receiptRow('Rule', truncate(result.rule_id, 64)));
      break;
    case 'remember_fact':
      if (result.fact_id) rows.push(receiptRow('Fact', truncate(result.fact_id, 64)));
      if (result.subject) rows.push(receiptRow('Subject', truncate(result.subject, 64)));
      // Provenance proof, read straight from the server result: the operator's
      // own words and how many source rows were in view at mint. Honest-row
      // discipline — render each ONLY when actually present, so a standalone
      // mint (no note, 0 rows) shows no empty "Operator words"/"Source rows: 0".
      if (result.operator_note) rows.push(receiptRow('Operator words', truncate(result.operator_note, 120)));
      if (Number.isFinite(result.transaction_count) && result.transaction_count > 0) {
        rows.push(receiptRow('Source rows', String(result.transaction_count)));
      }
      break;
    case 'mark_personal': {
      const acct = truncate(result.account_name, 80);
      if (acct) rows.push(receiptRow('Account', acct));
      break;
    }
    case 'leave_review_note':
      if (result.follow_up_at) rows.push(receiptRow('Follow-up', truncate(result.follow_up_at, 32)));
      break;
    default:
      break;
  }
  return rows;
};

export const buildProposalApplyReceiptMetadata = (action) => {
  if (!action || typeof action !== 'object') return null;
  if (action.status !== 'applied') return null;
  const result = (action.result && typeof action.result === 'object') ? action.result : {};
  const rows = [];
  const notes = [];
  const warnings = [];

  // Batch (feed mass-command) count rows + per-row proof, when present. Failures
  // carry the reason; applied rows carry the id the server minted (evidence
  // request / review item / parse run). Failures are noted FIRST so an actionable
  // reason is never crowded out of the note cap by success proof.
  if (Number.isFinite(result.applied)) {
    rows.push(receiptRow('Applied', String(result.applied)));
    if (Number.isFinite(result.failed) && result.failed > 0) rows.push(receiptRow('Failed', String(result.failed)));
    // Rows deliberately not acted on (e.g. sync_to_accounting's post-accepted-only
    // skips). Only present when the verb reports a skipped count; surfaced so a
    // partial batch reads honestly ("3 posted, 2 skipped") rather than as a clean run.
    if (Number.isFinite(result.skipped) && result.skipped > 0) rows.push(receiptRow('Skipped', String(result.skipped)));
    const perRow = Array.isArray(result.results) ? result.results : [];
    // Rows whose review coding SAVED but whose ledger post errored. Surfaced as
    // its own count + warning so an applied batch is never read as fully posted.
    const postingFailed = batchPostingFailures(result);
    if (postingFailed.length > 0) {
      rows.push(receiptRow('Posting failed', String(postingFailed.length)));
      warnings.push(`Review coding saved, but the ledger was not updated for ${postingFailed.length} row${postingFailed.length === 1 ? '' : 's'} — see the per-row reasons.`);
    }
    // Recodes of posted rows the reclass step could not complete — the
    // ledger still shows the prior coding until an adjustment posts.
    const postingPending = batchPostingPending(result);
    if (postingPending.length > 0) {
      rows.push(receiptRow('Ledger adjustment pending', String(postingPending.length)));
      warnings.push(`Review coding saved, but ${postingPending.length} row${postingPending.length === 1 ? '' : 's'} still need${postingPending.length === 1 ? 's' : ''} a ledger adjustment — the ledger shows the prior coding until it posts.`);
    }
    const rowNote = (r, value) => `${truncate(r.transaction_id, 24) || 'row'}: ${truncate(value, 48)}`;
    // Actionable reasons first (apply failures, then posting failures) so the
    // note cap never drops them in favour of success proof.
    for (const r of perRow) {
      if (r && typeof r === 'object' && r.applied === false) {
        notes.push(rowNote(r, r.error || r.skipped?.reason || 'skipped'));
      }
    }
    for (const r of postingFailed) {
      notes.push(rowNote(r, `posting failed: ${r.posting.error || 'unknown'}`));
    }
    for (const r of postingPending) {
      notes.push(rowNote(r, `ledger adjustment pending${r.posting.reason ? `: ${r.posting.reason}` : ''}`));
    }
    for (const r of perRow) {
      if (r && typeof r === 'object' && r.applied === true && r.posting && r.posting.step === 'ledger_reclass' && r.posting.status === 'posted') {
        notes.push(rowNote(r, 'ledger reclassed (adjustment posted)'));
      }
    }
    for (const r of perRow) {
      if (r && typeof r === 'object' && r.applied === true && !(r.posting && r.posting.status === 'error')) {
        const proof = perRowProofId(r);
        if (proof) notes.push(rowNote(r, proof));
      }
    }
  }
  if (result.skipped_reason) notes.push(truncate(result.skipped_reason, 80));

  rows.push(...receiptDetailRows(action, result, notes, warnings));

  return {
    type: action.type,
    status: deriveReceiptStatus(result),
    summary: receiptSummary(action, result),
    writer: ACTION_META[action.type]?.writer || null,
    rows: rows.slice(0, MAX_RECEIPT_ROWS),
    notes: notes.slice(0, MAX_RECEIPT_NOTES),
    warnings: warnings.slice(0, MAX_WARNINGS)
  };
};
