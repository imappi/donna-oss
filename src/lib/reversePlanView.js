// Operator reverse plan view (pure, FE) — G2 PR-15.
//
// The /operator/reverse endpoint returns the executor's PLAN (dry run, the
// default) or its RECEIPT (execute). This module turns either response into
// render-ready rows and holds the confirm-flow state machine, so the panel
// component stays thin and the render fidelity is testable under node --test.
//
// Render the persisted verdict (CLAUDE.md): every disposition, reason and
// surfaced side effect below comes from the server's plan. This module maps
// tokens to copy; it never re-decides a disposition, never drops a row, and
// falls back to the RAW token for a reason it does not recognize rather than
// hiding it. Two halves are load-bearing for honesty (the PR-14 builder note):
//   - the memory/ask legs' reasons are memory-shaped (`<kind>_pre_existed`,
//     `ask_answered`, `already_reversed`, `ask_reopen_not_auto_planned`,
//     `outbound_never_auto_fired`) and each needs its own sentence, or the
//     founder reads "skipped" with no idea the apply TAUGHT something;
//   - entries can carry `surfaced[]`, the side effects a reverse deliberately
//     does NOT undo (a confirmation bump, a rule cascade). A plan render
//     without them silently drops the "this is what stays taught" half.

const safeString = (value) => (value == null ? '' : String(value));

// The adjustment-journal instruction a posted line carries, verbatim (Kari's
// recorded call: surface and stay proposed, never silently un-post; the fix
// is a dated adjustment journal). The panel renders this string exactly.
export const LEDGER_ADJUSTMENT_INSTRUCTION =
  'Posted to the ledger. Donna never un-posts silently. Post a dated adjustment journal, then reverse.';

// The executor's four dispositions. Only `reverse` writes; the other three are
// reported. Tones map onto the house palette (ok = writes, amber = refused
// because state moved, alert = ledger, muted = nothing to do).
export const REVERSE_DISPOSITION_META = Object.freeze({
  reverse: { label: 'Will reverse', tone: 'ok', writes: true },
  stale: { label: 'Refused, row moved', tone: 'amber', writes: false },
  needs_ledger_adjustment: { label: 'Needs ledger adjustment', tone: 'alert', writes: false },
  skip: { label: 'Nothing to write', tone: 'muted', writes: false }
});

// Every reason token the executor and the pure builders can emit, mapped to
// one honest sentence. An unknown token renders as itself (never hidden).
export const REVERSE_REASON_COPY = Object.freeze({
  // Builder refusals (malformed / unsupported capture rows).
  malformed_before_after_row: 'The captured row is malformed. Nothing can be restored from it.',
  not_reversible: 'The captured row cannot be reversed.',
  empty_before_state: 'The capture recorded no before state to restore.',
  not_match_shaped: 'The captured row is not match shaped. Nothing is written.',
  cascade_cannot_restore: 'Restoring this match cannot reproduce the recorded before state. Refused rather than a partial write.',
  not_memory_mint_shaped: 'The captured row is not a recognized memory mint. Nothing is written.',
  // Planner refusals.
  target_missing: 'The target row no longer exists.',
  writer_not_supported: 'This apply went through a writer the reverse executor cannot restore. Reported only.',
  // Optimistic concurrency (stale).
  status_moved: 'The row moved since this apply. A newer decision would be clobbered, so the reverse is refused.',
  review_state_moved: 'The review state moved since this apply. A newer decision would be clobbered, so the reverse is refused.',
  match_status_moved: 'The match moved since this apply. A newer decision would be clobbered, so the reverse is refused.',
  reconciliation_status_moved: 'The line was re-decided since this apply. A newer decision would be clobbered, so the reverse is refused.',
  // Ledger.
  posted_to_ledger: LEDGER_ADJUSTMENT_INSTRUCTION,
  // The memory/ask mint legs (G2 PR-14). A mint that landed on a pre-existing
  // object is surfaced, never retired: the apply did not create it.
  firm_fact_pre_existed: 'This fact existed before the apply. The apply re-taught it, so the reverse leaves it in place.',
  client_rule_pre_existed: 'This rule existed before the apply. The apply re-taught it, so the reverse leaves it in place.',
  client_evidence_request_pre_existed: 'This ask existed before the apply. The apply re-asked it, so the reverse leaves it open.',
  already_reversed: 'Already reversed. Running it again would write a second tombstone.',
  ask_answered: 'The owner answered this ask. Their answer supersedes the action being reversed, so it is never clobbered.',
  // Ask lifecycle writers: surfaced only, with named reasons. A reverse never
  // re-opens a question and outbound is never auto-fired.
  ask_reopen_not_auto_planned: 'This apply cancelled an ask. Reopening would re-ask the owner, so it is not planned automatically.',
  ask_amendment_not_auto_reverted: 'This apply amended an ask. Reverting the amendment is not planned automatically.',
  outbound_never_auto_fired: 'This apply sent outbound. A reverse never fires outbound, so it is reported only.',
  // Execute-phase skips (the receipt).
  fact_not_active: 'The fact moved out of active between the plan and the write. Nothing was changed.',
  ask_not_cancellable: 'The ask was no longer cancellable when the write ran. Nothing was changed.',
  review_item_not_found: 'The review item behind this line no longer exists. Nothing was changed.'
});

// The side effects a reverse deliberately does NOT undo. The server sends its
// own reason sentence per row; the label names the kind, the server sentence
// is rendered verbatim as the detail.
export const SURFACED_KIND_LABELS = Object.freeze({
  rule_confirmation_bump: 'Confirmation bump stays',
  rule_cascade_not_unwound: 'Rule cascade stays'
});

// Named writers, in operator words. Surfacing the writer is the receipt that
// the reverse routes through a known writer (INV-1).
export const REVERSE_WRITER_LABELS = Object.freeze({
  updateTransactionReviewItemInDb: 'Coding change',
  updateReconciliationMatchInDb: 'Match change',
  createManualReconciliationMatchInDb: 'Manual link',
  saveFirmFact: 'Taught a firm fact',
  saveMerchantRuleForPayload: 'Taught a merchant rule',
  createClientEvidenceRequestInDb: 'Asked the owner',
  cancelClientEvidenceRequestInDb: 'Cancelled an ask',
  amendClientEvidenceRequestInDb: 'Amended an ask',
  deliverEvidenceAsksOnAllChannels: 'Sent asks to the owner'
});

// What each mint leg's reverse writes, in the governed writer's own retire
// verb. None is a delete: the fact keeps its content, the rule its history,
// the ask its question.
export const MEMORY_STATUS_COPY = Object.freeze({
  dismissed: 'Fact dismissed. Its content is kept as the trail of the correction.',
  retired: 'Rule retired. It stops matching future lines; its history is kept.',
  cancelled: 'Ask cancelled. The question that was sent is kept.'
});

// The FIRST-principle warning the cancel writer computes: cancelling an ask
// can leave its line resting on neither sanctioned terminal.
export const LINE_HANGING_WARNING =
  'Cancelling this ask leaves its line on neither terminal. It needs a new ask or a reconcile.';

const normalizeSummary = (summary) => ({
  total: Number(summary?.total || 0),
  reverse: Number(summary?.reverse || 0),
  stale: Number(summary?.stale || 0),
  needs_ledger_adjustment: Number(summary?.needs_ledger_adjustment || 0),
  skip: Number(summary?.skip || 0),
  surfaced: Number(summary?.surfaced || 0)
});

export const reverseReasonCopy = (reason) => {
  const token = safeString(reason);
  if (!token) return '';
  return REVERSE_REASON_COPY[token] || token;
};

const entryView = (entry) => {
  const disposition = safeString(entry?.disposition) || 'skip';
  const meta = REVERSE_DISPOSITION_META[disposition] || REVERSE_DISPOSITION_META.skip;
  const reason = entry?.reason == null ? null : String(entry.reason);
  const expected = entry?.expected ?? null;
  const actual = entry?.actual ?? null;
  return {
    target: entry?.target == null ? null : String(entry.target),
    matchId: entry?.match_id == null ? null : String(entry.match_id),
    kind: entry?.kind == null ? null : String(entry.kind),
    disposition,
    dispositionLabel: meta.label,
    tone: meta.tone,
    writes: meta.writes,
    reason,
    reasonCopy: reverseReasonCopy(reason),
    // A stale row says exactly what moved: recorded expected vs current actual.
    movement: expected != null || actual != null
      ? { expected: expected == null ? null : String(expected), actual: actual == null ? null : String(actual) }
      : null,
    // The verbatim instruction rides every ledger row, whatever its reason.
    instruction: disposition === 'needs_ledger_adjustment' ? LEDGER_ADJUSTMENT_INSTRUCTION : null,
    surfaced: (Array.isArray(entry?.surfaced) ? entry.surfaced : []).map((row) => ({
      kind: safeString(row?.kind),
      label: SURFACED_KIND_LABELS[safeString(row?.kind)] || safeString(row?.kind),
      // The server's own sentence for why this is not undone, verbatim.
      detail: safeString(row?.reason),
      ruleId: row?.rule_id == null ? null : String(row.rule_id),
      reviewItemId: row?.review_item_id == null ? null : String(row.review_item_id),
      priorCount: row?.prior_count ?? null,
      confirmationCount: row?.confirmation_count ?? null,
      matched: row?.matched ?? null
    }))
  };
};

const cardView = (card) => {
  const writer = card?.writer == null ? null : String(card.writer);
  const entries = (Array.isArray(card?.entries) ? card.entries : []).map(entryView);
  const summary = normalizeSummary(card?.summary);
  return {
    id: card?.proposal_id == null ? null : String(card.proposal_id),
    writer,
    writerLabel: (writer && REVERSE_WRITER_LABELS[writer]) || writer || 'Unknown writer',
    leg: card?.leg ?? null,
    proposalType: card?.proposal_type == null ? null : String(card.proposal_type),
    status: card?.status == null ? null : String(card.status),
    createdAt: card?.created_at ?? null,
    summary,
    // A card with zero writable rows can still be READ (its refusals are the
    // honest report) but selecting it for execution would write nothing.
    selectable: summary.reverse > 0,
    entries
  };
};

// Dry-run response → the plan view the panel renders.
export const buildReversePlanView = (response) => ({
  dryRun: response?.dry_run !== false,
  clientId: response?.client_id == null ? null : String(response.client_id),
  summary: normalizeSummary(response?.summary),
  cards: (Array.isArray(response?.cards) ? response.cards : []).map(cardView)
});

// How many rows would actually WRITE across the selected cards. The confirm
// bar states this number; zero means the confirm button stays disabled.
export const selectedReverseCount = (planView, selectedIds = []) => {
  const selected = new Set((selectedIds || []).map(String));
  return (planView?.cards || [])
    .filter((card) => selected.has(String(card.id)))
    .reduce((sum, card) => sum + (card.summary?.reverse || 0), 0);
};

// Execute response → the receipt view. Applied rows keep the executor's own
// vocabulary: reversed (with the retire verb that ran), skipped (benign
// no-op between plan and write), error.
const APPLIED_STATUS_META = Object.freeze({
  reversed: { label: 'Reversed', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'muted' },
  error: { label: 'Failed', tone: 'alert' }
});

export const buildReverseReceiptView = (response) => {
  const applied = (Array.isArray(response?.applied) ? response.applied : []).map((row) => {
    const status = safeString(row?.status) || 'error';
    const meta = APPLIED_STATUS_META[status] || APPLIED_STATUS_META.error;
    const memoryStatus = row?.memory_status == null ? null : String(row.memory_status);
    return {
      proposalId: row?.proposal_id == null ? null : String(row.proposal_id),
      target: row?.target == null ? null : String(row.target),
      matchId: row?.match_id == null ? null : String(row.match_id),
      kind: row?.kind == null ? null : String(row.kind),
      status,
      statusLabel: meta.label,
      tone: meta.tone,
      memoryStatus,
      memoryStatusCopy: memoryStatus ? MEMORY_STATUS_COPY[memoryStatus] || memoryStatus : null,
      leavesLineHanging: row?.leaves_line_hanging === true,
      reason: row?.reason == null ? null : String(row.reason),
      reasonCopy: reverseReasonCopy(row?.reason)
    };
  });
  return {
    summary: {
      ...normalizeSummary(response?.summary),
      reversed: Number(response?.summary?.reversed || 0),
      errors: Number(response?.summary?.errors || 0)
    },
    applied,
    hangingCount: applied.filter((row) => row.leavesLineHanging).length
  };
};

// ── Confirm-flow state machine ──────────────────────────────────────────────
//
// read → select → CONFIRM → execute → receipt. The execute call is only
// reachable from the confirm phase with a non-empty selection: the component
// guards its network call on canExecuteReverse, and the wiring test pins that
// guard, so "execute-only-on-confirm" is machine-checked rather than a habit.

export const initialReverseUiState = Object.freeze({ phase: 'loading', selected: [], error: null });

export const canExecuteReverse = (state) =>
  state?.phase === 'confirm' && Array.isArray(state.selected) && state.selected.length > 0;

export const reverseUiReduce = (state = initialReverseUiState, event = {}) => {
  const type = safeString(event.type);
  switch (type) {
    case 'plan_loaded':
      return { phase: 'plan', selected: [], error: null };
    case 'plan_failed':
      return { phase: 'error', selected: [], error: safeString(event.message) || 'Could not load the reverse plan.' };
    case 'toggle': {
      if (state.phase !== 'plan') return state;
      const id = safeString(event.id);
      if (!id) return state;
      const selected = state.selected.includes(id)
        ? state.selected.filter((existing) => existing !== id)
        : [...state.selected, id];
      return { ...state, selected };
    }
    case 'clear_selection':
      return state.phase === 'plan' ? { ...state, selected: [] } : state;
    case 'request_confirm':
      // Confirm needs something selected; an empty confirm screen would be a
      // button that writes nothing.
      return state.phase === 'plan' && state.selected.length > 0 ? { ...state, phase: 'confirm' } : state;
    case 'cancel_confirm':
      return state.phase === 'confirm' ? { ...state, phase: 'plan' } : state;
    case 'execute_start':
      // The one transition that leads to a write. Refused from every phase
      // except an armed confirm.
      return canExecuteReverse(state) ? { ...state, phase: 'executing' } : state;
    case 'execute_done':
      return state.phase === 'executing' ? { ...state, phase: 'receipt' } : state;
    case 'execute_failed':
      return state.phase === 'executing'
        ? { ...state, phase: 'confirm', error: safeString(event.message) || 'Reverse failed.' }
        : state;
    case 'reload':
      return { phase: 'loading', selected: [], error: null };
    default:
      return state;
  }
};
