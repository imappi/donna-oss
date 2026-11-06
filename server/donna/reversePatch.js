// Donna — the pure reverse-patch builder (pod-safety #2, reverse half).
//
// Extracted verbatim from firmDb.js so the reverse EXECUTOR (reverseExecutor.js) can build
// restoring patches without importing the heavy firmDb chain — the same firmDb-free discipline
// feedChatProposalShadow.js keeps. firmDb.js re-exports these symbols, so its own callers and
// firmDb.test.js are untouched.
//
// Given ONE persisted before_after row (proposal_cards.before_after — the __reviewItemBeforeAfter
// shape captured at apply time), build the patch that RESTORES the before-state through the SAME
// writer, plus the optimistic-concurrency precondition (contract §13: refuse if the row moved
// since the apply being reversed) and an honest needs_ledger_adjustment flag — when the recorded
// after showed a ledger-terminal reconciliation_status, the coding patch alone doesn't un-post the
// journal; the executor must pair it with a dated adjustment journal (Kari's call: surface + stay
// proposed, never silently un-post — the ledger path is on the isolation list). Pure; no DB.

// A recorded `after.transaction.reconciliation_status` in this set means the line POSTED to the
// ledger after the apply — so a coding reverse alone can't un-post it.
export const LEDGER_TERMINAL_RECONCILIATION_STATUSES = new Set(['reconciled', 'posted', 'auto_reconciled']);

// The MATCH leg's ledger-terminal signal is DIFFERENT from the coding leg's set above:
// 'reconciled' is what the match-confirm cascade ITSELF writes (every confirmed link sits
// there), so on this leg it means "settled by a match", not "posted to the ledger". Only
// 'posted' (stamped by commitPreparedLedgerPosting when a ledger journal actually exists)
// means a journal must be adjusted before the match can move.
export const MATCH_LEDGER_POSTED_STATUSES = new Set(['posted']);

// The match writers' closed status vocabulary (updateReconciliationMatchInDb's own guard).
const MATCH_STATUSES = new Set(['suggested', 'auto_matched', 'confirmed', 'rejected']);

// What updateReconciliationMatchInDb's own cascade writes onto the bank transaction for a
// given match status: confirmed/auto_matched settle ('reconciled'), rejected reopens
// ('needs_review'), suggested leaves the tx untouched (null = unchanged). Mirror of
// firmDb.__matchBeforeAfter — the capture and the reverse must speak the same semantics.
const matchCascadeForStatus = (status) =>
  status === 'confirmed' || status === 'auto_matched'
    ? 'reconciled'
    : status === 'rejected'
      ? 'needs_review'
      : null;

// Pod-safety #2, match-writer reverse leg (pure builder). Given ONE captured
// __matchBeforeAfter row (target = bank transaction id; before/after carry match_id,
// match_status and the tx reconciliation_status), build the patch that restores the
// before-state through the MATCH writer (updateReconciliationMatchInDb — the same
// PATCH-path writer the FE uses, INV-1):
//   - before.match_status = 'confirmed'/'auto_matched'/'suggested'/'rejected' → re-set it;
//   - before.match_status = null (the apply CREATED the link — a fresh manual link) →
//     'rejected' is the writer's unlink verb; there is no delete.
// Honesty check, record-only: the writer's own cascade for the restore status must
// REPRODUCE the recorded before tx state (a 'suggested' restore leaves the tx wherever it
// sits — i.e. at the recorded after). If it can't (e.g. an upsert that flipped
// suggested→confirmed: re-suggesting would strand the tx at 'reconciled'), refuse with
// `cascade_cannot_restore` — fail-closed, surfaced in the plan, never a partial write.
// Preconditions are MATCH-shaped (contract §13 optimistic concurrency): the current match
// row status AND the current tx reconciliation_status must still be where the apply left
// them. Pure; no DB.
export const matchReversePatchFromBeforeAfter = ({ target = null, before = null, after = null } = {}) => {
  if (!target || !before || typeof before !== 'object' || !after || typeof after !== 'object') {
    return { target, reversible: false, reason: 'malformed_before_after_row' };
  }
  const matchId = after.match_id ?? before.match_id ?? null;
  if (!matchId || !MATCH_STATUSES.has(String(after.match_status ?? ''))) {
    return { target, reversible: false, reason: 'not_match_shaped' };
  }
  const beforeStatus = before.match_status ?? null;
  if (beforeStatus !== null && !MATCH_STATUSES.has(String(beforeStatus))) {
    return { target, match_id: matchId, reversible: false, reason: 'not_match_shaped' };
  }
  const restoreStatus = beforeStatus === null ? 'rejected' : String(beforeStatus);
  const beforeTx = before.transaction?.reconciliation_status ?? null;
  const afterTx = after.transaction?.reconciliation_status ?? null;
  // What the restore's cascade will leave on the tx: the branch's own write, or — for a
  // 'suggested' restore, which touches nothing — the state the row currently sits at
  // (the recorded after, which the planner preconditions the current read against).
  const restoredTx = matchCascadeForStatus(restoreStatus) ?? afterTx;
  if (String(restoredTx ?? '') !== String(beforeTx ?? '')) {
    return { target, match_id: matchId, reversible: false, reason: 'cascade_cannot_restore' };
  }
  return {
    target,
    match_id: matchId,
    reversible: true,
    patch: { status: restoreStatus },
    preconditions: {
      object: String(matchId),
      expected_match_status: after.match_status,
      expected_reconciliation_status: afterTx
    }
  };
};

// ─── The memory / ask MINT leg (G2 PR-14) ────────────────────────────────────
//
// "The reverse covers what the action taught, not just what it posted." An apply
// that minted a firm fact, a merchant rule or an owner ask leaves state the
// coding/match legs above cannot see. The capture records ONE row per minted
// object (memoryMintBeforeAfterRow, written at the apply site); this builder turns
// that row into the restoring patch — routed by the executor through the EXISTING
// governed writers (dismissFirmFact / updateClientRuleStatusInDb+allowActiveRetire /
// cancelClientEvidenceRequestInDb), never a new memory mutation (INV-1).
//
// The load-bearing asymmetry: a mint is only reversible when THIS apply actually
// created the object. All three writers are upserts that collapse onto an existing
// row (the deterministic fact id, the deterministic rule id, the F-19 ask id), so a
// re-teach or a second ask on the same anchor returns an object the apply did NOT
// bring into being. Retiring/dismissing/cancelling it would destroy state the
// reversed action never created — so `before.present === true` fail-closes to a
// surfaced, non-applying row. Recorded trade-off: a re-teach that RE-ACTIVATED a
// retired rule (the rule upsert forces status='active') is also surfaced-only —
// the capture records presence, not the prior status, and over-surfacing is the
// safe side of that line.
export const MEMORY_MINT_KINDS = Object.freeze(new Set(['firm_fact', 'client_rule', 'client_evidence_request']));

// What the RESTORE writes per kind — each is the governed writer's own retire verb,
// not a delete: a dismissed fact keeps its content as the governance trail of a
// human "no" (the firm-memory rail), a retired rule keeps its history, a cancelled
// ask keeps the question that was asked.
export const MEMORY_REVERSE_STATUS = Object.freeze({
  firm_fact: 'dismissed',
  client_rule: 'retired',
  client_evidence_request: 'cancelled'
});

// The status an object of each kind rests at right after its mint (the default
// `after.status` when the capture site didn't record one).
const MEMORY_MINT_DEFAULT_STATUS = Object.freeze({
  firm_fact: 'active',
  client_rule: 'active',
  client_evidence_request: 'open'
});

// Build ONE capture row for a minted (or collapsed-onto) memory/ask object. Shared
// by every apply site so the capture and the reverse speak the same semantics —
// the same discipline __matchBeforeAfter keeps with matchReversePatchFromBeforeAfter.
//   minted === false ⇒ the writer's upsert landed on a PRE-EXISTING row; the row is
//   still captured (the plan must be able to SAY so) but plans to a surfaced skip.
export const memoryMintBeforeAfterRow = ({ kind, id, minted = false, status = null, detail = null } = {}) => {
  const cleanKind = String(kind ?? '');
  const cleanId = id == null ? '' : String(id);
  if (!MEMORY_MINT_KINDS.has(cleanKind) || !cleanId) return null;
  const restingStatus = status || MEMORY_MINT_DEFAULT_STATUS[cleanKind];
  return {
    target: cleanId,
    before: minted
      ? { kind: cleanKind, present: false, status: null }
      : { kind: cleanKind, present: true, status: restingStatus },
    after: {
      kind: cleanKind,
      present: true,
      status: restingStatus,
      ...(detail && typeof detail === 'object' ? detail : {})
    }
  };
};

// Pure builder for the mint leg. Returns the same envelope shape as its siblings:
// { target, kind, reversible, patch, preconditions } or { reversible: false, reason }.
export const memoryMintReversePatchFromBeforeAfter = ({ target = null, before = null, after = null } = {}) => {
  if (!target || !before || typeof before !== 'object' || !after || typeof after !== 'object') {
    return { target, reversible: false, reason: 'malformed_before_after_row' };
  }
  const kind = String(after.kind ?? before.kind ?? '');
  if (!MEMORY_MINT_KINDS.has(kind) || after.present !== true) {
    return { target, reversible: false, reason: 'not_memory_mint_shaped' };
  }
  if (before.present !== false) {
    // The apply collapsed onto state it did not create — surfaced, never clobbered.
    return { target, kind, reversible: false, reason: `${kind}_pre_existed` };
  }
  return {
    target,
    kind,
    reversible: true,
    patch: { status: MEMORY_REVERSE_STATUS[kind] },
    preconditions: {
      object: String(target),
      expected_status: after.status ?? MEMORY_MINT_DEFAULT_STATUS[kind]
    }
  };
};

export const reversePatchFromBeforeAfter = ({ target = null, before = null, after = null } = {}) => {
  if (!target || !before || typeof before !== 'object' || !after || typeof after !== 'object') {
    return { target, reversible: false, reason: 'malformed_before_after_row' };
  }
  const patch = {};
  for (const [key, value] of Object.entries(before)) {
    if (key === 'transaction') continue; // the tx row follows via the writer's own cascade
    patch[key] = value;
  }
  if (!Object.keys(patch).length) {
    return { target, reversible: false, reason: 'empty_before_state' };
  }
  // Hint from the RECORDED after only — the line may have posted since (e.g. codingAutoPost on
  // accept), so the executor re-checks the CURRENT reconciliation_status before applying; this
  // flag can only escalate, never clear, that check.
  const afterReconciliation = String(after?.transaction?.reconciliation_status || '');
  return {
    target,
    reversible: true,
    patch,
    preconditions: {
      object: String(target),
      expected_status: after.status ?? null,
      expected_review_state: after.review_state ?? null
    },
    needs_ledger_adjustment: LEDGER_TERMINAL_RECONCILIATION_STATUSES.has(afterReconciliation)
  };
};
